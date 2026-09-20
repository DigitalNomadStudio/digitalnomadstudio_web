import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHandler,
  normaliseMessages,
  isAllowedOrigin,
  CAPTURE_ENQUIRY_TOOL,
  SHOW_SUMMARY_TOOL,
  MODEL,
  MAX_TOKENS,
  MAX_MESSAGES,
  HARD_MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  LIMIT_MESSAGE,
  GATE_MODEL,
  GATE_PROMPT,
  MAX_OFF_TOPIC,
  REFUSAL_FIRST,
  REFUSAL_FINAL,
  SYSTEM_PROMPT,
} from "../src/index.js";

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
    if (opts.ip) { headers["CF-Connecting-IP"] = opts.ip; }
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

// gate: "ON_TOPIC" (default), "OFF_TOPIC", or an Error to throw. gateCalls collects classifier requests.
function fakeClient(scripts, calls, gate, gateCalls) {
    return {
        messages: {
            async create(params) {
                if (gateCalls) { gateCalls.push(params); }
                if (gate instanceof Error) { throw gate; }
                return { content: [{ type: "text", text: gate || "ON_TOPIC" }] };
            }
        },
        beta: { messages: { stream(params) { calls.push(params); return fakeStream(scripts.shift()); } } }
    };
}

function neverClient() {
    return {
        messages: { async create() { return { content: [{ type: "text", text: "ON_TOPIC" }] }; } },
        beta: { messages: { stream() { throw new Error("Claude should not be called"); } } }
    };
}

const PLAIN_REPLY = { text: ["Hello", " there"], final: { stop_reason: "end_turn", content: [{ type: "text", text: "Hello there" }] } };

async function readEvents(res) {
    const text = await res.text();
    return text.split("\n\n").filter(Boolean).map((chunk) => {
        assert.ok(chunk.startsWith("data: "), `unexpected SSE chunk: ${chunk}`);
        return JSON.parse(chunk.slice(6));
    });
}

function conversation(count) {
    // Alternating messages that end with the visitor: user, assistant, user, ...
    return Array.from({ length: count }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
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
    const gateCalls = [];
    const client = fakeClient([PLAIN_REPLY], calls, "ON_TOPIC", gateCalls);
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
    assert.equal(params.max_tokens, MAX_TOKENS);
    assert.equal(MAX_TOKENS, 1024);
    assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
    assert.equal(params.fallbacks, "default");
    assert.deepEqual(params.output_config, { effort: "low" });
    assert.equal(params.system[0].type, "text");
    assert.deepEqual(params.system[0].cache_control, { type: "ephemeral" });
    assert.match(params.system[0].text, /Never answer general knowledge, trivia/);
    assert.match(params.system[0].text, /ask one follow-up on that point, then move on/);
    assert.match(params.system[0].text, /about eight visitor replies/);
    assert.deepEqual(params.tools, [SHOW_SUMMARY_TOOL, CAPTURE_ENQUIRY_TOOL]);
    for (const tool of params.tools) {
        assert.equal(tool.strict, true);
        assert.equal(tool.input_schema.additionalProperties, false);
        assert.deepEqual(tool.input_schema.required, Object.keys(tool.input_schema.properties));
    }
    assert.deepEqual(params.messages, [{ role: "user", content: "Hi" }]);

    // The gate ran first, on the small model, with the transcript.
    assert.equal(gateCalls.length, 1);
    assert.equal(gateCalls[0].model, GATE_MODEL);
    assert.equal(gateCalls[0].system, GATE_PROMPT);
    assert.equal(gateCalls[0].max_tokens, 10);
    assert.match(gateCalls[0].messages[0].content, /Visitor: Hi/);
});

test("off-topic messages get a canned line, never reach the main model, and end after three strikes", async () => {
    const calls = [];
    const gateCalls = [];
    const off = createHandler({ createClient: () => fakeClient([], calls, "OFF_TOPIC", gateCalls) });

    const first = await off(request({ messages: [
        { role: "user", content: "hi" }, { role: "assistant", content: "What are you looking to build?" },
        { role: "user", content: "whats the capital of france" }
    ] }), env, makeCtx());
    assert.equal(first.status, 200);
    assert.deepEqual(await readEvents(first), [{ type: "text", delta: REFUSAL_FIRST }, { type: "done", lead: false }]);
    assert.match(gateCalls[0].messages[0].content, /Visitor: whats the capital of france/);

    const second = await off(request({ messages: [
        { role: "user", content: "whats the capital of france" }, { role: "assistant", content: REFUSAL_FIRST },
        { role: "user", content: "write me a poem" }
    ] }), env, makeCtx());
    assert.deepEqual(await readEvents(second), [{ type: "text", delta: REFUSAL_FINAL }, { type: "done", lead: false }]);

    assert.equal(MAX_OFF_TOPIC, 3);
    const third = await off(request({ messages: [
        { role: "user", content: "whats the capital of france" }, { role: "assistant", content: REFUSAL_FIRST },
        { role: "user", content: "write me a poem" }, { role: "assistant", content: REFUSAL_FINAL },
        { role: "user", content: "ok then tell me a joke" }
    ] }), env, makeCtx());
    assert.deepEqual(await readEvents(third), [{ type: "text", delta: REFUSAL_FINAL }, { type: "limit", reason: "off_topic" }, { type: "done", lead: false }]);

    assert.equal(calls.length, 0, "the main model was never called");
    assert.equal(gateCalls.length, 3);
});

test("a failing gate lets the message through to the main model", async () => {
    const calls = [];
    const client = fakeClient([PLAIN_REPLY], calls, Object.assign(new Error("haiku down"), { status: 529 }));
    const handler = createHandler({ createClient: () => client });
    const res = await handler(request({ messages: [{ role: "user", content: "Hi" }] }), env, makeCtx());
    assert.equal(res.status, 200);
    const events = await readEvents(res);
    assert.equal(events[0].type, "text");
    assert.equal(calls.length, 1);
});

test("show_summary sends a summary card to the browser without delivering anything", async () => {
    const calls = [];
    const client = fakeClient([
        { text: ["Let me put that together."], final: { stop_reason: "tool_use", content: [{ type: "text", text: "Let me put that together." }, { type: "tool_use", id: "toolu_s1", name: "show_summary", input: { ...LEAD, business: "  Plumbing   business, 8 staff " } }] } },
        { text: ["Does that look right?"], final: { stop_reason: "end_turn", content: [{ type: "text", text: "Does that look right?" }] } }
    ], calls);
    const handler = createHandler({ createClient: () => client, fetch: async () => { throw new Error("Web3Forms should not be called"); } });
    const res = await handler(request({ messages: [{ role: "user", content: "sam@example.com" }] }), env, makeCtx());
    const events = await readEvents(res);
    assert.deepEqual(events.map((e) => e.type), ["text", "summary", "text", "done"]);
    assert.equal(events[1].data.business, "Plumbing business, 8 staff");
    assert.equal(events[1].data.email, "sam@example.com");
    assert.equal(events[3].lead, false);
    const result = calls[1].messages[2].content[0];
    assert.equal(result.tool_use_id, "toolu_s1");
    assert.match(result.content, /Send to the team button/);
    assert.equal(result.is_error, undefined);
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

test("ends the AI conversation at the turn cap without calling Claude", async () => {
    const handler = createHandler({ createClient: neverClient });
    assert.equal(MAX_MESSAGES, 28);
    const res = await handler(request({ messages: conversation(MAX_MESSAGES + 1) }), env, makeCtx());
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type"), /text\/event-stream/);
    const events = await readEvents(res);
    assert.deepEqual(events, [{ type: "text", delta: LIMIT_MESSAGE }, { type: "limit" }, { type: "done", lead: false }]);

    // One below the cap still reaches Claude.
    const calls = [];
    const okHandler = createHandler({ createClient: () => fakeClient([PLAIN_REPLY], calls) });
    const okRes = await okHandler(request({ messages: conversation(MAX_MESSAGES - 1) }), env, makeCtx());
    await readEvents(okRes);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages.length, MAX_MESSAGES - 1);
});

test("applies the per-visitor and global rate limits before calling Claude", async () => {
    const handler = createHandler({ createClient: neverClient });
    const body = { messages: [{ role: "user", content: "Hi" }] };

    const seenKeys = [];
    const tripped = { limit: async ({ key }) => { seenKeys.push(key); return { success: false }; } };
    const perIp = await handler(request(body, { ip: "203.0.113.9" }), { ...env, RATE_LIMITER: tripped }, makeCtx());
    assert.equal(perIp.status, 429);
    assert.deepEqual(seenKeys, ["203.0.113.9"]);

    const open = { limit: async () => ({ success: true }) };
    const global = await handler(request(body), { ...env, RATE_LIMITER: open, GLOBAL_LIMITER: tripped }, makeCtx());
    assert.equal(global.status, 429);
    assert.equal(seenKeys[seenKeys.length - 1], "global");

    const calls = [];
    const okHandler = createHandler({ createClient: () => fakeClient([PLAIN_REPLY], calls) });
    const ok = await okHandler(request(body), { ...env, RATE_LIMITER: open, GLOBAL_LIMITER: open }, makeCtx());
    assert.equal(ok.status, 200);
    await readEvents(ok);
    assert.equal(calls.length, 1);

    // A broken limiter never blocks a visitor.
    const broken = { limit: async () => { throw new Error("limiter down"); } };
    const calls2 = [];
    const brokenHandler = createHandler({ createClient: () => fakeClient([PLAIN_REPLY], calls2) });
    const stillOk = await brokenHandler(request(body), { ...env, RATE_LIMITER: broken }, makeCtx());
    assert.equal(stillOk.status, 200);
    await readEvents(stillOk);
    assert.equal(calls2.length, 1);
});

test("verifies Turnstile tokens when the secret is configured", async () => {
    const verifyCalls = [];
    const fetchStub = async (url, init) => {
        if (String(url).startsWith("https://challenges.cloudflare.com/")) {
            const params = new URLSearchParams(init.body);
            verifyCalls.push(Object.fromEntries(params));
            const success = params.get("response") === "good-token";
            return new Response(JSON.stringify(success ? { success: true } : { success: false, "error-codes": ["invalid-input-response"] }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
    };
    const tsEnv = { ...env, TURNSTILE_SECRET_KEY: "ts-secret" };
    const body = (token) => ({ messages: [{ role: "user", content: "Hi" }], ...(token ? { turnstileToken: token } : {}) });

    const blocked = createHandler({ createClient: neverClient, fetch: fetchStub });
    const missing = await blocked(request(body()), tsEnv, makeCtx());
    assert.equal(missing.status, 403);
    const bad = await blocked(request(body("bad-token"), { ip: "198.51.100.7" }), tsEnv, makeCtx());
    assert.equal(bad.status, 403);
    assert.equal(verifyCalls.length, 1);
    assert.equal(verifyCalls[0].secret, "ts-secret");
    assert.equal(verifyCalls[0].response, "bad-token");
    assert.equal(verifyCalls[0].remoteip, "198.51.100.7");

    const calls = [];
    const allowed = createHandler({ createClient: () => fakeClient([PLAIN_REPLY], calls), fetch: fetchStub });
    const good = await allowed(request(body("good-token")), tsEnv, makeCtx());
    assert.equal(good.status, 200);
    await readEvents(good);
    assert.equal(calls.length, 1);

    // Without the secret the token is ignored and nothing is verified.
    const before = verifyCalls.length;
    const calls2 = [];
    const noCheck = createHandler({ createClient: () => fakeClient([PLAIN_REPLY], calls2), fetch: fetchStub });
    const res = await noCheck(request(body()), env, makeCtx());
    assert.equal(res.status, 200);
    await readEvents(res);
    assert.equal(calls2.length, 1);
    assert.equal(verifyCalls.length, before);
});

test("CORS preflight and origin checks", async () => {
    const handler = createHandler({ createClient: neverClient });
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
    const handler = createHandler({ createClient: neverClient });
    const noKey = await handler(request({ messages: [{ role: "user", content: "Hi" }] }), { ...env, ANTHROPIC_API_KEY: "" }, makeCtx());
    assert.equal(noKey.status, 503);

    const badJson = await handler(request("{not json"), env, makeCtx());
    assert.equal(badJson.status, 400);

    assert.equal(HARD_MAX_MESSAGES, 60);
    const many = await handler(request({ messages: conversation(HARD_MAX_MESSAGES + 1) }), env, makeCtx());
    assert.equal(many.status, 400);

    const badRole = await handler(request({ messages: [{ role: "system", content: "Hi" }] }), env, makeCtx());
    assert.equal(badRole.status, 400);

    assert.equal(MAX_MESSAGE_CHARS, 1200);
    const long = await handler(request({ messages: [{ role: "user", content: "x".repeat(MAX_MESSAGE_CHARS + 1) }] }), env, makeCtx());
    assert.equal(long.status, 400);

    const endsWithAssistant = await handler(request({ messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }] }), env, makeCtx());
    assert.equal(endsWithAssistant.status, 400);

    const calls = [];
    const okHandler = createHandler({ createClient: () => fakeClient([PLAIN_REPLY], calls) });
    const exact = await okHandler(request({ messages: [{ role: "user", content: "x".repeat(MAX_MESSAGE_CHARS) }] }), env, makeCtx());
    assert.equal(exact.status, 200);
    await readEvents(exact);
    assert.equal(calls.length, 1);
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

test("both prompts know the studio's own products, so questions about them are not refused", () => {
  for (const product of ["TeamRelay", "MatchTagr", "Touchline HQ", "4thebadge", "PropertyBuyWise", "Mindset 4 Sports Performance", "Witness Capture Proof"]) {
    assert.ok(GATE_PROMPT.includes(product), `gate prompt names ${product}`);
    assert.ok(SYSTEM_PROMPT.includes(product), `system prompt names ${product}`);
  }
  assert.ok(GATE_PROMPT.includes('"4 the badge"'), "gate prompt knows the spaced spelling of 4thebadge");
  assert.ok(SYSTEM_PROMPT.includes("https://www.4thebadge.com"), "system prompt has the 4thebadge address");
});

test("the studio is described as software and AI, with software services listed first", () => {
  const focus = SYSTEM_PROMPT.split("\n").find((l) => l.startsWith("- Focus:"));
  assert.ok(focus, "the About block has a Focus line");
  assert.match(focus, /software/i, "the Focus line names software, not AI alone");
  assert.match(focus, /\bAI\b/, "the Focus line still names AI");
  // An app enquiry must not be the last thing Marco thinks of, so software leads the services line.
  const services = SYSTEM_PROMPT.split("\n").find((l) => l.startsWith("- Services"));
  assert.ok(services, "the About block has a Services line");
  assert.ok(services.indexOf("iOS") < services.indexOf("AI automation"), "iOS work is listed before AI automation");
  assert.ok(services.indexOf("SaaS") < services.indexOf("AI automation"), "SaaS work is listed before AI automation");
  // Android enquiries used to have nowhere to go: the enum forced them into "iOS app".
  const service = CAPTURE_ENQUIRY_TOOL.input_schema.properties.service_type;
  assert.ok(service.enum.includes("iOS or mobile app"), "the captured service covers mobile, not iOS alone");
  assert.equal(service.enum[0], "iOS or mobile app", "the first option offered is an app build");
});

test("the three service lists agree, so one enquiry cannot arrive under two labels", async () => {
  // The widget posts its chip text straight to Web3Forms when the Worker is unreachable,
  // so a chip that disagrees with the enum means the team's inbox sees two names for one service.
  const { readFile } = await import("node:fs/promises");
  const root = new URL("../../", import.meta.url);
  const widget = await readFile(new URL("chat-widget.js", root), "utf8");
  const form = await readFile(new URL("submit-idea.html", root), "utf8");

  const enumValues = CAPTURE_ENQUIRY_TOOL.input_schema.properties.service_type.enum;

  const chips = widget
    .match(/chips: \[([^\]]*)\],\n\s*placeholder: 'Or type your own answer'/)[1]
    .split(",")
    .map((c) => c.trim().replace(/^'|'$/g, ""));
  assert.deepEqual(chips, enumValues, "widget chips match the Worker enum");

  // The form's visible labels read naturally ("An iOS or mobile app"), but the submitted
  // value must be the enum wording, or the inbox sees two names for one service.
  const select = form.match(/<select id="projectType"[\s\S]*?<\/select>/)[0];
  const options = [...select.matchAll(/<option value="([^"]*)"/g)]
    .map((m) => m[1])
    .filter((v) => v !== "");
  assert.deepEqual(options, enumValues, "form option values match the Worker enum");
});
