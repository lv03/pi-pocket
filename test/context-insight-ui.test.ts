import {
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

const shots = "/tmp/context-insight-ui-shots";
const moduleName = "context-insight";
const unique = {
    firstUser: "CONTEXT_INSIGHT_FIRST_USER_EXACT",
    firstAnswer: "CONTEXT_INSIGHT_FIRST_ANSWER_EXACT",
    otherUser: "CONTEXT_INSIGHT_OTHER_USER_EXACT",
    read: "CONTEXT_INSIGHT_READ_EXACT",
    written: "CONTEXT_INSIGHT_WRITTEN_EXACT",
    edited: "CONTEXT_INSIGHT_EDITED_EXACT",
    command: "CONTEXT_INSIGHT_COMMAND_EXACT",
};

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let first: ConversationId;
let other: ConversationId;

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

const has = (selector: string) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
    );

const bodyText = () => inPage<string>(`return JSON.stringify(document.body.innerText)`);

const clickText = async (selector: string, label: string): Promise<void> => {
    await until(
        async () =>
            inPage<boolean>(`
                return JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})]
                    .some((element) => element.textContent.trim() === ${JSON.stringify(label)}));
            `),
        `${label} control`,
    );
    await page.evaluate(`
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((each) => each.textContent.trim() === ${JSON.stringify(label)});
        element.click();
        "clicked";
    `);
};

const waitForText = (value: string, what = value) =>
    until(async () => (await bodyText()).includes(value), what, 20_000);

const settleVisual = () =>
    page.evaluate(`
        await Promise.all([...document.getAnimations()]
            .filter((animation) => animation.effect?.target?.closest?.(".ext-page"))
            .map((animation) => animation.finished.catch(() => undefined)));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        "settled";
    `);

const openPanel = async (): Promise<void> => {
    if (await has(".ext-panel .ci")) {
        return;
    }

    const selector = (await has('.ext-top-button[data-module="context-insight"]'))
        ? '.ext-top-button[data-module="context-insight"]'
        : '.ext-composer-button[data-module="context-insight"]';

    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); "opened"`);
    await until(() => has(".ext-panel .ci"), "Context panel");
    await until(() => has(".ci-tabs .ci-tab"), "Context tabs");
    await page.evaluate(`document.querySelector(".ci-head-actions .ci-icon").click(); "english"`);
    await waitForText("What the model carries");
};

async function navigateSession(id: ConversationId): Promise<void> {
    await page.evaluate(`(await import("/store.js")).navigate(${Number(id)}); "navigated"`);
    await until(
        async () =>
            inPage<boolean>(`
                return JSON.stringify((await import("/store.js")).store.state.conversationId === ${Number(id)});
            `),
        `session ${id}`,
    );
}

async function tab(label: string): Promise<void> {
    await clickText(".ci-tabs .ci-tab", label);
}

async function saveShot(name: string, fullPage = false): Promise<string> {
    const shot = await page.screenshot({ fullPage });
    const path = join(shots, name);

    writeFileSync(path, Buffer.from(shot.data, "base64"));

    return path;
}

const route = (request: Parameters<typeof lastText>[0]) => {
    const { role, text } = lastText(request);

    if (role === "user") {
        if (text.includes("read fixture")) {
            return fauxAssistantMessage([fauxToolCall("read", { path: "fixture.txt" })], {
                stopReason: "toolUse",
            });
        }

        if (text.includes("write fixture")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("write", {
                        path: "written.txt",
                        content: `${unique.written}\nold line\n`,
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (text.includes("edit fixture")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("edit", {
                        path: "written.txt",
                        edits: [{ oldText: "old line", newText: unique.edited }],
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (text.includes("run fixture")) {
            return fauxAssistantMessage(
                [fauxToolCall("bash", { command: `printf '${unique.command}\\n'` })],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText(unique.firstAnswer)]);
    }

    return fauxAssistantMessage([fauxText("CONTEXT_INSIGHT_TOOL_COMPLETE_EXACT")]);
};

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(shots, { recursive: true });
    writeFileSync(join(work, "fixture.txt"), `${unique.read}\nsecond exact line\n`);
    app = await openApp(scriptedModel(route), mkdtempSync(join(root, "context-insight-data-")));
    await app.setExtensionEnabled(owner(app), "context-insight.ts", true);

    first = await newSession(app);
    other = await newSession(app);
    await say(app, first, unique.firstUser);
    await say(app, first, "read fixture");
    await say(app, first, "write fixture");
    await say(app, first, "edit fixture");
    await say(app, first, "run fixture");
    await say(app, other, unique.otherUser);

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "context-insight-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await navigateSession(first);
    await until(
        async () =>
            (await has('.ext-top-button[data-module="context-insight"]')) ||
            (await has('.ext-composer-button[data-module="context-insight"]')),
        "Context control",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "Context Insight UI covers seeded context, history, Insights, races, and viewports",
    { ...real, timeout: 90_000 },
    async () => {
        await openPanel();
        assert.match(await bodyText(), /CONTEXT_INSIGHT_FIRST_USER_EXACT/);
        assert.match(await bodyText(), /Tool schemas/);
        assert.match(await bodyText(), /Prompt sections/);

        const panelShot = await saveShot("context-panel-mobile.jpg");

        assert.equal(panelShot, "/tmp/context-insight-ui-shots/context-panel-mobile.jpg");

        // Sections, schemas, and user parts must expand to the exact server detail, not a clipped preview.
        await tab("Items");
        await until(
            async () =>
                (await inPage<number>(
                    `return JSON.stringify(document.querySelectorAll(".ci-item").length)`,
                )) > 0,
            "context items",
        );
        const expectedDetails = await inPage<{ role: string; label: string; expected: string }[]>(`
            const response = await fetch("/api/x/${moduleName}/items/${Number(first)}?offset=0&limit=200", { headers: { "x-pocket": "1" } });
            const result = await response.json();
            const wanted = ["section", "schema", "user"]
                .map((role) => result.items.find((item) => item.role === role))
                .filter(Boolean);
            const details = [];
            for (const item of wanted) {
                const key = item.key ?? JSON.stringify(item);
                const detail = await fetch("/api/x/${moduleName}/detail/${Number(first)}?key=" + encodeURIComponent(key), { headers: { "x-pocket": "1" } }).then((response) => response.json());
                const raw = item.role === "schema"
                    ? { description: detail.item.description, parameters: detail.item.parameters }
                    : (detail.item.text ?? detail.item.content ?? { description: detail.item.description, parameters: detail.item.parameters });
                details.push({ role: item.role, label: item.label, expected: typeof raw === "string" ? raw : JSON.stringify(raw, null, 2) });
            }
            return JSON.stringify(details);
        `);

        assert.equal(
            expectedDetails.some((item) => item.role === "section"),
            true,
            "a prompt section is seeded",
        );
        assert.equal(
            expectedDetails.some((item) => item.role === "schema"),
            true,
            "a tool schema is seeded",
        );
        assert.equal(
            expectedDetails.some((item) => item.role === "user"),
            true,
            "a user part is seeded",
        );

        const sectionGroups = await inPage<Record<string, string[]>>(`
            const response = await fetch("/api/x/${moduleName}/items/${Number(first)}?offset=0&limit=200", { headers: { "x-pocket": "1" } });
            const result = await response.json();
            const groups = {};
            for (const item of result.items.filter((candidate) => candidate.role === "section")) {
                (groups[item.category] ??= []).push(item.label);
            }
            return JSON.stringify(groups);
        `);
        const sectionLabels = Object.values(sectionGroups).flat();

        assert.ok(sectionLabels.length >= 3, "multiple prompt sections are retained");
        assert.equal(
            new Set(sectionLabels).size,
            sectionLabels.length,
            "section details keep distinct keys",
        );
        const displayedGroups = await inPage<Record<string, string[]>>(`
            const groups = {};
            for (const element of document.querySelectorAll(".ci-group")) {
                const heading = element.querySelector(".ci-group-head")?.textContent.trim() ?? "";
                const category = heading.startsWith("System prompt")
                    ? "system"
                    : heading.startsWith("Injected context")
                      ? "inject"
                      : heading;
                groups[category] = [...element.querySelectorAll(".ci-item-name")].map((item) => item.textContent.trim());
            }
            return JSON.stringify(groups);
        `);

        for (const [category, labels] of Object.entries(sectionGroups)) {
            assert.deepEqual(
                displayedGroups[category],
                labels,
                `browser preserves native ${category} section order while merging pages`,
            );
        }

        for (const label of sectionLabels) {
            await page.evaluate(`
                const button = [...document.querySelectorAll(".ci-item")].find((each) => each.querySelector(".ci-item-name")?.textContent.trim() === ${JSON.stringify(label)});
                button.click();
                "expanded";
            `);
            await until(
                async () =>
                    inPage<boolean>(
                        `return JSON.stringify([...document.querySelectorAll(".ci-item")].some((each) => each.querySelector(".ci-item-name")?.textContent.trim() === ${JSON.stringify(label)} && each.dataset.open === "1" && each.nextElementSibling?.querySelector(".ci-pre")?.textContent.trim().length > 0));`,
                    ),
                `${label} section detail`,
            );
            await page.evaluate(`
                const button = [...document.querySelectorAll(".ci-item")].find((each) => each.querySelector(".ci-item-name")?.textContent.trim() === ${JSON.stringify(label)});
                button.click();
                "closed";
            `);
        }

        for (const detail of expectedDetails) {
            await page.evaluate(`
                const button = [...document.querySelectorAll(".ci-item")].find((each) => each.querySelector(".ci-item-name")?.textContent.trim() === ${JSON.stringify(detail.label)});
                button.click();
                "expanded";
            `);
            await until(
                async () =>
                    inPage<boolean>(`
                        return JSON.stringify([...document.querySelectorAll(".ci-item")].some((each) => each.querySelector(".ci-item-name")?.textContent.trim() === ${JSON.stringify(detail.label)} && each.dataset.open === "1"));
                    `),
                `${detail.role} item expansion`,
            );
            await until(
                async () =>
                    (await bodyText()).includes(
                        detail.expected.slice(0, Math.min(80, detail.expected.length)),
                    ),
                `${detail.role} exact content`,
            );
            await page.evaluate(`
                const button = [...document.querySelectorAll(".ci-item")].find((each) => each.querySelector(".ci-item-name")?.textContent.trim() === ${JSON.stringify(detail.label)});
                button.click();
                "closed";
            `);
        }

        await tab("Events");
        await until(() => has(".ci-event"), "section events");
        const eventDetails = await inPage<string[]>(`
            return JSON.stringify([...document.querySelectorAll(".ci-event-detail")].map((element) => element.textContent.trim()));
        `);

        assert.ok(eventDetails.length >= 2, "multiple section events are visible");
        assert.ok(new Set(eventDetails).size >= 2, "section events keep distinct details");

        await tab("Growth");
        await until(() => has('select[aria-label="Metric"]'), "trend metric control");
        await page.select({ selector: 'select[aria-label="Metric"]' }, "delta");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('select[aria-label="Metric"]').value)`,
            ),
            "delta",
        );
        await clickText('.ci-switch button[aria-pressed="false"]', "Turn");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.ci-switch button[aria-pressed="true"]')?.textContent.trim() === "Turn")`,
            ),
            true,
        );
        await clickText(".ci-button", "Usage and timing table");
        await until(() => has(".ci-table tbody tr"), "usage and timing table");
        await page.evaluate(
            `document.querySelectorAll('input[type="range"]')[0].value = "0"; document.querySelectorAll('input[type="range"]')[0].dispatchEvent(new Event("input", { bubbles: true })); "range"`,
        );

        await tab("Items");
        await clickText('.ci-switch button[aria-pressed="false"]', "DNA");
        await until(() => has(".ci-dna button"), "DNA items");
        await page.evaluate(`document.querySelector(".ci-dna button").click(); "DNA selected"`);
        await until(
            async () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".ci-dna button[aria-pressed=\\"true\\"]") !== null)`,
                ),
            "DNA selection",
        );

        await tab("History");
        await waitForText("Captured requests", "captured requests history");
        await until(() => has(".ci-details"), "history rows");
        await page.evaluate(`
            const card = [...document.querySelectorAll(".ci-card")].find((each) => each.querySelector(".ci-card-head")?.textContent.includes("Captured requests"));
            card?.querySelector(".ci-details summary")?.click();
            "capture";
        `);
        await waitForText(
            "Captured normalized input after request hooks",
            "captured request detail",
        );
        assert.match(await bodyText(), /CONTEXT_INSIGHT_FIRST_USER_EXACT/);

        // The panel follows the live session. The delayed old response must not replace the new session.
        await page.evaluate(`
            globalThis.__ciOriginalFetch ??= window.fetch.bind(window);
            globalThis.__ciOldDelay = true;
            window.fetch = (input, init) => {
                const url = typeof input === "string" ? input : input.url;
                if (globalThis.__ciOldDelay && url.includes("/api/x/${moduleName}/session/${Number(first)}")) {
                    return new Promise((resolve, reject) => {
                        const timer = setTimeout(() => globalThis.__ciOriginalFetch(input, init).then(resolve, reject), 1800);
                        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
                    });
                }
                return globalThis.__ciOriginalFetch(input, init);
            };
            "delayed";
        `);
        await navigateSession(other);
        await until(
            async () => (await bodyText()).includes("CONTEXT_INSIGHT_OTHER_USER_EXACT"),
            "new session context",
        );
        assert.equal(
            (await bodyText()).includes("CONTEXT_INSIGHT_FIRST_USER_EXACT"),
            false,
            "late old data is not shown",
        );
        await page.evaluate(`globalThis.__ciOldDelay = false; "released"`);

        // Context Insights is a page. Close the panel first, including its leaving animation, so the page is visible.
        await page.evaluate(`(await import("/extension-ui.js")).closeExtPanel(); "panel closed"`);
        await until(
            async () =>
                inPage<boolean>(`
                    const visible = [...document.querySelectorAll(".ext-panel")].some((element) => {
                        const rect = element.getBoundingClientRect();
                        const style = getComputedStyle(element);
                        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
                    });
                    return JSON.stringify(!visible);
                `),
            "Context panel overlay removal",
        );
        await page.setViewport(VIEWPORTS.desktop);
        await page.evaluate(`
            globalThis.__ciOriginalFetch ??= window.fetch.bind(window);
            globalThis.__ciDelayInsights = true;
            window.fetch = (input, init) => {
                const url = typeof input === "string" ? input : input.url;
                if (globalThis.__ciDelayInsights && url.includes("/api/x/${moduleName}/insight/")) {
                    return new Promise((resolve, reject) => {
                        const timer = setTimeout(() => globalThis.__ciOriginalFetch(input, init).then(resolve, reject), 1200);
                        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
                    });
                }
                return globalThis.__ciOriginalFetch(input, init);
            };
            "delayed insights";
        `);
        await page.evaluate(
            `(await import("/extension-ui.js")).openPage("context-insight", "insights"); "insights"`,
        );
        await until(
            async () =>
                inPage<boolean>(`
                    const pageBox = document.querySelector(".ext-page .ci")?.getBoundingClientRect();
                    const panelVisible = [...document.querySelectorAll(".ext-panel")].some((element) => {
                        const rect = element.getBoundingClientRect();
                        const style = getComputedStyle(element);
                        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
                    });
                    return JSON.stringify(Boolean(pageBox && pageBox.width > 0 && pageBox.height > 0 && !panelVisible));
                `),
            "visible Context Insights page without the panel overlay",
        );
        await settleVisual();
        await clickText(".ci-tabs .ci-tab", "All");
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll("button.ci-button")].some((each) => each.textContent.trim() === "Cancel"))`,
                ),
            "Insights cancellation control",
        );
        await clickText("button.ci-button", "Cancel");
        await waitForText("Cancelled", "cancelled Insights scan");
        await page.evaluate(`globalThis.__ciDelayInsights = false; "released"`);

        await page.evaluate(`
            globalThis.__ciFailOne = true;
            window.fetch = (input, init) => {
                const url = typeof input === "string" ? input : input.url;
                if (globalThis.__ciFailOne && url.includes("/api/x/${moduleName}/insight/${Number(other)}")) {
                    globalThis.__ciFailOne = false;
                    return Promise.resolve(new Response("temporary fixture failure", { status: 503 }));
                }
                return globalThis.__ciOriginalFetch(input, init);
            };
            "fail once";
        `);
        await page.evaluate(
            `document.querySelector('.ext-page .ci .ci-icon[title="Refresh"]').click(); "refresh"`,
        );
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll("button.ci-button")].some((each) => each.textContent.includes("Retry failed")))`,
                ),
            "Insights retry control",
        );
        await clickText("button.ci-button", "Retry failed (1)");
        await until(
            async () =>
                (await bodyText()).includes("Scanned 2/2") &&
                !(await bodyText()).includes("Retry failed"),
            "retried Insights scan",
        );
        assert.match(await bodyText(), /CONTEXT_INSIGHT_OTHER_USER_EXACT|Sessions/);

        // Both requested viewports must keep content inside the viewport and produce no console errors.
        for (const [name, viewport] of [
            ["mobile", VIEWPORTS.mobile],
            ["desktop", VIEWPORTS.desktop],
        ] as const) {
            await page.setViewport(viewport);
            await settleVisual();
            const geometry = await inPage<{
                overflow: boolean;
                outside: string[];
                pageVisible: boolean;
                pageOpacity: number;
                pageHit: boolean;
                panelVisible: boolean;
            }>(`
                const pageElement = document.querySelector(".ext-page");
                const pageBox = document.querySelector(".ext-page .ci")?.getBoundingClientRect();
                const pageStyle = pageElement ? getComputedStyle(pageElement) : null;
                const pageHit = document.elementFromPoint(innerWidth * 0.7, innerHeight * 0.2)?.closest(".ext-page") !== null;
                const panelVisible = [...document.querySelectorAll(".ext-panel")].some((element) => {
                    const rect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
                });
                const outside = [...document.querySelectorAll(".ci, .ci *")]
                    .filter((element) => {
                        if (element.closest(".ci-table-wrap, .ci-tabs")) {
                            return false;
                        }

                        const rect = element.getBoundingClientRect();
                        return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
                    })
                    .slice(0, 10)
                    .map((element) => element.tagName + "." + element.className);
                return JSON.stringify({
                    overflow: document.documentElement.scrollWidth > innerWidth + 1,
                    outside,
                    pageVisible: Boolean(pageBox && pageBox.width > 0 && pageBox.height > 0),
                    pageOpacity: Number(pageStyle?.opacity ?? 0),
                    pageHit,
                    panelVisible,
                });
            `);

            assert.equal(
                geometry.pageVisible,
                true,
                `${name} Insights page is visible in the screenshot`,
            );
            assert.ok(geometry.pageOpacity > 0.95, `${name} Insights page is not dimmed`);
            assert.equal(geometry.pageHit, true, `${name} screenshot point hits Insights page`);
            assert.equal(
                geometry.panelVisible,
                false,
                `${name} Context panel is not over the Insights page`,
            );
            assert.equal(geometry.overflow, false, `${name} has no horizontal overflow`);
            assert.deepEqual(geometry.outside, [], `${name} has no element outside the viewport`);
            const path = await saveShot(`context-insights-${name}.jpg`);

            assert.equal(path, `/tmp/context-insight-ui-shots/context-insights-${name}.jpg`);
        }

        const errors = page.state(true).errors;

        assert.equal(errors, 0, `Chromium console errors: ${errors}`);
    },
);
