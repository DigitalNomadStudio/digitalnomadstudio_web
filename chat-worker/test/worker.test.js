import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, normaliseMessages, isAllowedOrigin, CAPTURE_ENQUIRY_TOOL, MODEL } from "../src/index.js";

const ORIGIN = "https://www.digitalnomadstudio.io";
const env = {
    ANTHROPIC_API_KEY: "test-key",
    WEB3FORMS_KEY: "test-web3forms-key",
    ALLOWED_ORIGINS: "https://www.digitalnomadstudio.io,https://digitalnomadstudio.io",
    NOTIFY_EMAIL: "team@digitalnomadstudio.io"
};

function makeCtx() {
    const tasks = [];
    return { waitUntil: (p) => tasks.push(p), tasks };
}

function request(body, opts = {}) {
    const method = opts.method || "POST";
    const headers = { "Content-Type": "application/json" };
    if (opts.origin !== null) { headers.Origin = opts.origin === undefined ? ORIGIN : opts.origin; }
    const init = { method, headers };
    if (method === "POST") { init.body = typeof body === "string" ? body : JSON.stringify(body); }
    return new Request("https://dns-chat.example.workers.dev/", init);
}

// A stand-in for the SDK's MessageStream: replays text deltas, then resolves the final message.
function fakeStream(script) {
    const handlers = {};
    const stream = {
        on(event, cb) { (handlers[event] = handlers[event] || []).push(cb); return stream; },
        async finalMessage() {
            if (script.error) { throw script.error; }
            for (const delta of script.text || []) { for (const cb of handlers.text || []) { cb(delta); } }
            return script.final;
        }
    };
    return stream;
}

function fakeClient(scripts, calls) {
    return { beta: { messages: { stream(params) { calls.push(params); return fakeStream(scripts.shift()); } } } };
}

async function readEvents(res) {
    const text = await res.text();
    return text.split("\n\n").filter(Boolean).map((chunk) => {
        assert.ok(chunk.startsWith("data: "), `unexpected SSE chunk: ${chunk}`);
        return JSON.parse(chunk.slice(6));
    });
}

const LEAD = {
    service_type: "AI automation",
    business: "Plumbing business, 8 staff, western Sydney",
    industry: "Trades and construction",
    problem: "Quotes are typed up by hand every evening from voice notes",
    timeline: "Within 1-3 months",
    budget: "Not provided",
    name: "Sam Taylor",
    email: "sam@example.com",
    phone: "Not provided",
    summary: "Plumbing business wants quotes drafted automatically from voice notes."
};

test("streams a plain text reply with the documented request shape", async () => {
    const calls = [];
    const client = fakeClient([{ text: ["Hello", " there"], final: { stop_reason: "end_turn", content: [{ type: "text", text: "Hello there" }] } }], calls);
    const handler = createHandler({ createClient: () => client, fetch: async () => { throw new Error("Web3Forms should not be called"); } });
    const ctx = makeCtx();
    const res = await handler(request({ messages: [{ role: "user", content: "Hi" }], page: "/" }), env, ctx);

    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type"), /text\/event-stream/);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.equal(ctx.tasks.length, 1);
    const events = await readEvents(res);
    assert.deepEqual(events, [{ type: "text", delta: "Hello" }, { type: "text", delta: " there" }, { type: "done", lead: false }]);

    assert.equal(calls.length, 1);
    const params = calls[0];
    assert.equal(params.model, MODEL);
    assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
    assert.equal(params.fallbacks, "default");
    assert.deepEqual(params.output_config, { effort: "low" });
    assert.equal(params.system[0].type, "text");
    assert.deepEqual(params.system[0].cache_control, { type: "ephemeral" });
    assert.equal(params.tools[0], CAPTURE_ENQUIRY_TOOL);
    assert.equal(params.tools[0].strict, true);
    assert.equal(params.tools[0].input_schema.additionalProperties, false);
    assert.deepEqual(params.tools[0].input_schema.required, Object.keys(params.tools[0].input_schema.properties));
    assert.deepEqual(params.messages, [{ role: "user", content: "Hi" }]);
});

test("delivers the enquiry through the tool loop and tells the browser", async () => {
    const calls = [];
    const firstContent = [
        { type: "text", text: "Sending that now." },
        { type: "tool_use", id: "toolu_01", name: "capture_enquiry", input: LEAD }
    ];
    const client = fakeClient([
        { text: ["Sending that now."], final: { stop_reason: "tool_use", content: firstContent } },
        { text: ["Done - the team will reply within two business days."], final: { stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] } }
    ], calls);
    const posted = [];
    const handler = createHandler({
        createClient: () => client,
        fetch: async (url, init) => { posted.push({ url, init }); return new Response(JSON.stringify({ success: true }), { status: 200 }); }
    });
    const res = await handler(request({ messages: [{ role: "user", content: "Yes please send it" }], page: "/ai-services.html" }), env, makeCtx());
    const events = await readEvents(res);

    assert.deepEqual(events.map((e) => e.type), ["text", "lead", "text", "done"]);
    assert.equal(events[events.length - 1].lead, true);

    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, "https://api.web3forms.com/submit");
    const payload = JSON.parse(posted[0].init.body);
    assert.equal(payload.access_key, env.WEB3FORMS_KEY);
    assert.equal(payload.subject, "New Chat Enquiry - AI automation");
    assert.equal(payload.email, "sam@example.com");
    assert.equal(payload.name, "Sam Taylor");
    assert.equal(payload.problem, LEAD.problem);
    assert.equal(payload.page, "/ai-services.html");

    assert.equal(calls.length, 2);
    const second = calls[1].messages;
    assert.equal(second.length, 3);
    assert.deepEqual(second[1], { role: "assistant", content: firstContent });
    assert.equal(second[2].role, "user");
    assert.equal(second[2].content[0].type, "tool_result");
    assert.equal(second[2].content[0].tool_use_id, "toolu_01");
    assert.equal(second[2].content[0].is_error, undefined);
});

test("reports a failed delivery back to the model as a tool error", async () => {
    const calls = [];
    const client = fakeClient([
        { text: [], final: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_02", name: "capture_enquiry", input: LEAD }] } },
        { text: ["Sorry, that did not send."], final: { stop_reason: "end_turn", content: [{ type: "text", text: "Sorry" }] } }
    ], calls);
    const handler = createHandler({
        createClient: () => client,
        fetch: async () => new Response(JSON.stringify({ success: false, message: "Invalid access key" }), { status: 200 })
    });
    const res = await handler(request({ messages: [{ role: "user", content: "send it" }] }), env, makeCtx());
    const events = await readEvents(res);
    assert.deepEqual(events.map((e) => e.type), ["text", "done"]);
    assert.equal(events[1].lead, false);
    const result = calls[1].messages[2].content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /Invalid access key/);
    assert.match(result.content, /team@digitalnomadstudio.io/);
});

test("rejects a lead without a valid email before contacting Web3Forms", async () => {
    let fetched = 0;
    const client = fakeClient([
        { text: [], final: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_03", name: "capture_enquiry", input: { ...LEAD, email: "Not provided" } }] } },
        { text: ["I still need your email."], final: { stop_reason: "end_turn", content: [] } }
    ], []);
    const handler = createHandler({ createClient: () => client, fetch: async () => { fetched += 1; return new Response("{}"); } });
    const res = await handler(request({ messages: [{ role: "user", content: "send it" }] }), env, makeCtx());
    const events = await readEvents(res);
    assert.equal(fetched, 0);
    assert.equal(events.some((e) => e.type === "lead"), false);
});

test("handles a refusal with a polite message", async () => {
    const client = fakeClient([{ text: [], final: { stop_reason: "refusal", content: [] } }], []);
    const handler = createHandler({ createClient: () => client });
    const res = await handler(request({ messages: [{ role: "user", content: "..." }] }), env, makeCtx());
    const events = await readEvents(res);
    assert.equal(events[0].type, "text");
    assert.match(events[0].delta, /team@digitalnomadstudio.io/);
    assert.deepEqual(events[1], { type: "done", lead: false });
});

test("turns API errors into an error event", async () => {
    const err = Object.assign(new Error("overloaded"), { status: 529 });
    const client = fakeClient([{ error: err }], []);
    const handler = createHandler({ createClient: () => client });
    const res = await handler(request({ messages: [{ role: "user", content: "Hi" }] }), env, makeCtx());
    const events = await readEvents(res);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.match(events[0].message, /busy/);
});

test("CORS preflight and origin checks", async () => {
    const handler = createHandler({ createClient: () => { throw new Error("no client expected"); } });
    const ok = await handler(request(null, { method: "OPTIONS" }), env, makeCtx());
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.equal(ok.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");

    const bad = await handler(request(null, { method: "OPTIONS", origin: "https://evil.example" }), env, makeCtx());
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get("Access-Control-Allow-Origin"), null);

    const post = await handler(request({ messages: [{ role: "user", content: "Hi" }] }, { origin: "https://evil.example" }), env, makeCtx());
    assert.equal(post.status, 403);

    const get = await handler(request(null, { method: "GET" }), env, makeCtx());
    assert.equal(get.status, 405);

    assert.equal(isAllowedOrigin("http://localhost:8000", env), true);
    assert.equal(isAllowedOrigin("http://127.0.0.1:8123", env), true);
    assert.equal(isAllowedOrigin("https://digitalnomadstudio.io/", env), true);
    assert.equal(isAllowedOrigin("", env), false);
});

test("configuration and body validation", async () => {
    const handler = createHandler({ createClient: () => { throw new Error("no client expected"); } });
    const noKey = await handler(request({ messages: [{ role: "user", content: "Hi" }] }), { ...env, ANTHROPIC_API_KEY: "" }, makeCtx());
    assert.equal(noKey.status, 503);

    const badJson = await handler(request("{not json"), env, makeCtx());
    assert.equal(badJson.status, 400);

    const tooMany = Array.from({ length: 41 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x" }));
    const many = await handler(request({ messages: tooMany }), env, makeCtx());
    assert.equal(many.status, 400);

    const badRole = await handler(request({ messages: [{ role: "system", content: "Hi" }] }), env, makeCtx());
    assert.equal(badRole.status, 400);

    const long = await handler(request({ messages: [{ role: "user", content: "x".repeat(2001) }] }), env, makeCtx());
    assert.equal(long.status, 400);

    const endsWithAssistant = await handler(request({ messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }] }), env, makeCtx());
    assert.equal(endsWithAssistant.status, 400);
});

test("normaliseMessages merges same-role runs and drops a leading assistant message", () => {
    const bell = String.fromCharCode(7);
    const result = normaliseMessages([
        { role: "assistant", content: "Greeting shown locally" },
        { role: "user", content: "First" },
        { role: "user", content: "Second" },
        { role: "assistant", content: "Reply" },
        { role: "user", content: "  Third " + bell + " " }
    ]);
    assert.deepEqual(result.messages, [
        { role: "user", content: "First\n\nSecond" },
        { role: "assistant", content: "Reply" },
        { role: "user", content: "Third" }
    ]);
    assert.equal(normaliseMessages([]).error, "messages must be a non-empty array");
    assert.equal(normaliseMessages([{ role: "user", content: "   " }]).error, "message content must not be empty");
});
