/**
 * dsh-session-delete —— Host 半包。
 *
 * 为什么要这个插件：DSH 0.1.5-rc.3 没有 deleteSession RPC，侧栏会话行的菜单
 * （重命名 / 分叉 / 归档）也是硬编码的，所以官方界面里根本没有「删除」这一项。
 * 唯一的替代方案是在进程外改 `~/.dsh/storages/*.json` 和会话目录，但
 * `dsh-storage-json` 的 single 布局是「内存权威 + 不监听文件」，运行中的
 * `dsh web` 看不到外部改动，只能重启进程。
 *
 * 这个插件把删除动作搬进 `dsh web` 进程内部：走活的服务对象改状态，内存和磁盘
 * 一起更新，并且 `domain/changed` 会顺着 workspace 的 follow 流推给浏览器，
 * 所以删完侧栏当场就干净了，不需要重启喵。
 *
 * ── 两个 Windows 专属的坑（2026-09-28 实测，第一版就栽在这） ──────────────
 *
 * 1. **给「正在被打开的文件所在的那个目录」改名会 EPERM**。实测：句柄开着时
 *    unlink 单个文件成功、rename 单个文件成功、递归 rm 整棵目录成功，唯独
 *    `rename(dir, ...)` 报 EPERM。所以删除**不能只靠改名**，必须带
 *    「复制到回收目录 → 再 rm 原目录」的兜底。
 * 2. **已加载（live）的会话不能一刀切拒删**。主人刚看过的那几个会话在
 *    SessionStore 里还是 live 的，硬拦就只能得到「点了没反应」。正确做法是
 *    把它从 SessionStore 里 detach 掉，再删磁盘。
 *
 * 安全模型：
 *   * 删除 = 移动/复制到 `~/.dsh/.sessions-trash/<UTC 时间戳>-ui/` 再清原目录，
 *     反悔就把回收目录里的东西搬回去。
 *   * 当前正在跑的会话（`DSH_SESSION_ID`）永不删除。
 *   * 只碰 `~/.dsh/sessions/` 下面、目录名等于目标 id 的那一个目录。
 */
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const name = "dsh-session-delete";
const inject = ["connection", "sessionPersistence", "workspaceRegistry", "storageDomain"];

const LIST_PATH = "/api/session.delete.list";
const DELETE_PATH = "/api/session.delete";
const PRUNE_PATH = "/api/session.delete.prune";

/** 会话 id 的合法形状：uuid 段，绝不含路径分隔符（挡掉路径穿越）。 */
const ID_PATTERN = /^[A-Za-z0-9_-]{8,}$/;
/** 一个必然不存在于任何工作区归属里的 id，用来触发一次剪枝扫描。 */
const SWEEP_ID = "session-00000000-0000-4000-8000-000000000000";

function home() {
  const fromEnv = process.env.DSH_HOME;
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : join(homedir(), ".dsh");
}

/** 磁盘目录名带 `session-` 前缀，id 可能带也可能不带；统一按裸 id 比对。 */
function bare(value) {
  const text = String(value ?? "");
  return text.startsWith("session-") ? text.slice("session-".length) : text;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function reason(error) {
  return String(error?.message ?? error);
}

/** 改名在 Windows 上会被「打开着的句柄」挡住，这几个码都当「需要走 rm 兜底」看。 */
const RENAME_BLOCKED = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EEXIST"]);

/**
 * 把一棵目录搬进回收目录。
 *
 * 先试改名（同盘、瞬间完成、最省 I/O）；被句柄挡住就退化成
 * 「整棵复制过去 → 再 rm 原目录」——实测 rm 不受句柄影响喵。
 *
 * @returns 搬运方式："renamed" | "copied"
 */
async function moveTree(source, target) {
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(source, target);
    return "renamed";
  } catch (error) {
    if (!RENAME_BLOCKED.has(error?.code)) throw error;
  }
  await cp(source, target, { recursive: true, force: true });
  await rm(source, { recursive: true, force: true });
  return "copied";
}

async function sizeOfTree(path) {
  let total = 0;
  const queue = [path];
  while (queue.length > 0) {
    const current = queue.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(child);
        continue;
      }
      try {
        total += (await stat(child)).size;
      } catch {
        /* 读不到大小的文件不计入，不影响删除 */
      }
    }
  }
  return total;
}

/** 磁盘上所有会话目录：[{ id, project, folder, path }]。 */
async function scanSessionDirs(root) {
  const out = [];
  let projects;
  try {
    projects = await readdir(join(root, "sessions"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, "sessions", project.name);
    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      out.push({
        id: bare(entry.name),
        project: project.name,
        folder: entry.name,
        path: join(projectDir, entry.name)
      });
    }
  }
  return out;
}

/** 投影缓存里的分片键，两种命名都试（历史数据两种都有）。 */
function shardKeys(id) {
  return [`session-${id}`, id];
}

function shardFile(root, key) {
  return join(root, "storages", "session_projcache", "sessions", `${key}.json`);
}

/**
 * 把会话从本进程的 SessionStore 里摘掉。
 *
 * 不摘的话：`session/list` 会把 live 会话从内存里重新列出来（它先并 persisted
 * 再并 live），于是侧栏那一行**删完还在**，看起来就是「点了没用」。
 *
 * `liveEntryFor` / `detachEntered` 是 SessionStore 的实例方法（TS 标注 private，
 * 运行时可调）；拿不到就跳过，让磁盘删除照常进行，只是那一行要等重启才消失。
 *
 * @returns "detached" | "deferred" | "not-live" | "no-store" | "cannot-detach"
 */
function detachLive(ctx, id) {
  const store = ctx.get?.("sessions");
  if (store === void 0) return "no-store";
  const session = store.get?.(`session-${id}`) ?? store.get?.(id);
  if (session === void 0) return "not-live";
  try {
    const entry = store.liveEntryFor?.(session);
    if (entry === void 0 || typeof store.detachEntered !== "function") return "cannot-detach";
    // 正在发布事件（appending）/ 正在宣告创建（announcing）时直接摘，会绕开 store
    // 自己的重入保护。官方 disposer 在临界区里也只是置 `detachRequested`，由
    // append/announce 的收尾自己调 detach()——这里照抄同一条路径喵。
    if (entry.appending === true || entry.announcing === true) {
      entry.detachRequested = true;
      return "deferred";
    }
    store.detachEntered(entry);
    return "detached";
  } catch {
    return "cannot-detach";
  }
}

/** 这个会话现在是不是真的在跑（有 agent 处于 running）。 */
function isRunning(ctx, id) {
  const agents = ctx.get?.("agents");
  return agents?.get?.(`session-${id}`)?.status === "running" || agents?.get?.(id)?.status === "running";
}

/**
 * 在摘掉 live 会话之前，先把它的缓冲事件刷到磁盘。
 *
 * `store.flush(session)` 是官方的持久化屏障（走 `session/flush` 监听器）。
 * 不刷的话：写句柄里还压着没落盘的事件，我们把目录删掉之后，某次 flush 又会把
 * 文件重新写出来，看起来就像「删了又自己长回来」喵。
 *
 * @returns "flushed" | "not-live" | "no-flush-api" | "failed"
 */
async function flushLive(ctx, id) {
  const store = ctx.get?.("sessions");
  const session = store?.get?.(`session-${id}`) ?? store?.get?.(id);
  if (session === void 0) return "not-live";
  // 不能写成 `await store.flush?.(session)`：接口不存在时那行会静默成功，
  // 于是「没刷盘」被谎报成「刷过了」喵。
  if (typeof store.flush !== "function") return "no-flush-api";
  try {
    await store.flush(session);
    return "flushed";
  } catch {
    return "failed";
  }
}

/**
 * 把会话从所有工作区的归属里摘掉，并顺手做一次剪枝扫描。
 *
 * `detachSession` 的写入路径会按 `sessionPath(id) === workspace.path`
 * 重算归属，所以哪怕传入一个根本不存在的 id（SWEEP_ID），也会把该工作区里那些
 * 「目录早没了、id 还留着」的死引用一并 durably 剪掉——这正是侧栏那一排点不开的
 * 幽灵行的成因。
 */
async function detachFromWorkspaces(ctx, id) {
  const registry = ctx.workspaceRegistry;
  let detached = 0;
  for (const workspace of registry.list()) {
    const owned = workspace.sessionIds.filter((accounted) => bare(accounted) === id);
    for (const accounted of owned) {
      await workspace.detachSession(accounted);
      detached += 1;
    }
    await workspace.detachSession(SWEEP_ID);
  }
  return detached;
}

/**
 * 从注册表全局的归档集合里去掉一个 id。
 *
 * 0.1.5-rc.3 只有 `archiveSession`，没有反归档的公开方法；`setState` 是同一个
 * 类的写入路径（TS 层面 private，运行时可调），走它才能同时更新介质和注册表
 * 内存里的 state——直接改 workspace.json 会让两边分叉。拿不到就走介质兜底，
 * 并在响应里说明。
 */
async function unarchive(ctx, id) {
  const registry = ctx.workspaceRegistry;
  const archived = [...(registry.archivedSessionIds ?? [])];
  if (!archived.some((value) => bare(value) === id)) return { removed: 0, durable: true };
  const keep = archived.filter((value) => bare(value) !== id);
  if (typeof registry.setState === "function" && typeof registry.requireState === "function") {
    const state = registry.requireState();
    await registry.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter((value) => bare(value) !== id) });
    return { removed: archived.length - keep.length, durable: true };
  }
  const domain = ctx.storageDomain?.get?.("workspace");
  if (domain?.global !== undefined) {
    const state = domain.global.get();
    await domain.global.set({ ...state, archivedSessionIds: keep });
    return { removed: archived.length - keep.length, durable: false };
  }
  return { removed: 0, durable: false };
}

/** 删掉投影缓存记录：先备份进回收目录，再走 domain 的 delete（内存+介质一起清）。 */
async function dropProjection(ctx, root, id, trash) {
  const domain = ctx.storageDomain?.get?.("session_projcache");
  const table = domain?.table?.("sessions");
  let removed = 0;
  const keep = join(trash, "projcache-shards");
  for (const key of shardKeys(id)) {
    const file = shardFile(root, key);
    const inMemory = table?.get?.(key) !== undefined;
    if (!inMemory) {
      // 内存里没有但磁盘上还有：直接搬走，避免留下幽灵分片。
      try {
        await mkdir(keep, { recursive: true });
        await rename(file, join(keep, `${key}.json`));
        removed += 1;
      } catch {
        /* 文件本来就不存在 */
      }
      continue;
    }
    await mkdir(keep, { recursive: true });
    try {
      await cp(file, join(keep, `${key}.json`), { force: true });
    } catch {
      /* 复制失败也继续删，回收副本只是保险 */
    }
    await table.delete(key);
    removed += 1;
  }
  return removed;
}

/** 顺手把没人读的遗留聚合文件也剪干净，免得以后误判。 */
async function pruneLegacyAggregate(root, ids, trash) {
  const file = join(root, "storages", "session_projcache.json");
  let doc;
  try {
    doc = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return 0;
  }
  const table = doc?.tables?.sessions;
  if (table === null || typeof table !== "object") return 0;
  let removed = 0;
  for (const key of Object.keys(table)) {
    if (ids.has(bare(key))) {
      delete table[key];
      removed += 1;
    }
  }
  if (removed === 0) return 0;
  try {
    await mkdir(join(trash, "json-backups"), { recursive: true });
    await cp(file, join(trash, "json-backups", `${basename(file)}-${stamp()}`), { force: true });
  } catch {
    /* 备份失败不挡正事 */
  }
  const temp = `${file}.dsh-session-delete.tmp`;
  await writeFile(temp, JSON.stringify(doc, null, 2), "utf8");
  await rename(temp, file);
  return removed;
}

async function handleList(ctx) {
  const root = home();
  const registry = ctx.workspaceRegistry;
  const archived = new Set((registry.archivedSessionIds ?? []).map(bare));
  const owned = new Map();
  for (const workspace of registry.list()) {
    for (const id of workspace.sessionIds) owned.set(bare(id), workspace.path);
  }
  const cache = ctx.storageDomain?.get?.("session_projcache")?.table?.("sessions");
  const liveStore = ctx.get?.("sessions");
  const agents = ctx.get?.("agents");
  const current = bare(process.env.DSH_SESSION_ID);
  const snapshots = await ctx.sessionPersistence.list();
  const items = [];
  for (const snapshot of snapshots) {
    const header = snapshot.header ?? {};
    const id = bare(header.id);
    if (id.length === 0) continue;
    const shard = cache?.get?.(`session-${id}`) ?? cache?.get?.(id);
    const rows = shard?.rows ?? {};
    const title = rows.title?.val;
    const live = liveStore?.get?.(header.id) !== void 0 || liveStore?.get?.(`session-${id}`) !== void 0;
    items.push({
      id: header.id,
      short: id.slice(0, 8),
      title: typeof title === "string" ? title : "",
      turns: rows.sessionStats?.val?.turns ?? null,
      createdAt: header.createdAt ?? null,
      cwd: header.cwd ?? null,
      origin: header.origin ?? "user",
      parent: header.parentSession === void 0 ? null : bare(header.parentSession),
      sizeBytes: snapshot.sizeBytes ?? null,
      workspace: owned.get(id) ?? null,
      archived: archived.has(id),
      live,
      running: isRunning(ctx, id),
      current: id === current
    });
  }
  items.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  return json({ home: root, sessions: items });
}

/**
 * 收集一条会话名下的所有子代理（含孙代理）。
 *
 * 子代理关系只躺在各自会话 header 的 `parentSession` 里（不是从属的目录结构），
 * 所以得问一次 `sessionPersistence.list()`——它每次读盘，拿到的是磁盘上真实存在的
 * header。只收 `origin === "subagent"` 的，避免误伤别的亲缘字段喵。
 *
 * @returns 后代裸 id（不含 `session-` 前缀），父在前、子在后
 */
async function collectDescendants(ctx, id) {
  let snapshots;
  try {
    snapshots = await ctx.sessionPersistence.list();
  } catch {
    return [];
  }
  const childrenOf = new Map();
  for (const snapshot of snapshots) {
    const header = snapshot.header ?? {};
    if (header.origin !== "subagent") continue;
    const parent = bare(header.parentSession);
    const child = bare(header.id);
    if (parent.length === 0 || child.length === 0 || parent === child) continue;
    const bucket = childrenOf.get(parent);
    if (bucket === void 0) childrenOf.set(parent, [child]);
    else bucket.push(child);
  }
  const out = [];
  const seen = new Set([id]);
  const queue = [...(childrenOf.get(id) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    queue.push(...(childrenOf.get(current) ?? []));
  }
  return out;
}

/**
 * 把一条会话从「内存 + 工作区归属 + 归档集合 + 磁盘 + 投影分片」里彻底摘走。
 *
 * 步骤和顺序只有这一份实现：级联删子代理、对账清孤儿都走它。顺序很重要——
 * 先把 live 会话的缓冲事件刷盘、再摘出 SessionStore，最后才碰文件喵：
 *   * 不刷盘 → 写句柄里的缓冲事件会在删除后又把文件写回来（「删了自己长回来」）；
 *   * 不摘   → session/list 会把 live 会话重新列出来，侧栏那一行删完还在。
 *
 * @returns 成功时带统计字段；跳过时带 `skipped`（`busy` / `not-found`）
 */
async function removeSession(ctx, root, id, trash) {
  const warnings = [];
  const dirs = (await scanSessionDirs(root)).filter((entry) => entry.id === id);
  if (dirs.length === 0) return { id, skipped: "not-found", warnings };

  const flush = await flushLive(ctx, id);
  let live = detachLive(ctx, id);
  if (live === "deferred") {
    // 多半只是撞上了毫秒级的 append 临界区：放一拍让 store 自己收尾，再来一次。
    await new Promise((resolve) => setTimeout(resolve, 200));
    live = detachLive(ctx, id);
    if (live === "deferred") return { id, skipped: "busy", warnings };
  }
  if (live === "cannot-detach") {
    warnings.push("这个会话在本进程里还加载着，没摘干净的话侧栏那条可能要刷新页面后才消失");
  }
  if (flush === "no-flush-api") {
    warnings.push("这个 DSH 版本没有 session flush 接口，live 会话的缓冲事件没能刷盘，删除后可能有残留写入");
  }
  if (flush === "failed") {
    warnings.push("这个会话的缓冲事件没能刷盘，删除后可能有残留写入");
  }

  // 再摘归属/归档（可逆），最后才动文件，避免中途失败留下幽灵行。
  const detached = await detachFromWorkspaces(ctx, id);
  const archive = await unarchive(ctx, id);
  if (archive.durable === false) {
    warnings.push("归档集合没能通过活服务更新，下次重启前「归档会话」那一栏可能还留着这条");
  }

  let freedBytes = 0;
  const moved = [];
  const methods = [];
  for (const entry of dirs) {
    const bytes = await sizeOfTree(entry.path);
    const target = join(trash, entry.project, entry.folder);
    methods.push(await moveTree(entry.path, target));
    freedBytes += bytes;
    moved.push(target);
  }

  const shards = await dropProjection(ctx, root, id, trash);
  const legacy = await pruneLegacyAggregate(root, new Set([id]), trash);
  return {
    id,
    freedBytes,
    moved,
    trash,
    detached,
    unarchived: archive.removed,
    shards,
    legacy,
    live,
    flush,
    // 句柄挡着改名时走的是「复制+rm」，结果一样，但值得让主人看得见喵
    methods: [...new Set(methods)],
    warnings
  };
}

async function handleDelete(ctx, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体必须是 JSON：{\"sessionId\": \"...\"}" }, 400);
  }
  const id = bare(typeof body?.sessionId === "string" ? body.sessionId.trim() : "");
  if (!ID_PATTERN.test(id)) return json({ error: "sessionId 形状不对" }, 400);

  // 当前会话：主进程环境里**没有** DSH_SESSION_ID（那变量只注入 dsh 拉起的子进程），
  // 所以除了环境变量，还要认浏览器上报的那个 id，否则这道保护形同虚设喵。
  const reportedCurrent = bare(typeof body?.currentSessionId === "string" ? body.currentSessionId : "");
  const currentCandidates = new Set([bare(process.env.DSH_SESSION_ID), reportedCurrent].filter((value) => value.length > 0));
  if (currentCandidates.has(id)) {
    return json({ error: "这是主人正在看的会话，不能删自己喵", code: "current-session" }, 409);
  }
  if (isRunning(ctx, id)) {
    return json({ error: "这个会话正在跑（有任务在生成），先等它停下来或者取消，再删喵", code: "session-running" }, 409);
  }

  const root = home();
  const dirs = (await scanSessionDirs(root)).filter((entry) => entry.id === id);
  if (dirs.length === 0) return json({ error: `磁盘上找不到会话 ${id}`, code: "not-found" }, 404);

  const trash = join(root, ".sessions-trash", `${stamp()}-ui`);
  // 级联名单要在删父会话**之前**问：父目录一没，它的孩子就只剩孤儿身份了喵。
  const descendantIds = body?.cascade === true ? await collectDescendants(ctx, id) : [];

  const main = await removeSession(ctx, root, id, trash);
  if (main.skipped === "busy") {
    return json({ error: "这个会话正在写入事件，等它这一拍过去再删喵", code: "session-busy" }, 409);
  }
  if (main.skipped === "not-found") return json({ error: `磁盘上找不到会话 ${id}`, code: "not-found" }, 404);

  // 级联：子代理是独立目录，删父会话不会自动带走它们。正在跑 / 是当前会话的只跳过、不失败喵。
  const children = [];
  const skippedChildren = [];
  for (const childId of descendantIds) {
    if (currentCandidates.has(childId)) {
      skippedChildren.push({ id: childId, reason: "current-session" });
      continue;
    }
    if (isRunning(ctx, childId)) {
      skippedChildren.push({ id: childId, reason: "session-running" });
      continue;
    }
    const result = await removeSession(ctx, root, childId, trash);
    if (result.skipped !== void 0) {
      skippedChildren.push({ id: childId, reason: result.skipped });
      continue;
    }
    children.push(result);
  }

  const childBytes = children.reduce((sum, item) => sum + item.freedBytes, 0);
  return json({
    ok: true,
    sessionId: `session-${id}`,
    freedBytes: main.freedBytes + childBytes,
    moved: main.moved,
    trash,
    detached: main.detached,
    unarchived: main.unarchived,
    shards: main.shards,
    legacy: main.legacy,
    live: main.live,
    flush: main.flush,
    methods: main.methods,
    children: children.map((item) => ({
      id: item.id,
      freedBytes: item.freedBytes,
      methods: item.methods,
      shards: item.shards,
      live: item.live
    })),
    skippedChildren,
    warnings: [...new Set([...main.warnings, ...children.flatMap((item) => item.warnings)])]
  });
}

/** 全量对账：把目录已经不存在的死引用（归属 / 归档 / 幽灵分片）一次扫干净。 */
async function handlePrune(ctx) {
  const root = home();
  const onDisk = new Set((await scanSessionDirs(root)).map((entry) => entry.id));
  onDisk.add(bare(process.env.DSH_SESSION_ID));
  const registry = ctx.workspaceRegistry;

  const archived = [...(registry.archivedSessionIds ?? [])];
  const deadArchived = archived.filter((value) => !onDisk.has(bare(value)));
  if (deadArchived.length > 0) {
    if (typeof registry.setState === "function" && typeof registry.requireState === "function") {
      const state = registry.requireState();
      await registry.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((value) => onDisk.has(bare(value)))
      });
    } else {
      const domain = ctx.storageDomain?.get?.("workspace");
      if (domain?.global !== undefined) {
        const state = domain.global.get();
        await domain.global.set({ ...state, archivedSessionIds: state.archivedSessionIds.filter((value) => onDisk.has(bare(value))) });
      }
    }
  }

  // 每个工作区各跑一次剪枝（detachSession 的写入路径会重算归属）。
  for (const workspace of registry.list()) await workspace.detachSession(SWEEP_ID);

  const trashBase = join(root, ".sessions-trash", `${stamp()}-ui`);

  // 孤儿子代理：父会话目录早就不在磁盘上了，这条记录已经没有主人，顺手也收掉喵。
  // 父还在磁盘上的子代理**一律不动**（主人可能就想留着它们喵）。
  let orphans = 0;
  let orphanBytes = 0;
  const orphanSkipped = [];
  let snapshots = [];
  try {
    snapshots = await ctx.sessionPersistence.list();
  } catch {
    snapshots = [];
  }
  for (const snapshot of snapshots) {
    const header = snapshot.header ?? {};
    if (header.origin !== "subagent") continue;
    const childId = bare(header.id);
    const parentId = bare(header.parentSession);
    if (childId.length === 0 || parentId.length === 0) continue;
    if (onDisk.has(parentId)) continue;
    if (isRunning(ctx, childId)) {
      orphanSkipped.push(childId);
      continue;
    }
    const result = await removeSession(ctx, root, childId, trashBase);
    if (result.skipped !== void 0) {
      orphanSkipped.push(childId);
      continue;
    }
    orphans += 1;
    orphanBytes += result.freedBytes;
  }

  let shards = 0;
  const cache = ctx.storageDomain?.get?.("session_projcache")?.table?.("sessions");
  const trash = join(trashBase, "projcache-ghosts");
  // 内存 keys 之外再扫一遍磁盘：外部工具往分片目录塞过东西时，内存并不知道，
  // 只靠 keys() 会漏掉这类真幽灵。
  const suspects = new Set([...(cache?.keys?.() ?? [])]);
  try {
    for (const entry of await readdir(join(root, "storages", "session_projcache", "sessions"))) {
      if (entry.endsWith(".json")) suspects.add(entry.slice(0, -".json".length));
    }
  } catch {
    /* 目录不存在就是没有 */
  }
  for (const key of suspects) {
    if (onDisk.has(bare(key))) continue;
    shards += await dropProjection(ctx, root, bare(key), trash);
  }

  return json({
    ok: true,
    unarchived: deadArchived.length,
    shards,
    scanned: onDisk.size,
    orphans,
    orphanBytes,
    orphanSkipped
  });
}

function apply(ctx) {
  const connection = ctx.connection ?? ctx.get?.("connection");
  if (connection?.fetch?.register === undefined) {
    ctx.logger?.warn?.("[dsh-session-delete] 拿不到 connection.fetch，插件不启用喵");
    return;
  }
  connection.fetch.register({
    path: LIST_PATH,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async () => {
      try {
        return await handleList(ctx);
      } catch (error) {
        return json({ error: reason(error) }, 500);
      }
    }
  });
  connection.fetch.register({
    path: DELETE_PATH,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      try {
        return await handleDelete(ctx, request);
      } catch (error) {
        return json({ error: reason(error) }, 500);
      }
    }
  });
  connection.fetch.register({
    path: PRUNE_PATH,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async () => {
      try {
        return await handlePrune(ctx);
      } catch (error) {
        return json({ error: reason(error) }, 500);
      }
    }
  });
  ctx.logger?.info?.("[dsh-session-delete] 已挂载 /api/session.delete* 三条路由喵");
}

export { apply, inject, name };
