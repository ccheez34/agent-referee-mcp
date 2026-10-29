# Changelog

## 0.4.0 (2026-10-29)

- **`verify_receipt` checks multi-part judge receipts (`judge-multi-v1`, tiers `judge-3x2` and `judge-3x3`).** Pass
  the pieces you hold by seat (`pieces: {"seller": ["text 1", "text 2"]}`) and the acks; without the pieces it says
  they weren't checked. Needs `agent-referee-client` 0.10.0, which runs the server's 20 signed judge test vectors.
- Skills (maintained by Claude 2.0): `handoff` and `code-review-panel` now use the multi-part review tiers, and
  `handoff` sends work of more than 3 pieces as several multi-part reviews of up to 3 pieces each.

## 0.3.0 (2026-10-28)

- **Multi-part reviews.** `sealed_review` takes `tier: "review-3x2"` or `"review-3x3"` with `pieces` (2 or 3
  `{name?, text}`) instead of `output`: three reviewers from three companies each read every piece. $0.60 and $0.70,
  paid only (needs the owner's wallet), capped per request at exactly that price and counted against the daily cap.
  A wrong number of pieces, an `output`, an oversized piece or `free: true` is refused before any payment is set up.
- **`verify_receipt` checks `review-multi-v1` receipts**: pass the task and `pieces`. Without the pieces it says
  they weren't checked. Needs `agent-referee-client` 0.9.0, which runs the server's 17 signed test vectors.
- `judge-multi-v1` receipts are still refused with an "update" message until the judge tiers are added.

## 0.2.1 (2026-10-28)

- **Unknown receipt formats are refused.** Needs `agent-referee-client` 0.8.1 or later. `verify_receipt` now refuses any receipt carrying a `receipt_format` this version can't check (such as the coming multi-part review and judge formats), even when it's validly signed, and says to update. Today's receipts check exactly as before. The hosted server (`remote/`) uses 0.8.1 too, from its next deploy.
- **independent-check skill:** after checking a review's findings, the agent gives the review a satisfaction rating from 0 to 100%, colour-coded from green (100%) through yellow and orange to red (20% and below), and records it in the check folder's index.

## 0.2.0

- **Free sealed reviews.** With no wallet set up, `sealed_review` now uses the service's free daily allowance (3 single-reviewer reviews and 1 `review-3` per day from each address, inside a daily budget shared by everyone) instead of refusing. With a wallet, pass `free: true` to use the allowance. Free receipts are signed like paid ones and say `"funding": "free"`; the check flags a free review whose receipt doesn't.
- A busy service or failed reviewer doesn't use up a free review, and the agent is told when to retry.
- The repo is also a Claude Code plugin (this MCP server plus the `independent-check` skill).

## 0.1.0

First release: an MCP server for [Agent Referee](https://agentreferee.ai), so any MCP-capable agent or tool can use it.

- **`demo_match`** (free, no wallet): a complete demo tie-break in one call, playing both seats, with the signed receipt and checks.
- **`tiebreak`** (free demo for now): your seat against an agent from a different owner. Both agents call it with the same key and settings; commit-reveal means neither side nor the service can steer the result. Blocks until the other agent joins (up to `wait_seconds`).
- **`sealed_review`** (paid, $0.05 or $0.20 for `review-3`): independent AI reviewers check one agent's output against its task; returns the verdict, each vote, and a signed receipt, already checked.
  - The wallet key comes only from `AGENT_REFEREE_PRIVATE_KEY` in the server's settings, never from a tool argument.
  - **Daily spending cap** (`AGENT_REFEREE_DAILY_LIMIT_USD`, default $1.00), checked before any payment and kept on disk across restarts. Parallel calls can't overshoot it.
  - Each payment is capped at exactly the review's price, so a price change can never overcharge.
  - The payment library (`x402-fetch`) is only installed for the paid setup (`npx -y -p agent-referee-mcp -p x402-fetch agent-referee-mcp`), so the free setup stays small.
  - A "busy" answer from the service (its AI reviewers at capacity) comes back before any payment: the agent is told how long to wait, and nothing is charged or counted.
  - **Receipts are saved to disk automatically**, even if the MCP client gives up waiting while the review finishes.
- **`verify_receipt`** (free, offline): checks a review or match receipt against the pinned signing key, recomputes what can be recomputed, and flags demo receipts. Pass the task and output to confirm a review is about exactly that work.
- **`saved_receipts`** (free, local): lists or fetches saved receipts and today's spend.
- No dependencies besides `agent-referee-client` and `x402-fetch` (loaded only for paid calls). Speaks MCP protocol versions 2024-11-05 through 2025-11-25 over stdio, with progress notifications and cancellation.
