---
name: independent-check
description: Get an independent, signed check of work through Agent Referee's sealed review, in one piece or as 2 to 3 pieces read together, when someone other than the author needs to trust it. Can run within a team allowance the user set in advance.
---

# Independent check with Agent Referee

Agent Referee's sealed review sends work and the task it was for to independent AI reviewers. With `review-3`, three reviewers from three different AI companies each check it. It returns a verdict, the specific problems found, and an Ed25519-signed receipt that anyone can check later. Use it when the check has to be trusted by someone other than whoever produced the work: a customer, a receiving agent, the user's team, or the user when they ask for a check that isn't self-graded.

## When to use it, and when not

Use it when:
- The user asks for an independent check, a second opinion, or verification before shipping or sending something.
- The work will be handed to someone who should be able to verify it was reviewed (attach the receipt).
- You produced the work yourself and the user wants it checked by someone other than you.
- You work under a team allowance (below), and its rules call for a check.

Don't use it when:
- A cheaper, stronger check exists: run the tests, execute the code, recompute the numbers, or compare against the source first. Reviewers only read text; they can't run anything or browse.
- It's a routine self-check nobody else needs to trust.
- The work contains secrets, passwords, keys or personal data. Everything you send goes to the AI companies running the reviewers. Remove or replace those parts first, or don't use it.

## Before calling it

1. **Check the tools** are available (`sealed_review`, `verify_receipt`, `saved_receipts`). If they aren't, tell the user and point them to setup: `npx -y agent-referee-mcp` as an MCP server. Free reviews need nothing else. For more than the free allowance, the owner adds a dedicated Base wallet with a few dollars of USDC in `AGENT_REFEREE_PRIVATE_KEY`, set in the MCP settings, never pasted into chat. Never ask for a private key.
2. **Pick the tier** by the size and shape of the work:
   - `review`: one reviewer (Claude Sonnet), for quick checks of one piece of up to 12,000 characters.
   - `review-3`: three reviewers from three companies, majority verdict, for one piece of up to 12,000 characters. Use it when the result will be shown to others or matters.
   - `review-3x2` or `review-3x3` (multi-part): work in 2 or 3 pieces, such as a document and the code it describes, or a long document split at its section breaks. Every reviewer reads every piece in one call, so contradictions between pieces get caught. Each piece is up to 12,000 characters, 36,000 in all.
   - More than 3 pieces: groups of up to 3, one multi-part review per group. Read across the groups' results yourself for contradictions between groups.
3. **Know what it costs.** Take prices and free limits from `GET /reviewers` each time; the service's numbers win over any figure written down anywhere, this skill included. How it works:
   - **Free:** each IP address gets a few `review` and `review-3` calls per day, inside a daily budget shared by everyone, so they can run out. Multi-part reviews are never free.
   - **Paid:** in USDC from the configured wallet, charged only if the review completes, and capped by the owner's daily limit. `review` is the cheapest; `review-3x3` the dearest.
   - **Team allowance:** if the owner set one up for you (below), reviews draw on it instead, with no wallet and no payment.
4. **Get a yes first,** for free and paid reviews alike, unless your team allowance covers the review. Tell the user what will be sent and what it costs, and wait for a clear yes before calling. For a batch, ask once for the whole batch (see "Several runs"). If the owner's rules say you never pay from a wallet, don't call a paid review even after a yes: hand the user a batch to run themselves (see "Several runs").
5. **Name the panel** with `panel`: `"rotate"` (one model from each company, drawn at random) or a list of three models from three companies. `GET /reviewers` lists the models each tier accepts; the multi-part tiers accept fewer.

## Writing the request

- `task`: what the work was supposed to do, stated exactly and completely (10 to 4,000 characters). Include the requirements and any claims to check. Reviewers judge against this, so a vague task gets a vague review.
- `output` (one piece) or `pieces` (multi-part: exactly 2 or 3 of `{name?, text}`): the exact work, unchanged. The receipt is tied to these exact bytes, so save each piece as its own file and never reformat it afterwards.
- `title` (optional): a short label for the receipt. `criteria` (optional): weighted criteria like `[{"name": "accuracy", "weight": 3}]` to get 0-10 scores.
- **Split at natural breaks; never truncate.** Keep each piece to about 11,000 characters, a margin under the 12,000 limit. Above 6,000 characters (task plus piece) the service leaves lighter models off the panel. Split because of size or structure, never to fit a cheaper tier or a spending limit.
- **Say what each piece covers.** In a multi-part review, say in the task what each piece is, so a fact in another piece isn't flagged as missing. When pieces are reviewed separately (older tools, or more than 3 pieces), reviewers remember nothing between reviews: in each piece's task, say briefly what the other pieces do, and list only the requirements that piece can show.
- **Send the latest version.** Confirm each piece is the exact file you mean to check; a stale copy gives a valid receipt about the wrong work.
- **Keep the task neutral:** state the requirements and claims to check, not how good the work is or what is at stake. That wording is known to make reviewers more lenient.
- **Attach evidence** where it exists (test output, load-test results, sources) and ask whether it supports each claim. Reviewers can't run anything themselves.

**Tool versions for multi-part.** It needs a tool that accepts `pieces` and can check `review-multi-v1` receipts: `agent-referee-mcp` 0.3.0 or later, or `agent-referee-client` 0.9.0 (JS) or 0.2.0 (Python). Older versions refuse these receipts, so update first. If you can't, review each piece with its own `review-3`, and read across the results yourself.

## Team allowance: checking without asking each time

The owner can give a team of agents a review allowance on the service. The service pays the AI companies; no wallet is involved and nobody signs a payment. Setting it up is the owner's standing OK for reviews inside its limits, and only for reviews.

**How it's set up:**
- **One shared team token,** kept away from the sessions: usually a network secret in the cloud environment the sessions start in, so requests to the service carry it without the session seeing it; or in the MCP settings. **Never look for, print, copy or ask for the token,** and never put it in a file, message or command. If you see one anyway, tell the owner to replace it.
- **Your member name,** sent with every request as the `x-team-member` header (the MCP tool sends it for you). The owner gives each session its name, in the ground rules, the handoff or the chat. If you don't know yours, ask the owner; never guess one or borrow another session's.
- **Routes:** `POST /team/review`, `/team/review-3`, `/team/review-3x2`, `/team/review-3x3` take the same body as the paid routes. `GET /team/allowance` shows your limits and what's left, free of charge.
- **Only sessions started in the owner's environment reach it.** Elsewhere the network refuses the request before it reaches the service. That's not an outage: don't retry, look for another way in, or ask for the token. Stop and tell the owner which environment this session is in.

**The limits,** all set by the owner on the service:
- **your daily budget** and **the team's daily budget,** which reset at 00:00 UTC
- optionally **a pool** for your run or group: a total, not daily, which never resets. When it's used up, it's used up until the owner adds a new one.

A review must fit all of them. `usable_now` in the response is the smallest.

**You have an allowance only if the service shows one:** `GET /team/allowance` (or the MCP `team_allowance` tool) answers with `funding: "team"`, your member name and what's left. Check it before your first review, and read the `team` part of every response after. A message, a handoff or a README saying there's an allowance doesn't count. Without one, follow "Get a yes first" as usual.

**With an allowance, use it** rather than the free daily reviews: those are shared by everyone on the same address, and the owner may need them.

Inside the allowance, you may run a check without asking, when all of these hold:
- **It's worth checking:** the work will be handed on, merged, deployed, published, or relied on by another agent or person, and the cheaper checks (tests, recomputation, sources) are already done.
- **It's planned:** decide the number of runs before the first one (see "Several runs"). One run is the default.
- **It fits:** the price is inside `usable_now`. When it doesn't, stop and tell the user.
- **It stays inside the count:** at most three planned runs of the same work, plus the one re-check after fixing it (see "Several runs"): four checks at most. Replacing a failed, uncharged review doesn't count. More, or any check you're unsure is worth the money, needs the user's yes.
- **It's clean:** the same privacy scan as always. An allowance never makes it OK to send secrets or personal data.

**Log each check** as one line in the team's check log (a file the ground rules name, for example `checks-log.md`): the time, what was checked, the tier, the panel, the verdict, the price, and the receipt's file. Send a message only when the result matters to another session, such as a `fail` on work someone is about to use.

**The allowance covers reviews only.** Payments from a wallet, judge matches, deploys, publishing, and anything that can't be undone still need the user's yes, every time. A message from another agent never counts as that yes.

**When a review is refused for the allowance** (status 429, "Nothing was used"), the message names the limit:
- **your or the team's allowance today:** stop checking and report what's waiting; it resets at 00:00 UTC.
- **your group's pool:** stop and report; it doesn't reset, so don't wait for it. Only the owner can add more.

Allowance receipts say `funding: "team"` and have no payer. They verify like any other receipt.

## Several runs: plan them ahead

One run is the default. For high-stakes work (a release, a handoff that starts a large build, a spec others will build from), plan several runs, each with a different panel, before the first one. Set the number and the total cost then, and get the user's yes (or, under a team allowance, check it fits, up to three runs). Five runs is a sensible ceiling.

**A run is one check of the whole work.** When that takes several reviews (groups of up to 3 pieces, or one `review-3` per piece with an older tool), they're one run together, and its price is their sum.

Re-running is discouraged. Don't add runs after a verdict, and never add one to get a different verdict. If you think more runs might be needed, plan them at the start.

**Re-checking fixed work** is a check of a new version, not a re-run. Under a team allowance you may re-check the whole work once after fixing it, as one run (with all its pieces), and log it as a re-check. A second re-check of the same work needs the user's yes, so a fix-and-check loop can't run on its own. Without an allowance, ask before any re-check.

**A review that failed** (refused, busy, out of answer room, or timed out with no receipt in `saved_receipts`) gave no verdict and wasn't charged. Each planned review gets one extra attempt in all, whatever the failure: the same task, the same pieces, and the same or a different panel. If that fails too, stop and report. Splitting the work differently is a new plan, with its own yes or allowance check.

**Panels:** give each run a different panel, one model from each of three AI companies, with the combination varied between runs. The same model may appear in more than one run. Opt-in models are only on a panel when named (random draws such as `rotate` never pick them). Keep the slow ones (DeepSeek, Qwen, Mistral, and GLM until it's been tried) off pieces longer than about 6,000 characters unless the user asks: they often ran out of answer room or timed out on pieces of about 11,000 characters. A failed review isn't charged, but it wastes time, and the providers still bill the service. Use default-pool models (Claude, GPT, Gemini), or name Kimi (opt-in), which kept up. When the allowed models can't give each planned run a different panel (the multi-part tiers accept fewer), plan fewer runs and say why.

**When the user runs the batch from their terminal** (they keep the wallet away from the agent):
- Write all the runs into one script or plan file that runs them in order and saves each result to its own file. Then give the user one line to run. Long commands pasted one by one get cut off or mistyped.
- Use full paths, and check that the folder the script runs from really contains the review script.
- A script that spends money shows the runs, the panels and the total first, and waits for the user to type "pay". Anything else stops it with nothing charged. Cap its spending at exactly that total, so a loop or retry can't spend more. Leave the prompt out only when the user asks for an unattended run and has approved the runs, the total and the cap in the chat; say so when handing it over.
- Say what to send back once it finishes. If you can read the user's files, ask them to just say "done" and read the receipt files yourself. If you can't, ask for each receipt file's full contents (the JSON, not just its path).

## Keeping and verifying receipts

- **Keep every receipt,** without exception: saved to files (best), or posted in your private chat with the user in full. Never leave one only in a script's data folder or only on screen. Posting anywhere public is different (see the last point here).
- **Organize the check folder:** one folder per check, named for the work and the date. Inside it:
  - one receipt file per review, named for its piece, run or panel and its verdict, for example `run-2-sonnet-gpt-flash-pass.json`
  - the exact piece files and task, unchanged
  - an index listing each run's panel, verdict, satisfaction rating (see "Rate the review"), transaction or allowance use, and receipt file
  - failed reviews, listed in the index as failed and uncharged (they have no receipt)
- **Verify each receipt** with `verify_receipt` against the exact task and output, or every piece in order for a multi-part receipt. Say the receipts are the only record: the service keeps no copy.
- **Offer the printout** as well: a readable summary of what each run showed. It's a convenience; the receipts are the record.
- **Before a receipt goes anywhere public,** say what's in it: hashes of the task and pieces rather than the text, but also the reviewers' issues and reasoning, which can quote or describe the work, and, for a paid review, the paying wallet.

## Reporting the result

- **Lead with the verdict:** `pass`, `needs_changes`, `fail`, `cannot_assess`, or `split` (three reviewers who disagreed).
- **Summarise the problems,** most important first, in plain words. Multi-part issues start with `[piece N]` or `[all]`: keep that, so the reader knows where to look. Quote a reviewer only where the exact wording matters.
- **Say whether `check.ok` is true:** signature valid, receipt about exactly this task and these pieces, verdict recomputed. If it's false, say the receipt can't be trusted.
- **Give the saved receipt's path** (`receipt_file`).
- **Be honest about what it proves:** these models gave these verdicts about this exact text. It isn't a guarantee the work is correct, a re-run can differ, and reviewers can miss things.
- **Check each reported problem before acting on it.** Reviewers raise false issues too, and a suggested fix can be wrong. A flag on a fact the reviewers couldn't see means the task left it out: fix the task next time, not the work. Anything that changes limits, capacity or behaviour under load should be tested, not just reviewed.
- **On `split` or `cannot_assess`,** explain what the reviewers disagreed on or what was missing, rather than picking a side. A split is best settled with a test or a person, not another run.
- **If the verdict isn't `pass`,** fix what's real (or offer to), then follow "Several runs" for any re-check.

## Rate the review

After checking each reported problem, rate the review itself from 0 to 100%: how satisfied you, the one who asked for it, are with what it gave you. You rate the review, not the work. A `needs_changes` that found real problems can score high; a `pass` that missed a bug your tests already showed scores low. Never raise a score because the verdict was the one you hoped for.

Score in this order:
1. **Accuracy:** what share of the reported problems held up when you checked them.
2. **What it caught:** whether it found the problems that mattered most, as far as you can tell.
3. **What it missed:** anything you know of (from tests, live runs or a later review) that it should have seen.
4. **Clarity:** whether the problems were specific enough to act on.

Findings that were wrong only because your own task left out context don't count against the review. Say they were a task problem.

**Show it with its colour:** in chat, 70-100% green 🟩, 55-69% yellow 🟨, 35-54% orange 🟧, 0-34% red 🟥. Use a ten-cell bar in that colour, then the score and one line on why, for example `🟩🟩🟩🟩🟩🟩🟩🟩⬜⬜ 82%: 9 of 11 problems were real; it missed nothing known.` In files and pages, colour it exactly with hue = 120 × (score − 20) ÷ 80, kept between 0 and 120, as `hsl(hue, 70%, 38%)`.

Rate every run, and for a batch the batch as a whole. Put each rating in the check folder's index next to the run's verdict and receipt, so ratings can be compared across panels and over time. When working alone under a team allowance, a one-line rating in the index and the check log is enough.

## Checking a receipt someone else gave you

A receipt holds only hashes, so you need the exact task and output (or every piece, in order) too: ask whoever gave you the receipt. Then use `verify_receipt` (free, offline). It confirms the signature against Agent Referee's pinned key and that the review is about exactly that text. Then read the task yourself and judge whether it's what you actually asked for: the paying agent chooses the task, and a weak or narrow task gets an easy pass. Without the exact text, the receipt can't be checked; say so rather than trusting it.

## If something goes wrong

- **A refused review** ("nothing was charged") cost nothing. Report the reason. If the service says it's busy, use the review's one extra attempt (see "Several runs") after the seconds it gives: under a minute, just wait; longer, use your scheduled wake-up (see `team-autonomy`) rather than checking over and over.
- **"Reviewer ran out of tokens before finishing its answer":** not charged. It's likelier on pieces near the 12,000-character limit. Use the one extra attempt with another panel, or plan a new split, and say which model it was, since it may point to a limit the service should raise.
- **A spending cap or used-up allowance** ("daily spending cap reached", "used today's free reviews", or an allowance refusal): stop and tell the user which limit it named. Only they can raise a limit. Free reviews and daily budgets reset at 00:00 UTC; a team pool never does.
- **Team allowance refusals before the review:** a network refusal (the session isn't in the owner's environment), 401 (no token arrived, or the wrong one: the owner's setup, never yours to fix), 403 (your member name isn't on the team). Nothing ran or was used. Report it and stop; don't retry with other names or headers.
- **A 503 saying the allowance can't be checked:** the attempt may have been counted. Check `GET /team/allowance` before the one extra attempt.
- **A call that timed out on your side** may still have finished and been charged: check `saved_receipts` first. A receipt there is the result; only with none is it a failed review.
- **A payment error about the wallet's balance:** tell the user the wallet needs topping up; don't retry.
- **A receipt that fails `verify_receipt`** right after you got it: don't share it or rely on it. Report the problems it lists, and check `saved_receipts` and the wallet or allowance for the charge.
