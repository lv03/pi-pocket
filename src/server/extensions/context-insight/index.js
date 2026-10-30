export const pocketApi = 1;

import { cacheRate, fmt, money, pct, timeOf, dayOf } from "./format.js";
import { t, lang, setLang, subscribeLang } from "./text.js";

const ORDER = [
    "system",
    "tools",
    "user",
    "inject",
    "skill",
    "answers",
    "thinking",
    "toolCalls",
    "tool",
];

const SHORT = {
    system: "System prompt",
    tools: "Tool schemas",
    user: "Your messages",
    inject: "Injected context",
    skill: "Skills",
    answers: "Answers",
    thinking: "Reasoning",
    toolCalls: "Tool calls",
    tool: "Tool results",
};

const MIX = ["input", "output", "cacheRead", "cacheWrite"];
const MIX_LABEL = {
    input: "Input",
    output: "Output",
    cacheRead: "Cache read",
    cacheWrite: "Cache write",
};

const GROUP_LABEL = {
    working: "Working",
    waiting: "Waiting",
    failed: "Failed",
    done: "Done",
};

/** Which part of Pi Pocket a tool comes from, as far as its name says. */
const TOOL_SOURCES = {
    read: "coding",
    write: "coding",
    edit: "coding",
    bash: "coding",
    artifact: "artifacts",
    artifact_inline: "artifacts",
    ask_someone: "ask",
    background: "background",
    browser: "browser",
    codemode: "codemode",
    memory: "memory",
    schedule: "schedules",
    subagent: "subagents",
    team: "teams",
    watch_pr: "watch",
    sessions: "pip",
    session_read: "pip",
    session_start: "pip",
    session_send: "pip",
    session_follow: "pip",
    session_stop: "pip",
    session_archive: "pip",
    session_schedule: "pip",
    session_watch_pr: "pip",
    approvals: "pip",
    repo_watch: "pip",
};

/** Extension names that have a friendlier word of their own. */
const SOURCE_NAMES = {
    "coding-tools": "coding",
    "pocket-agent-teams": "teams",
    "pocket-ask-someone": "ask",
    "pocket-artifacts": "artifacts",
    "pocket-background": "background",
    "pocket-browser": "browser",
    "pocket-codemode": "codemode",
    "pocket-core": "core",
    "pocket-gallery": "gallery",
    "pocket-goals": "goals",
    "pocket-guard": "guard",
    "pocket-memory": "memory",
    "pocket-pip": "pip",
    "pocket-plan": "plan",
    "pocket-prompt": "prompt",
    "pocket-schedules": "schedules",
    "pocket-subagents": "subagents",
    "pocket-triggers": "watch",
    "pocket-updates": "updates",
};

/** A tool's source, as a label the page shows. The registry's answer wins over the name. */
function sourceLabel(tool) {
    const name = typeof tool === "string" ? tool : String(tool?.name ?? tool?.label ?? "");
    const source = typeof tool === "string" ? undefined : tool?.source;

    if (typeof source === "string" && source !== "") {
        const known = SOURCE_NAMES[source];

        return known === undefined ? source : t(`src.${known}`);
    }

    if (name.startsWith("mcp_") || name.includes("__")) {
        return t("src.mcp");
    }

    return t(`src.${TOOL_SOURCES[name] ?? "extension"}`);
}

const EVENT_KINDS = ["compact", "reset", "model", "inject", "tools", "edit", "error"];
const EVENT_LABEL = {
    compact: "Compaction",
    reset: "New context",
    model: "Model",
    inject: "Injected",
    tools: "Tools",
    edit: "Edit",
    error: "Error",
};

const store = (key, value) => {
    try {
        if (value === undefined) {
            return localStorage.getItem(key);
        }

        localStorage.setItem(key, String(value));
    } catch {
        // Storage can be off: keep the choice for this page only.
    }

    return value;
};

/** A fold's event detail in the language of the page. */
function detailText(detail) {
    if (lang() !== "zh" || typeof detail !== "string") {
        return detail;
    }

    return detail
        .replace(/ added$/, " 添加")
        .replace(/ grew$/, " 增大")
        .replace(/ shrank$/, " 减小")
        .replace(/^(\d+) tools offered$/, "$1 个工具")
        .replace("the window reached its limit", "到达窗口上限")
        .replace("the window overflowed", "窗口溢出")
        .replace("compacted", "已压缩")
        .replace("an earlier entry was left out", "隐藏了一条较早的条目")
        .replace("an earlier entry was replaced", "替换了一条较早的条目")
        .replace("a new context, with a handoff", "新上下文，带交接")
        .replace("a new context", "新上下文")
        .replace("the answer ended: ", "回答结束：");
}

export default async function setup(pocket) {
    let disposed = false;

    pocket.onDispose(() => {
        disposed = true;
    });
    pocket.style("look.css");

    const settings =
        typeof pocket.settings === "function" ? await pocket.settings().catch(() => null) : null;

    if (disposed) {
        return;
    }

    const defaults = settings?.values ?? {};

    const { html, useState, useEffect, useMemo, useCallback, useRef } = pocket;

    /** The language, and a render when it changes. */
    function useLang() {
        const [value, setValue] = useState(lang());

        useEffect(() => subscribeLang(setValue), []);

        return value;
    }

    /** Read one session's fold, and read it again when Pi works there. */
    function useSession(id) {
        const [data, setData] = useState(null);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);
        const [at, setAt] = useState(0);
        const timer = useRef(null);
        const request = useRef(null);
        const load = useCallback(
            async (quiet) => {
                request.current?.abort();

                if (!id) {
                    setData(null);
                    setError(null);
                    setBusy(false);
                    setAt(0);

                    return;
                }

                const stop = new AbortController();

                request.current = stop;

                if (!quiet) {
                    setBusy(true);
                }

                try {
                    const answer = await pocket.api(`session/${id}`, undefined, {
                        signal: stop.signal,
                    });

                    if (stop.signal.aborted) {
                        return;
                    }

                    setData(answer);
                    setError(null);
                    setAt(Date.now());
                } catch (failure) {
                    if (stop.signal.aborted) {
                        return;
                    }

                    if (failure?.status === 404) {
                        setData(null);
                        setError(t("This session is not available."));
                    } else {
                        setError(failure?.message ?? String(failure));
                    }
                } finally {
                    if (!stop.signal.aborted) {
                        setBusy(false);
                    }
                }
            },
            [id],
        );

        useEffect(() => {
            setData(null);
            setError(null);
            setAt(0);
            void load(false);

            return () => request.current?.abort();
        }, [load]);

        useEffect(() => {
            const stop = pocket.on("changed", (event) => {
                if (!id || event?.conversationId !== id) {
                    return;
                }

                if (timer.current) {
                    clearTimeout(timer.current);
                }

                timer.current = setTimeout(() => {
                    timer.current = null;
                    void load(true);
                }, 600);
            });

            return () => {
                stop();

                if (timer.current) {
                    clearTimeout(timer.current);
                    timer.current = null;
                }
            };
        }, [id, load]);

        return { data, error, busy, at, reload: () => load(false) };
    }

    function useItems(id, step) {
        const [state, setState] = useState({ loading: true, data: null, error: null });

        useEffect(() => {
            if (!id) {
                setState({ loading: false, data: null, error: null });

                return;
            }

            const stop = new AbortController();

            setState({ loading: true, data: null, error: null });
            pocket
                .api(`items/${id}${step === null ? "" : `/${step}`}`, undefined, {
                    signal: stop.signal,
                })
                .then(
                    (data) => {
                        if (!stop.signal.aborted) {
                            setState({ loading: false, data, error: null });
                        }
                    },
                    (failure) => {
                        if (!stop.signal.aborted) {
                            setState({ loading: false, data: null, error: failure.message });
                        }
                    },
                );

            return () => stop.abort();
        }, [id, step]);

        return state;
    }

    function useEntry(id, entryId) {
        const [state, setState] = useState({ loading: false, entry: null, error: null });

        useEffect(() => {
            if (!id || !entryId) {
                setState({ loading: false, entry: null, error: null });

                return;
            }

            const stop = new AbortController();

            setState({ loading: true, entry: null, error: null });
            pocket.api(`entry/${id}/${entryId}`, undefined, { signal: stop.signal }).then(
                (data) => {
                    if (!stop.signal.aborted) {
                        setState({ loading: false, entry: data.entry, error: null });
                    }
                },
                (failure) => {
                    if (!stop.signal.aborted) {
                        setState({ loading: false, entry: null, error: failure.message });
                    }
                },
            );

            return () => stop.abort();
        }, [id, entryId]);

        return state;
    }

    function Bar({ parts, height = 10 }) {
        const sum = ORDER.reduce((total, key) => total + (parts?.[key] ?? 0), 0);

        if (!sum) {
            return html`<div class="ci-bar" style=${`height:${height}px`}></div>`;
        }

        return html`<div class="ci-bar" style=${`height:${height}px`}>
            ${ORDER.map((key) => {
                const value = parts?.[key] ?? 0;

                return (
                    value > 0 &&
                    html`<span
                        class=${`ci-seg ci-seg-${key}`}
                        style=${`width:${(value / sum) * 100}%`}
                        title=${`${SHORT[key]}: ${fmt(value)}`}
                    ></span>`
                );
            })}
        </div>`;
    }

    function Categories({ parts, total, filter, onFilter }) {
        const sum = total || ORDER.reduce((each, key) => each + (parts?.[key] ?? 0), 0);

        return html`<div class="ci-legend">
            ${ORDER.map((key) => {
                const value = parts?.[key] ?? 0;
                const share = sum > 0 ? (value / sum) * 100 : 0;

                return html`<button
                    class="ci-cat"
                    data-dim=${filter !== null && filter !== key ? "1" : "0"}
                    onClick=${() => onFilter(filter === key ? null : key)}
                    title=${t("tap to filter")}
                >
                    <span class="ci-swatch" style=${`background:var(--ci-${key})`}></span>
                    <span>${t(SHORT[key])}</span>
                    <small>${fmt(value)}</small>
                    <small>${share > 0 && share < 1 ? "<1" : Math.round(share)}%</small>
                </button>`;
            })}
        </div>`;
    }

    function Hero({ stats }) {
        const used = stats?.used ?? 0;
        const window = stats?.window;

        return html`<div class="ci-hero">
            <div class="ci-hero-line">
                <b>${window ? `${pct(stats.percent)}` : fmt(used)}</b>
                <span class="ci-sub">
                    ${window ? `${fmt(used)} of ${fmt(window)} tokens` : `${t("tokens in context")}`}
                    ${stats?.estimated ? ` · ${t("estimated")}` : ""}
                </span>
            </div>
            <${Bar} parts=${stats?.parts} height=${14} />
            <div class="ci-foot">
                <span
                    >${stats?.model ? `${stats.model.provider}/${stats.model.model}` : t("no model yet")}</span
                >
                <span>
                    ${lastCache(stats) !== null ? `cache ${lastCache(stats)}% · ` : ""}
                    ${fmt(stats?.entries ?? 0)} ${t("entries")}
                </span>
            </div>
        </div>`;
    }

    function lastCache(stats) {
        const steps = stats?.steps ?? [];
        const step = steps[steps.length - 1];

        if (step === undefined) {
            return null;
        }

        return cacheRate(step.prompt, step.cacheRead);
    }

    function StepCard({ step }) {
        if (!step) {
            return html`<div class="ci-empty">${t("No requests yet.")}</div>`;
        }

        const sum = ORDER.reduce((each, key) => each + (step.parts?.[key] ?? 0), 0);

        return html`<div class="ci-card">
            <div class="ci-card-head">
                <b>${t("Request")} ${step.index + 1}</b>
                <span>${timeOf(step.at)}</span>
            </div>
            <div class="ci-body">
                <div class="ci-step">
                    <span>${t("prompt")} <b>${fmt(step.prompt)}</b></span>
                    <span>${t("output")} <b>${fmt(step.output)}</b></span>
                    <span>${t("cache read")} <b>${fmt(step.cacheRead)}</b></span>
                    <span>${t("cache write")} <b>${fmt(step.cacheWrite)}</b></span>
                    <span>${t("cost")} <b>${money(step.cost)}</b></span>
                    ${step.model && html`<span>${step.model}</span>`}
                </div>
                <${Bar} parts=${step.parts} height=${12} />
                ${ORDER.filter((key) => (step.parts?.[key] ?? 0) > 0).map(
                    (key) =>
                        html`<div class="ci-cat">
                            <span class="ci-swatch" style=${`background:var(--ci-${key})`}></span>
                            <span>${t(SHORT[key])}</span>
                            <small>${fmt(step.parts[key])}</small>
                            <small
                                >${sum > 0 ? Math.round((step.parts[key] / sum) * 100) : 0}%</small
                            >
                        </div>`,
                )}
                ${step.user && html`<div class="ci-hint">${t("You")}: ${step.user}</div>`}
                ${step.answer && html`<div class="ci-hint">${t("Response")}: ${step.answer}</div>`}
                ${
                    step.delta &&
                    html`<div class="ci-step">
                        ${ORDER.filter((key) => (step.delta?.[key] ?? 0) !== 0).map(
                            (key) =>
                                html`<span>
                                    ${t(SHORT[key])}
                                    <b
                                        class=${step.delta[key] > 0 ? "ci-delta-up" : "ci-delta-down"}
                                    >
                                        ${step.delta[key] > 0 ? "+" : ""}${fmt(step.delta[key])}
                                    </b>
                                </span>`,
                        )}
                    </div>`
                }
                ${
                    step.stopReason &&
                    step.stopReason !== "stop" &&
                    html`<div class="ci-hint">
                        ${t("ended")}: ${step.stopReason}${step.error ? ` · ${step.error}` : ""}
                    </div>`
                }
            </div>
        </div>`;
    }

    function Trend({ steps, events, selected, onSelect }) {
        useLang();
        const [mode, setMode] = useState(
            store("x.context-insight.mode") ?? defaults.trend ?? "total",
        );
        const [overview, setOverview] = useState(store("x.context-insight.overview") === "1");

        const choose = (value) => {
            setMode(value);
            store("x.context-insight.mode", value);
        };

        const width = overview ? 1000 : Math.max(300, Math.min(steps.length * 8, 6000));
        const height = 150;
        const pad = 6;
        const bottom = 16;
        const plot = height - pad - bottom;
        const stepWidth = steps.length > 0 ? (width - pad * 2) / steps.length : 0;

        const totals = steps.map((step) =>
            ORDER.reduce((sum, key) => sum + (step.parts?.[key] ?? 0), 0),
        );
        const deltas = totals.map((value, index) => value - (totals[index - 1] ?? 0));
        const most = Math.max(1, ...totals);
        const mostDelta = Math.max(1, ...deltas.map((value) => Math.abs(value)));
        const middle = pad + plot / 2;

        const x = (index) => pad + (index + 0.5) * stepWidth;
        const y = (value) => pad + plot - (value / most) * plot;

        const areas = useMemo(() => {
            if (mode !== "total") {
                return [];
            }

            const base = steps.map(() => 0);
            const paths = [];

            for (const key of ORDER) {
                const top = [];
                const under = [];

                steps.forEach((step, index) => {
                    top.push(`${x(index)},${y(base[index] + (step.parts?.[key] ?? 0))}`);
                    under.unshift(`${x(index)},${y(base[index])}`);
                });

                if (steps.length > 0) {
                    const last = steps.length - 1;

                    top.unshift(`${pad},${y(base[0] + (steps[0].parts?.[key] ?? 0))}`);
                    top.push(`${width - pad},${y(base[last] + (steps[last].parts?.[key] ?? 0))}`);
                    under.unshift(`${width - pad},${y(base[last])}`);
                    under.push(`${pad},${y(base[0])}`);
                }

                for (let index = 0; index < steps.length; index++) {
                    base[index] += steps[index].parts?.[key] ?? 0;
                }

                if (base.some((value) => value > 0) || top.length > 0) {
                    paths.push({ key, points: [...top, ...under].join(" ") });
                }
            }

            return paths;
        }, [steps, mode, most, width]);

        const markers = events.filter(
            (event) => event.kind === "compact" || event.kind === "reset",
        );

        const pick = (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const scale = rect.width / width;
            const at = (event.clientX - rect.left) / scale;
            const index = Math.max(
                0,
                Math.min(steps.length - 1, Math.round((at - pad) / stepWidth - 0.5)),
            );

            onSelect(steps[index] ?? null);
        };

        return html`<div class="ci-card">
            <div class="ci-card-head">
                <b>${t("Growth")}</b>
                <div style="display:flex;gap:6px;align-items:center">
                    <button
                        class="ci-tab"
                        aria-selected=${overview}
                        onClick=${() => {
                            const next = !overview;

                            setOverview(next);
                            store("x.context-insight.overview", next ? "1" : "0");
                        }}
                    >
                        ${t("Overview")}
                    </button>
                    <div class="ci-switch">
                        <button aria-pressed=${mode === "total"} onClick=${() => choose("total")}>
                            ${t("Total")}
                        </button>
                        <button aria-pressed=${mode === "delta"} onClick=${() => choose("delta")}>
                            ${t("Delta")}
                        </button>
                    </div>
                </div>
            </div>
            <div class="ci-body">
                ${
                    steps.length === 0
                        ? html`<div class="ci-empty">${t("No requests yet.")}</div>`
                        : html`<div class="ci-chart" style=${overview ? "overflow-x:hidden" : ""}>
                              <svg
                                  width=${overview ? "100%" : width}
                                  height=${height}
                                  viewBox=${`0 0 ${width} ${height}`}
                                  preserveAspectRatio=${overview ? "none" : "xMidYMid meet"}
                                  role="img"
                                  aria-label=${t("Context by request")}
                                  onClick=${pick}
                              >
                                  <line
                                      x1=${pad}
                                      x2=${width - pad}
                                      y1=${mode === "total" ? height - bottom : middle}
                                      y2=${mode === "total" ? height - bottom : middle}
                                      stroke="var(--line)"
                                  />
                                  ${
                                      mode === "total"
                                          ? areas.map(
                                                (area) =>
                                                    html`<polygon
                                                        points=${area.points}
                                                        fill=${`var(--ci-${area.key})`}
                                                        opacity="0.9"
                                                    />`,
                                            )
                                          : deltas.map((delta, index) => {
                                                const heightOf =
                                                    (Math.abs(delta) / mostDelta) * (plot / 2);

                                                return html`<rect
                                                    x=${x(index) - Math.max(1, stepWidth * 0.35)}
                                                    y=${delta >= 0 ? middle - heightOf : middle}
                                                    width=${Math.max(2, stepWidth * 0.7)}
                                                    height=${Math.max(1, heightOf)}
                                                    fill=${delta >= 0 ? "var(--ci-error)" : "var(--ci-ok)"}
                                                />`;
                                            })
                                  }
                                  ${markers.map((marker) => {
                                      const index = Math.max(
                                          0,
                                          Math.min(
                                              steps.length - 1,
                                              marker.step ?? steps.length - 1,
                                          ),
                                      );

                                      return html`<line
                                          x1=${x(index)}
                                          x2=${x(index)}
                                          y1=${pad}
                                          y2=${height - bottom}
                                          stroke="var(--muted)"
                                          stroke-dasharray="2 3"
                                      />`;
                                  })}
                                  ${
                                      selected !== null &&
                                      steps[selected] !== undefined &&
                                      html`<line
                                          x1=${x(selected)}
                                          x2=${x(selected)}
                                          y1=${pad}
                                          y2=${height - bottom}
                                          stroke="var(--text)"
                                          stroke-width="1.5"
                                      />`
                                  }
                              </svg>
                          </div>`
                }
                <div class="ci-chart-keys">
                    ${ORDER.map(
                        (key) =>
                            html`<span>
                                <span
                                    class="ci-swatch"
                                    style=${`background:var(--ci-${key})`}
                                ></span>
                                ${t(SHORT[key])}
                            </span>`,
                    )}
                </div>
                <div class="ci-hint">
                    ${steps.length} ${t("requests")} · ${t("tap a bar to see that request")}
                </div>
            </div>
        </div>`;
    }

    function ImageCard({ id, entry, index }) {
        const [src, setSrc] = useState(null);
        const [failed, setFailed] = useState(null);

        useEffect(() => {
            const stop = new AbortController();

            setSrc(null);
            setFailed(null);
            pocket.api(`image/${id}/${entry}/${index}`, undefined, { signal: stop.signal }).then(
                (data) => {
                    if (stop.signal.aborted) {
                        return;
                    }

                    if (typeof data?.data === "string") {
                        setSrc(`data:${data.mimeType};base64,${data.data}`);
                    } else {
                        setFailed(t("Image"));
                    }
                },
                (failure) => {
                    if (!stop.signal.aborted) {
                        setFailed(failure.message);
                    }
                },
            );

            return () => stop.abort();
        }, [id, entry, index]);

        if (failed) {
            return html`<span class="ci-media ci-media-failed">${t("Image")} ${index + 1}</span>`;
        }

        return html`<span class="ci-media">
            ${
                src
                    ? html`<img
                          src=${src}
                          alt=${`${t("Image")} ${index + 1}`}
                          loading="lazy"
                          onError=${() => setFailed(t("Image"))}
                      />`
                    : html`<${pocket.Loader} />`
            }
        </span>`;
    }

    function imageCount(entry) {
        const message = entry?.messages?.[0];

        return message?.role === "user" || message?.role === "toolResult"
            ? message.parts.filter((part) => part.type === "image").length
            : 0;
    }

    function EntryText({ id, entry }) {
        const state = useEntry(id, entry);

        if (state.loading) {
            return html`<div class="ci-loading"><${pocket.Loader} /> ${t("Reading")}</div>`;
        }

        if (state.error) {
            return html`<div class="ci-error">${state.error}</div>`;
        }

        const images = imageCount(state.entry);

        return html`<div>
            ${
                images > 0 &&
                html`<div class="ci-media-row">
                    ${Array.from(
                        { length: Math.min(images, 4) },
                        (_, index) => html`<${ImageCard} id=${id} entry=${entry} index=${index} />`,
                    )}
                </div>`
            }
            <pre class="ci-pre">${entryText(state.entry)}</pre>
        </div>`;
    }

    function entryText(entry) {
        const parts = [];

        for (const message of entry?.messages ?? []) {
            if (message.role === "user") {
                parts.push(
                    ...message.parts.flatMap((part) =>
                        part.type === "text" ? [part.text] : ["[image]"],
                    ),
                );
            } else if (message.role === "assistant") {
                parts.push(
                    ...message.parts.map((part) =>
                        part.type === "text"
                            ? part.text
                            : part.type === "thinking"
                              ? `[thinking]\n${part.text}`
                              : part.type === "toolCall"
                                ? `[${part.name}] ${JSON.stringify(part.arguments)}`
                                : "[image]",
                    ),
                );
            } else if (message.role === "toolResult") {
                parts.push(
                    ...message.parts.flatMap((part) =>
                        part.type === "text" ? [part.text] : ["[image]"],
                    ),
                );
            } else if (message.role === "system") {
                parts.push(...Object.values(message.sections ?? {}).filter(Boolean));
            }
        }

        const text = parts.join("\n\n");

        return text.length <= 40_000 ? text : `${text.slice(0, 40_000)}\n\n…`;
    }

    function Browser({ id, data, step, setStep, filter, setFilter }) {
        const state = useItems(id, step);
        const [openKey, setOpenKey] = useState(null);
        const [query, setQuery] = useState("");
        const [flat, setFlat] = useState(store("x.context-insight.flat") === "1");

        useEffect(() => {
            setOpenKey(null);
        }, [id, step, filter]);

        if (state.loading) {
            return html`<div class="ci-loading">
                <${pocket.Loader} /> ${t("Reading the context")}
            </div>`;
        }

        if (state.error) {
            return html`<div class="ci-error">${state.error}</div>`;
        }

        const needle = query.trim().toLowerCase();
        const items = (state.data?.items ?? []).filter(
            (item) =>
                needle === "" ||
                `${itemLabel(item)} ${item.label} ${item.preview}`.toLowerCase().includes(needle),
        );
        const groups = ORDER.map((key) => ({
            key,
            items: items.filter((item) => item.category === key),
            tokens: items
                .filter((item) => item.category === key)
                .reduce((sum, item) => sum + item.tokens, 0),
        })).filter((group) => (filter !== null ? group.key === filter : group.items.length > 0));
        const total = state.data?.total ?? 0;
        const more = state.data?.itemsMore ?? 0;

        const itemRow = (item, position) => {
            const key = `${item.entry}:${item.role}:${item.part}:${item.label}`;

            return html`<div>
                <button
                    class="ci-item"
                    data-open=${openKey === key ? "1" : "0"}
                    onClick=${() => setOpenKey(openKey === key ? null : key)}
                >
                    <span class="ci-item-main">
                        <span class="ci-item-label">
                            ${flat && html`<small class="ci-hint">#${position}</small>`}
                            <span class="ci-item-name">${itemLabel(item)}</span>
                            ${
                                item.role === "schema" &&
                                html`<small class="ci-chip">${sourceLabel(item)}</small>`
                            }
                            ${item.entry > 0 && html`<small class="ci-hint">#${item.entry}</small>`}
                        </span>
                        <span class="ci-item-preview">${item.preview}</span>
                    </span>
                    <span class="ci-item-tokens">${fmt(item.tokens)}</span>
                </button>
                ${
                    openKey === key &&
                    (item.entry > 0
                        ? html`<${EntryText} id=${id} entry=${item.entry} />`
                        : html`<pre class="ci-pre">${item.preview}</pre>`)
                }
            </div>`;
        };

        return html`<div class="ci-body" style="padding:0">
            <div class="ci-toolbar" style="padding:10px 10px 0">
                <div class="ci-step">
                    <span>${step === null ? t("Now") : `${t("Request")} #${step}`}</span>
                    ${
                        total > items.length &&
                        html`<span>${fmt(items.length)} / ${fmt(total)} ${t("items")}</span>`
                    }
                </div>
                <div class="ci-switch">
                    <button aria-pressed=${step === null} onClick=${() => setStep(null)}>
                        ${t("Now")}
                    </button>
                    <button
                        aria-pressed=${step !== null}
                        onClick=${() => setStep(lastStep(data))}
                        disabled=${lastStep(data) === null}
                    >
                        ${t("Last request")}
                    </button>
                </div>
            </div>
            <div class="ci-toolbar" style="padding:0 10px 8px">
                <span class="ci-hint">${t("Reading order")}</span>
                <div class="ci-switch">
                    <button
                        aria-pressed=${!flat}
                        onClick=${() => {
                            setFlat(false);
                            store("x.context-insight.flat", "0");
                        }}
                    >
                        ${t("Grouped")}
                    </button>
                    <button
                        aria-pressed=${flat}
                        onClick=${() => {
                            setFlat(true);
                            store("x.context-insight.flat", "1");
                        }}
                    >
                        ${t("DNA")}
                    </button>
                </div>
            </div>
            <div style="padding:0 10px 8px">
                <input
                    type="search"
                    value=${query}
                    placeholder=${t("Filter items")}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                    style="width:100%;min-height:34px;border:1px solid var(--line);border-radius:9px;background:transparent;color:var(--text);padding:0 9px"
                />
            </div>
            ${
                more > 0 &&
                html`<div class="ci-hint" style="padding:0 10px 8px">
                    ${t("The newest items show; older ones are hidden.")} (${fmt(more)})
                </div>`
            }
            ${
                filter !== null &&
                html`<div style="padding:0 10px 8px">
                    <button class="ci-button" onClick=${() => setFilter(null)}>
                        ${t("All categories")}
                    </button>
                </div>`
            }
            ${
                flat &&
                html`<div class="ci-group">
                    ${items
                        .map((item, index) => ({ item, position: index + 1 }))
                        .filter(({ item }) => filter === null || item.category === filter)
                        .map(({ item, position }) => itemRow(item, position))}
                </div>`
            }
            ${
                !flat &&
                groups.map(
                    (group) =>
                        html`<div class="ci-group">
                            <div
                                class="ci-group-head"
                                style="grid-template-columns:10px 1fr auto auto"
                            >
                                <span
                                    class="ci-swatch"
                                    style=${`background:var(--ci-${group.key})`}
                                ></span>
                                <span>${t(SHORT[group.key])}</span>
                                <small>${fmt(group.tokens)}</small>
                                <small>${group.items.length}</small>
                            </div>
                            ${
                                group.items.length === 0
                                    ? html`<div class="ci-empty">${t("Nothing here now.")}</div>`
                                    : group.items.map((item) => itemRow(item, 0))
                            }
                        </div>`,
                )
            }
            ${items.length === 0 && html`<div class="ci-empty">${t("Nothing in the context yet.")}</div>`}
        </div>`;
    }

    function itemLabel(item) {
        if (
            (item.role === "user" && ["Summary", "File", "You"].includes(item.label)) ||
            (item.role === "thinking" && item.label === "Reasoning") ||
            (item.role === "answers" && item.label === "Answer")
        ) {
            return t(item.label);
        }

        return item.label;
    }

    function lastStep(data) {
        const steps = data?.stats?.steps ?? [];

        return steps.length > 0 ? steps[steps.length - 1].id : null;
    }

    function Events({ events, onPick }) {
        const [filter, setFilter] = useState(null);

        const shown = events.filter((event) => filter === null || event.kind === filter);
        const counts = {};

        for (const event of events) {
            counts[event.kind] = (counts[event.kind] ?? 0) + 1;
        }

        return html`<div class="ci-card">
            <div class="ci-card-head">
                <b>${t("Events")}</b>
                <span>${events.length}</span>
            </div>
            <div class="ci-tabs" style="padding:8px 10px 0">
                <button
                    class="ci-tab"
                    aria-selected=${filter === null}
                    onClick=${() => setFilter(null)}
                >
                    ${t("All")}
                </button>
                ${EVENT_KINDS.filter((kind) => counts[kind]).map(
                    (kind) =>
                        html`<button
                            class="ci-tab"
                            aria-selected=${filter === kind}
                            onClick=${() => setFilter(filter === kind ? null : kind)}
                        >
                            ${t(EVENT_LABEL[kind])} ${counts[kind]}
                        </button>`,
                )}
            </div>
            ${
                shown.length === 0
                    ? html`<div class="ci-empty">${t("No events yet.")}</div>`
                    : shown
                          .slice()
                          .reverse()
                          .map(
                              (event) =>
                                  html`<div
                                      class="ci-event"
                                      onClick=${() => event.step !== undefined && onPick(event.step)}
                                  >
                                      <time>${timeOf(event.at)}</time>
                                      <span class="ci-event-kind">
                                          <b>${t(EVENT_LABEL[event.kind] ?? event.kind)}</b>
                                          <span class="ci-event-detail"
                                              >${detailText(event.detail)}</span
                                          >
                                      </span>
                                      <small
                                          class=${
                                              event.tokens > 0
                                                  ? "ci-delta-up"
                                                  : event.tokens < 0
                                                    ? "ci-delta-down"
                                                    : ""
                                          }
                                      >
                                          ${
                                              event.tokens === undefined
                                                  ? ""
                                                  : `${event.tokens > 0 ? "+" : ""}${fmt(event.tokens)}`
                                          }
                                      </small>
                                  </div>`,
                          )
            }
        </div>`;
    }

    function Files({ id, files }) {
        const [query, setQuery] = useState("");
        const [open, setOpen] = useState(null);
        const [preview, setPreview] = useState(null);

        const shown = files.filter((file) =>
            file.path.toLowerCase().includes(query.trim().toLowerCase()),
        );

        return html`<div class="ci-card">
            <div class="ci-card-head">
                <b>${t("Files")}</b>
                <span>${files.length}</span>
            </div>
            <div style="padding:8px 10px">
                <input
                    type="search"
                    value=${query}
                    placeholder=${t("Filter a path")}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                    style="width:100%;min-height:34px;border:1px solid var(--line);border-radius:9px;background:transparent;color:var(--text);padding:0 9px"
                />
            </div>
            ${
                shown.length === 0
                    ? html`<div class="ci-empty">${t("No files touched yet.")}</div>`
                    : shown.map(
                          (file) =>
                              html`<div>
                                  <button
                                      class="ci-file"
                                      style="width:100%;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--text);text-align:left"
                                      onClick=${() => {
                                          setOpen(open === file.path ? null : file.path);
                                          setPreview(null);
                                      }}
                                  >
                                      <span class="ci-file-path">${file.path}</span>
                                      <small>
                                          ${file.read > 0 ? `R${file.read} ` : ""}${file.written > 0 ? `W${file.written} ` : ""}${file.edited > 0 ? `E${file.edited}` : ""}
                                          ${file.added + file.removed > 0 ? ` · +${file.added}/−${file.removed}` : ""}
                                      </small>
                                  </button>
                                  ${
                                      open === file.path &&
                                      html`<div class="ci-ops">
                                          ${file.ops.map((op, index) => {
                                              const key = `${file.path}:${index}`;
                                              const entry =
                                                  op.kind === "read"
                                                      ? op.entry
                                                      : (op.call ?? op.entry);

                                              return html`<div>
                                                  <div class="ci-event">
                                                      <time>${timeOf(op.at)}</time>
                                                      <span class="ci-event-kind">
                                                          <b>${op.kind}</b>
                                                          <span class="ci-event-detail">
                                                              #${op.entry}${op.error ? ` · ${t("error")}` : ""}
                                                          </span>
                                                      </span>
                                                      <button
                                                          class="ci-link"
                                                          onClick=${() => setPreview(preview === key ? null : key)}
                                                      >
                                                          ${preview === key ? t("Hide") : t("View")}
                                                      </button>
                                                  </div>
                                                  ${
                                                      preview === key &&
                                                      html`<${FileText}
                                                          id=${id}
                                                          entry=${entry}
                                                          kind=${op.kind}
                                                      />`
                                                  }
                                              </div>`;
                                          })}
                                      </div>`
                                  }
                              </div>`,
                      )
            }
        </div>`;
    }

    function FileText({ id, entry, kind }) {
        const state = useEntry(id, entry);

        if (state.loading) {
            return html`<div class="ci-loading"><${pocket.Loader} /> ${t("Reading")}</div>`;
        }

        if (state.error) {
            return html`<div class="ci-error">${state.error}</div>`;
        }

        return html`<pre class="ci-pre">${fileText(state.entry, kind)}</pre>`;
    }

    function fileText(entry, kind) {
        if (kind !== "read") {
            for (const message of entry?.messages ?? []) {
                if (message.role !== "assistant") {
                    continue;
                }

                for (const part of message.parts) {
                    if (part.type !== "toolCall") {
                        continue;
                    }

                    const args = part.arguments ?? {};

                    if (part.name === "write" && typeof args.content === "string") {
                        return args.content;
                    }

                    if (part.name === "edit" && Array.isArray(args.edits)) {
                        const parts = args.edits
                            .map((edit) => (typeof edit?.newText === "string" ? edit.newText : ""))
                            .filter((text) => text !== "");

                        if (parts.length > 0) {
                            return parts.join("\n\n---\n\n");
                        }
                    }
                }
            }
        }

        return entryText(entry);
    }

    function Commands({ commands }) {
        const [status, setStatus] = useState(null);
        const [query, setQuery] = useState("");

        const shown = commands.filter(
            (row) =>
                (status === null || row.status === status) &&
                row.command.toLowerCase().includes(query.trim().toLowerCase()),
        );

        return html`<div class="ci-card">
            <div class="ci-card-head">
                <b>${t("Commands")}</b>
                <span>${commands.length}</span>
            </div>
            <div class="ci-tabs" style="padding:8px 10px 0">
                <button
                    class="ci-tab"
                    aria-selected=${status === null}
                    onClick=${() => setStatus(null)}
                >
                    ${t("All")}
                </button>
                <button
                    class="ci-tab"
                    aria-selected=${status === "ok"}
                    onClick=${() => setStatus("ok")}
                >
                    ${t("OK")}
                </button>
                <button
                    class="ci-tab"
                    aria-selected=${status === "error"}
                    onClick=${() => setStatus("error")}
                >
                    ${t("Error")}
                </button>
            </div>
            <div style="padding:8px 10px">
                <input
                    type="search"
                    value=${query}
                    placeholder=${t("Filter a command")}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                    style="width:100%;min-height:34px;border:1px solid var(--line);border-radius:9px;background:transparent;color:var(--text);padding:0 9px"
                />
            </div>
            ${
                shown.length === 0
                    ? html`<div class="ci-empty">${t("No commands yet.")}</div>`
                    : shown
                          .slice()
                          .reverse()
                          .map(
                              (row) =>
                                  html`<div class="ci-cmd">
                                      <div class="ci-cmd-line">
                                          <span class=${`ci-dot ci-dot-${row.status}`}></span>
                                          <code>${row.command}</code>
                                          <small
                                              >${row.ms === undefined ? "" : `${row.ms} ms`}</small
                                          >
                                      </div>
                                      <small>${row.output}</small>
                                  </div>`,
                          )
            }
        </div>`;
    }

    function useFleet(id) {
        const [state, setState] = useState({ loading: true, agents: [], error: null });

        useEffect(() => {
            setState({ loading: Boolean(id), agents: [], error: null });

            if (!id) {
                return;
            }

            let stop;

            const load = () => {
                stop?.abort();
                stop = new AbortController();

                const signal = stop.signal;

                pocket.api(`fleet/${id}`, undefined, { signal }).then(
                    (data) => {
                        if (!signal.aborted) {
                            setState({ loading: false, agents: data.agents ?? [], error: null });
                        }
                    },
                    (failure) => {
                        if (!signal.aborted) {
                            setState({
                                loading: false,
                                agents: [],
                                error: failure.message,
                            });
                        }
                    },
                );
            };

            load();

            const off = pocket.on("changed", (event) => {
                if (event?.conversationId === id) {
                    load();
                }
            });

            return () => {
                stop?.abort();
                off();
            };
        }, [id]);

        return state;
    }

    function useAgent(id) {
        const [state, setState] = useState({ loading: true, stats: null, messages: [] });

        useEffect(() => {
            setState({ loading: Boolean(id), stats: null, messages: [] });

            if (!id) {
                return;
            }

            const stop = new AbortController();

            pocket.api(`agent/${id}`, undefined, { signal: stop.signal }).then(
                (data) => {
                    if (!stop.signal.aborted) {
                        setState({
                            loading: false,
                            stats: data.stats ?? null,
                            messages: data.messages ?? [],
                        });
                    }
                },
                () => {
                    if (!stop.signal.aborted) {
                        setState({ loading: false, stats: null, messages: [] });
                    }
                },
            );

            return () => stop.abort();
        }, [id]);

        return state;
    }

    function agentState(agent) {
        if (agent.waiting) {
            return { key: "waiting", label: "waiting", tone: "warn" };
        }

        if (agent.busy) {
            return { key: "working", label: "working", tone: "ok" };
        }

        if (agent.failed) {
            return agent.stopped
                ? { key: "failed", label: "stopped", tone: "error" }
                : { key: "failed", label: "failed", tone: "error" };
        }

        return { key: "done", label: "done", tone: "ok" };
    }

    function Chat({ rows }) {
        if (rows.length === 0) {
            return html`<div class="ci-empty">${t("No messages yet.")}</div>`;
        }

        return html`<div class="ci-chat">
            ${rows.map(
                (row) =>
                    html`<div class="ci-chat-row">
                        <div class="ci-chat-meta">
                            <b>${row.dir === "to" ? t("Parent") : t("Agent")}</b>
                            <time>${timeOf(row.at)}</time>
                        </div>
                        <div class="ci-chat-text">${row.text}</div>
                    </div>`,
            )}
        </div>`;
    }

    function AgentCard({ id, agent, stats }) {
        const [open, setOpen] = useState(false);
        const self = useAgent(id);
        const agentStats = self.stats;
        const messages = self.messages;
        const state = agentState(agent);
        const answers = messages.filter((row) => row.from === "agent");
        const last = answers[answers.length - 1];
        const comms = (stats?.comms ?? []).filter((row) => row.name === agent.name);
        const asks = comms.filter((row) => row.dir === "to");
        const reports = comms.filter((row) => row.dir === "from");
        const rows = [...asks, ...(answers.length > 0 ? answers : reports)].sort(
            (a, b) => (a.at ?? 0) - (b.at ?? 0),
        );

        return html`<div class="ci-agent">
            <div class="ci-agent-head">
                <span class="ci-dot" style=${`background:var(--ci-${state.tone})`}></span>
                <b>${agent.name}</b>
                <span class="ci-chip">${t(state.label)}</span>
                ${agent.reporting && html`<span class="ci-chip">${t("reporting")}</span>`}
                <button
                    class="ci-button"
                    style="margin-left:auto;min-height:30px;padding:0 9px"
                    onClick=${() => pocket.openConversation(agent.conversationId)}
                >
                    ${t("Open")}
                </button>
            </div>
            ${agent.asked && html`<div class="ci-task"><span>${t("Task")}</span> ${agent.asked}</div>`}
            <div class="ci-step">
                ${
                    agentStats
                        ? html`<span
                                  >${fmt(agentStats.used)}${agentStats.window ? ` / ${fmt(agentStats.window)}` : ""}
                                  ${t("tokens")}</span
                              >
                              <span>${pct(agentStats.percent)}</span>
                              <span>${fmt(agentStats.steps?.length ?? 0)} ${t("requests")}</span>
                              <span>${money(usageCost(agentStats.usage))}</span>`
                        : ""
                }
                ${agent.askedAt === undefined ? "" : html`<span>${t("Asked")} ${timeOf(agent.askedAt)}</span>`}
                ${
                    agent.answeredAt === undefined
                        ? ""
                        : html`<span>${t("Answered")} ${timeOf(agent.answeredAt)}</span>`
                }
                ${
                    agent.askedAt !== undefined && agent.answeredAt !== undefined
                        ? html`<span
                              >${Math.max(0, Math.round((agent.answeredAt - agent.askedAt) / 1000))}s</span
                          >`
                        : ""
                }
            </div>
            ${last && html`<div class="ci-task"><span>${t("Last answer")}</span> ${last.text}</div>`}
            ${agent.error && html`<div class="ci-error">${agent.error}</div>`}
            <button class="ci-link" onClick=${() => setOpen(!open)}>
                ${open ? t("Hide messages") : `${t("Messages")} (${rows.length})`}
            </button>
            ${
                open &&
                (self.loading
                    ? html`<div class="ci-loading"><${pocket.Loader} /></div>`
                    : html`<${Chat} rows=${rows} />`)
            }
        </div>`;
    }

    function TaskBoard({ agents }) {
        return html`<div class="ci-card">
            <div class="ci-card-head">
                <b>${t("Tasks")}</b>
                <span>${agents.length}</span>
            </div>
            <div class="ci-body" style="padding:10px">
                <div class="ci-hint">
                    ${t("One task per subagent. Pi Pocket keeps no task dependencies.")}
                </div>
                ${["working", "waiting", "failed", "done"]
                    .map((key) => ({
                        key,
                        agents: agents.filter((agent) => agentState(agent).key === key),
                    }))
                    .filter((group) => group.agents.length > 0)
                    .map(
                        (group) =>
                            html`<div>
                                <div class="ci-group-title">
                                    ${t(GROUP_LABEL[group.key])} ${group.agents.length}
                                </div>
                                ${group.agents.map(
                                    (agent) =>
                                        html`<div class="ci-board-row">
                                            <span
                                                class=${`ci-dot ci-dot-${agentState(agent).tone}`}
                                            ></span>
                                            <span class="ci-board-name">${agent.name}</span>
                                            <span class="ci-board-task">${agent.asked ?? ""}</span>
                                            <span class="ci-board-time">
                                                ${agent.askedAt === undefined ? "" : timeOf(agent.askedAt)}
                                                ${
                                                    agent.askedAt !== undefined &&
                                                    agent.answeredAt !== undefined
                                                        ? ` · ${Math.max(0, Math.round((agent.answeredAt - agent.askedAt) / 1000))}s`
                                                        : ""
                                                }
                                            </span>
                                            <button
                                                class="ci-button"
                                                style="min-height:30px;padding:0 9px"
                                                onClick=${() => pocket.openConversation(agent.conversationId)}
                                            >
                                                ${t("Open")}
                                            </button>
                                        </div>`,
                                )}
                            </div>`,
                    )}
                ${agents.length === 0 && html`<div class="ci-empty">${t("No subagents yet.")}</div>`}
            </div>
        </div>`;
    }

    function Fleet({ id, stats }) {
        const [view, setView] = useState(store("x.context-insight.fleet") ?? "agents");

        const choose = (next) => {
            setView(next);
            store("x.context-insight.fleet", next);
        };

        const { agents, loading, error } = useFleet(id);
        const groups = ["working", "waiting", "failed", "done"].map((key) => ({
            key,
            agents: agents.filter((agent) => agentState(agent).key === key),
        }));

        return html`<div class="ci-body" style="padding:0">
            <div class="ci-toolbar" style="padding:0 2px">
                <div class="ci-switch">
                    <button aria-pressed=${view === "agents"} onClick=${() => choose("agents")}>
                        ${t("Agents")}
                    </button>
                    <button aria-pressed=${view === "tasks"} onClick=${() => choose("tasks")}>
                        ${t("Tasks")}
                    </button>
                </div>
            </div>
            ${view === "tasks" && html`<${TaskBoard} agents=${agents} />`}
            ${
                view === "agents" &&
                html`<div class="ci-card">
                    <div class="ci-card-head">
                        <b>${t("This session")}</b>
                        <span>${agents.length + 1} ${t("agents")}</span>
                    </div>
                    <div class="ci-body" style="padding:10px">
                        <div class="ci-step">
                            <span
                                >${fmt(stats.used)}${stats.window ? ` / ${fmt(stats.window)}` : ""}
                                ${t("tokens")}</span
                            >
                            <span>${stats.percent === undefined ? "" : pct(stats.percent)}</span>
                            <span>${fmt(stats.steps?.length ?? 0)} ${t("requests")}</span>
                        </div>
                    </div>
                </div>`
            }
            ${error && html`<div class="ci-error">${error}</div>`}
            ${loading && html`<div class="ci-loading"><${pocket.Loader} /></div>`}
            ${
                view === "agents" &&
                (!loading && agents.length === 0 && !error
                    ? html`<div class="ci-card">
                          <div class="ci-empty">${t("No subagents yet.")}</div>
                      </div>`
                    : groups
                          .filter((group) => group.agents.length > 0)
                          .map(
                              (group) =>
                                  html`<div class="ci-card">
                                      <div class="ci-card-head">
                                          <b>${t(GROUP_LABEL[group.key])}</b>
                                          <span>${group.agents.length}</span>
                                      </div>
                                      <div class="ci-body" style="padding:10px">
                                          ${group.agents.map(
                                              (agent) =>
                                                  html`<${AgentCard}
                                                      id=${agent.conversationId}
                                                      agent=${agent}
                                                      stats=${stats}
                                                  />`,
                                          )}
                                      </div>
                                  </div>`,
                          ))
            }
        </div>`;
    }

    function Panel() {
        const [id, setId] = useState(pocket.conversationId);

        useLang();
        const [tab, setTab] = useState(store("x.context-insight.tab") ?? defaults.tab ?? "current");
        const [selected, setSelected] = useState(null);
        const [filter, setFilter] = useState(null);
        const { data, error, busy, at, reload } = useSession(id);

        useEffect(() => pocket.onConversation(setId), []);

        const stats = data?.stats;
        const steps = stats?.steps ?? [];
        const step = selected === null ? steps.length - 1 : selected;
        const chosen = steps[step] ?? null;

        useEffect(() => {
            setSelected(null);
            setFilter(null);
        }, [id]);

        useEffect(() => {
            setSelected((old) => (old !== null && (old >= steps.length || old < 0) ? null : old));
        }, [steps.length]);

        const openTab = (next) => {
            setTab(next);
            store("x.context-insight.tab", next);
        };

        if (!id) {
            return html`<div class="ci ci-empty">${t("Open a session to see its context.")}</div>`;
        }

        return html`<div class="ci">
            <div class="ci-head">
                <div class="ci-title">
                    <span class="ci-sub">
                        ${stats?.model ? `${stats.model.provider}/${stats.model.model}` : t("no model yet")}
                        ${busy ? " · …" : at ? ` · ${timeOf(at)}` : ""}
                    </span>
                </div>
                <div class="ci-head-actions">
                    <button
                        class="ci-icon"
                        title=${t("Language")}
                        onClick=${() => setLang(lang() === "zh" ? "en" : "zh")}
                    >
                        ${lang() === "zh" ? "EN" : "中"}
                    </button>
                    <button class="ci-icon" title=${t("Refresh")} onClick=${reload}>
                        <${pocket.Icon} name="reload" />
                    </button>
                </div>
            </div>

            ${error && html`<div class="ci-error">${error}</div>`}
            ${!stats && !error && html`<div class="ci-loading"><${pocket.Loader} /></div>`}
            ${
                stats &&
                html`<${Hero} stats=${stats} />
                    ${
                        startsTruncated(stats) &&
                        html`<div class="ci-hint">
                            ${t("The oldest entries are left out of this view.")}
                        </div>`
                    }

                    <div class="ci-tabs">
                        ${[
                            ["current", t("Now")],
                            ["trend", t("Growth")],
                            ["browser", t("Items")],
                            ["events", t("Events")],
                            ["files", t("Files")],
                            ["commands", t("Commands")],
                            ["fleet", t("Fleet")],
                        ].map(
                            ([key, label]) =>
                                html`<button
                                    class="ci-tab"
                                    aria-selected=${tab === key}
                                    onClick=${() => openTab(key)}
                                >
                                    ${label}
                                </button>`,
                        )}
                    </div>

                    ${
                        tab === "current" &&
                        html`<div class="ci-card">
                            <div class="ci-card-head">
                                <b>${t("What the model carries")}</b>
                                <span>${fmt(stats.used)} ${t("tokens")}</span>
                            </div>
                            <div class="ci-body">
                                <div class="ci-kpis">
                                    <div class="ci-kpi">
                                        <small>${t("Requests")}</small>
                                        <b>${fmt(steps.length + (stats.stepsMore ?? 0))}</b>
                                    </div>
                                    <div class="ci-kpi">
                                        <small>${t("Tokens")}</small>
                                        <b>${fmt(usageTotals(stats.usage).total)}</b>
                                    </div>
                                    <div class="ci-kpi">
                                        <small>${t("Cost")}</small>
                                        <b>${money(usageTotals(stats.usage).cost)}</b>
                                    </div>
                                    <div class="ci-kpi">
                                        <small>${t("Cache")}</small>
                                        <b
                                            >${usageTotals(stats.usage).cache === null ? "—" : `${usageTotals(stats.usage).cache}%`}</b
                                        >
                                    </div>
                                </div>
                                <${Categories}
                                    parts=${stats.parts}
                                    total=${stats.used}
                                    filter=${filter}
                                    onFilter=${(next) => {
                                        setFilter(next);
                                        openTab("browser");
                                    }}
                                />
                                ${
                                    stats.sections?.length > 0 &&
                                    html`<div>
                                        <div class="ci-card-head" style="border:0;padding:2px 0">
                                            <b>${t("Prompt sections")}</b>
                                            <span>${stats.sections.length}</span>
                                        </div>
                                        ${stats.sections.slice(0, 12).map(
                                            (section) =>
                                                html`<div class="ci-cat">
                                                    <span
                                                        class="ci-swatch"
                                                        style="background:var(--ci-inject)"
                                                    ></span>
                                                    <span>${section.key}</span>
                                                    <small>${fmt(section.tokens)}</small>
                                                    <small>${t(section.group)}</small>
                                                </div>`,
                                        )}
                                    </div>`
                                }
                                ${
                                    stats.tools?.length > 0 &&
                                    html`<div>
                                        <div class="ci-card-head" style="border:0;padding:2px 0">
                                            <b>${t("Tool schemas")}</b>
                                            <span>${stats.tools.length}</span>
                                        </div>
                                        ${stats.tools.slice(0, 12).map(
                                            (tool) =>
                                                html`<div class="ci-cat">
                                                    <span
                                                        class="ci-swatch"
                                                        style="background:var(--ci-tools)"
                                                    ></span>
                                                    <span>${tool.name}</span>
                                                    <small>${fmt(tool.tokens)}</small>
                                                    <small class="ci-chip"
                                                        >${sourceLabel(tool)}</small
                                                    >
                                                </div>`,
                                        )}
                                    </div>`
                                }
                            </div>
                        </div>`
                    }
                    ${
                        tab === "trend" &&
                        html`<${Trend}
                                steps=${steps}
                                events=${stats.events ?? []}
                                selected=${step}
                                onSelect=${(picked) => {
                                    const at = steps.findIndex((each) => each.id === picked?.id);

                                    setSelected(at >= 0 ? at : null);
                                }}
                            />
                            <${StepCard} step=${chosen} />`
                    }
                    ${
                        tab === "browser" &&
                        html`<div class="ci-card">
                            <div class="ci-card-head">
                                <b>${t("Items in the context")}</b>
                                <span
                                    >${selected !== null && chosen ? `#${chosen.id}` : t("Now")}</span
                                >
                            </div>
                            <${Browser}
                                key=${id}
                                id=${id}
                                data=${data}
                                step=${selected !== null && chosen ? chosen.id : null}
                                setStep=${(next) => {
                                    const index = steps.findIndex((each) => each.id === next);

                                    setSelected(next !== null && index >= 0 ? index : null);
                                }}
                                filter=${filter}
                                setFilter=${setFilter}
                            />
                        </div>`
                    }
                    ${
                        tab === "events" &&
                        html`<${Events}
                            events=${stats.events ?? []}
                            onPick=${(index) => {
                                setSelected(index);
                                openTab("trend");
                            }}
                        />`
                    }
                    ${tab === "files" && html`<${Files} id=${id} files=${stats.files ?? []} />`}
                    ${tab === "commands" && html`<${Commands} commands=${stats.commands ?? []} />`}
                    ${tab === "fleet" && html`<${Fleet} id=${id} stats=${stats} />`}

                    <div class="ci-foot">
                        <span>${fmt(stats.entries)} ${t("entries")}</span>
                        <span>
                            ${stats.usage ? t("spend") + " " + money(usageCost(stats.usage)) : ""}
                        </span>
                    </div>`
            }
        </div>`;
    }

    /** A session's tokens, cost, and cache share, from `pi.usage`. */
    function usageTotals(usage) {
        let total = 0;
        let cost = 0;
        let input = 0;
        let cacheRead = 0;
        let cacheWrite = 0;

        for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) {
            for (const value of Object.values(bucket)) {
                input += Number(value?.input ?? 0);
                cacheRead += Number(value?.cacheRead ?? 0);
                cacheWrite += Number(value?.cacheWrite ?? 0);
                total += Number(value?.totalTokens ?? 0);
                cost += Number(value?.cost?.total ?? 0);
            }
        }

        const prompt = input + cacheRead + cacheWrite;

        return {
            total,
            cost,
            cache: prompt > 0 ? Math.round((cacheRead / prompt) * 100) : null,
        };
    }

    function usageCost(usage) {
        let cost = 0;

        for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) {
            for (const value of Object.values(bucket)) {
                cost += value?.cost?.total ?? 0;
            }
        }

        return cost;
    }

    function startsTruncated(stats) {
        return stats?.truncated === true;
    }

    function Quick({ close }) {
        useLang();
        const [id] = useState(pocket.conversationId);
        const { data, error, busy } = useSession(id);
        const stats = data?.stats;
        const allSteps = stats?.steps ?? [];
        const steps = allSteps.slice(-3).reverse();

        return html`<div class="ci">
            ${error && html`<div class="ci-error">${error}</div>`}
            ${!stats && !error && html`<div class="ci-loading"><${pocket.Loader} /></div>`}
            ${
                stats &&
                html`<${Hero} stats=${stats} />
                    <div class="ci-card">
                        <div class="ci-card-head">
                            <b>${t("What the model carries")}</b>
                            <span>${busy ? "…" : ""}</span>
                        </div>
                        <div class="ci-body">
                            <div class="ci-kpis">
                                <div class="ci-kpi">
                                    <small>${t("Requests")}</small>
                                    <b>${fmt(allSteps.length + (stats.stepsMore ?? 0))}</b>
                                </div>
                                <div class="ci-kpi">
                                    <small>${t("Tokens")}</small>
                                    <b>${fmt(usageTotals(stats.usage).total)}</b>
                                </div>
                                <div class="ci-kpi">
                                    <small>${t("Cost")}</small>
                                    <b>${money(usageTotals(stats.usage).cost)}</b>
                                </div>
                                <div class="ci-kpi">
                                    <small>${t("Cache")}</small>
                                    <b
                                        >${usageTotals(stats.usage).cache === null ? "—" : `${usageTotals(stats.usage).cache}%`}</b
                                    >
                                </div>
                            </div>
                            <${Categories}
                                parts=${stats.parts}
                                total=${stats.used}
                                filter=${null}
                                onFilter=${() => {}}
                            />
                        </div>
                    </div>
                    ${
                        steps.length > 0 &&
                        html`<div class="ci-card">
                            <div class="ci-card-head"><b>${t("Last requests")}</b></div>
                            ${steps.map(
                                (step) =>
                                    html`<div class="ci-event">
                                        <time>${timeOf(step.at)}</time>
                                        <span class="ci-event-kind"><b>#${step.id}</b></span>
                                        <small>${fmt(step.prompt)} · ${money(step.cost)}</small>
                                    </div>`,
                            )}
                        </div>`
                    }
                    <div style="display:flex;gap:8px">
                        <button
                            class="ci-button primary"
                            style="flex:1"
                            onClick=${() => {
                                close();
                                pocket.openPanel("context");
                            }}
                        >
                            ${t("Open the panel")}
                        </button>
                        <button class="ci-button" onClick=${close}>${t("Close")}</button>
                    </div>`
            }
        </div>`;
    }

    function Insights() {
        useLang();
        const [range, setRange] = useState(
            store("x.context-insight.range") ?? defaults.range ?? "7",
        );
        const [state, setState] = useState({
            loading: true,
            error: null,
            sessions: [],
            done: 0,
            total: 0,
        });

        const request = useRef(null);
        const load = useCallback(async () => {
            request.current?.abort();

            const stop = new AbortController();
            const signal = stop.signal;

            request.current = stop;
            setState((old) => ({ ...old, loading: true, error: null, done: 0 }));

            try {
                const list = await pocket.api("sessions", undefined, { signal });

                if (signal.aborted) {
                    return;
                }

                const sessions = (list.sessions ?? []).slice(0, 60);

                setState((old) => ({ ...old, sessions: [], total: sessions.length }));

                const rows = [];
                let done = 0;

                for (const session of sessions) {
                    try {
                        const insight = await pocket.api(`insight/${session.id}`, undefined, {
                            signal,
                        });

                        rows.push({ ...session, insight });
                    } catch {
                        // A session this person may no longer see, or one that fails to fold: leave it out.
                    }

                    if (signal.aborted) {
                        return;
                    }

                    done++;
                    setState((old) => ({ ...old, done, sessions: rows.slice() }));
                }

                setState({
                    loading: false,
                    error: null,
                    sessions: rows,
                    done,
                    total: sessions.length,
                });
            } catch (failure) {
                if (!signal.aborted) {
                    setState({
                        loading: false,
                        error: failure.message,
                        sessions: [],
                        done: 0,
                        total: 0,
                    });
                }
            }
        }, []);

        useEffect(() => {
            void load();

            return () => request.current?.abort();
        }, [load]);

        const days = Number(range);
        const since = Date.now() - (days === 0 ? 3650 : days) * 86_400_000;
        const daily = new Map();

        for (const row of state.sessions) {
            for (const [day, value] of Object.entries(row.insight?.days ?? {})) {
                const at = new Date(`${day}T12:00:00`).getTime();

                if (at < since) {
                    continue;
                }

                const current = daily.get(day) ?? { tokens: 0, cost: 0, steps: 0 };

                current.tokens += value.tokens;
                current.cost += value.cost;
                current.steps += value.steps;
                daily.set(day, current);
            }
        }

        const inRange = (row) => {
            let tokens = 0;
            let cost = 0;
            let steps = 0;

            for (const [day, value] of Object.entries(row.insight?.days ?? {})) {
                if (new Date(`${day}T12:00:00`).getTime() < since) {
                    continue;
                }

                tokens += value.tokens;
                cost += value.cost;
                steps += value.steps;
            }

            return { tokens, cost, steps };
        };

        const totals = state.sessions.reduce(
            (sum, row) => {
                const each = inRange(row);

                return {
                    sessions: sum.sessions + (each.steps > 0 ? 1 : 0),
                    tokens: sum.tokens + each.tokens,
                    cost: sum.cost + each.cost,
                    steps: sum.steps + each.steps,
                };
            },
            { sessions: 0, tokens: 0, cost: 0, steps: 0 },
        );

        const last7 = [];
        const start = new Date();

        start.setHours(0, 0, 0, 0);

        for (let index = 6; index >= 0; index--) {
            const date = new Date(start.getTime() - index * 86_400_000);
            const key = dayOf(date.getTime());
            const value = daily.get(key) ?? { tokens: 0, cost: 0 };

            last7.push({ key, label: `${date.getMonth() + 1}/${date.getDate()}`, ...value });
        }

        const most = Math.max(1, ...last7.map((day) => day.tokens));
        const heat = [];
        const heatStart = new Date(start.getTime() - 55 * 86_400_000);

        for (let index = 0; index < 56; index++) {
            const date = new Date(heatStart.getTime() + index * 86_400_000);
            const key = dayOf(date.getTime());
            const value = daily.get(key)?.tokens ?? 0;
            const level =
                value === 0
                    ? 0
                    : value < most * 0.05
                      ? 1
                      : value < most * 0.2
                        ? 2
                        : value < most * 0.5
                          ? 3
                          : 4;

            heat.push({ key, value, level });
        }

        const mix = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

        for (const row of state.sessions) {
            for (const value of Object.values(row.insight?.usage?.models ?? {})) {
                mix.input += Number(value?.input ?? 0);
                mix.output += Number(value?.output ?? 0);
                mix.cacheRead += Number(value?.cacheRead ?? 0);
                mix.cacheWrite += Number(value?.cacheWrite ?? 0);
            }
        }

        const mixAll = MIX.reduce((sum, key) => sum + mix[key], 0);

        const rows = state.sessions
            .map((row) => ({ ...row, range: inRange(row) }))
            .filter((row) => row.range.steps > 0 || Number(range) === 0)
            .sort((a, b) => b.updatedAt - a.updatedAt);

        return html`<div class="ci" style="max-width:980px;margin:0 auto">
            <div class="ci-head">
                <div class="ci-title">
                    <span class="ci-sub">${t("What your sessions carry, and what they cost")}</span>
                </div>
                <div class="ci-head-actions">
                    <button
                        class="ci-icon"
                        title=${t("Language")}
                        onClick=${() => setLang(lang() === "zh" ? "en" : "zh")}
                    >
                        ${lang() === "zh" ? "EN" : "中"}
                    </button>
                    <button class="ci-icon" onClick=${load} title=${t("Refresh")}>
                        <${pocket.Icon} name="reload" />
                    </button>
                </div>
            </div>

            <div class="ci-tabs">
                ${[
                    ["7", t("Last 7 days")],
                    ["30", t("Last 30 days")],
                    ["0", t("All")],
                ].map(
                    ([key, label]) =>
                        html`<button
                            class="ci-tab"
                            aria-selected=${range === key}
                            onClick=${() => {
                                setRange(key);
                                store("x.context-insight.range", key);
                            }}
                        >
                            ${label}
                        </button>`,
                )}
            </div>

            ${state.error && html`<div class="ci-error">${state.error}</div>`}
            ${
                state.loading &&
                html`<div class="ci-loading">
                    <${pocket.Loader} />
                    ${t("Reading sessions")} ${state.done}/${state.total}
                </div>`
            }

            <div class="ci-kpis">
                <div class="ci-kpi"><small>${t("Sessions")}</small><b>${totals.sessions}</b></div>
                <div class="ci-kpi"><small>${t("Tokens")}</small><b>${fmt(totals.tokens)}</b></div>
                <div class="ci-kpi"><small>${t("Cost")}</small><b>${money(totals.cost)}</b></div>
                <div class="ci-kpi"><small>${t("Requests")}</small><b>${fmt(totals.steps)}</b></div>
            </div>

            <div class="ci-card">
                <div class="ci-card-head">
                    <b>${t("Token mix")}</b><span>${t("all time")}</span>
                </div>
                <div class="ci-body">
                    <div class="ci-bar" style="height:14px">
                        ${MIX.map(
                            (key) =>
                                mix[key] > 0 &&
                                html`<span
                                    style=${`width:${(mix[key] / Math.max(1, mixAll)) * 100}%;background:var(--ci-${key})`}
                                    title=${`${key}: ${fmt(mix[key])}`}
                                ></span>`,
                        )}
                    </div>
                    <div class="ci-legend">
                        ${MIX.map(
                            (key) =>
                                html`<div class="ci-cat">
                                    <span
                                        class="ci-swatch"
                                        style=${`background:var(--ci-${key})`}
                                    ></span>
                                    <span>${t(MIX_LABEL[key])}</span>
                                    <small>${fmt(mix[key])}</small>
                                    <small
                                        >${mixAll > 0 ? Math.round((mix[key] / mixAll) * 100) : 0}%</small
                                    >
                                </div>`,
                        )}
                    </div>
                </div>
            </div>

            <div class="ci-card">
                <div class="ci-card-head">
                    <b>${t("Last 7 days")}</b><span>${t("tokens")}</span>
                </div>
                <div class="ci-body">
                    <div style="display:flex;align-items:flex-end;gap:6px;height:110px">
                        ${last7.map(
                            (day) =>
                                html`<div
                                    style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end"
                                >
                                    <span class="ci-hint">${fmt(day.tokens)}</span>
                                    <div
                                        style=${`width:100%;border-radius:4px 4px 0 0;background:var(--accent);height:${Math.max(2, (day.tokens / most) * 78)}px`}
                                    ></div>
                                    <span class="ci-hint">${day.label}</span>
                                </div>`,
                        )}
                    </div>
                </div>
            </div>

            <div class="ci-card">
                <div class="ci-card-head"><b>${t("Activity")}</b><span>${t("8 weeks")}</span></div>
                <div class="ci-body">
                    <div class="ci-heat">
                        ${heat.map(
                            (cell) =>
                                html`<span
                                    data-level=${cell.level}
                                    title=${`${cell.key}: ${fmt(cell.value)} tokens`}
                                ></span>`,
                        )}
                    </div>
                </div>
            </div>

            <div class="ci-card">
                <div class="ci-card-head"><b>${t("Sessions")}</b><span>${rows.length}</span></div>
                ${
                    rows.length === 0
                        ? html`<div class="ci-empty">${t("No sessions in this range.")}</div>`
                        : rows.map(
                              (row) =>
                                  html`<button
                                      class="ci-session"
                                      onClick=${() => pocket.openConversation(row.id)}
                                  >
                                      <span class="ci-session-title">${row.title}</span>
                                      <span class="ci-session-num">
                                          ${fmt(row.range.tokens)} · ${money(row.range.cost)}
                                      </span>
                                      <span class="ci-session-path">${row.cwd}</span>
                                  </button>`,
                          )
                }
            </div>

            <div class="ci-foot">
                <span>${t("Scanned")} ${state.sessions.length} ${t("sessions")}</span>
                <span>${t("The figures are Pi's own meter, anchored to each response.")}</span>
            </div>
        </div>`;
    }

    pocket.panel({
        id: "context",
        title: t("Context"),
        icon: "pulse",
        component: Panel,
    });

    pocket.composerButton({
        id: "context",
        title: t("Context"),
        icon: "pulse",
        sheet: "quick",
    });

    pocket.sheet({
        id: "quick",
        title: t("Context"),
        component: Quick,
        wide: true,
    });

    pocket.rail({
        id: "context-insights",
        title: t("Context Insights"),
        icon: "pulse",
        page: "insights",
    });

    pocket.page({
        id: "insights",
        title: t("Context Insights"),
        component: Insights,
    });

    pocket.menu({
        id: "context",
        label: t("Context"),
        group: "session",
        sheet: "quick",
    });
}
