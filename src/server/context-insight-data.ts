/** Paging and usage accounting shared by the Context Insight routes. */
import type { UsageState } from "@earendil-works/pi-durable";

export interface UsageTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    tokens: number;
    cost: number;
}

export interface UsageRow {
    at?: number;
    bucket: "models" | "tools";
    key: string;
    usage: unknown;
    /** Billed attempts, including failed attempts, compaction, and cache maintenance. */
    requests?: number;
}

export interface DayTotals extends UsageTotals {
    steps: number;
    models: Record<string, UsageTotals>;
    tools: Record<string, UsageTotals>;
}

export function zeroUsage(): UsageTotals {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, tokens: 0, cost: 0 };
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function counter(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function usageTotals(value: unknown): UsageTotals {
    const usage = record(value);
    const input = counter(usage.input);
    const output = counter(usage.output);
    const cacheRead = counter(usage.cacheRead);
    const cacheWrite = counter(usage.cacheWrite);
    const cost = record(usage.cost);

    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning: counter(usage.reasoning),
        tokens: counter(usage.totalTokens) || input + output + cacheRead + cacheWrite,
        cost: counter(cost.total),
    };
}

export const USAGE_KEYS = [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "reasoning",
    "tokens",
    "cost",
] as const;

export function addUsage(into: UsageTotals, value: UsageTotals): UsageTotals {
    for (const key of USAGE_KEYS) {
        into[key] += value[key];
    }

    return into;
}

export function ledgerTotals(usage: UsageState | null): UsageTotals {
    const result = zeroUsage();

    for (const bucket of [usage?.models, usage?.tools]) {
        for (const value of Object.values(bucket ?? {})) {
            addUsage(result, usageTotals(value));
        }
    }

    return result;
}

/** Offset has the same sign as Date.getTimezoneOffset(); a date never depends on locale formatting. */
export function dayOf(
    at: number,
    offset: number | string = new Date(at).getTimezoneOffset(),
): string {
    if (typeof offset === "string") {
        const parts = new Intl.DateTimeFormat("en", {
            timeZone: offset,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(new Date(at));
        const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));

        return `${value.year}-${value.month}-${value.day}`;
    }

    return new Date(at - offset * 60_000).toISOString().slice(0, 10);
}

/**
 * Date only usage whose timestamp was recorded. An old ledger can contain spend with no surviving dated record;
 * expose that remainder instead of silently dropping it or assigning it to the day the dashboard first opened.
 */
export function accountUsage(
    rows: readonly UsageRow[],
    ledger: UsageState | null,
    offset?: number | string,
) {
    const days: Record<string, DayTotals> = {};
    const dated = zeroUsage();
    let requests = 0;

    for (const row of rows) {
        if (row.at === undefined || !Number.isFinite(row.at)) {
            continue;
        }

        const totals = usageTotals(row.usage);
        const date = dayOf(row.at, offset);
        const day = (days[date] ??= { ...zeroUsage(), steps: 0, models: {}, tools: {} });

        addUsage(day, totals);
        addUsage(dated, totals);
        day.steps += row.requests ?? (row.bucket === "models" ? 1 : 0);
        requests += row.requests ?? (row.bucket === "models" ? 1 : 0);

        const table = day[row.bucket];
        const bucket = Object.hasOwn(table, row.key) ? table[row.key]! : zeroUsage();

        addUsage(bucket, totals);
        Object.defineProperty(table, row.key, { value: bucket, enumerable: true, writable: true });
    }

    const authoritative = ledgerTotals(ledger);
    const undated = zeroUsage();
    const overcount = zeroUsage();

    for (const key of USAGE_KEYS) {
        const delta = authoritative[key] - dated[key];
        const tolerance = key === "cost" ? 1e-8 : 0;

        undated[key] = delta > tolerance ? delta : 0;
        overcount[key] = delta < -tolerance ? -delta : 0;
    }

    return {
        days,
        steps: requests,
        tokens: dated.tokens,
        cost: dated.cost,
        accounting: {
            dated,
            undated,
            authoritative,
            overcount,
            complete:
                Object.values(undated).every((value) => value === 0) &&
                Object.values(overcount).every((value) => value === 0),
        },
    };
}

/** Latest-first paging retains chronological order inside each page. `forward` is for ranked file rows. */
export function pageRows<T>(
    rows: readonly T[],
    offset: number,
    limit: number,
    forward = false,
): { rows: T[]; total: number; more: number; next: number | null } {
    const total = rows.length;
    const end = forward ? Math.min(total, offset + limit) : Math.max(0, total - offset);
    const start = forward ? Math.min(offset, total) : Math.max(0, end - limit);
    const shown = rows.slice(start, end);
    const next = Math.min(total, offset + shown.length);

    return {
        rows: shown,
        total,
        more: Math.max(0, total - next),
        next: next < total ? next : null,
    };
}
