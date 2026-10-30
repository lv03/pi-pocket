// Real codemode calls retain nested metadata after their parent task retires its result documents.
import {
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    context,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const dataDir = join(root, "nested-capture");
const source = join(root, "nested-source.txt");
const destination = join(root, "nested-written.txt");

writeFileSync(source, "one\ntwo\nthree\n");
after(cleanUp);

test("enabled capture retains codemode nested metadata after idle and restart without adding context or inherited bills", async () => {
    const model = () =>
        scriptedModel((request) => {
            const last = lastText(request as never);

            if (last.role === "user" && last.text.includes("Durable nested")) {
                return fauxAssistantMessage([fauxToolCall("nested_probe", {})], {
                    stopReason: "toolUse",
                });
            }

            if (last.role === "user") {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("codemode", {
                            code: `const read = await tools.read({path:${JSON.stringify(source)},offset:2,limit:1}); const written = await tools.write({path:${JSON.stringify(destination)},content:"new content\\n"}); return {read,written};`,
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage([fauxText("Nested work complete.")]);
        });

    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    writeFileSync(
        join(dataDir, "extensions", "nested-probe.ts"),
        `/** Durable nested inspection fixture. */
import {defineExtension,defineTool} from "@earendil-works/pi-durable";
import {Type} from "@earendil-works/pi-ai";
export default () => defineExtension({name:"nested-probe",tools:[defineTool({
name:"nested_probe",description:"Read through a real nested tool task",parameters:Type.Object({}),replay:"safe",
execute:async (_args,api,context)=>{await api.executeTool("read",{path:${JSON.stringify(source)},offset:2,limit:1},context);return {output:[{type:"text",text:"nested read complete"}]};}
})]});
`,
    );
    let app = await openApp(model(), dataDir);

    try {
        await app.setExtensionEnabled(owner(app), "context-insight.ts", true);
        await app.setExtensionEnabled(owner(app), "nested-probe.ts", true);
        const id = await newSession(app);

        await say(app, id, "Inspect the nested source and write one file.");
        await app.inspection.flush();
        const transcript = await app.transcripts.transcript(id, { full: true, limit: 200 });
        const parentResult = transcript.entries
            .flatMap((entry) => entry.messages ?? [])
            .find((message) => message.role === "toolResult" && message.name === "codemode");

        assert.equal(parentResult?.role, "toolResult");
        const calls = (parentResult?.role === "toolResult" ? parentResult.details : undefined) as {
            calls: {
                name: string;
                arguments: unknown;
                outputRecorded?: boolean;
                output?: unknown;
            }[];
        };

        assert.equal(calls.calls.length, 2);
        const read = calls.calls.find((row) => row.name === "read")!;

        assert.deepEqual(read.arguments, { path: source, offset: 2, limit: 1 });
        assert.equal(read.outputRecorded, true);
        assert.ok(read.output);
        const directActivity = await app.transcripts.toolActivity(id);

        assert.equal(
            directActivity.length,
            0,
            "Pocket codemode uses direct calls, not Durable nested tasks",
        );
        const native = await (await app.conversation(id)).context(context);

        assert.ok(native.entries.every((entry) => entry.kind !== "pocket.tool-activity"));
        const count = native.entries.length;

        await app.close();
        app = await openApp(model(), dataDir);
        const after = await app.transcripts.transcript(id, { full: true, limit: 200 });
        const retained = after.entries
            .flatMap((entry) => entry.messages ?? [])
            .find((message) => message.role === "toolResult" && message.name === "codemode");

        assert.deepEqual(retained, parentResult);
        assert.equal((await (await app.conversation(id)).context(context)).entries.length, count);
        const tail = native.entries.at(-1)!;
        const fork = await app.commands.fork(id, owner(app), { entryId: tail.id });

        assert.equal((await app.transcripts.toolActivity(fork.id)).length, 0);
        assert.equal((await app.inspection.usageHistory(fork.id)).events.length, 0);
        await app.setExtensionEnabled(owner(app), "context-insight.ts", false);
        const disabledId = await newSession(app);

        await say(app, disabledId, "Run with inspection disabled.");
        const disabledTranscript = await app.transcripts.transcript(disabledId, {
            full: true,
            limit: 200,
        });
        const disabledResult = disabledTranscript.entries
            .flatMap((entry) => entry.messages ?? [])
            .find((message) => message.role === "toolResult" && message.name === "codemode");
        const disabledDetails =
            disabledResult?.role === "toolResult"
                ? (disabledResult.details as { calls: unknown[] })
                : undefined;

        assert.ok(disabledDetails);
        assert.ok(
            disabledDetails.calls.every(
                (call) => !("output" in (call as object)) && !("arguments" in (call as object)),
            ),
        );
        assert.equal((await app.inspection.requestHistory(disabledId)).length, 0);
        await app.setExtensionEnabled(owner(app), "context-insight.ts", true);

        const nestedId = await newSession(app);

        await say(app, nestedId, "Durable nested read");
        await app.inspection.flush();
        const nested = await app.transcripts.toolActivity(nestedId);

        assert.equal(nested.length, 1);
        assert.equal(nested[0]!.toolName, "read");
        assert.equal(nested[0]!.status, "completed");
        assert.equal(nested[0]!.resultAvailable, true);
        assert.equal(nested[0]!.outputRecorded, true);
        assert.ok(nested[0]!.rootCallId);
        await app.close();
        app = await openApp(model(), dataDir);
        assert.deepEqual(await app.transcripts.toolActivity(nestedId), nested);
    } finally {
        await app.close();
    }
});
