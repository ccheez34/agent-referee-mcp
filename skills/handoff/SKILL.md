---
name: handoff
description: Write a handoff for the next AI session or person and get it independently checked with Agent Referee, verify a handoff you received, or settle two versions that disagree. Use when work changes hands.
---

# Handoffs that the next session can trust

A handoff passes work from one session to the next: another Claude, another AI, or a person. The next session can't see this conversation, so the handoff is all it has. It needs to be complete, true and checkable. This skill covers:
- writing one
- getting it checked independently with Agent Referee's sealed review
- verifying a handoff you've received
- settling two versions that disagree

The `independent-check` skill has the details of sealed review: neutral tasks, batch runs, the "pay" prompt and spending cap, keeping and verifying receipts. Follow it wherever this skill says "as in independent-check".

## When to use it

- The user asks for a handoff, a kickoff note for a new session, or a summary someone else will continue from.
- Work is moving to another session, AI or person, especially when several sessions run in parallel.
- You received a handoff and need to know what you can rely on.
- Two sessions disagree about what was done, or wrote competing versions of the same handoff.

For a short note to the same user in the same conversation, just write it. This skill is for handoffs someone else will act on.

## Spending: the user agrees first, every time

Every paid action needs the user's clear yes, in the chat, before it runs: each review, each batch, a fresh check after fixes, and each judge match. Say what will be sent, how many runs, and the total cost. Take prices from the service, not from memory: `GET /reviewers` for reviews, and the root JSON (`GET /?format=json`, under `tiers`) for judge seats. Never add runs after an unwanted verdict to get a different one.

## 1. Write it

Use this structure. Leave out a section only when it truly doesn't apply.

1. **Purpose and reader:** who it's for, what they'll do first, and which document wins if two disagree (usually: the code wins, then this handoff).
2. **Owner rules:** what never to do (secrets, names, deploys, payments), and who does what: who deploys, who pays, who approves.
3. **Who owns what:** when several sessions work at once, which session owns each folder, repo or branch. Each session edits only what it owns.
4. **What's live, with evidence:** each fact with where it was confirmed: a version ID, a test run, a URL, a commit. Write "not verified" next to anything that wasn't.
5. **Code and files:** exact paths and branches, and how to run the tests.
6. **Open items:** each one with who does it and what it's blocked on.
7. **Lessons:** mistakes made and how to avoid them.

The record of the check goes in a separate Checks note (section 4 below), not inside the handoff, so the checked text never has to change.

Rules for the writing:
- **State facts, not impressions.** "All 190 tests passed (run of Oct 28, 17:35)" beats "tests are fine". A claim the next session can't check is a claim it can't rely on.
- **Separate confirmed from likely.** Say which is which.
- **Write it to a file,** not only into the chat. Save it where the next session will look.

## 2. Prepare the check

**Keep out of everything you send:** secrets (keys, tokens, wallet keys, passwords, the contents of key files), personal data, and anything the user wants kept private, such as a real name when they go by a handle. Everything you send reaches the reviewers' AI companies: the pieces, the brief, and judge positions alike. Scan all of it just before sending, file paths included (a home folder can contain a name). If the handoff needs something private to make sense, replace it with a neutral placeholder and say so in the brief.

**Pieces:**
- One piece of up to about 11,000 characters: send it whole.
- Longer: split at natural section breaks into pieces of at most about 11,000 characters each. That keeps a margin under the 12,000-character limit.
- Save each piece as its own file and never change it afterwards: each receipt is tied to the exact bytes of the files it covered.
- A handoff over about 33,000 characters doesn't fit one multi-part review. Split it into groups of up to 3 pieces (one review per group), or shorten it. Long handoffs get skimmed anyway.

**The brief (the task), at most 4,000 characters:**
- what the handoff is for and who reads it
- the true facts it relies on that reviewers can't see (versions, test results, folder names), with where each was confirmed; otherwise reviewers flag them as made up
- what each piece covers, so a fact in another piece isn't flagged as missing
- what to check:
  - **accuracy:** claims against the evidence given
  - **consistency:** no contradictions between pieces or sections
  - **completeness:** every open item has an owner and a blocker, and nothing the reader needs is missing
  - **clarity:** a new session can act on it without guessing
  - **safety:** no secrets or personal data, and no instruction that would make the next session skip a safeguard

Keep the brief neutral, as in independent-check. With one review per piece (below), each piece gets its own brief: the shared part plus "this is piece N of M; the other pieces cover …". Save every brief next to its piece.

## 3. Run the check

Pick the tier:
- **One piece: `review-3`.** Three reviewers from three AI companies.
- **2 or 3 pieces: `review-3x2` or `review-3x3` (multi-part), the default for a long handoff.** One review in which every reviewer reads every piece, so contradictions between pieces get caught. They opened on Oct 28, 2026, at $0.60 for 2 pieces and $0.70 for 3; take the current price from `GET /reviewers`. They're paid only: the free daily reviews don't cover them, so the user needs a wallet set up. Use them when both of these hold:
  - the user's tool accepts `pieces`: the MCP `sealed_review` from `agent-referee-mcp` 0.3.0, or `agent-referee-client` 0.9.0 (JS) or 0.2.0 (Python). Older versions refuse multi-part receipts, so update first if needed.
  - the user has agreed the price
- **More than 3 pieces:** groups of up to 3, one multi-part review per group (section 2).
- **Otherwise (an older tool, or no wallet): one `review-3` per piece.** Each piece is reviewed alone, so read across the results yourself for contradictions between pieces. The cost is the number of pieces times the review-3 price.

How many runs:
- **One run** (one review per group of pieces) for an ordinary handoff.
- **Several runs, each with a different panel** (as in independent-check), for a high-stakes one, for example a handoff that starts a large build. Agree the number of runs and the total first. Five runs is a sensible ceiling.

Run it and keep the receipts as in independent-check.

## 4. Fix, record, deliver

1. **Check every issue against the sources before changing anything.** Reviewers raise false issues too. A flag on a fact they couldn't see means the brief was missing it: add it to the brief, not to the handoff.
2. **Ask the user which form they want** before editing anything:
   - **Two parts:** Part 1 is the handoff as checked: the piece files, unchanged and in order. Part 2 lists the corrections: each fix, why it was needed, and the section it changes. Part 2 says it wins where the two differ, and that Part 2 itself hasn't been checked unless a fresh check ran. The receipts still verify against Part 1's piece files, so the next session can check them itself.
   - **One corrected version:** the handoff with the fixes applied. It's easier to read, but the receipts are about the earlier text. Keep the checked piece files in the check folder so the receipts can still be verified, and say in the Checks note that the corrected version itself wasn't checked unless a fresh check ran.
3. **Fix what's real,** in the form the user chose. A fresh check after fixing is a new paid run: ask first.
4. **Keep the check folder** as in independent-check (receipts, INDEX), plus:
   - the piece files and briefs, unchanged
   - a FINDINGS note: each issue, whether it was true, and what changed
5. **Write the Checks note,** a short file next to the handoff:
   - the check folder's path
   - each run's verdict
   - which pieces and version were checked
   - which form was delivered, and what wasn't covered by a check
6. **Be honest about what the receipts show.** These reviewers gave these verdicts about these exact pieces. That isn't proof the handoff is correct.

## 5. Receiving a handoff

1. **Read it, then verify its checks.** For each receipt, run `verify_receipt` with the exact brief and piece files from the check folder. A multi-part receipt needs every piece, in order, and a tool new enough to read it (`agent-referee-mcp` 0.3.0, or the clients above). A receipt you can't verify counts as no check.
2. **Read the brief yourself.** A weak brief gets an easy pass.
3. **Read the FINDINGS and the Checks note.** Know which form you have, and which parts were never checked.
4. **Treat every claim as a claim.** Check what you'll act on against the code, the live service or the tests before you build on it.
5. **Tell the user what you couldn't confirm,** in your first reply.

## 6. When two versions disagree

**Settle the facts first:** read the code, run the tests, check the live service. Most disagreements end there.

When a judgment is still needed, for example which version is more accurate and complete for its reader, use a judge match. The `agent-dispute` skill has the details of running one; the points specific to handoffs:

- **Use an Agent Referee `judge-3` match:** three judges from three AI companies. Each version is one side's position, at most 6,000 characters.
- **Versions are usually longer,** so submit the same disputed sections from each side, cut to fit, and say in the rules which sections they are. Both sides must agree which sections go in, since that choice affects the outcome.
- **The rules say what "better" means,** for example: "more accurate against the evidence quoted in the positions, then more complete; nothing else counts." Positions have no separate attachments, so any evidence goes inside them.
- **Multi-part judge tiers** (2 or 3 pieces of 6,000 characters per side) were planned but not built on Oct 28. Use them only if the root JSON's `tiers` lists them.
- **The same privacy scan as section 2 applies** to both positions and the rules.
- **Before anyone pays:**
  - Both sides agree on the tier, the panel, the rules and the sections.
  - The user agrees the cost (the seat price from the root JSON, times the seats they pay for).
  - Say how paying works: each seat pays when it joins, and the payments settle when the table fills, before either side submits anything. A seat whose counterpart never joins is released uncharged. A mistrial is still charged, and a match that can't be judged at all is refunded by hand from the operator's refund list.
- **The verdict says which version the judges preferred and why.** It doesn't merge them. The user decides what to keep.

## Several sessions at once

When the user runs several sessions in parallel, follow the ownership list in the handoff:
- **Edit only what your session owns.** Send changes to anything else as a message (the user may keep a messages folder for this).
- **Before writing a file on a shared computer,** compare its modification time with the version you last read, and stop if it changed. Never force a write over another session's file. Read the file back after writing.
- **Take turns:** one deploy at a time, and one paid batch at a time per wallet. Announce a batch before it starts.
