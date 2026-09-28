/**
 * dsh-session-delete 的离线逻辑测试。
 *
 * 不碰真实的 ~/.dsh：造一个临时 DSH_HOME，塞假会话目录 + 投影分片 + 遗留聚合，
 * 再用 stub 出来的 cordis ctx 直接调插件注册的 /api/session.delete* 路由。
 *
 * 重点覆盖 2026-09-28 在真机上踩到的坑：
 *   A. 句柄占用时 rename 目录必 EPERM → 必须退化成「复制 + rm」兜底
 *   B. live 会话不摘干净 → session/list 会把它重新列出来（点了像没删）
 *   C. 主进程环境里没有 DSH_SESSION_ID → 当前会话保护只能靠浏览器上报
 *   D. 会话正卡在 append 临界区时硬摘会绕开 store 的重入保护 → 必须 409 挡住
 *   E. store 没有 flush 接口时不能谎报「刷过了」→ 必须如实警告
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = "session-11111111-2222-4333-8444-555555555555";
const HELD = "session-hhhhhhhh-2222-4333-8444-555555555555";
const LIVE = "session-llllllll-2222-4333-8444-555555555555";
const BUSY = "session-bbbbbbbb-2222-4333-8444-555555555555";
const NOFLUSH = "session-nnnnnnnn-2222-4333-8444-555555555555";
const OTHER = "session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CURRENT = "session-99999999-8888-4777-8666-555555555555";
const GHOST = "session-ggghhhgg-gggg-4hhh-8ggg-hhhhhhhhhhhh";
const SUB1 = "session-cccc1111-2222-4333-8444-555555555555";
const SUB2 = "session-cccc2222-2222-4333-8444-555555555555";
const KEEPSUB = "session-cccc3333-2222-4333-8444-555555555555";
const ORPHAN = "session-cccc4444-2222-4333-8444-555555555555";
const P2 = "session-pppppp22-2222-4333-8444-555555555555";


const root = await mkdtemp(join(tmpdir(), "dsh-sd-test-"));
const projectDir = join(root, "sessions", "--test-project--");

async function makeSession(id, logBytes, blobBytes) {
  const dir = join(projectDir, id);
  await mkdir(join(dir, "attachments"), { recursive: true });
  await writeFile(join(dir, "session.v3.jsonl.zstd"), logBytes, "utf8");
  if (blobBytes > 0) await writeFile(join(dir, "attachments", "a.bin"), "x".repeat(blobBytes), "utf8");
  return dir;
}

const targetDir = await makeSession(TARGET, "fake log bytes", 2048);
const heldDir = await makeSession(HELD, "held log", 0);
const liveDir = await makeSession(LIVE, "live log", 0);
const neighbour = await makeSession(OTHER, "other", 0);
const busyDir = await makeSession(BUSY, "busy log", 0);
const noFlushDir = await makeSession(NOFLUSH, "no-flush log", 0);
const sub1Dir = await makeSession(SUB1, "sub1 log", 16);
const sub2Dir = await makeSession(SUB2, "sub2 log", 8);
const keepSubDir = await makeSession(KEEPSUB, "kept sub", 4);
const orphanDir = await makeSession(ORPHAN, "orphan log", 8);
const p2Dir = await makeSession(P2, "p2 log", 4);

const shardDir = join(root, "storages", "session_projcache", "sessions");
await mkdir(shardDir, { recursive: true });
const writeShard = (key) =>
  writeFile(join(shardDir, `${key}.json`), JSON.stringify({ version: 7, record: { rows: {} } }), "utf8");
const shardFile = join(shardDir, `${TARGET}.json`);
await writeShard(TARGET);
const neighbourShard = join(shardDir, `${OTHER}.json`);
await writeShard(OTHER);
const ghostShard = join(shardDir, `${GHOST}.json`);
await writeShard(GHOST);

const aggregate = join(root, "storages", "session_projcache.json");
await writeFile(aggregate, JSON.stringify({
  version: 7,
  global: null,
  tables: { sessions: { [TARGET]: { rows: {} }, [OTHER]: { rows: {} } } }
}, null, 2), "utf8");

// 回收目录里两个假堆：一个 40 天前的旧堆（对账时应被清）、一个刚删的新堆（保留期内必须不动）。
const trashBaseDir = join(root, ".sessions-trash");
const oldStamp = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().replace(/[:.]/g, "-");
const freshStamp = new Date().toISOString().replace(/[:.]/g, "-");
const oldTrash = join(trashBaseDir, `${oldStamp}-ui`, "--test-project--", TARGET);
const freshTrash = join(trashBaseDir, `${freshStamp}-ui`, "--test-project--", OTHER);
await mkdir(oldTrash, { recursive: true });
await writeFile(join(oldTrash, "session.v3.jsonl.zstd"), "old trash".repeat(10), "utf8");
await mkdir(freshTrash, { recursive: true });
await writeFile(join(freshTrash, "session.v3.jsonl.zstd"), "fresh trash".repeat(10), "utf8");

// 关键：**故意不设 DSH_SESSION_ID**，逼「当前会话」保护只能靠浏览器上报，
// 这正是 `dsh web` 主进程里的真实情形喵。
delete process.env.DSH_SESSION_ID;
process.env.DSH_HOME = root;

// ── stub ctx ──────────────────────────────────────────────────────────────
const routes = new Map();
const workspacePath = "X";
const workspaceRecord = { sessionIds: [TARGET, OTHER, BUSY, NOFLUSH, "session-deadbeef-0000-4000-8000-000000000000"] };
const archivedBox = { value: [TARGET, "session-deadbeef-0000-4000-8000-000000000000"] };
const shardMemory = new Map([
  [TARGET, { rows: {} }],
  [OTHER, { rows: {} }],
  [LIVE, { rows: {} }]
]);
/** 只有磁盘上还在的会话才有 sessionPath —— 模拟真实注册表的 header 索引。 */
const sessionPaths = new Map([[TARGET, workspacePath], [OTHER, workspacePath], [LIVE, workspacePath], [BUSY, workspacePath], [NOFLUSH, workspacePath]]);

const workspaceEntity = {
  path: workspacePath,
  get sessionIds() {
    return workspaceRecord.sessionIds.filter((id) => sessionPaths.get(id) === workspacePath);
  },
  async detachSession(id) {
    const without = workspaceRecord.sessionIds.filter((value) => value !== id);
    workspaceRecord.sessionIds = without.filter((value) => sessionPaths.get(value) === workspacePath);
  }
};

const registry = {
  list: () => [workspaceEntity],
  get archivedSessionIds() {
    return archivedBox.value;
  },
  requireState: () => ({ initialized: true, workspaceIds: ["w1"], archivedSessionIds: archivedBox.value }),
  async setState(state) {
    archivedBox.value = state.archivedSessionIds;
  }
};

// 假 SessionStore：验证「先刷盘 → 再摘出去 → 然后才删文件」，
// 另外备两个特殊条目：BUSY 永远停在 append 临界区（必须被 409 挡住）、
// NOFLUSH 用来验「没有 flush 接口时要如实警告」。
const storeCalls = { flushed: [], detached: [] };
const liveSessions = new Map();
const liveEntries = new Map();
function addLive(id, extra = {}) {
  const session = { id };
  liveSessions.set(id, session);
  liveEntries.set(id, { id, ...extra });
  return session;
}
const liveSession = addLive(LIVE);
addLive(BUSY, { appending: true });
addLive(NOFLUSH);
const sessionStore = {
  get: (id) => liveSessions.get(id),
  list: () => [...liveSessions.values()],
  liveEntryFor: (session) => liveEntries.get(session.id),
  detachEntered: (entry) => {
    storeCalls.detached.push(entry.id);
    liveEntries.delete(entry.id);
    liveSessions.delete(entry.id);
    sessionPaths.delete(entry.id);
  },
  flush: async (session) => {
    storeCalls.flushed.push(session.id);
  }
};

const ctx = {
  workspaceRegistry: registry,
  sessionPersistence: {
    async list() {
      return [
        { header: { id: TARGET, cwd: "X", origin: "user", createdAt: 1790000000000 }, sizeBytes: 100 },
        { header: { id: OTHER, cwd: "X", origin: "subagent", createdAt: 1790000001000 }, sizeBytes: 5 },
        { header: { id: LIVE, cwd: "X", origin: "user", createdAt: 1790000002000 }, sizeBytes: 7 },
        { header: { id: SUB1, cwd: "X", origin: "subagent", parentSession: TARGET, createdAt: 1790000003000 }, sizeBytes: 40 },
        { header: { id: SUB2, cwd: "X", origin: "subagent", parentSession: SUB1, createdAt: 1790000004000 }, sizeBytes: 8 },
        { header: { id: KEEPSUB, cwd: "X", origin: "subagent", parentSession: P2, createdAt: 1790000005000 }, sizeBytes: 4 },
        { header: { id: ORPHAN, cwd: "X", origin: "subagent", parentSession: "session-deadbeef-0000-4000-8000-000000000000", createdAt: 1790000006000 }, sizeBytes: 8 },
        { header: { id: P2, cwd: "X", origin: "user", createdAt: 1790000007000 }, sizeBytes: 4 }
      ];
    }
  },
  storageDomain: {
    get(domainName) {
      if (domainName === "workspace") {
        return { global: { get: () => registry.requireState(), set: async (state) => registry.setState(state) } };
      }
      if (domainName === "session_projcache") {
        return {
          table: () => ({
            get: (key) => shardMemory.get(key),
            keys: () => [...shardMemory.keys()],
            async delete(key) {
              if (!shardMemory.has(key)) return false;
              shardMemory.delete(key);
              await rm(join(shardDir, `${key}.json`), { force: true });
              return true;
            }
          })
        };
      }
      return void 0;
    }
  },
  get: (key) => (key === "sessions" ? sessionStore : key === "agents" ? { get: () => void 0 } : void 0),
  logger: { info: () => {}, warn: (message) => console.log("WARN", message) },
  connection: { fetch: { register: (route) => routes.set(route.path, route) } }
};

const mod = await import("../lib/index.js");
mod.apply(ctx);

async function call(path, body) {
  const route = routes.get(path);
  if (route === void 0) throw new Error(`route ${path} 没注册`);
  const request = {
    method: body === void 0 ? "GET" : "POST",
    url: `http://127.0.0.1:3080${path}`,
    json: async () => body
  };
  const response = await route.fetch(request);
  return { status: response.status, payload: await response.json() };
}

let failures = 0;
function check(label, condition, detail) {
  if (!condition) failures += 1;
  console.log(`[${condition ? "PASS" : "FAIL"}] ${label}${detail === void 0 ? "" : ` —— ${JSON.stringify(detail)}`}`);
}

const exists = (path) => stat(path).then(() => true, () => false);

console.log("注册的路由：", [...routes.keys()].join(", "));
check("三条路由都注册了", routes.size === 3);

// ── 1. 列表 ───────────────────────────────────────────────────────────────
const listed = await call("/api/session.delete.list");
check("list 返回 200", listed.status === 200);
check("list 列出八条", listed.payload.sessions?.length === 8, listed.payload.sessions?.map((row) => row.short));
check("list 认得出子代理标记", listed.payload.sessions?.find((row) => row.short === SUB1.slice(8, 16))?.origin === "subagent");
check("list 带出父会话指针", listed.payload.sessions?.find((row) => row.short === SUB1.slice(8, 16))?.parent === TARGET.slice(8));
check("list 认得出 live", listed.payload.sessions?.find((row) => row.short === LIVE.slice(8, 16))?.live === true);

// ── 2. 当前会话保护：环境变量没有，只能靠浏览器上报 ─────────────────────────
const self = await call("/api/session.delete", { sessionId: CURRENT, currentSessionId: CURRENT });
check("靠上报的 currentSessionId 拦住当前会话", self.status === 409 && self.payload.code === "current-session", self.payload);

// ── 3. 非法 id / 不存在 ───────────────────────────────────────────────────
check("拒绝路径穿越式 id", (await call("/api/session.delete", { sessionId: "../../etc/passwd" })).status === 400);
check("找不到会话回 404",
  (await call("/api/session.delete", { sessionId: "session-00000000-0000-4000-8000-000000000099" })).status === 404);

// ── 4. 普通删除 ───────────────────────────────────────────────────────────
const removed = await call("/api/session.delete", { sessionId: TARGET });
check("删除返回 200", removed.status === 200, removed.payload?.error ?? removed.payload?.warnings);
check("释放字节数正确（14 + 2048）", removed.payload.freedBytes === 2062, removed.payload.freedBytes);
check("摘掉 1 条工作区归属", removed.payload.detached === 1, removed.payload.detached);
check("清掉 1 条归档引用", removed.payload.unarchived === 1, removed.payload.unarchived);
check("删掉 1 个投影分片", removed.payload.shards === 1, removed.payload.shards);
check("剪掉 1 条遗留聚合", removed.payload.legacy === 1, removed.payload.legacy);
check("原目录已消失", (await exists(targetDir)) === false);
check("会话进了回收目录（可反悔）",
  (await exists(join(removed.payload.trash, "--test-project--", TARGET, "session.v3.jsonl.zstd"))) === true);
check("邻居会话没被误删", (await exists(neighbour)) === true);
check("邻居分片没被误删", (await exists(neighbourShard)) === true);
check("工作区里的死引用被一并剪掉",
  workspaceRecord.sessionIds.includes("session-deadbeef-0000-4000-8000-000000000000") === false, workspaceRecord.sessionIds);
check("邻居归属保留", workspaceRecord.sessionIds.includes(OTHER));

// ── 4b. 没勾「连子代理一起删」时，子代理一律不动 ────────────────────────────
check("不带 cascade 时子代理目录原封不动",
  (await exists(sub1Dir)) === true && (await exists(sub2Dir)) === true);
check("不带 cascade 时响应里 children 为空", removed.payload.children?.length === 0, removed.payload.children);

// ── 4c. cascade：删父会话连子代理（含孙代理）一起收进回收目录 ────────────────
const cascaded = await call("/api/session.delete", { sessionId: P2, cascade: true });
check("cascade 删除返回 200", cascaded.status === 200, cascaded.payload?.error ?? cascaded.payload?.warnings);
check("cascade 连带删了 1 个子代理", cascaded.payload.children?.length === 1 && cascaded.payload.children[0].id === KEEPSUB.slice(8), cascaded.payload.children);
check("释放字节 = 父 10 + 子 12（含附件）", cascaded.payload.freedBytes === 22, cascaded.payload.freedBytes);
check("子代理目录已消失", (await exists(keepSubDir)) === false);
check("子代理也进了同一个回收目录",
  (await exists(join(cascaded.payload.trash, "--test-project--", KEEPSUB, "session.v3.jsonl.zstd"))) === true);
check("工作区归属里子代理也摘掉了", workspaceRecord.sessionIds.includes(KEEPSUB) === false);

// ── 5. live 会话：先刷盘 → 再摘出 SessionStore → 然后才删 ───────────────────
const liveRemoved = await call("/api/session.delete", { sessionId: LIVE });
check("live 会话删除成功", liveRemoved.status === 200, liveRemoved.payload);
check("删除前先刷了盘", storeCalls.flushed.includes(LIVE), storeCalls.flushed);
check("把它摘出了 SessionStore", storeCalls.detached.includes(LIVE), storeCalls.detached);
check("响应如实报告 live=detached", liveRemoved.payload.live === "detached", liveRemoved.payload.live);
check("live 会话目录已消失", (await exists(liveDir)) === false);

// ── 6. 句柄占用：rename 必 EPERM，必须走「复制 + rm」兜底 ────────────────────
const holder = spawn(process.execPath, [
  "-e",
  `const fs=require('fs');const fd=fs.openSync(${JSON.stringify(join(heldDir, "session.v3.jsonl.zstd"))},'a');
   process.stdout.write('held\\n');
   setTimeout(()=>{try{fs.closeSync(fd)}catch{};process.exit(0);}, 20000);`
], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => holder.stdout.once("data", resolve));

const heldResult = await call("/api/session.delete", { sessionId: HELD });
holder.kill();
check("句柄占用时删除仍然成功", heldResult.status === 200, heldResult.payload);
check("如实报告用的是 copied 兜底", heldResult.payload.methods?.includes("copied") === true, heldResult.payload.methods);
check("被占用的会话目录已消失", (await exists(heldDir)) === false);
check("回收目录里有它的完整副本",
  (await exists(join(heldResult.payload.trash, "--test-project--", HELD, "session.v3.jsonl.zstd"))) === true);

// ── 7. 对账：扫磁盘揪出幽灵分片 ────────────────────────────────────────────
const pruned = await call("/api/session.delete.prune", {});
check("prune 返回 200", pruned.status === 200, pruned.payload);
check("prune 剪掉归档死引用",
  pruned.payload.unarchived === 1 && !archivedBox.value.some((value) => value.includes("deadbeef")), archivedBox.value);
check("prune 从磁盘揪出幽灵分片", pruned.payload.shards === 1, pruned.payload);
check("幽灵分片已移走", (await exists(ghostShard)) === false);
check("prune 没误删邻居分片", (await exists(neighbourShard)) === true);

// ── 7b. 清孤儿子代理：父目录已不在的 subagent 一并收掉，父还活着的不动 ────────
// 对账的 onDisk 名单是进场时拍的一次快照：第一轮只收「快照时父已不在」的，
// 所以 SUB1（父 TARGET 已删）和 ORPHAN（父根本不存在）这轮收走，SUB2（父 SUB1
// 快照时还在）要等第二轮——逐轮向内收敛是设计行为，不是漏删喵。
check("prune 第一轮收掉 2 条孤儿子代理", pruned.payload.orphans === 2, pruned.payload);
check("孤儿释放字节 = SUB1 24 + ORPHAN 18", pruned.payload.orphanBytes === 42, pruned.payload.orphanBytes);
check("第一轮的孤儿目录已消失",
  (await exists(sub1Dir)) === false && (await exists(orphanDir)) === false);
check("第一轮不误删父还在的子代理", (await exists(sub2Dir)) === true);
check("已删干净的孤儿如实记进 skipped（目录早没了只剩记忆）",
  pruned.payload.orphanSkipped?.length === 1 && pruned.payload.orphanSkipped[0] === KEEPSUB.slice(8), pruned.payload.orphanSkipped);

const pruned2 = await call("/api/session.delete.prune", {});
check("prune 第二轮收掉孙代理", pruned2.payload.orphans === 1 && pruned2.payload.orphanBytes === 16, pruned2.payload);
check("孙代理目录也消失了", (await exists(sub2Dir)) === false);

// ── 7c. 回收目录保留期：默认 30 天，过期的清、保留期内的不动 ──────────────────
// 40 天的旧堆在第一轮对账（第 7 节）就该被清掉；测试过程里各次删除新建的堆
// 时间戳都是「现在」，必须原封不动喵。
check("第一轮对账就清掉过期回收堆", pruned.payload.trashRemoved >= 1, pruned.payload);
check("过期的回收堆已消失", (await exists(join(trashBaseDir, `${oldStamp}-ui`))) === false);
check("保留期内的回收堆原封不动",
  pruned2.payload.trashKept >= 1 && (await exists(freshTrash)) === true,
  { kept: pruned2.payload.trashKept, trashRemoved: pruned2.payload.trashRemoved });

// ── 7d. 一键清空回收目录：真销毁，剩下的全收 ──────────────────────────────────
const emptied = await call("/api/session.delete.prune", { emptyTrash: true });
check("一键清空把保留期内的堆也收掉",
  emptied.payload.trashRemoved >= 1 && emptied.payload.trashFreedBytes >= 100, emptied.payload);
check("清空后回收目录没有残留", (await exists(freshTrash)) === false);
check("再按一次如实报 0", (await call("/api/session.delete.prune", { emptyTrash: true })).payload.trashRemoved === 0);

// ── 7e. 自定义保留天数：retentionDays 覆盖默认 30 天 ─────────────────────────
// 重新造一个「40 天前」的堆和几个刚删的堆，用不同保留期各对账一次喵。
const oldTrash2 = join(trashBaseDir, `${oldStamp}-ui2`, "--test-project--", TARGET);
await mkdir(oldTrash2, { recursive: true });
await writeFile(join(oldTrash2, "a.bin"), "x".repeat(64), "utf8");
const freshTrash2 = join(trashBaseDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-ui`, "--test-project--", OTHER);
await mkdir(freshTrash2, { recursive: true });
await writeFile(join(freshTrash2, "a.bin"), "y".repeat(64), "utf8");

const withZero = await call("/api/session.delete.prune", { retentionDays: 0 });
check("retentionDays=0 时连保留期内的堆也一起清",
  withZero.payload.trashRemoved >= 1 && (await exists(freshTrash2)) === false, withZero.payload);

// 再造一个 40 天旧堆：长保留期（3650 天）不该清它，短保留期（7 天）才清喵。
const oldTrash3 = join(trashBaseDir, `${oldStamp}-ui3`, "--test-project--", TARGET);
await mkdir(oldTrash3, { recursive: true });
await writeFile(join(oldTrash3, "b.bin"), "z".repeat(64), "utf8");
const longKeep = await call("/api/session.delete.prune", { retentionDays: 3650 });
check("retentionDays=3650 时 40 天的旧堆也被保留",
  longKeep.payload.trashRemoved === 0 && (await exists(oldTrash3)) === true,
  longKeep.payload);
const shortKeep = await call("/api/session.delete.prune", { retentionDays: 7 });
check("retentionDays=7 时 40 天的旧堆被清", shortKeep.payload.trashRemoved >= 1, shortKeep.payload);
check("旧堆目录已消失", (await exists(oldTrash3)) === false);

// ── 8. 遗留聚合 ───────────────────────────────────────────────────────────
const agg = JSON.parse(await readFile(aggregate, "utf8"));
check("遗留聚合里目标已删", agg.tables.sessions[TARGET] === void 0, Object.keys(agg.tables.sessions));
check("遗留聚合里邻居保留", agg.tables.sessions[OTHER] !== void 0);

// ── 9. append 临界区：不能硬摘，409 挡住且一个文件都不许动 ──────────────────
const busyResult = await call("/api/session.delete", { sessionId: BUSY });
check("正在写入的会话被 409 挡住", busyResult.status === 409 && busyResult.payload.code === "session-busy", busyResult.payload);
check("被挡住时目录原封不动", (await exists(busyDir)) === true);
check("被挡住时没摘工作区归属", workspaceRecord.sessionIds.includes(BUSY), workspaceRecord.sessionIds);
check("被挡住时没摘出 SessionStore", storeCalls.detached.includes(BUSY) === false, storeCalls.detached);

// ── 10. 没有 flush 接口时必须如实警告，不能谎报「刷过了」 ────────────────────
const savedFlush = sessionStore.flush;
delete sessionStore.flush;
const noFlush = await call("/api/session.delete", { sessionId: NOFLUSH });
sessionStore.flush = savedFlush;
check("没有 flush 接口时删除仍成功", noFlush.status === 200, noFlush.payload?.error ?? noFlush.payload?.warnings);
check("如实报告 flush=no-flush-api", noFlush.payload.flush === "no-flush-api", noFlush.payload.flush);
check("如实警告没刷盘", (noFlush.payload.warnings ?? []).some((text) => text.includes("flush")), noFlush.payload.warnings);
check("no-flush 会话照样被摘出 SessionStore", storeCalls.detached.includes(NOFLUSH), storeCalls.detached);
check("no-flush 会话目录已消失", (await exists(noFlushDir)) === false);

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
console.log("临时目录：", root);
if (process.env.KEEP !== "1") await rm(root, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
