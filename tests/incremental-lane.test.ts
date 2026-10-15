import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-incr-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

interface Turn {
    sinceSeq: number;
    messages: unknown[];
    resync?: boolean;
    system?: string;
    request?: Record<string, unknown>;
}

interface Harness {
    proxyUrl: string;
    path: string;
    turn: (t: Turn) => Promise<{ status: number; headers: Headers; body: unknown }>;
    forwarded: Record<string, unknown>[];
    dir: string;
    close: () => Promise<void>;
}

async function harness(storageMode: "full" | "legacy", opts: { upstreamDelayMs?: number } = {}): Promise<Harness> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = storageMode === "full" ? "full" : "legacy";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            const reply = (): void => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
            };
            if (opts.upstreamDelayMs) setTimeout(reply, opts.upstreamDelayMs);
            else reply();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const path = "/v1/messages";
    const turn = async (t: Turn) => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-inc-1" },
            body: JSON.stringify({ conversationId: "conv-inc-1", sinceSeq: t.sinceSeq, ...(t.resync ? { resync: true } : {}), ...(t.system !== undefined ? { system: t.system } : {}), path, request: { model: "claude-test", max_tokens: 1024, ...(t.request ?? {}) }, messages: t.messages }),
        });
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, headers: response.headers, body };
    };
    // store handle must be released before the teardown rm -rf: Windows cannot
    // unlink an open index.db (EBUSY) — same seam the storage-unified suite uses.
    return { proxyUrl, path, turn, forwarded, dir, close: async () => { await new Promise<void>((resolve) => proxy.close(() => resolve())); store.closeQuietly(); await new Promise<void>((resolve) => upstream.close(() => resolve())); } };
}

const userTurn = (n: number, text = "hello") => ({ id: `u${n}`, role: "user", contentType: "text", content: text.repeat(400) });
const assistantTurn = (n: number) => ({ id: `a${n}`, role: "assistant", contentType: "text", content: `model answer ${n}` });

test("incremental lane: seed → delta → upstream receives the assembled full history; ack advances", async () => {
    const h = await harness("full");
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1)] });
        assert.equal(seed.status, 200);
        assert.equal(seed.headers.get("x-bili-applied-seq"), "1");
        const upstream1 = h.forwarded.at(-1) as { system?: unknown; messages: { role: string; content: string }[] };
        assert.ok(Array.isArray(upstream1.messages) && upstream1.messages.length === 1);
        assert.equal(upstream1.messages[0].role, "user");

        // Delta: everything after ack — the previous assistant reply + the new user turn.
        const delta = await h.turn({ sinceSeq: 1, messages: [assistantTurn(1), userTurn(2, "second question")] });
        assert.equal(delta.status, 200);
        assert.equal(delta.headers.get("x-bili-applied-seq"), "3");
        const upstream2 = h.forwarded.at(-1) as { messages: { role: string }[] };
        assert.equal(upstream2.messages.length, 3, "assembled history = seed + delta");
        assert.deepEqual(upstream2.messages.map((m) => m.role), ["user", "assistant", "user"]);
    } finally {
        await h.close();
    }
});

test("incremental lane: seq mismatch answers 409 with the server's seq; resync recovers", async () => {
    const h = await harness("full");
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1)] });
        assert.equal(seed.status, 200);
        // Client guesses a stale seq.
        const stale = await h.turn({ sinceSeq: 0, messages: [assistantTurn(1), userTurn(2)] });
        assert.equal(stale.status, 409);
        assert.equal((stale.body as { error?: string }).error, "seq-mismatch");
        assert.equal((stale.body as { serverSeq?: number }).serverSeq, 1);
        // Resync with the full history re-seeds the canonical.
        const recovered = await h.turn({ sinceSeq: 0, resync: true, messages: [userTurn(1), assistantTurn(1), userTurn(2)] });
        assert.equal(recovered.status, 200);
        assert.equal(recovered.headers.get("x-bili-applied-seq"), "3");
        const upstream = h.forwarded.at(-1) as { messages: { role: string }[] };
        assert.deepEqual(upstream.messages.map((m) => m.role), ["user", "assistant", "user"]);
    } finally {
        await h.close();
    }
});

test("incremental lane: cold rebuild after restart serves the next delta from the unified table", async () => {
    const h = await harness("full");
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1)] });
        assert.equal(seed.status, 200);
        // Simulate a process restart: session pool + warm caches dropped. The
        // canonical prefix must rebuild from the unified messages table.
        _resetSessionsForTest();
        __resetIncrementalLaneForTests();
        const delta = await h.turn({ sinceSeq: 1, messages: [assistantTurn(1), userTurn(2, "after restart")] });
        assert.equal(delta.status, 200);
        const upstream = h.forwarded.at(-1) as { messages: { role: string }[] };
        assert.deepEqual(upstream.messages.map((m) => m.role), ["user", "assistant", "user"], "table-rebuilt canonical + delta");
    } finally {
        await h.close();
    }
});

test("incremental lane: divergent resync survives a cold restart without a 409 loop", async () => {
    const h = await harness("full");
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1, "old branch one"), assistantTurn(1), userTurn(2, "old branch two")] });
        assert.equal(seed.status, 200);
        // The client rewinds to an edited branch (divergent content, ids and all).
        const resync = await h.turn({ sinceSeq: 0, resync: true, messages: [userTurn(1, "edited branch")] });
        assert.equal(resync.status, 200);
        assert.equal(resync.headers.get("x-bili-applied-seq"), "1");
        // Cold restart: the canonical must rebuild from the CURRENT branch
        // only — the rejected branch's rows stay in the table (append-only)
        // but the served history slices past them (baseSeq epoch).
        _resetSessionsForTest();
        __resetIncrementalLaneForTests();
        const delta = await h.turn({ sinceSeq: 1, messages: [assistantTurn(1), userTurn(2, "new branch tail")] });
        assert.equal(delta.status, 200);
        assert.equal(delta.headers.get("x-bili-applied-seq"), "3");
        const upstream = h.forwarded.at(-1) as { messages: { role: string; content: unknown }[] };
        assert.equal(upstream.messages.length, 3, "served history is the edited branch, not the row union");
        const first = JSON.stringify(upstream.messages[0].content);
        assert.ok(first.includes("edited branch"), `first message is the resynced one: ${first.slice(0, 80)}`);
        assert.ok(!JSON.stringify(upstream.messages).includes("old branch"), "old branch rows do not leak into the canonical");
    } finally {
        await h.close();
    }
});

test("incremental lane: sessions share the plugin conversation id — incremental and normal traffic interop", async () => {
    const h = await harness("full");
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1)] });
        assert.equal(seed.status, 200);
        const session = peekSession("conv-inc-1");
        assert.ok(session, "session id = the plugin conversation id (same as normal plugin traffic)");
        assert.equal(session.stats.requests, 1);
    } finally {
        await h.close();
    }
});

test("incremental lane: sticky system — omitted system keeps the last one, a new value replaces it", async () => {
    const h = await harness("full");
    // The assembled body rides the normal pipeline, which renders the system
    // prompt as anthropic blocks (with its cache marks) — compare by text.
    const sysText = (v: unknown): string => typeof v === "string" ? v : Array.isArray(v) ? v.map((b) => (b as { text?: string })?.text ?? "").join("") : String(v);
    try {
        await h.turn({ sinceSeq: 0, system: "SYSTEM-A", messages: [userTurn(1)] });
        const upstream1 = sysText((h.forwarded.at(-1) as { system?: unknown }).system);
        assert.ok(upstream1.startsWith("SYSTEM-A"), `turn 1 carries the client system: ${upstream1.slice(0, 40)}`);
        // Omitted → sticky.
        await h.turn({ sinceSeq: 1, messages: [assistantTurn(1), userTurn(2)] });
        const upstream2 = sysText((h.forwarded.at(-1) as { system?: unknown }).system);
        assert.ok(upstream2.startsWith("SYSTEM-A"), "omitted system keeps the last one");
        // Explicit new value replaces.
        await h.turn({ sinceSeq: 3, system: "SYSTEM-B", messages: [assistantTurn(2), userTurn(3)] });
        const upstream3 = sysText((h.forwarded.at(-1) as { system?: unknown }).system);
        assert.ok(upstream3.startsWith("SYSTEM-B"), "explicit system replaces");
        assert.ok(!upstream3.includes("SYSTEM-A"), "the old system is fully replaced");
    } finally {
        await h.close();
    }
});

test("incremental lane: a second concurrent turn on the same conversation answers 409 turn-in-flight", async () => {
    // Margins sized for loaded runners: the settle sleep must beat the first
    // request's path into inFlight, and the upstream delay must outlive it —
    // 40ms/150ms flaked (review of #3253).
    const h = await harness("full", { upstreamDelayMs: 800 });
    try {
        const first = h.turn({ sinceSeq: 0, messages: [userTurn(1)] });
        await new Promise((r) => setTimeout(r, 120)); // let the first enter forward
        const second = await h.turn({ sinceSeq: 1, messages: [assistantTurn(1), userTurn(2)] });
        assert.equal(second.status, 409);
        assert.equal((second.body as { error?: string }).error, "turn-in-flight");
        assert.equal((await first).status, 200);
    } finally {
        await h.close();
    }
});

test("incremental lane: request params (tools/max_tokens) ride the assembled body to the upstream", async () => {
    const h = await harness("full");
    try {
        const tools = [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: {} } }];
        await h.turn({ sinceSeq: 0, request: { max_tokens: 777, tools }, messages: [userTurn(1)] });
        const upstream = h.forwarded.at(-1) as { max_tokens?: number; tools?: unknown; model?: string };
        assert.equal(upstream.max_tokens, 777);
        assert.equal(upstream.model, "claude-test");
        assert.ok(Array.isArray(upstream.tools));
        // Disallowed request params never ride.
        await h.turn({ sinceSeq: 1, request: { max_tokens: 512, messages: [{ role: "user", content: "smuggled" }] } as never, messages: [assistantTurn(1), userTurn(2)] });
        const upstream2 = h.forwarded.at(-1) as { messages: { role: string }[] };
        assert.equal(upstream2.messages.length, 3, "request.messages is ignored — the lane owns the message list");
    } finally {
        await h.close();
    }
});

test("incremental lane: legacy-only storage answers 503 with the enablement hint", async () => {
    const h = await harness("legacy");
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1)] });
        assert.equal(seed.status, 503);
        assert.match(String((seed.body as { error?: string }).error), /storage\.unified/);
    } finally {
        await h.close();
    }
});
