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

## 2b. Or deploy from GitHub instead of your own machine

The repository has a **Deploy chat Worker** workflow (`.github/workflows/deploy-chat-worker.yml`).
It runs the unit tests, deploys the Worker and sets the `ANTHROPIC_API_KEY` secret, using two
repository secrets that you add once under **Settings > Secrets and variables > Actions**:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard > My Profile > API Tokens > Create Token > use the "Edit Cloudflare Workers" template |
| `ANTHROPIC_API_KEY` | The dedicated key from step 1 |

The Cloudflare account ID is not secret and is set as `account_id` in `wrangler.toml`.

Then run the workflow from the Actions tab (it also runs automatically whenever `chat-worker/` changes
on `main`). The run summary shows the Worker URL. If the first deploy complains that the account has
no workers.dev subdomain, open Workers & Pages in the Cloudflare dashboard once and choose a subdomain,
then re-run the workflow.

## 3. Connect the website

Open `chat-config.js` in the website repo and set the endpoint:

```js
endpoint: "https://dns-chat.<your-subdomain>.workers.dev",
```

Commit and merge. Once GitHub Pages redeploys, the widget switches from the guided questions to the
AI assistant automatically. Open the site, click "Chat with us" and say hello. `npx wrangler tail`
shows live logs from the Worker while you test.

## How an enquiry is captured

When the assistant has the service, business, problem, name and email, it calls the `show_summary`
tool. The widget renders that as a labelled summary card with **Send to the team** and **Change
something** buttons, so the visitor checks the details in a tidy format rather than a paragraph.
Tapping Send posts "Yes, please send it to the team." back to the assistant, which then calls
`capture_enquiry`; the Worker delivers the details through Web3Forms and the widget shows a
"Sent to the team" card. Replies may use light formatting (bold labels and short "- " lists), which
the widget renders safely as text nodes, never as raw HTML.

## Limits and abuse protection

The assistant is for project enquiries only. Every message first passes a small classifier call
(Claude Haiku, `GATE_MODEL` in `src/index.js`) that decides whether it belongs in a project enquiry.
Unrelated messages (trivia, coding, homework, other companies, "ignore your instructions") get a fixed
canned line and never reach the main model, so nobody can use the widget as a general chatbot. The
second unrelated message gets a one-line pointer to the project form, and the third ends the AI part
of the conversation. If the classifier itself fails, the message goes through to the main model,
whose own prompt refuses unrelated requests. Behind that sit hard limits that do not depend on any
model behaving:

| Limit | Default | Where |
|---|---|---|
| Visitor turns per conversation | 12 (the widget then switches to its guided questions) | `MAX_MESSAGES` in `src/index.js`, `MAX_HISTORY` in `chat-widget.js` |
| Characters per message | 1200 | `MAX_MESSAGE_CHARS` in `src/index.js`, `MAX_LEN` in `chat-widget.js` |
| Tokens per reply | 1024 | `MAX_TOKENS` in `src/index.js` |
| Messages per visitor IP | 8 a minute | `RATE_LIMITER` binding in `wrangler.toml` |
| Messages across all visitors | 30 a minute | `GLOBAL_LIMITER` binding in `wrangler.toml` |
| Monthly spend | the Anthropic workspace limit | Anthropic Console (add a usage alert at half the limit) |

Change a value, commit to `main`, and the Worker redeploys itself.

### Optional: Cloudflare Turnstile bot check

The rate limits stop a single connection hammering the chat. Turnstile stops scripts calling the Worker
directly with a faked website origin, by requiring a token that only a real browser on the site can
obtain. Visitors normally never see it.

1. Cloudflare dashboard > **Turnstile** > **Add widget**. Hostnames: `digitalnomadstudio.io` and
   `www.digitalnomadstudio.io`. Widget mode: **Invisible**. Create it and copy both keys.
2. Add the **Secret Key** as the GitHub repository secret `TURNSTILE_SECRET_KEY` and re-run the
   **Deploy chat Worker** workflow (it uploads the secret to the Worker automatically).
3. Put the **Site Key** into `turnstileSiteKey` in `chat-config.js` in the website repo and merge.

With both in place the Worker refuses any request without a valid token (HTTP 403). Remove the secret
(`npx wrangler secret delete TURNSTILE_SECRET_KEY`) and clear the site key to switch it off again.

### Enquiry spam

Enquiries reach the inbox through Web3Forms, both from the AI assistant and from the guided questions
and the project form. If junk enquiries appear, switch on hCaptcha or the spam filter in the Web3Forms
dashboard for that access key.

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
