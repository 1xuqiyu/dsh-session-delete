# dsh-session-delete

给 DSH Web 侧栏加一个**「会话清理」面板 + 手动删除按钮**，删完**当场生效，不用重启 `dsh web`** 喵。

## 为什么要它

DSH 0.1.5-rc.3 根本没有删会话的能力喵：

* 没有 `session/delete` RPC（`dsh-api-session-controller` 只导出 create / fork / rename / follow / prompt / cancel / search / list / modelCatalog / page / attachment / control / updateQueue / canOpenWorkspacePath / openWorkspacePath + skills/list）；
* 侧栏会话行的 `...` 菜单是**硬编码**的三项（重命名 / 分叉 / 归档），插件塞不进去（`dsh-client-ui-workspace/lib/client.js` 的 `sessionMenuItems`）。

所以唯一的替代方案是在**进程外**改 `~/.dsh/sessions/` 和 `~/.dsh/storages/*.json`（就是 `/del-session` 技能那个 Python 脚本）。但 `dsh-storage-json` 的 single 布局是**内存权威 + 完全不监听文件**（`openSingleUnit` 只在 open 时 `readFile` 一次，全包 grep `fs.watch` / `chokidar` 零命中），运行中的 `dsh web` 看不到外部改动 —— 于是必须重启进程喵。

## 它怎么做到的

插件的 Host 半包**跑在 `dsh web` 进程内部**，所以它改的是活的对象，不是背后的文件喵：

| 动作 | 走的路子 | 效果 |
|------|----------|------|
| 摘工作区归属 | `workspaceRegistry.list()` → `entity.detachSession(id)` | 内存 + `workspace.json` 一起更新 |
| 清归档引用 | `registry.requireState()` → `registry.setState(...)` | 同上（0.1.5-rc.3 没有反归档 API，`setState` 是同一个类的写入路径） |
| 删投影分片 | `storageDomain.get("session_projcache").table("sessions").delete(key)` | 先落盘再改内存，并 emit `domain/changed` |
| 删会话目录 | 先 `rename` 进 `~/.dsh/.sessions-trash/<时间戳>-ui/`；被打开句柄挡成 `EPERM` 时自动退化成「复制 + `rm`」 | **移动不是销毁**，可反悔 |

`domain/changed` 会被 `WorkspaceFeed` 接住并顺着 `workspace/follow` 流推给浏览器（`dsh-api-workspace-controller/lib/index.js` L48-53、L86-131），而会话列表本身是**每次读盘**的（`sessionPersistence.list()` → `listArtifacts()` → `readdir`），所以浏览器再按一次 F5 就是干净的 —— **不需要重启 `dsh web`** 喵。

## 装 / 卸

```powershell
# 装（link: 方式，和主人的皮肤插件一样）
cd C:\Users\x1551\.dsh\profiles\web
dsh plugin --profile web add "link:D:/gongzuo/dsh-plugins/dsh-session-delete"

# 卸载
dsh plugin --profile web remove dsh-session-delete
```

装完**必须重启一次 `dsh web`**（loader 条目只在启动时读），之后删会话就再也不用重启了喵。

## 路由

三条，全部挂在 `/api/` 下，因此自动继承 Connection 的 loopback Host/Origin fence + browser-session cookie 认证（不用像 qoder 那样自己造轮子）：

* `GET  /api/session.delete.list` —— 列出磁盘上所有会话（含侧栏故意隐藏的 `origin: subagent` 记录），带标题 / 回合 / 大小 / 归档 / live / running / current 标记
* `POST /api/session.delete` —— body `{"sessionId": "session-...", "currentSessionId": "session-...", "cascade": true}`，删一条（`currentSessionId` 由浏览器上报，因为 `DSH_SESSION_ID` 只注入子进程、主进程里读不到）。**`cascade: true`（面板默认勾选）时先按 `parentSession` 收集整棵后代链（含孙代理），父删完顺手把还在磁盘上的子代理一起搬进同一个回收目录**；正在跑 / 是当前会话的子代理只跳过、不失败，如实记进 `skippedChildren`
* `POST /api/session.delete.prune` —— 全量对账，把目录已不存在的归档死引用 / 工作区死归属 / 幽灵分片一次扫干净；顺带**清孤儿子代理**：`origin: "subagent"` 且 `parentSession` 已不在磁盘上的记录一并收掉，父还活着的一律不动。进场先拍一次 onDisk 快照，所以孤儿是**逐轮向内收敛**的（第一轮收走快照时父已不在的，下一轮才轮到孙代理），多按一次「对账 + 清孤儿」就干净了

## 安全栏

* **当前会话永不删**：`DSH_SESSION_ID`（实测只注入子进程）+ 浏览器上报的 `currentSessionId`，任一命中就回 409 `current-session`；面板的标签与禁用态用的是同一份判据，不会出现「点得下去、服务端才拒」；
* **live 会话不拒删**：先 `store.flush(session)` 刷盘 → `store.detachEntered(entry)` 把它从 SessionStore 摘出去 → 然后才动文件。不刷盘的话写句柄会把文件又写回来；不摘的话 `session/list` 会把 live 会话重新列出来 —— 这两条都是「点了没反应 / 删了还在」的成因；
* **正卡在 append / announce 临界区时回 409 `session-busy`**：此时只置 `entry.detachRequested` 让 store 自己收尾，绝不硬摘（会绕开 store 的重入保护），文件一个字节都不动；
* **真正在跑的会话拒删**（`ctx.agents.get(id)?.status === "running"`），面板按钮同步禁用；
* **id 必须是 `^[A-Za-z0-9_-]{8,}$`**，挡掉路径穿越；
* 只碰 `~/.dsh/sessions/` 下目录名等于目标 id 的那一个目录；
* 顺序是「先摘归属/归档（可逆）→ 再动文件」，中途失败不会留下幽灵行；
* 反悔：把 `~/.dsh/.sessions-trash/<时间戳>-ui/` 里的目录搬回 `~/.dsh/sessions/<工作区键>/` 即可。

## 测试

```powershell
node D:\gongzuo\dsh-plugins\dsh-session-delete\tests\offline.mjs
```

在临时 `DSH_HOME` 里造假会话 + 分片 + 遗留聚合，用 stub ctx 直接调注册进 Connection 的路由，**61 项断言**覆盖：路由注册、列表（含子代理标记与 `parent` 指针）、拒删自己、拒路径穿越、404、删除后的磁盘效果（邻居不误删、进回收目录）、内存效果（归属/归档/分片同步）、遗留聚合、对账路由，外加 2026-09-28 真机踩到的五个坑 —— 句柄占用时走 `copied` 兜底、live 会话先刷盘再摘、当前会话只能靠上报、append 临界区回 409 且不动文件、没有 `flush` 接口时如实警告；以及本轮新增的级联与孤儿覆盖 —— 不带 `cascade` 时子代理原封不动、带 `cascade` 时连子代理一起收（响应如实报 `children`/`skippedChildren` 与合并字节数）、对账逐轮收敛清孤儿且不误删父还活着的。不碰真实数据喵。
