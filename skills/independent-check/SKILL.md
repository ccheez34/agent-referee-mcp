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
- Split large work into separately checkable pieces rather than truncating it. Reviewers are less reliable on long inputs, and above 6,000 characters (task + output) the service leaves lighter models out of the panel.
- Each piece is reviewed on its own. Choosing the same models again doesn't give you the same reviewer: nothing carries over between reviews. So in each piece's task, say briefly what the other pieces do, and list only the requirements this piece can show. A requirement whose code is in another piece gets marked missing.
- Send the latest version. Before calling, confirm the output is the exact file or text you mean to check (a stale copy gives a valid receipt about the wrong work).
- Keep the task neutral: state the requirements and claims to check, not how good the work is or what is at stake. Wording like that is known to make reviewers more lenient.
- Attach evidence where it exists (test output, load-test results, sources) and ask whether it supports each claim. Reviewers can't run anything themselves.

## Several reviews in a row

To check one piece several times (a different panel each run, so the runs are independent) or several pieces in turn, and the user runs the reviews from a terminal (for example with a review script, because only they sign payments):
- Write all the commands into one script file (`.cmd` on Windows, `.sh` elsewhere) that runs them one after another and saves each result to its own file. Then give the user one line to run. Long commands pasted one by one get cut off or mistyped, and saved results can be read straight from the files instead of being pasted back.
- Use full paths, and check that the folder the script runs from really contains the review script before handing it over.
- Give each run a different panel: one model from each of three AI companies, varied between runs, with repeats of a model allowed.
- When handing over the line to run, say what to send back once it finishes. The receipt comes first: it's the signed record, and it already holds each reviewer's verdict, issues and reasoning. If you can read the user's files, ask them to just say "done" and read the receipt files yourself. If you can't, ask them to paste each receipt file's full contents (the JSON, not just its path).
- Every receipt must end up kept, without exception: posted in the chat in full, saved to files, or both. Never leave one only in the script's own data folder or only on screen. When you can write files, organize them: one folder per check (named for the work and the date), one receipt file per review named for its piece, run or panel and its verdict (for example `run-2-sonnet-gpt-flash-pass.json`), and an index file listing each run's panel, verdict, transaction and receipt file. Failed reviews have no receipt; list them in the index as failed and uncharged. Then verify each receipt with `verify_receipt` against the exact task and output you sent, and say the receipts are the only record (the service keeps no copy).
- Offer the printout as well: what the window showed for each run, as a readable summary, posted in the chat or saved next to the receipts. It's a convenience; the receipts are the record.
- A receipt holds only hashes of the task and output, not the work itself, but a paid one names the paying wallet. Mention that before the user posts a receipt anywhere public.

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
- "Reviewer ran out of tokens before finishing its answer": not charged. A reviewer's answer hit its length limit, which is likelier on long pieces near the 12,000-character limit. Retry with another panel, or split the piece. Tell the user which model it was, since it may point to a limit the service should raise. Opt-in models (DeepSeek, Qwen, Mistral and the like) also run out of tokens or time out more often on long pieces, so prefer default-pool models for long work.
- "Daily spending cap reached": tell the user; only they can raise `AGENT_REFEREE_DAILY_LIMIT_USD`.
- "Used today's free reviews" or "free reviews are used up for everyone": tell the user. They reset at 00:00 UTC; a configured wallet can pay instead, but ask first.
- If the call timed out on your side, the review may still have finished: check `saved_receipts` before paying for another.