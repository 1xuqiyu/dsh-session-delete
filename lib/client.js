window.__ModuleLoader__.load({
  id: "dsh-session-delete",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const runtime = require("react/jsx-runtime");
    const h = runtime.jsx;
    const hs = runtime.jsxs;

    const name = "dsh-session-delete";
    const inject = ["slots", "sessions"];

    const PANEL_ID = "session-delete-panel";
    const LIST_PATH = "/api/session.delete.list";
    const DELETE_PATH = "/api/session.delete";
    const PRUNE_PATH = "/api/session.delete.prune";
    const CSS_ID = "dsh-session-delete-css";

    const STYLE = `
.dshsd-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#e8e8ee)}
.dshsd-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:20px 24px 14px;border-bottom:1px solid rgba(255,255,255,.08)}
.dshsd-title{font-size:17px;font-weight:600;letter-spacing:.2px}
.dshsd-sub{margin-top:4px;font-size:12px;opacity:.62;line-height:1.5;max-width:62ch}
.dshsd-actions{display:flex;gap:8px;flex:none;align-items:center}
.dshsd-check{display:flex;align-items:center;gap:6px;font-size:12.5px;opacity:.85;cursor:pointer;user-select:none}
.dshsd-check input{cursor:pointer;margin:0}
.dshsd-btn{font:inherit;font-size:12.5px;padding:6px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:inherit;cursor:pointer}
.dshsd-btn:hover:not(:disabled){background:rgba(255,255,255,.12)}
.dshsd-btn:disabled{opacity:.45;cursor:not-allowed}
.dshsd-btn-danger{border-color:rgba(255,107,107,.5);background:rgba(255,107,107,.12);color:#ff9c9c}
.dshsd-btn-danger:hover:not(:disabled){background:rgba(255,107,107,.24)}
.dshsd-btn-armed{border-color:#ff6b6b;background:#ff6b6b;color:#fff}
.dshsd-list{flex:1;min-height:0;overflow:auto;padding:8px 14px 24px}
.dshsd-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 12px;border-radius:10px}
.dshsd-row:hover{background:rgba(255,255,255,.05)}
.dshsd-name{font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshsd-meta{margin-top:3px;font-size:11.5px;opacity:.58;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.dshsd-tag{font-size:10.5px;line-height:16px;padding:0 6px;border-radius:5px;background:rgba(255,255,255,.1);opacity:.9}
.dshsd-tag-warn{background:rgba(255,180,60,.18);color:#ffc861}
.dshsd-tag-danger{background:rgba(255,107,107,.18);color:#ff9c9c}
.dshsd-status{padding:10px 24px;font-size:12px;line-height:1.6;white-space:pre-wrap;border-top:1px solid rgba(255,255,255,.08);opacity:.85}
.dshsd-status[data-kind="error"]{color:#ff9c9c}
.dshsd-status[data-kind="ok"]{color:#8fe3a8}
.dshsd-empty{padding:40px 24px;text-align:center;font-size:13px;opacity:.55}
`;

    function ensureStyle() {
      if (typeof document === "undefined" || document.getElementById(CSS_ID) !== null) return;
      const tag = document.createElement("style");
      tag.id = CSS_ID;
      tag.textContent = STYLE;
      document.head.appendChild(tag);
    }

    function formatBytes(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "未知大小";
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
      return `${(value / 1024 / 1024).toFixed(1)} MB`;
    }

    function formatDate(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "";
      const date = new Date(value);
      const pad = (input) => String(input).padStart(2, "0");
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    async function request(path, body) {
      const response = await fetch(path, body === void 0 ? { method: "GET" } : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      return payload ?? {};
    }

    /** 侧栏 sidebar.panellist 那一行的图标，只拿得到 { size, active }。 */
    function PanelGlyph(props) {
      const size = typeof props.size === "number" ? props.size : 16;
      return h("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 1.4,
        "stroke-linecap": "round",
        "aria-hidden": "true",
        children: [
          h("path", { d: "M2.5 4.2h11", key: "lid" }),
          h("path", { d: "M6.4 4.2V2.6h3.2v1.6", key: "handle" }),
          h("path", { d: "M3.7 4.2l.7 8.3a1.2 1.2 0 0 0 1.2 1.1h4.8a1.2 1.2 0 0 0 1.2-1.1l.7-8.3", key: "can" }),
          h("path", { d: "M6.6 6.8v5M9.4 6.8v5", key: "ribs" })
        ]
      });
    }

    /**
     * 当前会话也要一起送出去。
     *
     * 服务端是 `dsh web` 主进程，而 `DSH_SESSION_ID` 只注入 `dsh` 拉起的子进程，
     * 主进程环境里根本没有它——所以「别删主人正在用的这条」这件事，必须由浏览器
     * 这边告诉它喵。
     */
    /** 磁盘目录名带 `session-` 前缀、store 里的 current 可能带也可能不带，统一按裸 id 比。 */
    function bareId(value) {
      const text = typeof value === "string" ? value : "";
      return text.startsWith("session-") ? text.slice("session-".length) : text;
    }

    function currentSessionId(sessions) {
      try {
        const state = sessions?.list?.getSnapshot?.() ?? sessions?.getSnapshot?.();
        const value = state?.current;
        return typeof value === "string" && value.length > 0 ? value : void 0;
      } catch {
        return void 0;
      }
    }

    function SessionDeletePanel(props) {
      const sessions = props.sessions;
      // 服务端主进程读不到 DSH_SESSION_ID，所以「哪条是当前会话」只能这边算。
      // 面板里的标签 / 禁用态也必须用同一份判据，否则按钮点得下去、服务端才拒。
      const currentId = bareId(currentSessionId(sessions));
      const isSelf = (row) => currentId.length > 0 && bareId(row.id) === currentId;
      const [rows, setRows] = react.useState(null);
      const [busy, setBusy] = react.useState(null);
      const [armed, setArmed] = react.useState(null);
      const [status, setStatus] = react.useState(null);
      // 默认勾上：主人的心智是「删了父会话，它名下的子代理不该还留着」喵。
      const [cascade, setCascade] = react.useState(true);
      // 回收目录保留天数：对账时自动清掉超过这个天数的旧堆；0 = 不留，对账即全清。
      const [retentionDays, setRetentionDays] = react.useState("30");
      /** 把输入框的自由文本折成合法天数；不合法就退回默认 30，绝不下发脏值喵。 */
      const retentionMs = () => {
        const days = Math.floor(Number(retentionDays));
        if (!Number.isFinite(days) || days < 0 || days > 3650) return 30 * 24 * 60 * 60 * 1000;
        return days * 24 * 60 * 60 * 1000;
      };
      const list = rows ?? [];
      /** 子代理关系就在各行 header 的 `parent` 里，面板已经拿到了，直接算就行喵。 */
      const childrenOf = (row) => list.filter((other) => bareId(other.parent ?? "") === bareId(row.id));

      const load = react.useCallback(async () => {
        try {
          const payload = await request(LIST_PATH);
          setRows(payload.sessions ?? []);
        } catch (error) {
          setStatus({ kind: "error", text: `读取会话列表失败：${error.message}` });
        }
      }, []);

      react.useEffect(() => {
        ensureStyle();
        void load();
      }, [load]);

      // 图标按钮的二次确认：第一次点变红，3 秒内再点才真删。
      react.useEffect(() => {
        if (armed === null) return;
        const timer = window.setTimeout(() => setArmed(null), 3000);
        return () => window.clearTimeout(timer);
      }, [armed]);

      async function remove(row) {
        if (isSelf(row)) {
          setStatus({ kind: "error", text: "这是主人正在看的会话，不能删自己喵。" });
          return;
        }
        setBusy(row.id);
        setArmed(null);
        try {
          const result = await request(DELETE_PATH, {
            sessionId: row.id,
            currentSessionId: currentSessionId(sessions),
            cascade
          });
          const notes = [];
          if (result.live === "detached") notes.push("已从内存里摘掉");
          if (result.methods?.includes("copied")) notes.push("句柄占用中，已改用复制+清理");
          const kids = result.children ?? [];
          if (kids.length > 0) notes.push(`连带删掉了 ${kids.length} 个子代理记录`);
          for (const skipped of result.skippedChildren ?? []) {
            notes.push(`子代理 ${String(skipped.id).slice(0, 8)} 跳过（${skipped.reason}）`);
          }
          for (const text of result.warnings ?? []) notes.push(text);
          setStatus({
            kind: "ok",
            text: `已删除「${row.title || row.id}」，释放 ${formatBytes(result.freedBytes)}，回收目录：${result.trash}`
              + (notes.length > 0 ? `\n${notes.join("\n")}` : "")
          });
          await load();
          await sessions?.refresh?.();
        } catch (error) {
          setStatus({ kind: "error", text: `删除失败：${error.message}` });
        } finally {
          setBusy(null);
        }
      }

      async function prune() {
        setBusy("__prune__");
        try {
          const result = await request(PRUNE_PATH, { retentionDays: retentionMs() / (24 * 60 * 60 * 1000) });
          const held = (result.orphanSkipped ?? []).length;
          const trashNote = result.trashRemoved > 0
            ? `、清掉过期回收堆 ${result.trashRemoved} 堆（释放 ${formatBytes(result.trashFreedBytes)}）`
            : "";
          setStatus({
            kind: "ok",
            text: `对账完成：剪掉归档死引用 ${result.unarchived} 条、幽灵分片 ${result.shards} 条、`
              + `孤儿子代理 ${result.orphans} 条${held > 0 ? `（另有 ${held} 条正在跑，跳过）` : ""}${trashNote}。`
          });
          await load();
          await sessions?.refresh?.();
        } catch (error) {
          setStatus({ kind: "error", text: `对账失败：${error.message}` });
        } finally {
          setBusy(null);
        }
      }

      /** 一键清空回收目录：这是真正的销毁，必须二次确认（3 秒内再点一次）。 */
      async function emptyTrash() {
        setBusy("__trash__");
        setArmed(null);
        try {
          const result = await request(PRUNE_PATH, { emptyTrash: true });
          setStatus({
            kind: result.trashRemoved > 0 ? "ok" : "error",
            text: result.trashRemoved > 0
              ? `回收站已清空：删掉 ${result.trashRemoved} 堆，释放 ${formatBytes(result.trashFreedBytes)}。这次是真销毁，反悔不了了喵。`
              : "回收站本来就是空的喵。"
          });
        } catch (error) {
          setStatus({ kind: "error", text: `清空回收站失败：${error.message}` });
        } finally {
          setBusy(null);
        }
      }

      return hs("div", {
        className: "dshsd-root",
        children: [
          hs("div", {
            className: "dshsd-head",
            children: [
              hs("div", {
                children: [
                  h("div", { className: "dshsd-title", children: "会话清理" }),
                  h("div", {
                    className: "dshsd-sub",
                    children: "删除是移动不是销毁，会话会进 ~/.dsh/.sessions-trash/ 可反悔（30 天后对账自动清掉）；当前会话与仍在运行的会话一律拒绝。删完侧栏当场生效，不用重启 dsh web。"
                  })
                ]
              }),
              hs("div", {
                className: "dshsd-actions",
                children: [
                  h("label", {
                    className: "dshsd-check",
                    title: "删父会话时，把它名下的子代理记录也一起搬进回收目录",
                    children: [
                      h("input", {
                        type: "checkbox",
                        checked: cascade,
                        disabled: busy !== null,
                        onChange: (event) => setCascade(event.target.checked)
                      }),
                      h("span", { children: "连子代理一起删" })
                    ]
                  }),
                  h("label", {
                    className: "dshsd-check",
                    title: "对账时自动清掉回收目录里超过这个天数的旧堆；填 0 表示不留（对账即全清）",
                    children: [
                      h("span", { children: "回收保留" }),
                      h("input", {
                        type: "number",
                        min: 0,
                        max: 3650,
                        value: retentionDays,
                        disabled: busy !== null,
                        onChange: (event) => setRetentionDays(event.target.value),
                        style: { width: 52, font: "inherit", padding: "2px 4px", borderRadius: 6, border: "1px solid rgba(255,255,255,.16)", background: "rgba(255,255,255,.06)", color: "inherit" }
                      }),
                      h("span", { children: "天" })
                    ]
                  }),
                  h("button", {
                    type: "button",
                    className: "dshsd-btn",
                    onClick: () => void prune(),
                    disabled: busy !== null,
                    children: "对账 + 清孤儿"
                  }),
                  h("button", {
                    type: "button",
                    className: armed === "__trash__" ? "dshsd-btn dshsd-btn-armed" : "dshsd-btn dshsd-btn-danger",
                    onClick: () => {
                      if (armed === "__trash__") {
                        void emptyTrash();
                        return;
                      }
                      setArmed("__trash__");
                    },
                    disabled: busy !== null,
                    children: busy === "__trash__" ? "清空中…" : armed === "__trash__" ? "确认清空（真销毁）" : "清空回收站"
                  }),
                  h("button", {
                    type: "button",
                    className: "dshsd-btn",
                    onClick: () => void load(),
                    disabled: busy !== null,
                    children: "刷新"
                  })
                ]
              })
            ]
          }),
          rows === null
            ? h("div", { className: "dshsd-empty", children: "读取中…" })
            : list.length === 0
              ? h("div", { className: "dshsd-empty", children: "磁盘上没有会话了。" })
              : h("div", {
                className: "dshsd-list",
                children: list.map((row) => {
                  const kids = childrenOf(row);
                  return hs("div", {
                  className: "dshsd-row",
                  children: [
                    hs("div", {
                      style: { minWidth: 0 },
                      children: [
                        h("div", { className: "dshsd-name", title: row.id, children: row.title || "（无标题）" }),
                        hs("div", {
                          className: "dshsd-meta",
                          children: [
                            h("span", { children: formatDate(row.createdAt) }),
                            h("span", { children: `回合 ${row.turns ?? "?"}` }),
                            h("span", { children: formatBytes(row.sizeBytes) }),
                            h("span", { children: row.short }),
                            row.origin === "subagent" ? h("span", { className: "dshsd-tag", children: "子代理" }) : null,
                            row.origin !== "subagent" && kids.length > 0 ? h("span", { className: "dshsd-tag dshsd-tag-warn", children: `含 ${kids.length} 个子代理` }) : null,
                            row.archived ? h("span", { className: "dshsd-tag", children: "已归档" }) : null,
                            row.current === true || isSelf(row) ? h("span", { className: "dshsd-tag dshsd-tag-warn", children: "当前会话" }) : null,
                            row.running ? h("span", { className: "dshsd-tag dshsd-tag-warn", children: "正在运行" }) : null,
                            row.live && !row.running ? h("span", { className: "dshsd-tag dshsd-tag-warn", children: "本进程已加载" }) : null
                          ]
                        })
                      ]
                    }),
                    h("button", {
                      type: "button",
                      className: armed === row.id ? "dshsd-btn dshsd-btn-armed" : "dshsd-btn dshsd-btn-danger",
                      disabled: busy !== null || row.current === true || row.running === true || isSelf(row),
                      onClick: () => {
                        if (armed === row.id) {
                          void remove(row);
                          return;
                        }
                        setArmed(row.id);
                      },
                      children: busy === row.id
                        ? "删除中…"
                        : armed === row.id
                          ? (cascade && kids.length > 0 ? `确认删除（含 ${kids.length} 个子代理）` : "确认删除")
                          : row.current === true || isSelf(row)
                            ? "当前会话"
                            : row.running
                              ? "运行中"
                              : "删除"
                    })
                  ]
                }, row.id);
                })
              }),
          status === null ? null : h("div", { className: "dshsd-status", "data-kind": status.kind, children: status.text })
        ]
      });
    }

    function apply(ctx) {
      // 注册失败只影响这个面板本身，绝不能拖垮整个客户端启动。
      try {
        const sessions = ctx.sessions;
        ctx.slots.inject("main", () => ctx.slots.register({
          name: "main",
          key: PANEL_ID,
          label: "会话清理",
          inject: () => ({ sessions })
        }, SessionDeletePanel));
        ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 40,
          label: "会话清理"
        }, PanelGlyph));
      } catch (error) {
        console.error("[dsh-session-delete] 面板注册失败（Host 路由不受影响）：", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  }
});
