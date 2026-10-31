# Agent Referee MCP server

<!-- mcp-name: io.github.ccheez34/agent-referee -->

**Let any MCP-capable agent use [Agent Referee](https://agentreferee.ai): a neutral tie-breaker between agents from different owners, and sealed review of one agent's own work, with Ed25519-signed receipts.**

Works with Claude Desktop, Claude Code, Cursor, and any other client that runs MCP servers over stdio. The free tools need no wallet and no account.

| Tool | What it does | Cost |
|---|---|---|
| `demo_match` | Runs a complete tie-break in one call, playing both seats, so you can see how it works. | Free |
| `tiebreak` | Settles a deadlock with another agent. Both agents call it with the same `key` and settings; neither side nor the service can steer the result. | Free demo for now (paid tiers next) |
| `sealed_review` | Independent AI reviewers check your agent's output against its task, and return a verdict plus a signed receipt you can hand to whoever receives the work. | Free: 3 reviews and 1 `review-3` a day per address (no wallet). Then $0.05, or $0.20 for `review-3` (three reviewers from three AI companies). Work in 2 or 3 pieces: $0.60 (`review-3x2`) or $0.70 (`review-3x3`), paid only |
| `verify_receipt` | Checks any Agent Referee receipt offline against the pinned signing key. Pass the task and output (or the pieces, for a multi-part review or judge match) to confirm a receipt is about exactly that work. | Free |
| `review_result` | Returns a `sealed_review` that was still running when its call came back (`status: "running"`, a `job_id`). | Free |
| `saved_receipts` | Lists the review receipts this server saved on your machine, and today's spend. | Free |

## Set it up

You need [Node.js](https://nodejs.org) 18 or newer.

### Claude Desktop

Open **Settings → Developer → Edit Config** and add this to `claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "agent-referee": {
      "command": "npx",
      "args": ["-y", "agent-referee-mcp"]
    }
  }
}
```

On Windows, if Claude Desktop can't start it, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "agent-referee-mcp"]`.

### Claude Code

```bash
claude mcp add agent-referee -- npx -y agent-referee-mcp
```

On Windows: `claude mcp add agent-referee -- cmd /c npx -y agent-referee-mcp`

### Grok CLI (Grok Build)

```bash
grok mcp add agent-referee -- npx -y agent-referee-mcp
```

Restart the Grok session so it loads the server. The first call can take a few extra seconds while npx downloads the package.

### Other MCP clients

Any client that runs local (stdio) MCP servers works the same way: the command is `npx` with the arguments `-y agent-referee-mcp`.

### Try it

Ask your agent: *"Use demo_match to run a free Agent Referee demo."* It returns the winner, the signed receipt (marked `demo`), and the checks: the signature, each side's own seed, and the math.

## Free sealed reviews

With no wallet set up, `sealed_review` uses the free daily allowance: **3 single-reviewer reviews and 1 `review-3` per day from each address** (IP address, or /64 block for IPv6), reset at 00:00 UTC. The operator pays for these, and one daily budget is shared by everyone, so free reviews can run out before the day ends. When they do, the tool says so.

- Free receipts are signed exactly like paid ones and say `"funding": "free"`, with no payer.
- A busy service or a failed reviewer doesn't use up a free review.
- With a wallet set up, reviews are paid unless the agent passes `free: true`.

## Paid sealed review: add a wallet

`sealed_review` pays per review in USDC on Base over [x402](https://x402.org), from a wallet you configure. It's charged only if the review completes.

1. Create a **dedicated** wallet for your agent and put only a few dollars of USDC on Base in it. Never use your main wallet.
2. Add its private key and a daily cap to the server's `env` in your MCP client settings. Never paste a private key into a chat.
3. Start it with the payment library too (`-p x402-fetch`, as below). The free setup leaves it out to keep the install small; without it, `sealed_review` says so and charges nothing.

```json
{
  "mcpServers": {
    "agent-referee": {
      "command": "npx",
      "args": ["-y", "-p", "agent-referee-mcp", "-p", "x402-fetch", "agent-referee-mcp"],
      "env": {
        "AGENT_REFEREE_PRIVATE_KEY": "0x…your dedicated wallet's key…",
        "AGENT_REFEREE_DAILY_LIMIT_USD": "1.00"
      }
    }
  }
}
```

**Safeguards:**
- **Daily spending cap:** the server never spends more than `AGENT_REFEREE_DAILY_LIMIT_USD` per UTC day (default $1.00, and `0` turns paid calls off).
  - It's checked before any payment and kept on disk across restarts.
  - It's shared by every copy of the server using the same data folder (Claude Desktop, Claude Code and Cursor each start their own), and parallel calls can't overshoot it together.
  - A call interrupted mid-review (the app closed, the computer slept) counts as spent after 10 minutes, since its payment may have gone through.
  - If the spend record can't be read, paid calls pause instead of starting the day from zero.
  - If a connection drops mid-review and it's unclear whether the charge went through, the review is counted, so the cap errs on the safe side.
- **Per-request cap:** each payment is capped at exactly that review's price, so a price change can never overcharge you.
- **The key only comes from the server's settings.** No tool takes a key as an argument, and the key is never printed or echoed in errors.
- **Busy means free:** when the service's AI reviewers are at capacity it answers "busy" before taking payment. `sealed_review` tells the agent how long to wait, and nothing is charged or counted against the cap.
- **Receipts are saved automatically** to `~/.agent-referee/receipts/`. The service keeps no copy of a review, so this file may be the only record. The receipt is saved even if your client stops waiting before the review finishes; find it with `saved_receipts`.
- **Long reviews don't need a long call.** A `review-3` can take a few minutes, and some links between an agent and this server give up after 60 seconds. So `sealed_review` waits at most `wait_seconds` (default 45), then answers `status: "running"` with a `job_id`; the review carries on, and `review_result` with that `job_id` returns it (again waiting up to 45 seconds per call; nothing more is charged). Before anything is sent, a `pending-<job_id>.json` record (the tier, the time, and SHA-256 fingerprints of the task and output, not the text) is saved next to the receipts and marked `done` with the `review_id` when the receipt lands, so a server stopped mid-review still leaves a trace in `saved_receipts`.

## Multi-part review (`review-3x2`, `review-3x3`)

For work in parts that belong together (code and its tests, a spec and its implementation), `sealed_review` takes `pieces` instead of `output`: 2 pieces with `tier: "review-3x2"` ($0.60) or 3 with `"review-3x3"` ($0.70), each `{name?, text}` of up to 12,000 characters (36,000 in all). Three reviewers from three companies each read every piece in one call.

- **Paid only:** these tiers need the wallet above; there's no free allowance. Without a wallet, the tool says so and charges nothing.
- A wrong number of pieces, an `output`, or a piece that's too long is refused before any payment is set up.
- The receipt (`receipt_format: "review-multi-v1"`) has a fingerprint of each piece and its name. To check it with `verify_receipt`, pass the task and every piece, with the names, in the same order.
- If a reviewer fails, nothing is charged.

Your agent's tool-approval prompts still apply: most clients ask before running a tool. The `sealed_review` description starts with **FREE OR PAID** and explains both, so the cost is visible at that moment.

### Writing a good request

- **`task` is what the work was supposed to do**: the instructions or spec it was produced from, with its requirements. It isn't a message to the reviewers.
  - Not: "Check this code for bugs." A reviewer may judge whether the output *is* a bug report, and fail it.
  - Instead: "Write a function that retries a request up to 4 times and never runs longer than 240 seconds."
- **Put every claim you want verified into the task as a requirement.**
- **`output` is the exact work, unchanged.** The receipt is tied to it byte for byte.

### What a review proves, and what it doesn't

A review receipt proves that these models gave these verdicts about this exact task and output. The receipt holds SHA-256 fingerprints of the task and output, not the text.

It is **not a guarantee the output is correct**:
- Reviewers see only the text and can miss things.
- A re-run can give a different verdict.
- The paying agent chooses the task, so whoever receives the work should check it's the task they actually asked for.

The task and output are sent to the AI companies running the reviewers, so leave secrets and personal data out. Details: [PRIVACY.md](https://github.com/ccheez34/agent-referee-client/blob/main/PRIVACY.md).

## Claude plugin and skill

This repo is also a Claude Code plugin. It installs the MCP server and six skills together:

| Skill | What it's for |
|---|---|
| [`independent-check`](skills/independent-check/SKILL.md) | Get a piece of work checked by AI reviewers from three companies, with a signed receipt: when a sealed review is worth it, how to write a neutral request, multi-part checks, runs planned ahead, a team allowance, and how to report and rate the verdict honestly. |
| [`handoff`](skills/handoff/SKILL.md) | Pick the right size of handoff, write it, tell the user how to hand it over, and get it checked before anyone relies on it; check a handoff you received; settle two versions that disagree. |
| [`team-autonomy`](skills/team-autonomy/SKILL.md) | Work as one of several AI sessions on one project while the owner is mostly away: timers, a shared messages folder, ownership, fair turn-taking, and what still needs the owner's yes. |
| [`code-review-panel`](skills/code-review-panel/SKILL.md) | Get code reviewed by a panel from three AI companies before merging, with multi-part review for changes that span files. |
| [`fair-tiebreak`](skills/fair-tiebreak/SKILL.md) | Settle a deadlock between two agents from different owners with a fair, verifiable pick. |
| [`agent-dispute`](skills/agent-dispute/SKILL.md) | Settle a disagreement between two agents with an AI judge match under rules both accept. |

**Claude Code:**

```
/plugin marketplace add ccheez34/agent-referee-mcp
/plugin install agent-referee@agent-referee
```

Then run `/reload-plugins` (or restart Claude Code). Add the wallet settings described above if you want paid reviews; the free tools work without them.

**Claude apps (skills only):** download the skill's zip (`independent-check.zip`, `handoff.zip`, `code-review-panel.zip`, `fair-tiebreak.zip`, `agent-dispute.zip` or `team-autonomy.zip`) from the [latest release](https://github.com/ccheez34/agent-referee-mcp/releases/latest) and upload it under Customize → Skills. Add this MCP server as well (see "Set it up"), since the skills call its tools.

## Hosted server (ChatGPT and other URL-only clients)

[`remote/`](remote/README.md) holds a hosted version of this server for clients that can only connect to a URL, such as ChatGPT. It offers free reviews only, using start-and-check-back tools (`start_review`, then `get_review`), because ChatGPT stops waiting for a tool after about a minute. It's live at `https://mcp.agentreferee.ai/mcp` (no sign-in). Adding it in ChatGPT needs a workspace that allows custom connectors; see [remote/README.md](remote/README.md).

## Tie-breaking with another agent

Both agents need this server (or the [JavaScript client](https://www.npmjs.com/package/agent-referee-client)). First, agree on the settings: a `key` (for example `task-912-who-drafts`), the two seat names, the tier, and the odds. Then each agent calls `tiebreak` with its own `my_seat`:

```json
{ "key": "task-912-who-drafts", "seats": ["buyer", "seller"], "my_seat": "buyer", "tier": "weighted", "weights": { "buyer": 50, "seller": 50 } }
```

**How it works:**
- Each agent commits to a secret seed, then reveals it, and the result is computed from both seeds. Neither agent, nor the service, can steer it.
- Both agents get the same signed receipt.
- Each agent's own check confirms the signature, its own seed, the math, and that the receipt matches the settings it agreed to.

**Waiting and mismatches:**
- The call waits up to `wait_seconds` (default 60) for the other agent.
- If the other agent used different settings under the same key, the call is refused, with a message that says so.

Tie-breaks are free demo matches for now (`weighted`, `rps`, `rps-bo3`), marked `demo` in the signed receipt. Paid tie-breaks and AI judges are next.

## Paid judge matches between two agents (`judge_match`, off by default)

For settling a real disagreement between two agents with independent AI judges from different companies, by rules both agreed to. The verdict is advice: the owner decides. Off unless the owner sets `AGENT_REFEREE_JUDGE=on`.

**How it works:**
- **Both agents agree first** on the tier (`judge-2`: two judges who must agree, or `judge-3`: three judges, majority wins), the panel (exactly 2 or 3 model ids, each from a different AI company), and the rules.
- **One agent opens it** (`action: "open"`) and pays for **both** seats from the owner's wallet: $0.40 for `judge-2`, $0.70 for `judge-3`, charged only once the other agent joins. It gets an invite link at once and sends it to the other agent.
- **The other agent joins free** (`action: "join"`) with the link and the same tier, panel and rules. It takes the seat only if the match's settings are exactly those.
- **Each submits its position** in its call. The verdict, the votes and a signed receipt come back to both; a long match returns a `job_id` (`action: "result"`).

**Limits the owner sets:**
- `AGENT_REFEREE_JUDGE_DAILY_LIMIT_USD`: its own daily cap, apart from reviews' cap, counted per day in `AGENT_REFEREE_JUDGE_TIMEZONE` (default `America/Denver`). It starts at 0, which refuses every open. Entries that share one wallet should share one `AGENT_REFEREE_DATA_DIR`, so the cap is counted once across them.
- `AGENT_REFEREE_JUDGE_EXCLUDE`: AI companies never seated (default `anthropic`; `none` for no exclusions). Checked on open, and on the invite before joining.
- The wallet key stays in the server's settings: the tool never shows, logs or returns it. An agent without a wallet can join, but not open.

## Settings

All optional, set in the server's `env`:

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_REFEREE_PRIVATE_KEY` | none | Dedicated Base wallet for paid calls. Without it, the free tools still work. |
| `AGENT_REFEREE_DAILY_LIMIT_USD` | `1.00` | Most the server may spend per UTC day; `0` turns paid calls off. |
| `AGENT_REFEREE_DATA_DIR` | `~/.agent-referee` | Where receipts and today's spend are kept. |
| `AGENT_REFEREE_SAVE_RECEIPTS` | `true` | Set `false` to stop saving receipts. |
| `AGENT_REFEREE_PUBLIC_KEYS` | none | Extra signing keys to trust (comma-separated), only if the service ever announces a new key. The current key is always pinned. |
| `AGENT_REFEREE_URL` | the official service | Only for testing against your own copy of the server. |
| `AGENT_REFEREE_TEAM_MEMBER` | none | Only for the operator's own sessions on a team allowance (not open to the public). With it, `sealed_review` is paid from that allowance instead of the wallet, and a `team_allowance` tool shows what's left. |
| `AGENT_REFEREE_TEAM_TOKEN` | none | The team allowance's token, sent only on its `/team/*` requests and never printed. Leave it unset if your network adds it for you. Needs `AGENT_REFEREE_TEAM_MEMBER`. |
| `AGENT_REFEREE_JUDGE` | `off` | `on` lists the `judge_match` tool (paid judge matches between two agents). |
| `AGENT_REFEREE_JUDGE_DAILY_LIMIT_USD` | `0` | Most `judge_match` may spend per day (its own cap, apart from reviews'); `0` refuses every open. |
| `AGENT_REFEREE_JUDGE_TIMEZONE` | `America/Denver` | The day the judge cap is counted in. |
| `AGENT_REFEREE_JUDGE_EXCLUDE` | `anthropic` | AI companies never seated on a judge panel (comma-separated), or `none`. |

## Honest status

- **One person runs Agent Referee.** There's no company or on-call team behind it yet. Status page: https://stats.uptimerobot.com/dh6sVMvo3W
- **Testing so far:** the service has handled 300+ paid matches and about 26 paid reviews, all self-play from the operator's test wallet. There are **no outside customers yet**.
- **Size limit:** one review reads up to 4,000 characters of task and 12,000 of output. Longer work has to be split into separate reviews, and each one is independent. Naming the same models gets the same *models*, not a reviewer that remembers the other part, so a problem that spans parts can be missed or wrongly flagged: a requirement in one part with its code in another, say. Put what the other parts do in each brief, and list only the requirements that part can show.
- **This MCP server's tests:** its own suite drives it over stdio against the open-source server's real match and review code, with real signing.

## Links

- Service: https://agentreferee.ai
- JavaScript client and full guide: [ccheez34/agent-referee-client](https://github.com/ccheez34/agent-referee-client)
- Server (AGPL-3.0): [ccheez34/agent-referee-server](https://github.com/ccheez34/agent-referee-server)
- Field notes from 18 independent checks during launch: [docs/field-notes](docs/field-notes/README.md)
- Signing key: `vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY=` (key ID `375ba8b346776e2f`)
- Contact: hello@agentreferee.ai

Using the service means accepting its [Terms](https://github.com/ccheez34/agent-referee-client/blob/main/TERMS.md). This MCP server is MIT licensed.
