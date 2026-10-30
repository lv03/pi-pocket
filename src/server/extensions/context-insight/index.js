export const pocketApi = 1;

import { cacheRate, duration, fmt, money, pct, timeOf, dayOf } from "./format.js";
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

let preferences = {};

let savePreferences = () => {};

const store = (key, value) => {
    const name = key.replace("x.context-insight.", "");

    if (value !== undefined) {
        preferences[name] = String(value);
        savePreferences();
    } else if (preferences[name] !== undefined) {
        return preferences[name];
    }

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
    const saved = await pocket.api("preferences").catch(() => null);

    if (disposed) {
        return;
    }

    preferences = {};

    for (const name of [
        "lang",
        "mode",
        "overview",
        "flat",
        "fleet",
        "tab",
        "range",
        "grouping",
        "metric",
    ]) {
        const local = store("x.context-insight." + name);

        if (local !== null && local !== undefined) {
            preferences[name] = local;
        }
    }

    Object.assign(preferences, saved?.preferences ?? {});

    if (preferences.lang) {
        setLang(preferences.lang);
    }

    let preferenceTimer;

    savePreferences = () => {
        clearTimeout(preferenceTimer);
        preferenceTimer = setTimeout(() => {
            pocket.api("preferences", { preferences }, { method: "PUT" }).catch(() => {});
        }, 350);
    };

    const offLanguage = subscribeLang((value) => store("x.context-insight.lang", value));

    pocket.onDispose(() => {
        clearTimeout(preferenceTimer);

        savePreferences = () => {};

        offLanguage();
    });

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

    function rowKey(row) {
        return (
            row.key ??
            (row.path !== undefined
                ? row.path
                : JSON.stringify([
                      row.id,
                      row.entry,
                      row.callId,
                      row.message,
                      row.part,
                      row.role,
                      row.label,
                      row.kind,
                      row.detail,
                      row.dir,
                      row.name,
                      row.at,
                      row.command,
                  ]))
        );
    }

    function mergeRows(first, second) {
        return [...new Map([...first, ...second].map((row) => [rowKey(row), row])).values()];
    }

    /** Page offsets come from the server. No page count is a client limit. */
    function usePages(path, field, seed = [], initialMore = 0) {
        const [state, setState] = useState({
            rows: [],
            next: 0,
            total: 0,
            busy: false,
            error: null,
            loaded: false,
        });
        const request = useRef(null);
        const currentPath = useRef(path);

        currentPath.current = path;
        useEffect(() => {
            request.current?.abort();
            setState({ rows: [], next: 0, total: 0, busy: false, error: null, loaded: false });

            return () => request.current?.abort();
        }, [path]);

        const load = async (reset = false) => {
            if (!path || (state.busy && !reset)) {
                return;
            }

            request.current?.abort();
            const stop = new AbortController();
            const requestedPath = path;
            const offset = reset ? 0 : state.next;

            if (offset === null) {
                return;
            }

            request.current = stop;
            setState((old) => ({ ...old, busy: true, error: null }));

            try {
                const data = await pocket.api(
                    path +
                        (path.includes("?") ? "&" : "?") +
                        "offset=" +
                        offset +
                        "&limit=200" +
                        (state.through !== undefined && !reset && !path.includes("through=")
                            ? "&through=" + encodeURIComponent(state.through)
                            : ""),
                    undefined,
                    { signal: stop.signal },
                );

                if (stop.signal.aborted || currentPath.current !== requestedPath) {
                    return;
                }

                setState((old) => ({
                    ...data,
                    rows: reset ? (data[field] ?? []) : mergeRows(old.rows, data[field] ?? []),
                    next: data.next ?? null,
                    total: data.total ?? 0,
                    loaded: true,
                    busy: false,
                    error: null,
                }));
            } catch (failure) {
                if (!stop.signal.aborted && currentPath.current === requestedPath) {
                    setState((old) => ({ ...old, busy: false, error: failure.message }));
                }
            }
        };

        const rows = mergeRows(state.rows, seed);

        return {
            ...state,
            rows,
            total: Math.max(state.total, seed.length + Number(initialMore || 0)),
            more: state.loaded ? state.next !== null : initialMore > 0,
            load,
        };
    }

    function Paging({ page, earlier = true }) {
        return html`<div class="ci-paging">
            <span class="ci-hint"
                >${fmt(page.rows.length)} / ${fmt(page.total)} ${t("Loaded")}</span
            >
            ${page.error && html`<span class="ci-error">${page.error}</span>`}
            ${
                (page.more || page.error) &&
                html`<button class="ci-button" disabled=${page.busy} onClick=${() => page.load()}>
                    ${page.busy ? t("Reading") : page.error ? t("Retry") : t(earlier ? "Load earlier" : "Load more")}
                </button>`
            }
        </div>`;
    }

    function useItems(id, step, filters) {
        const query = new URLSearchParams();

        for (const [key, value] of Object.entries(filters)) {
            if (value !== "" && value !== null) {
                query.set(key, value);
            }
        }

        const path = id ? `items/${id}${step === null ? "" : `/${step}`}?${query}` : null;
        const page = usePages(path, "items");

        useEffect(() => {
            void page.load(true);
        }, [path]);

        return page;
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
            <div class="ci-step">
                <span>${t("Capacity")}: <b>${window ? fmt(window) : "—"}</b></span
                ><span
                    >${t("Headroom")}:
                    <b>${window ? fmt(Math.max(0, window - used)) : "—"}</b></span
                >${window && used > window && html`<span class="ci-delta-up">${t("Over capacity")}: ${fmt(used - window)}</span>`}
            </div>
            <div class="ci-hint">
                ${t("Composition is estimated.")}
                ${t("Native context is reconstructed, not a captured final request.")}
            </div>
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

    function StepCard({ step, onItems }) {
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
                    <span>${t("Duration")} <b>${duration(step.durationMs)}</b></span>
                    <span>${t("Time to first token")} <b>${duration(step.ttftMs)}</b></span>
                    <span
                        >${t("Tokens per second")}
                        <b
                            >${(step.tokensPerSecond ?? step.outputTokensPerSecond)?.toFixed(1) ?? "—"}</b
                        ></span
                    >
                    ${step.model && html`<span>${step.model}</span>`}
                    ${onItems && html`<button class="ci-button" onClick=${onItems}>${t("Items and diff")}</button>`}
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

    function Trend({ steps, events, selected, onSelect, capacity }) {
        const [metric, setMetric] = useState(store("x.context-insight.metric") ?? "context");
        const [grouping, setGrouping] = useState(store("x.context-insight.grouping") ?? "step");
        const [bounds, setBounds] = useState(null);
        const [table, setTable] = useState(false);
        const drag = useRef(null);

        useEffect(() => setBounds(null), [steps.length]);
        const context = (row) => ORDER.reduce((sum, key) => sum + Number(row.parts?.[key] ?? 0), 0);
        const grouped = useMemo(() => {
            if (grouping === "step") {
                return steps;
            }

            const turns = new Map();

            for (const step of steps) {
                const row = turns.get(step.turn) ?? {
                    ...step,
                    prompt: 0,
                    output: 0,
                    cost: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    durationMs: undefined,
                    ttftMs: undefined,
                };

                for (const key of ["prompt", "output", "cost", "cacheRead", "cacheWrite"]) {
                    row[key] += step[key] ?? 0;
                }

                if (Number.isFinite(step.durationMs)) {
                    row.durationMs = (row.durationMs ?? 0) + step.durationMs;
                }

                row.ttftMs ??= step.ttftMs;
                Object.assign(row, { id: step.id, index: step.index, parts: step.parts });
                row.tokensPerSecond =
                    row.durationMs > 0 ? (row.output * 1000) / row.durationMs : undefined;
                turns.set(step.turn, row);
            }

            return [...turns.values()];
        }, [steps, grouping]);
        const length = grouped.length;
        const low = Math.min(bounds?.[0] ?? 0, Math.max(0, length - 1));
        const high = Math.max(low, Math.min(bounds?.[1] ?? length - 1, length - 1));
        const visible = grouped.slice(low, high + 1);
        const valueOf = (row, index) =>
            metric === "context"
                ? context(row)
                : metric === "delta"
                  ? context(row) - (index > 0 ? context(grouped[index - 1]) : 0)
                  : metric === "cache"
                    ? cacheRate(row.prompt, row.cacheRead)
                    : metric === "duration"
                      ? row.durationMs
                      : metric === "ttft"
                        ? row.ttftMs
                        : metric === "throughput"
                          ? (row.tokensPerSecond ?? row.outputTokensPerSecond)
                          : row[metric];
        const values = visible.map((row, index) => valueOf(row, low + index));
        const most = Math.max(
            1,
            metric === "context" ? (capacity ?? 0) : 0,
            ...values.filter(Number.isFinite).map(Math.abs),
        );
        const display = (value) =>
            value == null
                ? "—"
                : ["duration", "ttft"].includes(metric)
                  ? duration(value)
                  : metric === "cost"
                    ? money(value)
                    : metric === "cache"
                      ? pct(value)
                      : metric === "throughput"
                        ? value.toFixed(1)
                        : fmt(value);
        const x = (index) => 40 + ((index + 0.5) * 840) / Math.max(1, visible.length);
        const barWidth = 840 / Math.max(1, visible.length);
        const center = metric === "delta" ? 88 : 150;
        const plotHeight = metric === "delta" ? 62 : 125;
        const ribbonMax = Math.max(1, ...grouped.map(context));
        const ribbon = grouped
            .map(
                (row, index) =>
                    `${40 + (index / Math.max(1, length - 1)) * 840},${45 - (context(row) / ribbonMax) * 38}`,
            )
            .join(" ");

        const brushIndex = (event) => {
            const rect = event.currentTarget.getBoundingClientRect();

            return Math.max(
                0,
                Math.min(
                    length - 1,
                    Math.round(
                        ((((event.clientX - rect.left) / rect.width) * 900 - 40) / 840) *
                            Math.max(1, length - 1),
                    ),
                ),
            );
        };

        const choose = (name, value) => {
            if (name === "metric") {
                setMetric(value);
            } else {
                setGrouping(value);
                setBounds(null);
            }

            store("x.context-insight." + name, value);
        };

        return html`<div class="ci-card">
            <div class="ci-card-head">
                <b>${t("Growth")}</b
                ><span>${length} ${t(grouping === "step" ? "Requests" : "Turns")}</span>
            </div>
            <div class="ci-body">
                <div class="ci-toolbar">
                    <div class="ci-switch">
                        ${["step", "turn"].map((key) => html`<button aria-pressed=${grouping === key} onClick=${() => choose("grouping", key)}>${t(key === "step" ? "Step" : "Turn")}</button>`)}
                    </div>
                    <select
                        aria-label=${t("Metric")}
                        value=${metric}
                        onChange=${(event) => choose("metric", event.currentTarget.value)}
                    >
                        ${[
                            ["context", "Context"],
                            ["delta", "Delta"],
                            ["output", "Output"],
                            ["cache", "Cache"],
                            ["cost", "Cost"],
                            ["duration", "Duration"],
                            ["ttft", "Time to first token"],
                            ["throughput", "Tokens per second"],
                        ].map(([key, label]) => html`<option value=${key}>${t(label)}</option>`)}
                    </select>
                </div>
                ${
                    length === 0
                        ? html`<div class="ci-empty">${t("No requests yet.")}</div>`
                        : html`<div class="ci-chart">
                                  <svg
                                      width="100%"
                                      viewBox="0 0 900 180"
                                      role="img"
                                      aria-label=${t("Context by request")}
                                  >
                                      <text x="2" y="18" fill="var(--muted)" font-size="13">
                                          ${display(most)}
                                      </text>
                                      <line
                                          x1="40"
                                          x2="880"
                                          y1=${center}
                                          y2=${center}
                                          stroke="var(--line)"
                                      />
                                      ${metric === "context" && capacity > 0 && html`<line x1="40" x2="880" y1=${150 - (capacity / most) * plotHeight} y2=${150 - (capacity / most) * plotHeight} stroke="var(--warn)" stroke-dasharray="5 3"><title>${t("Capacity")}</title></line>`}
                                      ${visible.map((row, index) => {
                                          const value = values[index];
                                          let stacked = 0;

                                          return html`<g
                                              role="button"
                                              tabindex="0"
                                              aria-label=${`#${row.id} · ${display(value)}`}
                                              onClick=${() => onSelect(row)}
                                              onKeyDown=${(event) => {
                                                  if (["Enter", " "].includes(event.key)) {
                                                      event.preventDefault();
                                                      onSelect(row);
                                                  }
                                              }}
                                              ><title>
                                                  ${`#${row.id}: ${display(value)} · ${timeOf(row.at)}`}</title
                                              ><rect
                                                  x=${x(index) - barWidth / 2}
                                                  y="20"
                                                  width=${barWidth}
                                                  height="135"
                                                  fill="transparent"
                                              />
                                              ${
                                                  metric === "context"
                                                      ? ORDER.map((key) => {
                                                            const amount = row.parts?.[key] ?? 0;
                                                            const top =
                                                                150 -
                                                                ((stacked + amount) / most) *
                                                                    plotHeight;

                                                            stacked += amount;

                                                            return html`<rect
                                                                x=${x(index) - barWidth * 0.45}
                                                                y=${top}
                                                                width=${barWidth * 0.9}
                                                                height=${(amount / most) * plotHeight}
                                                                fill=${`var(--ci-${key})`}
                                                            />`;
                                                        })
                                                      : Number.isFinite(value) &&
                                                        html`<rect
                                                            x=${x(index) - barWidth * 0.4}
                                                            y=${value < 0 ? center : center - (Math.abs(value) / most) * plotHeight}
                                                            width=${barWidth * 0.8}
                                                            height=${Math.max(1, (Math.abs(value) / most) * plotHeight)}
                                                            fill=${value < 0 ? "var(--ok)" : "var(--accent)"}
                                                        />`
                                              }
                                              ${(row.id === steps[selected]?.id || (grouping === "turn" && row.turn === steps[selected]?.turn)) && html`<line x1=${x(index)} x2=${x(index)} y1="20" y2="155" stroke="var(--text)" stroke-width="2" />`}</g
                                          >`;
                                      })}
                                      ${events
                                          .filter((event) =>
                                              ["compact", "reset"].includes(event.kind),
                                          )
                                          .map((event) => {
                                              const index = visible.findIndex((row) =>
                                                  event.stepId
                                                      ? row.id >= event.stepId
                                                      : row.index >= event.step,
                                              );

                                              return (
                                                  index >= 0 &&
                                                  html`<line
                                                      x1=${x(index)}
                                                      x2=${x(index)}
                                                      y1="20"
                                                      y2="150"
                                                      stroke="var(--muted)"
                                                      stroke-dasharray="2 4"
                                                      ><title>
                                                          ${t(EVENT_LABEL[event.kind])}
                                                      </title></line
                                                  >`
                                              );
                                          })}
                                      <text x="40" y="176" fill="var(--muted)" font-size="13">
                                          #${visible[0]?.id}
                                      </text>
                                      <text
                                          x="880"
                                          y="176"
                                          text-anchor="end"
                                          fill="var(--muted)"
                                          font-size="13"
                                      >
                                          #${visible.at(-1)?.id}
                                      </text>
                                  </svg>
                              </div>
                              <div class="ci-ribbon" data-no-swipe>
                                  <svg
                                      width="100%"
                                      viewBox="0 0 900 52"
                                      aria-label=${t("Drag to zoom")}
                                      onPointerDown=${(event) => {
                                          drag.current = brushIndex(event);
                                          event.currentTarget.setPointerCapture?.(event.pointerId);
                                          setBounds([drag.current, drag.current]);
                                      }}
                                      onPointerMove=${(event) => {
                                          if (drag.current !== null) {
                                              const end = brushIndex(event);

                                              setBounds([
                                                  Math.min(drag.current, end),
                                                  Math.max(drag.current, end),
                                              ]);
                                          }
                                      }}
                                      onPointerUp=${() => {
                                          drag.current = null;
                                      }}
                                      onPointerCancel=${() => {
                                          drag.current = null;
                                      }}
                                  >
                                      <polyline
                                          points=${ribbon}
                                          fill="none"
                                          stroke="var(--accent)"
                                          stroke-width="2"
                                      />
                                      <rect
                                          x=${40 + (low / Math.max(1, length)) * 840}
                                          y="1"
                                          width=${Math.max(3, ((high - low + 1) / Math.max(1, length)) * 840)}
                                          height="49"
                                          fill="var(--accent)"
                                          fill-opacity="0.15"
                                          stroke="var(--text)"
                                      />
                                  </svg>
                                  <div class="ci-brush">
                                      <label
                                          >${t("From")}<input
                                              type="range"
                                              min="0"
                                              max=${Math.max(0, length - 1)}
                                              value=${low}
                                              onInput=${(event) => setBounds([Math.min(Number(event.currentTarget.value), high), high])} /></label
                                      ><label
                                          >${t("To")}<input
                                              type="range"
                                              min="0"
                                              max=${Math.max(0, length - 1)}
                                              value=${high}
                                              onInput=${(event) => setBounds([low, Math.max(low, Number(event.currentTarget.value))])}
                                      /></label>
                                  </div>
                              </div>
                              <div class="ci-toolbar">
                                  <span class="ci-hint"
                                      >${low + 1}–${high + 1} / ${length} ·
                                      ${t("Drag to zoom")}</span
                                  ><button class="ci-button" onClick=${() => setBounds(null)}>
                                      ${t("Reset zoom")}
                                  </button>
                              </div>`
                }
                <div class="ci-hint">
                    ${t("Missing timing values are unavailable.")}
                    ${grouping === "turn" ? t("Turn context uses the last request; usage and duration are summed.") : ""}
                </div>
                <button class="ci-button" aria-expanded=${table} onClick=${() => setTable(!table)}>
                    ${t("Usage and timing table")}
                </button>
                ${
                    table &&
                    html`<div class="ci-table-wrap">
                        <table class="ci-table">
                            <thead>
                                <tr>
                                    ${["Request", "Turn", "Input", "Output", "Cache read", "Cache write", "Cost", "Duration", "Time to first token", "Tokens per second"].map((label) => html`<th>${t(label)}</th>`)}
                                </tr>
                            </thead>
                            <tbody>
                                ${visible.map(
                                    (row) =>
                                        html`<tr
                                            data-selected=${row.id === steps[selected]?.id ? "1" : "0"}
                                        >
                                            <td>
                                                <button
                                                    class="ci-link"
                                                    onClick=${() => onSelect(row)}
                                                >
                                                    #${row.id}
                                                </button>
                                            </td>
                                            <td>${row.turn}</td>
                                            <td>
                                                ${fmt(Math.max(0, row.prompt - row.cacheRead - row.cacheWrite))}
                                            </td>
                                            <td>${fmt(row.output)}</td>
                                            <td>${fmt(row.cacheRead)}</td>
                                            <td>${fmt(row.cacheWrite)}</td>
                                            <td>${money(row.cost)}</td>
                                            <td>${duration(row.durationMs)}</td>
                                            <td>${duration(row.ttftMs)}</td>
                                            <td>
                                                ${(row.tokensPerSecond ?? row.outputTokensPerSecond)?.toFixed(1) ?? "—"}
                                            </td>
                                        </tr>`,
                                )}
                            </tbody>
                        </table>
                    </div>`
                }
            </div>
        </div>`;
    }

    function ImageCard({ id, entry, index, locator }) {
        const [src, setSrc] = useState(null);
        const [failed, setFailed] = useState(null);

        useEffect(() => {
            const stop = new AbortController();

            setSrc(null);
            setFailed(null);
            const location = new URLSearchParams();

            if (locator?.message !== undefined) {
                location.set("message", locator.message);
            }

            if (locator?.edit?.index !== undefined) {
                location.set("edit", locator.edit.index);
            }

            const query = location.size > 0 ? `?${location}` : "";

            pocket
                .api(`image/${id}/${entry}/${index}${query}`, undefined, { signal: stop.signal })
                .then(
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
        }, [id, entry, index, locator?.message, locator?.edit?.index]);

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
            <${FullText} text=${entryText(state.entry)} />
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

        return text;
    }

    function FullText({ text }) {
        const [shown, setShown] = useState(1);
        const size = 24000;
        const value = typeof text === "string" ? text : JSON.stringify(text ?? "", null, 2);
        const count = Math.max(1, Math.ceil(value.length / size));

        useEffect(() => setShown(1), [value]);

        return html`<div>
            <pre class="ci-pre">${value.slice(0, shown * size)}</pre>
            ${
                count > 1 &&
                html`<div class="ci-paging">
                    <span class="ci-hint"
                        >${Math.min(shown, count)} / ${count} ${t("Content chunks")} ·
                        ${value.length.toLocaleString()} ${t("characters")}</span
                    >
                    ${shown < count && html`<button class="ci-button" onClick=${() => setShown(shown + 1)}>${t("Show next chunk")}</button>`}
                </div>`
            }
        </div>`;
    }

    function Accuracy({ value }) {
        const source =
            typeof value === "string"
                ? value
                : (value?.request ??
                  value?.source ??
                  value?.reconstruction ??
                  "transcript-reconstruction");
        const captured =
            String(source).includes("captured") ||
            String(source).includes("normalized-after-hooks");

        return html`<div class="ci-inset">
            <div class="ci-hint">
                ${t(captured ? "Captured final normalized request." : "Native context is reconstructed, not a captured final request.")}
            </div>
            <${Metadata} label="Accuracy" value=${value} />
        </div>`;
    }

    function Metadata({ value, label = "Metadata" }) {
        if (value === undefined || value === null) {
            return null;
        }

        return html`<details class="ci-details">
            <summary>${t(label)}</summary>
            <${FullText} text=${JSON.stringify(value, null, 2)} />
        </details>`;
    }

    function ItemDetail({ id, item, step }) {
        const [state, setState] = useState({ busy: true, item: null, error: null });
        const [retry, setRetry] = useState(0);

        useEffect(() => {
            const stop = new AbortController();
            const query = new URLSearchParams({ key: item.key ?? rowKey(item) });

            if (step !== null) {
                query.set("step", step);
            }

            setState({ busy: true, item: null, error: null });
            pocket.api(`detail/${id}?${query}`, undefined, { signal: stop.signal }).then(
                (data) => {
                    if (!stop.signal.aborted) {
                        setState({ busy: false, item: data.item, error: null });
                    }
                },
                (failure) => {
                    if (!stop.signal.aborted) {
                        setState({ busy: false, item: null, error: failure.message });
                    }
                },
            );

            return () => stop.abort();
        }, [id, item.key, step, retry]);

        if (state.busy) {
            return html`<div class="ci-body"><${pocket.Loader} /></div>`;
        }

        if (state.error) {
            return html`<div class="ci-body">
                <span class="ci-error">${state.error}</span
                ><button class="ci-button" onClick=${() => setRetry(retry + 1)}>
                    ${t("Retry")}
                </button>
            </div>`;
        }

        const detail = state.item;

        if (!detail) {
            return html`<div class="ci-hint">${t("Selected content is unavailable.")}</div>`;
        }

        const image = detail.image;
        const locator = detail.locator ?? {};
        const imageEntry = image?.entry ?? image?.entryId ?? locator.entry ?? detail.entry;
        const imageIndex =
            locator.imageIndex ??
            image?.locator?.imageIndex ??
            image?.index ??
            image?.imageIndex ??
            detail.imageIndex;

        return html`<div class="ci-detail">
            <div class="ci-step">
                <span>${t("full content")}</span><span>${detail.tokenMethod ?? ""}</span>
            </div>
            ${image && Number.isInteger(imageIndex) && html`<${ImageCard} id=${id} entry=${imageEntry} index=${imageIndex} locator=${locator} />`}
            ${
                detail.text !== undefined
                    ? html`<${FullText} text=${detail.text} />`
                    : detail.parameters !== undefined
                      ? html`<${FullText}
                            text=${JSON.stringify({ description: detail.description, parameters: detail.parameters }, null, 2)}
                        />`
                      : detail.content !== undefined
                        ? html`<${FullText} text=${detail.content} />`
                        : html`<div class="ci-hint">${t("No recorded text.")}</div>`
            }
            ${detail.contentComplete === false && html`<div class="ci-hint">${t("Only the stored content is available.")}</div>`}
            <${Metadata}
                label="Provenance"
                value=${detail.provenance ?? detail.attribution ?? locator}
            />
            <${Metadata}
                value=${detail.metadata ?? { image, source: detail.source, role: detail.role, accuracy: detail.accuracy }}
            />
            ${detail.entry > 0 && typeof pocket.reveal === "function" && html`<button class="ci-link" onClick=${() => pocket.reveal(String(detail.entry)).catch(() => false)}>${t("Open the entry")}</button>`}
        </div>`;
    }

    function Diff({ id, step, onItem }) {
        const [base, setBase] = useState("previous");
        const [explicit, setExplicit] = useState("");
        const [state, setState] = useState({ busy: false, data: null, error: null });
        const chosenBase = base === "entry" ? explicit : base;

        useEffect(() => {
            if (step === null || chosenBase === "") {
                setState({ busy: false, data: null, error: null });

                return;
            }

            const stop = new AbortController();

            setState({ busy: true, data: null, error: null });
            pocket
                .api(`diff/${id}/${step}?base=${encodeURIComponent(chosenBase)}`, undefined, {
                    signal: stop.signal,
                })
                .then(
                    (data) => !stop.signal.aborted && setState({ busy: false, data, error: null }),
                    (error) =>
                        !stop.signal.aborted &&
                        setState({ busy: false, data: null, error: error.message }),
                );

            return () => stop.abort();
        }, [id, step, chosenBase]);

        return html`<details class="ci-details">
            <summary>${t("Context diff")}</summary>
            <label class="ci-field"
                >${t("Compare with")}<select
                    value=${base}
                    onChange=${(event) => setBase(event.currentTarget.value)}
                >
                    <option value="previous">${t("Previous request")}</option>
                    <option value="turn">${t("Turn start")}</option>
                    <option value="entry">${t("Entry ID")}</option>
                </select></label
            >
            ${base === "entry" && html`<input type="number" min="1" value=${explicit} aria-label=${t("Entry ID")} onInput=${(event) => setExplicit(event.currentTarget.value)} />`}
            ${step === null && html`<div class="ci-hint">${t("Select a request to compare.")}</div>`}
            ${state.busy && html`<${pocket.Loader} />`}
            ${state.error && html`<div class="ci-error">${state.error}</div>`}
            ${
                state.data &&
                ["added", "removed", "changed"].map(
                    (kind) =>
                        html`<div>
                            <b>${t(kind)} · ${state.data[kind]?.length ?? 0}</b>
                            ${(state.data[kind] ?? []).map((change) => {
                                const item = change.after ?? change.before ?? change.item ?? change;
                                const targetStep =
                                    kind === "removed"
                                        ? (state.data.base?.id ?? state.data.base)
                                        : step;

                                return html`<button
                                    class="ci-item"
                                    onClick=${() => onItem(item, targetStep)}
                                >
                                    <span>${item.label ?? item.key}</span
                                    ><small>${fmt(item.tokens)}</small>
                                </button>`;
                            })}
                        </div>`,
                )
            }
        </details>`;
    }

    function Browser({ id, data, step, setStep, filter, setFilter }) {
        const [openKey, setOpenKey] = useState(null);
        const [query, setQuery] = useState("");
        const [role, setRole] = useState("");
        const [source, setSource] = useState("");
        const [flat, setFlat] = useState(store("x.context-insight.flat") === "1");
        const [diffItem, setDiffItem] = useState(null);
        const page = useItems(id, step, {
            q: query,
            category: filter,
            role,
            source,
            through: data?.stats?.through ?? null,
        });
        const items = [...page.rows].sort((a, b) => {
            const aPinned = a.entry === 0 ? 0 : 1;
            const bPinned = b.entry === 0 ? 0 : 1;

            return (
                (a.order ?? 0) - (b.order ?? 0) ||
                aPinned - bPinned ||
                (a.entry ?? 0) - (b.entry ?? 0) ||
                (a.locator?.message ?? a.message ?? 0) - (b.locator?.message ?? b.message ?? 0) ||
                (a.part ?? 0) - (b.part ?? 0)
            );
        });
        const groups = ORDER.map((key) => ({
            key,
            items: items.filter((item) => item.category === key),
        })).filter((group) => group.items.length > 0);
        const sum = items.reduce((total, item) => total + Number(item.tokens || 0), 0);

        useEffect(() => {
            setOpenKey(null);
            setDiffItem(null);
        }, [id, step]);

        const select = (item) => setOpenKey(openKey === rowKey(item) ? null : rowKey(item));
        const itemRow = (item, index) =>
            html`<div key=${rowKey(item)}>
                <button
                    class="ci-item"
                    data-open=${openKey === rowKey(item) ? "1" : "0"}
                    onClick=${() => select(item)}
                >
                    <span class="ci-item-main"
                        ><span class="ci-item-label">
                            ${flat && html`<small>#${index + 1}</small>`}<span class="ci-item-name"
                                >${itemLabel(item)}</span
                            >
                            ${item.role === "schema" && html`<small class="ci-chip">${sourceLabel(item)}</small>`}
                            ${item.entry > 0 && html`<small>#${item.entry}</small>`} </span
                        ><span class="ci-item-preview">${item.preview}</span></span
                    ><span class="ci-item-tokens">${fmt(item.tokens)}</span>
                </button>
                ${openKey === rowKey(item) && html`<${ItemDetail} id=${id} item=${item} step=${step} />`}
            </div>`;

        return html`<div class="ci-body" style="padding:0">
            <div class="ci-toolbar ci-inset">
                <span>${step === null ? t("Now") : `${t("Request")} #${step}`}</span>
                <div class="ci-switch">
                    <button aria-pressed=${step === null} onClick=${() => setStep(null)}>
                        ${t("Now")}</button
                    ><button
                        aria-pressed=${step !== null}
                        disabled=${lastStep(data) === null}
                        onClick=${() => setStep(lastStep(data))}
                    >
                        ${t("Last request")}
                    </button>
                </div>
            </div>
            <div class="ci-filters ci-inset">
                <input
                    type="search"
                    value=${query}
                    placeholder=${t("Filter items")}
                    aria-label=${t("Filter items")}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                />
                <select
                    aria-label=${t("All categories")}
                    value=${filter ?? ""}
                    onChange=${(event) => setFilter(event.currentTarget.value || null)}
                >
                    <option value="">${t("All categories")}</option>
                    ${ORDER.map((key) => html`<option value=${key}>${t(SHORT[key])}</option>`)}
                </select>
                <select
                    aria-label=${t("Role")}
                    value=${role}
                    onChange=${(event) => setRole(event.currentTarget.value)}
                >
                    <option value="">${t("All roles")}</option>
                    ${["section", "schema", "user", "answers", "thinking", "toolCall", "tool"].map((key) => html`<option value=${key}>${t(key)}</option>`)}
                </select>
                <input
                    value=${source}
                    placeholder=${t("Source")}
                    aria-label=${t("Source")}
                    onInput=${(event) => setSource(event.currentTarget.value)}
                />
            </div>
            <div class="ci-toolbar ci-inset">
                <span class="ci-hint"
                    >${t("Reading order")} · ${t("Composition is estimated.")}</span
                >
                <div class="ci-switch">
                    ${[false, true].map(
                        (value) =>
                            html`<button
                                aria-pressed=${flat === value}
                                onClick=${() => {
                                    setFlat(value);
                                    store("x.context-insight.flat", value ? "1" : "0");
                                }}
                            >
                                ${t(value ? "DNA" : "Grouped")}
                            </button>`,
                    )}
                </div>
            </div>
            <${Accuracy} value=${page.accuracy} />
            ${
                flat &&
                html`<div class="ci-dna" role="group" aria-label=${t("Token-width DNA")}>
                        ${items.map((item) => html`<button key=${rowKey(item)} style=${`flex:${Math.max(1, item.tokens)} 0 0;background:var(--ci-${item.category})`} aria-pressed=${openKey === rowKey(item)} title=${`${itemLabel(item)} · ${fmt(item.tokens)} ${t("tokens")}`} aria-label=${itemLabel(item)} onClick=${() => select(item)}></button>`)}
                    </div>
                    <div class="ci-hint ci-inset">
                        ${fmt(sum)} ${t("tokens")} ·
                        ${t("Loaded items only; load earlier to extend DNA.")}
                    </div>`
            }
            ${page.busy && html`<div class="ci-loading ci-inset"><${pocket.Loader} /></div>`}
            ${
                flat
                    ? items.map(itemRow)
                    : groups.map(
                          (group) =>
                              html`<div class="ci-group">
                                  <div class="ci-group-head">
                                      <span
                                          class="ci-swatch"
                                          style=${`background:var(--ci-${group.key})`}
                                      ></span
                                      ><span>${t(SHORT[group.key])}</span
                                      ><small
                                          >${fmt(group.items.reduce((total, item) => total + item.tokens, 0))}</small
                                      ><small>${group.items.length}</small>
                                  </div>
                                  ${group.items.map(itemRow)}
                              </div>`,
                      )
            }
            ${!page.busy && items.length === 0 && html`<div class="ci-empty">${t("Nothing here now.")}</div>`}
            <${Paging} page=${page} />
            <${Diff}
                id=${id}
                step=${step}
                onItem=${(item, targetStep) => setDiffItem({ item, step: targetStep })}
            />
            ${diffItem && html`<div class="ci-inset"><button class="ci-button" onClick=${() => setDiffItem(null)}>${t("Close")}</button><${ItemDetail} id=${id} item=${diffItem.item} step=${diffItem.step} /></div>`}
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
                                      onClick=${() => (event.stepId !== undefined || event.step !== undefined) && onPick(event)}
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
        const [status, setStatus] = useState("");
        const shown = files.filter(
            (file) =>
                file.path.toLowerCase().includes(query.trim().toLowerCase()) &&
                (!status ||
                    (file.ops ?? []).some((op) =>
                        status === "error"
                            ? op.error || op.status === "error"
                            : !op.status || op.completeness === "unknown",
                    )),
        );

        return html`<div class="ci-card">
            <div class="ci-card-head"><b>${t("Files")}</b><span>${files.length}</span></div>
            <div class="ci-filters ci-inset">
                <input
                    type="search"
                    value=${query}
                    placeholder=${t("Filter a path")}
                    aria-label=${t("Filter a path")}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                /><select
                    value=${status}
                    aria-label=${t("Status")}
                    onChange=${(event) => setStatus(event.currentTarget.value)}
                >
                    <option value="">${t("All")}</option>
                    <option value="error">${t("Failed")}</option>
                    <option value="unknown">${t("Unknown")}</option>
                </select>
            </div>
            ${shown.length === 0 && html`<div class="ci-empty">${t("No files touched yet.")}</div>`}
            ${shown.map(
                (file) =>
                    html`<details class="ci-details">
                        <summary>
                            <span class="ci-file-path">${file.path}</span
                            ><span class="ci-hint">
                                R${file.read} W${file.written} E${file.edited} ·
                                +${file.added}/−${file.removed}</span
                            >
                        </summary>
                        ${(file.ops ?? []).map(
                            (op) =>
                                html`<details class="ci-details">
                                    <summary>
                                        ${op.kind} · #${op.entry} · ${timeOf(op.at)} ·
                                        ${t(op.error ? "Failed" : (op.status ?? "Unknown"))}
                                    </summary>
                                    <div class="ci-step">
                                        <span
                                            >${t("Completeness")}:
                                            ${t(op.completeness ?? "unknown")}</span
                                        ><span>${t("Tool")}: ${op.tool ?? "—"}</span>
                                    </div>
                                    <${Metadata}
                                        label="Requested read range"
                                        value=${op.requested ?? (op.kind === "read" ? { status: t("Unknown") } : undefined)}
                                    />
                                    <${Metadata}
                                        label="Returned read range"
                                        value=${op.returned ?? (op.kind === "read" ? { status: t("Unknown") } : undefined)}
                                    />
                                    <${Metadata}
                                        label="Provenance"
                                        value=${{ call: op.call, callId: op.callId, entry: op.entry, nested: op.nested, changedLinesMethod: op.changedLinesMethod }}
                                    />
                                    <${Metadata} label="Arguments" value=${op.arguments} />
                                    <${Metadata}
                                        label="Recorded diff"
                                        value=${op.diff ?? op.details?.diff ?? (op.kind === "edit" ? op.arguments?.edits : undefined)}
                                    />
                                    <${Metadata} value=${op.details} /><${Metadata}
                                        label="Matches"
                                        value=${op.matches}
                                    />
                                    ${
                                        op.output !== undefined
                                            ? html`<div class="ci-hint">
                                                      ${t("Recorded output")}
                                                  </div>
                                                  <${FullText} text=${op.output} />`
                                            : html`<div class="ci-hint">
                                                      ${t("Only stored tool content can be shown.")}
                                                  </div>
                                                  <${FileText}
                                                      id=${id}
                                                      entry=${op.kind === "read" ? op.entry : (op.call ?? op.entry)}
                                                      kind=${op.kind}
                                                  />`
                                    }
                                </details>`,
                        )}
                    </details>`,
            )}
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

        return html`<${FullText} text=${fileText(state.entry, kind)} />`;
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
                            .map((edit) =>
                                JSON.stringify(
                                    { oldText: edit?.oldText, newText: edit?.newText },
                                    null,
                                    2,
                                ),
                            )
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

    function CommandOutput({ id, row }) {
        const [lookup, setLookup] = useState(false);

        return html`<div class="ci-body">
            <div class="ci-step">
                <span>${t("Status")}: ${t(row.status ?? "unknown")}</span
                ><span>${t("Duration")}: ${duration(row.ms)}</span
                ><span>${row.durationMethod ?? ""}</span>
            </div>
            <${FullText} text=${row.command} />
            <div class="ci-hint">
                ${t(row.fullOutput !== undefined ? "Full recorded output" : "Recorded output preview")}
                · ${t("Unstored output cannot be recovered.")}
            </div>
            <${FullText} text=${row.fullOutput ?? row.output ?? t("No recorded text.")} />
            ${row.fullOutput === undefined && row.entry && html`<button class="ci-button" onClick=${() => setLookup(!lookup)}>${t("Stored result entry")}</button>`}
            ${lookup && html`<${EntryText} id=${id} entry=${row.entry} />`}
            <${Metadata}
                label="Provenance"
                value=${{ entry: row.entry, callId: row.callId, nested: row.nested, backgroundId: row.backgroundId, startedAt: row.startedAt, endedAt: row.endedAt }}
            />
            <${Metadata} value=${row.details} />
        </div>`;
    }

    function Commands({ id, commands }) {
        const [status, setStatus] = useState("");
        const [query, setQuery] = useState("");
        const [program, setProgram] = useState("");
        const programs = new Map();

        for (const row of commands) {
            const name = row.program ?? t("Unknown");
            const group = programs.get(name) ?? {
                name,
                count: 0,
                ok: 0,
                error: 0,
                running: 0,
                unknown: 0,
                ms: 0,
                timed: 0,
            };

            group.count++;
            group[row.status ?? "unknown"] = (group[row.status ?? "unknown"] ?? 0) + 1;

            if (Number.isFinite(row.ms)) {
                group.ms += row.ms;
                group.timed++;
            }

            programs.set(name, group);
        }

        const shown = commands.filter(
            (row) =>
                (!status || (row.status ?? "unknown") === status) &&
                (!program || row.program === program) &&
                row.command.toLowerCase().includes(query.trim().toLowerCase()),
        );

        return html`<div class="ci-card">
            <div class="ci-card-head"><b>${t("Commands")}</b><span>${commands.length}</span></div>
            <div class="ci-filters ci-inset">
                <input
                    type="search"
                    value=${query}
                    placeholder=${t("Filter a command")}
                    aria-label=${t("Filter a command")}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                /><select
                    value=${status}
                    aria-label=${t("Status")}
                    onChange=${(event) => setStatus(event.currentTarget.value)}
                >
                    ${["", "ok", "error", "running", "unknown"].map((key) => html`<option value=${key}>${t(key || "All")}</option>`)}</select
                ><select
                    value=${program}
                    aria-label=${t("Program")}
                    onChange=${(event) => setProgram(event.currentTarget.value)}
                >
                    <option value="">${t("All programs")}</option>
                    ${[...programs.keys()].map((name) => html`<option value=${name}>${name}</option>`)}
                </select>
            </div>
            <details class="ci-details">
                <summary>${t("Program statistics")} · ${t("Loaded history only")}</summary>
                <div class="ci-table-wrap">
                    <table class="ci-table">
                        <thead>
                            <tr>
                                ${["Program", "Commands", "OK", "Failed", "Working", "Unknown", "Duration", "Timed"].map((label) => html`<th>${t(label)}</th>`)}
                            </tr>
                        </thead>
                        <tbody>
                            ${[...programs.values()].map(
                                (row) =>
                                    html`<tr>
                                        <td>${row.name}</td>
                                        <td>${row.count}</td>
                                        <td>${row.ok}</td>
                                        <td>${row.error}</td>
                                        <td>${row.running}</td>
                                        <td>${row.unknown}</td>
                                        <td>${row.timed > 0 ? duration(row.ms) : "—"}</td>
                                        <td>${row.timed}/${row.count}</td>
                                    </tr>`,
                            )}
                        </tbody>
                    </table>
                </div>
            </details>
            ${shown.length === 0 && html`<div class="ci-empty">${t("No commands yet.")}</div>`}
            ${[...shown].reverse().map(
                (row) =>
                    html`<details class="ci-details">
                        <summary>
                            <span class=${`ci-dot ci-dot-${row.status}`}></span
                            ><code>${row.command}</code
                            ><span class="ci-hint"
                                >${t(row.status ?? "unknown")} · ${duration(row.ms)}</span
                            >
                        </summary>
                        <${CommandOutput} id=${id} row=${row} />
                    </details>`,
            )}
        </div>`;
    }

    function useFleet(id) {
        const [state, setState] = useState({ loading: true, agents: [], error: null });
        const [revision, setRevision] = useState(0);

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
                            setState({
                                ...data,
                                loading: false,
                                agents: data.agents ?? [],
                                error: null,
                            });
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
        }, [id, revision]);

        return { ...state, retry: () => setRevision((old) => old + 1) };
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
                    : html`<${Chat} rows=${rows} /><${AgentHistory} id=${id} />`)
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

    function FleetGraph({ nodes, edges }) {
        const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
        const width = Math.max(480, columns * 210);
        const height = Math.max(100, Math.ceil(nodes.length / columns) * 100);
        const identity = (node) => String(node.conversationId ?? node.id);
        const positions = new Map(
            nodes.map((node, index) => [
                identity(node),
                { x: 105 + (index % columns) * 210, y: 45 + Math.floor(index / columns) * 100 },
            ]),
        );
        const fromOf = (edge) => String(edge.from ?? edge.source ?? edge.parentId);
        const toOf = (edge) => String(edge.to ?? edge.target ?? edge.conversationId);

        return html`<div class="ci-card">
            <div class="ci-card-head">
                <b>${t("Relationships")}</b
                ><span>${nodes.length} · ${edges.length} ${t("Known edges")}</span>
            </div>
            <div class="ci-body">
                <div class="ci-chart">
                    <svg
                        width=${width}
                        height=${height}
                        viewBox=${`0 0 ${width} ${height}`}
                        role="img"
                        aria-label=${t("Relationships")}
                    >
                        ${edges.map((edge) => {
                            const from = positions.get(fromOf(edge));
                            const to = positions.get(toOf(edge));

                            return (
                                from &&
                                to &&
                                html`<g
                                    ><line
                                        x1=${from.x}
                                        y1=${from.y}
                                        x2=${to.x}
                                        y2=${to.y}
                                        stroke="var(--muted)"
                                        stroke-dasharray=${(edge.relationship ?? edge.kind) === "linked" ? "5 3" : ""}
                                    /><text
                                        x=${(from.x + to.x) / 2}
                                        y=${(from.y + to.y) / 2 - 5}
                                        text-anchor="middle"
                                        fill="var(--muted)"
                                        font-size="11"
                                        >${t(edge.relationship ?? edge.kind ?? "relationship")}</text
                                    ></g
                                >`
                            );
                        })}
                        ${nodes.map((node) => {
                            const at = positions.get(identity(node));
                            const conversation = node.conversationId;

                            return html`<g
                                role="button"
                                tabindex="0"
                                aria-label=${node.name ?? identity(node)}
                                onClick=${() => conversation && pocket.openConversation(conversation)}
                                onKeyDown=${(event) => {
                                    if (event.key === "Enter" && conversation) {
                                        pocket.openConversation(conversation);
                                    }
                                }}
                                ><rect
                                    x=${at.x - 88}
                                    y=${at.y - 24}
                                    width="176"
                                    height="48"
                                    rx="9"
                                    fill="var(--card)"
                                    stroke="var(--line)"
                                /><text
                                    x=${at.x}
                                    y=${at.y - 3}
                                    text-anchor="middle"
                                    fill="var(--text)"
                                    font-size="13"
                                    >${node.name ?? identity(node)}</text
                                ><text
                                    x=${at.x}
                                    y=${at.y + 15}
                                    text-anchor="middle"
                                    fill="var(--muted)"
                                    font-size="11"
                                    >${t(node.state ?? "unknown")}</text
                                ><title>${JSON.stringify(node)}</title></g
                            >`;
                        })}
                    </svg>
                </div>
                <div class="ci-table-wrap">
                    <table class="ci-table">
                        <thead>
                            <tr>
                                ${["Agent", "Status", "Parent", "Relationship"].map((key) => html`<th>${t(key)}</th>`)}
                            </tr>
                        </thead>
                        <tbody>
                            ${nodes.map(
                                (node) =>
                                    html`<tr>
                                        <td>${node.name ?? identity(node)}</td>
                                        <td>${t(node.state ?? "unknown")}</td>
                                        <td>${node.parentId ?? "—"}</td>
                                        <td>${t(node.relationship ?? "unknown")}</td>
                                    </tr>`,
                            )}
                        </tbody>
                    </table>
                </div>
                ${edges.length === 0 && html`<div class="ci-hint">${t("No known relationships were returned.")}</div>`}
            </div>
        </div>`;
    }

    function AgentHistory({ id }) {
        const page = usePages("history/" + id + "/messages", "rows");

        useEffect(() => {
            void page.load(true);
        }, [id]);

        return html`<div>
            ${[...page.rows]
                .sort((a, b) => (a.id ?? a.entry) - (b.id ?? b.entry))
                .map(
                    (row) =>
                        html`<details class="ci-details">
                            <summary>#${row.id ?? row.entry} · ${timeOf(row.at)}</summary>
                            <${FullText} text=${row.text ?? entryText(row)} />
                        </details>`,
                )}<${Paging} page=${page} />
        </div>`;
    }

    function Fleet({ id, stats }) {
        const [view, setView] = useState(store("x.context-insight.fleet") ?? "agents");

        const choose = (next) => {
            setView(next);
            store("x.context-insight.fleet", next);
        };

        const fleet = useFleet(id);
        const { agents, loading, error } = fleet;
        const commsPage = usePages(
            "history/" + id + "/comms",
            "rows",
            fleet.communications ?? stats.comms ?? [],
            stats.commsMore,
        );
        const [channel, setChannel] = useState("");
        const channels = [
            ...new Set(commsPage.rows.map((row) => row.channel ?? row.kind ?? "unknown")),
        ];
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
            <div class="ci-tabs">
                ${["graph", "communications"].map((key) => html`<button class="ci-tab" aria-selected=${view === key} onClick=${() => choose(key)}>${t(key === "graph" ? "Relationships" : "Communications")}</button>`)}
            </div>
            ${view === "tasks" && html`<${TaskBoard} agents=${agents} />`}
            ${view === "graph" && html`<${FleetGraph} nodes=${fleet.nodes ?? agents.map((agent) => ({ ...agent, state: agentState(agent).label }))} edges=${fleet.edges ?? []} />`}
            ${
                view === "communications" &&
                html`<div class="ci-card">
                    <div class="ci-card-head">
                        <b>${t("Communications")}</b><span>${commsPage.rows.length}</span>
                    </div>
                    <div class="ci-body">
                        <select
                            value=${channel}
                            aria-label=${t("Channel")}
                            onChange=${(event) => setChannel(event.currentTarget.value)}
                        >
                            <option value="">${t("All channels")}</option>
                            ${channels.map((name) => html`<option value=${name}>${t(name)}</option>`)}</select
                        >${commsPage.rows
                            .filter(
                                (row) =>
                                    !channel || (row.channel ?? row.kind ?? "unknown") === channel,
                            )
                            .map(
                                (row) =>
                                    html`<details class="ci-details">
                                        <summary>
                                            ${timeOf(row.at)} ·
                                            ${row.from ?? (row.dir === "to" ? t("Parent") : row.name)}
                                            →
                                            ${row.to ?? (row.dir === "to" ? row.name : t("Parent"))}
                                            · ${t(row.channel ?? row.kind ?? "unknown")}
                                        </summary>
                                        <${FullText}
                                            text=${row.text ?? t("No recorded text.")}
                                        /><${Metadata}
                                            label="Provenance"
                                            value=${{ entry: row.entry, channel: row.channel, source: row.source }}
                                        />
                                    </details>`,
                            )}<${Paging} page=${commsPage} />
                    </div>
                </div>`
            }
            <div class="ci-hint">
                ${t("Only known parent and linked relationships are shown. Task dependencies and unrecorded messages are unavailable.")}
            </div>
            <${Metadata} label="Platform limits" value=${fleet.limits} />
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
            ${error && html`<div class="ci-error">${error}<button class="ci-button" onClick=${fleet.retry}>${t("Retry")}</button></div>`}
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
                                                      stats=${{ ...stats, comms: commsPage.rows }}
                                                  />`,
                                          )}
                                      </div>
                                  </div>`,
                          ))
            }
        </div>`;
    }

    function CapturedRequest({ id, capture }) {
        const path = `request/${id}/${encodeURIComponent(capture.id)}`;
        const page = usePages(path, "messages");

        return html`<details
            class="ci-details"
            onToggle=${(event) => {
                if (event.currentTarget.open && !page.loaded && !page.busy) {
                    void page.load(true);
                }
            }}
        >
            <summary>
                ${timeOf(capture.startedAt)} · ${capture.provider}/${capture.model} ·
                ${capture.outcome}
            </summary>
            <div class="ci-hint">
                ${t("Captured normalized input after request hooks; not provider-wire JSON.")}
            </div>
            <${Metadata}
                label="Provenance"
                value=${{ id: capture.id, accuracy: capture.accuracy, startedAt: capture.startedAt, endedAt: capture.endedAt }}
            />
            ${page.rows.map(
                (message) =>
                    html`<details class="ci-details">
                        <summary>${message.messageIndex + 1}. ${t(message.role)}</summary>
                        <${FullText} text=${entryText({ messages: [message] })} />
                        <${Metadata} value=${message} />
                    </details>`,
            )}
            <${Paging} page=${page} earlier=${false} />
            ${
                page.response &&
                html`<details class="ci-details">
                    <summary>${t("Recorded response")}</summary>
                    <${FullText} text=${entryText({ messages: [page.response] })} /><${Metadata}
                        value=${page.response}
                    />
                </details>`
            }
        </details>`;
    }

    function CapturedRequests({ id, revision }) {
        const page = usePages(`requests/${id}?revision=${revision ?? 0}`, "rows");

        useEffect(() => {
            void page.load(true);
        }, [id, revision]);

        return html`<div class="ci-card">
            <div class="ci-card-head">
                <b>${t("Captured requests")}</b><span>${page.total}</span>
            </div>
            ${page.rows
                .slice()
                .sort((a, b) => (b.order ?? 0) - (a.order ?? 0) || b.startedAt - a.startedAt)
                .map(
                    (capture) =>
                        html`<${CapturedRequest} key=${capture.id} id=${id} capture=${capture} />`,
                )}
            ${page.loaded && page.rows.length === 0 && html`<div class="ci-empty">${t("No captured requests yet.")}</div>`}
            <${Paging} page=${page} />
        </div>`;
    }

    function HistoryMessages({ id, revision }) {
        return html`<div class="ci-card">
                <div class="ci-card-head"><b>${t("History")}</b></div>
                <${AgentHistory} key=${`${id}:${revision}`} id=${id} />
            </div>
            <${CapturedRequests} id=${id} revision=${revision} />`;
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
        const historyPath = (kind) =>
            id
                ? "history/" +
                  id +
                  "/" +
                  kind +
                  (stats?.through !== undefined
                      ? "?through=" + encodeURIComponent(stats.through)
                      : "")
                : null;
        const stepPage = usePages(
            historyPath("steps"),
            "rows",
            stats?.steps ?? [],
            stats?.stepsMore,
        );
        const eventPage = usePages(
            historyPath("events"),
            "rows",
            stats?.events ?? [],
            stats?.eventsMore,
        );
        const filePage = usePages(
            historyPath("files"),
            "rows",
            stats?.files ?? [],
            stats?.filesMore,
        );
        const commandPage = usePages(
            historyPath("commands"),
            "rows",
            stats?.commands ?? [],
            stats?.commandsMore,
        );
        const steps = [...stepPage.rows].sort((a, b) => a.index - b.index);
        const events = [...eventPage.rows].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id - b.id);
        const step =
            selected === null ? steps.length - 1 : steps.findIndex((row) => row.id === selected);
        const chosen = steps[step] ?? null;

        useEffect(() => {
            setSelected(null);
            setFilter(null);
        }, [id]);

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
                            ["history", t("History")],
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
                                        <b>${fmt(stepPage.total)}</b>
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
                                        ${stats.sections.map(
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
                                        ${stats.tools.map(
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
                                events=${events}
                                capacity=${stats.window}
                                selected=${step}
                                onSelect=${(picked) => {
                                    setSelected(picked?.id ?? null);
                                }}
                            />
                            <${Paging} page=${stepPage} />
                            <${StepCard}
                                step=${chosen}
                                onItems=${() => {
                                    setSelected(chosen.id);
                                    openTab("browser");
                                }}
                            />`
                    }
                    ${
                        tab === "browser" &&
                        html`<div class="ci-card">
                            <div class="ci-card-head">
                                <b>${t("Items in the context")}</b>
                                <span>${selected !== null ? `#${selected}` : t("Now")}</span>
                            </div>
                            <${Browser}
                                key=${id}
                                id=${id}
                                data=${{ ...data, stats: { ...stats, steps } }}
                                step=${selected}
                                setStep=${(next) => {
                                    setSelected(next);
                                }}
                                filter=${filter}
                                setFilter=${setFilter}
                            />
                        </div>`
                    }
                    ${
                        tab === "events" &&
                        html`<${Events}
                                events=${events}
                                onPick=${(event) => {
                                    const found =
                                        event.stepId ??
                                        steps.find((row) => row.index === event.step)?.id;

                                    setSelected(found ?? null);
                                    openTab(
                                        steps.some((row) => row.id === found) ? "trend" : "browser",
                                    );
                                }}
                            /><${Paging} page=${eventPage} />`
                    }
                    ${tab === "files" && html`<${Files} id=${id} files=${filePage.rows} /><${Paging} page=${filePage} earlier=${false} />`}
                    ${tab === "commands" && html`<${Commands} id=${id} commands=${[...commandPage.rows].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))} /><${Paging} page=${commandPage} />`}
                    ${tab === "fleet" && html`<${Fleet} id=${id} stats=${stats} />`}
                    ${tab === "history" && html`<${HistoryMessages} id=${id} revision=${stats.through} />`}

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
        const [selectedDay, setSelectedDay] = useState(null);
        const [query, setQuery] = useState("");
        const [state, setState] = useState({
            loading: true,
            error: null,
            sessions: [],
            failed: [],
            done: 0,
            total: 0,
            cancelled: false,
        });
        const request = useRef(null);
        const snapshot = useRef(state);

        snapshot.current = state;
        const load = useCallback(async (retryOnly = false) => {
            request.current?.abort();
            const stop = new AbortController();
            const signal = stop.signal;
            const previous = snapshot.current;

            request.current = stop;
            setState((old) => ({ ...old, loading: true, error: null, cancelled: false }));

            try {
                const queue = retryOnly
                    ? previous.failed.map((row) => row.session)
                    : ((await pocket.api("sessions", undefined, { signal })).sessions ?? []);

                if (signal.aborted) {
                    return;
                }

                const rows = retryOnly ? [...previous.sessions] : [];
                const failed = [];
                const total = rows.length + queue.length;
                let done = rows.length;
                let cursor = 0;

                const publish = (loading) => {
                    if (!signal.aborted) {
                        setState({
                            loading,
                            error: null,
                            cancelled: false,
                            sessions: [...rows],
                            failed: [...failed],
                            done,
                            total,
                        });
                    }
                };

                publish(true);

                const worker = async () => {
                    while (!signal.aborted && cursor < queue.length) {
                        const session = queue[cursor++];

                        try {
                            const insight = await pocket.api(
                                "insight/" +
                                    session.id +
                                    "?zone=" +
                                    encodeURIComponent(
                                        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
                                    ),
                                undefined,
                                {
                                    signal,
                                },
                            );

                            if (signal.aborted) {
                                return;
                            }

                            rows.push({ ...session, insight });
                        } catch (error) {
                            if (signal.aborted) {
                                return;
                            }

                            failed.push({ session, error: error.message });
                        }

                        done++;
                        publish(true);
                    }
                };

                await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
                publish(false);
            } catch (error) {
                if (!signal.aborted) {
                    setState((old) => ({ ...old, loading: false, error: error.message }));
                }
            }
        }, []);

        useEffect(() => {
            void load();

            return () => request.current?.abort();
        }, [load]);

        const keys = ["tokens", "cost", "steps", "input", "output", "cacheRead", "cacheWrite"];
        const zero = () => Object.fromEntries(keys.map((key) => [key, 0]));

        const add = (into, value) => {
            for (const key of keys) {
                into[key] += Number(value?.[key] ?? 0);
            }

            return into;
        };

        const start = new Date();

        start.setHours(0, 0, 0, 0);
        const since = new Date(start);

        since.setDate(since.getDate() - Math.max(0, Number(range) - 1));
        const sinceDay = Number(range) === 0 ? "" : dayOf(since.getTime());
        const included = (day) => (selectedDay ? day === selectedDay : day >= sinceDay);
        const fullDaily = new Map();
        const daily = new Map();
        const accounting = { dated: zero(), undated: zero(), overcount: zero(), complete: true };
        const mixAvailable = state.sessions.every((row) =>
            Object.values(row.insight?.days ?? {})
                .filter((value) => value.steps > 0)
                .every((value) => MIX.every((key) => typeof value[key] === "number")),
        );

        for (const row of state.sessions) {
            for (const [day, value] of Object.entries(row.insight?.days ?? {})) {
                fullDaily.set(day, add(fullDaily.get(day) ?? zero(), value));

                if (included(day)) {
                    daily.set(day, add(daily.get(day) ?? zero(), value));
                }
            }

            const each = row.insight?.accounting;

            if (each) {
                add(accounting.dated, each.dated);
                add(accounting.undated, each.undated);
                add(accounting.overcount, each.overcount);
                accounting.complete &&= each.complete === true;
            } else {
                accounting.complete = false;
            }
        }

        const inRange = (row) => {
            const sum = zero();

            for (const [day, value] of Object.entries(row.insight?.days ?? {})) {
                if (included(day)) {
                    add(sum, value);
                }
            }

            return sum;
        };

        const totals = [...daily.values()].reduce(add, zero());
        const active = state.sessions.filter((row) => inRange(row).steps > 0).length;
        const mixAll = MIX.reduce((sum, key) => sum + totals[key], 0);
        const heat = [];
        const last7 = [];

        const dayAt = (offset) => {
            const date = new Date(start);

            date.setDate(date.getDate() + offset);

            return dayOf(date.getTime());
        };

        const heatMost = Math.max(
            1,
            ...Array.from(
                { length: 56 },
                (_, index) => fullDaily.get(dayAt(index - 55))?.tokens ?? 0,
            ),
        );

        for (let index = -55; index <= 0; index++) {
            const key = dayAt(index);
            const value = fullDaily.get(key)?.tokens ?? 0;

            heat.push({
                key,
                value,
                level: value === 0 ? 0 : Math.max(1, Math.ceil((value / heatMost) * 4)),
            });

            if (index >= -6) {
                last7.push({ key, tokens: value });
            }
        }

        const most = Math.max(1, ...last7.map((row) => row.tokens));
        const rows = state.sessions
            .map((row) => ({ ...row, range: inRange(row) }))
            .filter(
                (row) =>
                    (row.range.steps > 0 || (range === "0" && !selectedDay)) &&
                    (row.title ?? "").toLowerCase().includes(query.toLowerCase()),
            )
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
                        ${lang() === "zh" ? "EN" : "中"}</button
                    ><button class="ci-icon" title=${t("Refresh")} onClick=${() => load()}>
                        <${pocket.Icon} name="reload" />
                    </button>
                </div>
            </div>
            <div class="ci-tabs">
                ${[
                    ["7", "Last 7 days"],
                    ["30", "Last 30 days"],
                    ["0", "All"],
                ].map(
                    ([key, label]) =>
                        html`<button
                            class="ci-tab"
                            aria-selected=${range === key && !selectedDay}
                            onClick=${() => {
                                setRange(key);
                                setSelectedDay(null);
                                store("x.context-insight.range", key);
                            }}
                        >
                            ${t(label)}
                        </button>`,
                )}
            </div>
            ${selectedDay && html`<div class="ci-toolbar"><b>${selectedDay}</b><button class="ci-button" onClick=${() => setSelectedDay(null)}>${t("Clear day selection")}</button></div>`}
            ${state.error && html`<div class="ci-error">${state.error}</div>`}
            <div class="ci-toolbar" role="status">
                <span
                    >${t("Scanned")} ${state.done}/${state.total} · ${t("Failed")}:
                    ${state.failed.length}${state.cancelled ? " · " + t("Cancelled") : ""}</span
                >${
                    state.loading
                        ? html`<button
                              class="ci-button"
                              onClick=${() => {
                                  request.current?.abort();
                                  setState((old) => ({ ...old, loading: false, cancelled: true }));
                              }}
                          >
                              ${t("Cancel")}
                          </button>`
                        : state.failed.length > 0 &&
                          html`<button class="ci-button" onClick=${() => load(true)}>
                              ${t("Retry failed")} (${state.failed.length})
                          </button>`
                }
            </div>
            ${state.loading && html`<progress max=${Math.max(1, state.total)} value=${state.done} aria-label=${t("Reading sessions")}></progress>`}
            ${
                state.failed.length > 0 &&
                html`<details class="ci-details">
                    <summary>${t("Failed sessions")}</summary>
                    ${state.failed.map((row) => html`<div class="ci-hint">${row.session.title ?? row.session.id}: ${row.error}</div>`)}
                </details>`
            }
            <div class="ci-kpis">
                ${[
                    ["Sessions", active],
                    ["Tokens", fmt(totals.tokens)],
                    ["Cost", money(totals.cost)],
                    ["Requests", fmt(totals.steps)],
                ].map(
                    ([label, value]) =>
                        html`<div class="ci-kpi"><small>${t(label)}</small><b>${value}</b></div>`,
                )}
            </div>
            <div class="ci-hint">${t("Dated usage in the selected days.")} ${state.loading || state.cancelled || state.failed.length > 0 || !accounting.complete ? t("Accounting is incomplete.") : t("Accounting is complete.")}</div>
            <details class="ci-details">
                <summary>${t("Usage accounting")}</summary>
                <div class="ci-hint">${t("Undated usage is excluded from date filters.")}</div>
                <${Metadata} label="Dated" value=${accounting.dated} /><${Metadata}
                    label="Undated"
                    value=${accounting.undated}
                /><${Metadata} label="Unreconciled" value=${accounting.overcount} />
            </details>
            <div class="ci-card">
                <div class="ci-card-head">
                    <b>${t("Token mix")}</b
                    ><span
                        >${selectedDay ?? t(range === "0" ? "All dated days" : range === "7" ? "Last 7 days" : "Last 30 days")}</span
                    >
                </div>
                <div class="ci-body">
                    ${!mixAvailable && html`<div class="ci-hint">${t("Some daily token counters are unavailable.")}</div>`}
                    <div class="ci-bar" style="height:14px">
                        ${MIX.map((key) => totals[key] > 0 && html`<span style=${`width:${(totals[key] / Math.max(1, mixAll)) * 100}%;background:var(--ci-${key})`}></span>`)}
                    </div>
                    <div class="ci-legend">
                        ${MIX.map((key) => html`<div class="ci-cat"><span class="ci-swatch" style=${`background:var(--ci-${key})`}></span><span>${t(MIX_LABEL[key])}</span><small>${fmt(totals[key])}</small><small>${pct((totals[key] / Math.max(1, mixAll)) * 100)}</small></div>`)}
                    </div>
                    <div class="ci-table-wrap">
                        <table class="ci-table">
                            <thead>
                                <tr>
                                    ${["Day", "Input", "Output", "Cache read", "Cache write", "Tokens", "Cost", "Requests"].map((label) => html`<th>${t(label)}</th>`)}
                                </tr>
                            </thead>
                            <tbody>
                                ${[...daily.entries()]
                                    .sort(([a], [b]) => a.localeCompare(b))
                                    .map(
                                        ([day, value]) =>
                                            html`<tr>
                                                <td>
                                                    <button
                                                        class="ci-link"
                                                        onClick=${() => setSelectedDay(day)}
                                                    >
                                                        ${day}
                                                    </button>
                                                </td>
                                                ${MIX.map((key) => html`<td>${fmt(value[key])}</td>`)}
                                                <td>${fmt(value.tokens)}</td>
                                                <td>${money(value.cost)}</td>
                                                <td>${value.steps}</td>
                                            </tr>`,
                                    )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
            <div class="ci-card">
                <div class="ci-card-head">
                    <b>${t("Last 7 days")}</b><span>${t("tokens")}</span>
                </div>
                <div class="ci-body">
                    <div class="ci-days">
                        ${last7.map((day) => html`<button aria-pressed=${selectedDay === day.key} title=${day.key} onClick=${() => setSelectedDay(day.key)}><span>${fmt(day.tokens)}</span><i style=${`height:${Math.max(2, (day.tokens / most) * 78)}px`}></i><small>${day.key.slice(5)}</small></button>`)}
                    </div>
                </div>
            </div>
            <div class="ci-card">
                <div class="ci-card-head"><b>${t("Activity")}</b><span>${t("8 weeks")}</span></div>
                <div class="ci-body">
                    <div class="ci-heat">
                        ${heat.map((cell) => html`<button data-level=${cell.level} aria-pressed=${selectedDay === cell.key} aria-label=${`${cell.key}: ${fmt(cell.value)} ${t("tokens")}`} title=${`${cell.key}: ${fmt(cell.value)} ${t("tokens")}`} onClick=${() => setSelectedDay(cell.key)}></button>`)}
                    </div>
                    <div class="ci-hint">
                        ${t("Activity always shows 8 weeks of available dated usage.")}
                    </div>
                </div>
            </div>
            <div class="ci-card">
                <div class="ci-card-head"><b>${t("Sessions")}</b><span>${rows.length}</span></div>
                <div class="ci-inset">
                    <input
                        type="search"
                        value=${query}
                        aria-label=${t("Filter sessions")}
                        placeholder=${t("Filter sessions")}
                        onInput=${(event) => setQuery(event.currentTarget.value)}
                    />
                </div>
                ${rows.length === 0 ? html`<div class="ci-empty">${t("No sessions in this range.")}</div>` : rows.map((row) => html`<button class="ci-session" onClick=${() => pocket.openConversation(row.id)}><span class="ci-session-title">${row.title}</span><span class="ci-session-num">${fmt(row.range.tokens)} · ${money(row.range.cost)}</span><span class="ci-session-path">${row.cwd}</span></button>`)}
            </div>
            <div class="ci-foot">
                <span>${t("Scanned")} ${state.sessions.length} ${t("sessions")}</span
                ><span>${t("The figures are Pi's own meter, anchored to each response.")}</span>
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
