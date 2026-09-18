# Digital Nomad Studio chat assistant - Cloudflare Worker

This small Worker powers the "Chat with our AI assistant" widget on
[digitalnomadstudio.io](https://www.digitalnomadstudio.io). The widget itself is `chat-widget.js`
in the website repo and needs no build step. The Worker is the only part that talks to Claude, so the
API key never reaches the browser.

What it does on each message:

1. Checks the request came from the website (CORS allowlist) and is well formed
   (at most 40 messages of 2,000 characters each).
2. Asks Claude (`claude-opus-5`) for the next reply, using a system prompt that describes
   Digital Nomad Studio's services, sectors and products and how to guide the visitor.
3. Streams the reply back to the browser as it is generated.
4. When the visitor agrees to send their enquiry, Claude calls the `capture_enquiry` tool and the Worker
   delivers the details to the team inbox through Web3Forms (the same service the project form uses).

Until the Worker is deployed and its URL is set in `chat-config.js`, the widget runs a guided set of
questions in the browser instead and still delivers enquiries through Web3Forms. It also falls back to
that guided flow whenever the Worker cannot be reached.

## 1. Create a dedicated API key

Use a key that exists only for this Worker, so it can be capped and rotated without touching anything
else.

1. In the [Anthropic Console](https://console.anthropic.com/), create a new **workspace** called
   something like "Website chat".
2. On that workspace, set a **monthly spend limit** (start low, for example US$20, and raise it if the
   chat gets busy). Add a usage alert as well.
3. Create an **API key** inside that workspace. Copy it once; you will paste it into the Worker secret
   in the next step. Do not put it in `chat-config.js`, `wrangler.toml`, or anywhere in the website repo.

## 2. Deploy the Worker

You need Node.js 18 or newer and a free Cloudflare account.

```bash
cd chat-worker
npm install
npx wrangler login                              # opens the browser once
npx wrangler secret put ANTHROPIC_API_KEY       # paste the key from step 1
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL, for example `https://dns-chat.<your-subdomain>.workers.dev`.

## 3. Connect the website

Open `chat-config.js` in the website repo and set the endpoint:

```js
endpoint: "https://dns-chat.<your-subdomain>.workers.dev",
```

Commit and merge. Once GitHub Pages redeploys, the widget switches from the guided questions to the
AI assistant automatically. Open the site, click "Chat with us" and say hello. `npx wrangler tail`
shows live logs from the Worker while you test.

## Everyday operations

- **Rotate the key**: create a new key in the Console, run `npx wrangler secret put ANTHROPIC_API_KEY`
  again with the new value, then delete the old key. No redeploy is needed.
- **Change what the assistant says**: edit `SYSTEM_PROMPT` in `src/index.js` (services, sectors,
  products, tone) and run `npx wrangler deploy`.
- **Change where enquiries go**: `WEB3FORMS_KEY` and `NOTIFY_EMAIL` live in `wrangler.toml`.
- **Add another allowed site**: add its origin to `ALLOWED_ORIGINS` in `wrangler.toml`
  (comma separated, no trailing slash). Requests from `localhost` are always allowed for local testing.
- **Rate limiting**: uncomment the `RATE_LIMITER` binding in `wrangler.toml` to cap each visitor IP at
  30 requests a minute. Cloudflare's dashboard WAF rate-limiting rules work too.
- **Custom domain** (optional): in the Cloudflare dashboard add a route such as
  `chat.digitalnomadstudio.io` to the Worker and use that in `chat-config.js`.

## Costs

Each visitor message sends the system prompt (cached after the first request), the conversation so far
and a short reply. Conversations are short by design (replies are one to three sentences), so expect
cents per conversation rather than dollars. The workspace spend limit from step 1 is the hard stop.

## Local development

```bash
cd chat-worker
npm install
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars   # ignored by git
npx wrangler dev                                   # serves http://localhost:8787
```

Then serve the website locally (for example `python3 -m http.server 8000` from the repo root), set
`endpoint: "http://localhost:8787"` in `chat-config.js` while testing, and open
`http://localhost:8000/`.

Unit tests use a fake Claude stream and a fake Web3Forms, so they run offline:

```bash
npm test
```

## Security notes

- The API key is a Worker secret only. The browser never sees it.
- Only requests from the allowed origins are answered, and every conversation is capped in size.
- The Worker keeps no record of conversations; Cloudflare logs only what `wrangler tail` shows while
  it is running. Enquiries reach the inbox through Web3Forms.
- The assistant is told to stay on topic, never quote prices, and never to treat visitor text as
  instructions. The website privacy policy describes the chat data flow to visitors.
