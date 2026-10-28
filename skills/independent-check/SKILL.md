---
name: independent-check
description: Get an independent, signed check of a piece of work through Agent Referee's sealed review, when someone other than the author needs to trust it.
---

# Independent check with Agent Referee

Agent Referee's sealed review sends one piece of work and the task it was for to independent AI reviewers (with `review-3`, three reviewers from three different AI companies). It returns a verdict, the specific problems found, and an Ed25519-signed receipt that anyone can check later. Use it when the check has to be trusted by someone other than whoever produced the work: a customer, a receiving agent, the user's team, or the user when they ask for a check that isn't self-graded.

## When to use it, and when not

Use it when:
- The user asks for an independent check, a second opinion, or verification before shipping or sending something.
- The work will be handed to someone who should be able to verify it was reviewed (attach the receipt).
- You produced the work yourself and the user wants it checked by someone other than you.

Don't use it when:
- A cheaper, stronger check exists: run the tests, execute the code, recompute the numbers, or compare against the source first. Reviewers only read text; they can't run anything or browse.
- It's a routine self-check nobody else needs to trust.
- The work contains secrets, passwords, keys or personal data. The task and output are sent to the AI companies running the reviewers. Remove or replace those parts first, or don't use it.

## Before calling it

1. Check the Agent Referee MCP tools are available (`sealed_review`, `verify_receipt`, `saved_receipts`). If they aren't, tell the user and point them to setup: `npx -y agent-referee-mcp` as an MCP server. Free reviews need nothing else. For more than the free allowance, the owner adds a dedicated Base wallet with a few dollars of USDC in `AGENT_REFEREE_PRIVATE_KEY` (set in the MCP settings, never pasted into chat). Never ask for a private key.
2. Pick the tier:
   - `review`: one reviewer (Claude Sonnet). Good for quick checks.
   - `review-3`: three reviewers from three companies, majority verdict. Use when the result will be shown to others or matters.
3. Know what it costs:
   - **Free:** each address gets 3 `review` and 1 `review-3` per day, inside a daily budget shared by everyone, so they can run out. With no wallet set up, every review uses this allowance. With a wallet, pass `free: true` to use it.
   - **Paid:** $0.05 per `review`, $0.20 per `review-3`, in USDC from the configured wallet, charged only if the review completes, and capped by the owner's daily limit.
4. Tell the user what will be sent and whether it is free or what it costs, and get a clear yes before calling.

## Writing the request

- `task`: what the work was supposed to do, stated exactly and completely (10 to 4,000 characters). Include the requirements and any claims to check. Reviewers judge against this, so a vague task gets a vague review.
- `output`: the exact work, unchanged (up to 12,000 characters). The receipt is tied to this exact text, byte for byte, so don't reformat it afterwards.
- `title` (optional): a short label for the receipt.
- `criteria` (optional): weighted criteria like `[{"name": "accuracy", "weight": 3}]` to get 0-10 scores.
- Split large work into separately checkable pieces rather than truncating it. Reviewers are less reliable on long inputs, and above 8,000 characters (task + output) the service leaves lighter models out of the panel.
- Each piece is reviewed on its own. Choosing the same models again doesn't give you the same reviewer: nothing carries over between reviews. So in each piece's task, say briefly what the other pieces do, and list only the requirements this piece can show. A requirement whose code is in another piece gets marked missing.
- Send the latest version. Before calling, confirm the output is the exact file or text you mean to check (a stale copy gives a valid receipt about the wrong work).
- Keep the task neutral: state the requirements and claims to check, not how good the work is or what is at stake. Wording like that is known to make reviewers more lenient.
- Attach evidence where it exists (test output, load-test results, sources) and ask whether it supports each claim. Reviewers can't run anything themselves.

## Reporting the result

- Lead with the verdict: `pass`, `needs_changes`, `fail`, `cannot_assess`, or `split` (review-3 only: the reviewers disagreed).
- Summarise the problems each reviewer found, most important first, in plain words. Quote a reviewer only where the exact wording matters.
- Say whether `check.ok` is true (signature valid, receipt about exactly this task and output, verdict recomputed). If it's false, say the receipt can't be trusted.
- Give the path of the saved receipt (`receipt_file`) and say it is the only record: the service keeps no copy.
- Be honest about what it proves: these models gave these verdicts about this exact task and output. It is not a guarantee the work is correct, a re-run can differ, and reviewers can miss things.
- If the verdict isn't `pass`, offer to fix the problems. After fixing, a fresh review is a new paid call: ask before running it, and never re-run just to get a different verdict.
- On `split` or `cannot_assess`, explain what the reviewers disagreed on or what was missing, rather than picking a side. A split is best settled with a test or a person, not another run.
- Check each reported problem before acting on it: reviewers raise false issues too, and a suggested fix can be wrong. Anything that changes limits, capacity or behaviour under load should be tested, not just reviewed.

## Checking a receipt someone else gave you

Use `verify_receipt` (free, offline) with the receipt and the exact `task` and `output` you have. It confirms the signature against Agent Referee's pinned key and that the review is about exactly that work. Also check the task in the receipt's request is the one you actually asked for: the paying agent chooses the task.

## If something goes wrong

- A refused review ("nothing was charged") cost nothing. Report the reason. If the service says it is busy, wait the number of seconds it gives and retry once.
- "Daily spending cap reached": tell the user; only they can raise `AGENT_REFEREE_DAILY_LIMIT_USD`.
- "Used today's free reviews" or "free reviews are used up for everyone": tell the user. They reset at 00:00 UTC; a configured wallet can pay instead, but ask first.
- If the call timed out on your side, the review may still have finished: check `saved_receipts` before paying for another.