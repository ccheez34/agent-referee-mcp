# Agent Referee hosted MCP server (for ChatGPT)

A remote MCP server for clients that need a URL rather than a local process, such as ChatGPT. It offers **free sealed reviews** and offline receipt checks. Paid reviews and tie-breaks stay in the local [`agent-referee-mcp`](../README.md) package, where the owner's wallet lives.

- Endpoint: `https://mcp.agentreferee.ai/mcp`. It uses Streamable HTTP, is stateless (no sessions) and answers in JSON only.
- Tools:
  - `start_review` starts a review. It returns the result if the review finishes within about 20 seconds, and a `job_id` otherwise.
  - `get_review` gets the result, waiting up to about 40 seconds each time.
  - `verify_receipt` checks a receipt offline.
- **Why start-and-check-back:** a review takes 10–120 seconds, and ChatGPT stops waiting for a tool after about 60.
- **Tool annotations:** every tool sets `readOnlyHint`, `destructiveHint` and `openWorldHint` explicitly. `start_review` is marked not read-only, because it sends the text to outside AI providers.

## Who pays, and the limits

The reviews are free to the person. They run on Agent Referee's internal route (`/internal/free/review`, `/internal/free/review-3`), which needs the shared `INTERNAL_TOKEN` secret.

**Allowance per person.** Every ChatGPT request comes from OpenAI's addresses, so this server passes along ChatGPT's anonymous id for the person (`_meta["openai/subject"]`, which OpenAI provides for rate limiting).
- Each id gets 3 single-reviewer reviews and 1 review-3 per UTC day (`EXT_FREE_REVIEWS_PER_DAY`, `EXT_FREE_REVIEW3_PER_DAY` on the main Worker).
- Requests without an id share one allowance.

**Budget.** These reviews come out of their own daily budget, `EXT_FREE_DAILY_BUDGET_USD` (default $1.00), separate from the public free reviews. So ChatGPT traffic can't use up everyone else's free reviews, and the other way round.

## Privacy

- **Where the text goes:** the task and output go to Agent Referee, and from there to the reviewers' AI providers (Anthropic directly; OpenAI, Google and others through OpenRouter).
- **Deleted when done:** this server keeps the text only until the review finishes, then deletes it.
- **Result:** the verdict, votes and receipt are kept for 24 hours so `get_review` can return them, then deleted.
- **Your id:** ChatGPT's id for the person is stored only as a hash (to make sure the same person reads the result). Agent Referee stores it only as a daily-salted hash.
- **Nothing kept by Agent Referee:** it keeps no copy of the review.

## Deploy (operator)

1. **Make a token.** Generate one random token of 32 or more characters and keep it in a password manager.
2. **Set it on the main Worker**, from the `agent-referee-server` folder: `npx.cmd wrangler secret put INTERNAL_TOKEN`, then paste the token.
3. **Redeploy the main Worker** so `/internal/free/*` and the `EXT_FREE_*` settings are live. Staging comes first: `npx.cmd wrangler deploy --env staging`.
4. **Set up this folder** (`remote/`): run `npm.cmd install`, then `npx.cmd wrangler secret put INTERNAL_TOKEN` with the same token, then `npx.cmd wrangler deploy`.
5. **Check it.**
   - `https://mcp.agentreferee.ai/` should describe the server.
   - Calling `start_review` from an MCP client should return a review whose receipt says `"funding": "free"`.
6. **To stop new reviews:** set `REMOTE_PAUSED` to `"true"` in `wrangler.jsonc` and deploy. The main Worker's pause switches stop these reviews too.

For a staging copy, deploy with `REFEREE_URL` pointed at staging and the service binding removed. Also put staging's public key in `EXTRA_PUBLIC_KEYS`, so its receipts verify.

## Use it in ChatGPT

- **Who can add it:** custom MCP connectors with action tools need a ChatGPT workspace where developer mode or custom connectors are allowed (Business, Enterprise or Edu, set by an admin). OpenAI's plans and rules change, so check its current help pages.
- **How:** add a connector with the URL `https://mcp.agentreferee.ai/mcp` and no authentication.
- **Then:** ask ChatGPT to "get an independent check of this with Agent Referee". It calls `start_review`, then `get_review`.

## Tests

`npm test` in this folder runs the server with in-memory Durable Objects and a fake Agent Referee that signs real Ed25519 receipts.
