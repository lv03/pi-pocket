import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageState } from "@earendil-works/pi-durable";
import {
    accountUsage,
    dayOf,
    pageRows,
    type UsageRow,
    usageTotals,
} from "../src/server/context-insight-data.ts";

function usage(input: number, output: number, cost: number, cacheRead = 0, cacheWrite = 0) {
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    };
}

test("dated usage includes billed failures, tool usage, and captured compaction without double counting", () => {
    const at = Date.UTC(2026, 0, 4, 10);
    const rows: UsageRow[] = [
        { at, bucket: "models", key: "a/model", usage: usage(100, 20, 0.2) },
        { at, bucket: "models", key: "a/model", usage: usage(50, 0, 0.1) },
        { at, bucket: "models", key: "a/model", usage: usage(20, 10, 0.05) },
        { at, bucket: "tools", key: "search", usage: usage(10, 5, 0.03) },
    ];
    const ledger: UsageState = {
        models: { "a/model": usage(170, 30, 0.35) },
        tools: { search: usage(10, 5, 0.03) },
    };
    const result = accountUsage(rows, ledger, 0);

    assert.equal(result.tokens, 215);
    assert.equal(result.steps, 3);
    assert.equal(result.days["2026-01-04"]!.steps, 3);
    assert.equal(result.days["2026-01-04"]!.models["a/model"]!.tokens, 200);
    assert.equal(result.days["2026-01-04"]!.tools.search!.tokens, 15);
    assert.equal(result.accounting.complete, true);
    assert.equal(result.accounting.undated.cost, 0);
});

test("historical ledger spend without timestamps stays in the undated remainder", () => {
    const at = Date.UTC(2026, 0, 4, 10);
    const result = accountUsage(
        [{ at, bucket: "models", key: "a/model", usage: usage(100, 20, 0.2) }],
        { models: { "a/model": usage(300, 40, 0.6, 80) }, tools: {} },
        0,
    );

    assert.equal(result.accounting.complete, false);
    assert.equal(result.accounting.undated.tokens, 300);
    assert.equal(result.accounting.undated.input, 200);
    assert.equal(result.accounting.undated.cacheRead, 80);
    assert.ok(Math.abs(result.accounting.undated.cost - 0.4) < 1e-10);
    assert.equal(Object.keys(result.days).length, 1);
    assert.equal(result.days["2026-01-04"]!.tokens, 120);
});

test("an overcount is visible rather than hidden by clamping", () => {
    const result = accountUsage(
        [{ at: 1, bucket: "models", key: "a/model", usage: usage(100, 20, 0.2) }],
        { models: { "a/model": usage(50, 10, 0.1) }, tools: {} },
        0,
    );

    assert.equal(result.accounting.complete, false);
    assert.equal(result.accounting.overcount.tokens, 60);
    assert.equal(result.accounting.overcount.cost, 0.1);
    assert.equal(result.accounting.undated.tokens, 0);
});

test("daily cache mix and model counters remain available for the selected date range", () => {
    const result = accountUsage(
        [
            {
                at: Date.UTC(2026, 0, 4),
                bucket: "models",
                key: "a/model",
                usage: usage(10, 3, 0.1, 90),
            },
            {
                at: Date.UTC(2026, 0, 5),
                bucket: "models",
                key: "a/model",
                usage: usage(80, 4, 0.2, 20),
            },
        ],
        { models: { "a/model": usage(90, 7, 0.3, 110) }, tools: {} },
        0,
    );

    assert.equal(result.days["2026-01-04"]!.cacheRead, 90);
    assert.equal(result.days["2026-01-05"]!.cacheRead, 20);
    assert.equal(result.days["2026-01-05"]!.input, 80);
    assert.equal(result.accounting.complete, true);
});

test("model and tool keys do not become object prototypes", () => {
    const at = Date.UTC(2026, 0, 4);
    const ledger = JSON.parse(
        '{"models":{},"tools":{"__proto__":{"input":1,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":1,"cost":{"total":0}}}}',
    ) as UsageState;
    const result = accountUsage(
        [{ at, bucket: "tools", key: "__proto__", usage: usage(1, 0, 0) }],
        ledger,
        0,
    );

    assert.equal(Object.getPrototypeOf(result.days["2026-01-04"]!.tools), Object.prototype);
    assert.equal(Object.hasOwn(result.days["2026-01-04"]!.tools, "__proto__"), true);
    assert.equal(result.accounting.complete, true);
});

test("reasoning remains a separate reported counter and does not inflate total billed tokens", () => {
    assert.deepEqual(usageTotals({ ...usage(20, 10, 0), reasoning: 8 }), {
        input: 20,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 8,
        tokens: 30,
        cost: 0,
    });
});

test("latest pages cover a long history exactly once and expose the final cursor", () => {
    const rows = Array.from({ length: 41_001 }, (_, index) => index + 1);
    const seen: number[] = [];
    let next: number | null = 0;

    while (next !== null) {
        const page: ReturnType<typeof pageRows<number>> = pageRows(rows, next, 800);

        seen.unshift(...page.rows);
        next = page.next;
        assert.equal(page.more, Math.max(0, rows.length - seen.length));
    }

    assert.deepEqual(seen, rows);
    assert.deepEqual(pageRows(rows, rows.length + 10, 10).rows, []);
    assert.deepEqual(pageRows([], 0, 10), { rows: [], total: 0, more: 0, next: null });
});

test("ranked pages proceed forward and day boundaries use the requested timezone", () => {
    assert.deepEqual(pageRows(["a", "b", "c"], 0, 2, true), {
        rows: ["a", "b"],
        total: 3,
        more: 1,
        next: 2,
    });
    assert.equal(dayOf(Date.UTC(2026, 0, 4, 20), -480), "2026-01-05");
    assert.equal(dayOf(Date.UTC(2026, 0, 4, 1), 300), "2026-01-03");
});

test("IANA day boundaries use the historical offset across daylight-saving changes", () => {
    assert.equal(dayOf(Date.UTC(2026, 0, 5, 4, 30), "America/New_York"), "2026-01-04");
    assert.equal(dayOf(Date.UTC(2026, 6, 5, 4, 30), "America/New_York"), "2026-07-05");
    const winter = Date.UTC(2026, 0, 5, 4, 30);
    const result = accountUsage(
        [{ at: winter, bucket: "models", key: "a/model", usage: usage(1, 0, 0.1) }],
        { models: { "a/model": usage(1, 0, 0.1) }, tools: {} },
        "America/New_York",
    );

    assert.ok(result.days["2026-01-04"]);
    assert.equal(result.days["2026-01-05"], undefined);
});
