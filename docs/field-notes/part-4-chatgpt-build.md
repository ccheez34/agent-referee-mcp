# Part 4: Ten checks on the ChatGPT build, and what repeating them showed

Oct 28, 2026 · ccheez34. The day after the launch, Claude built two things: an admin stats page for the service, and a hosted MCP server so ChatGPT can use free reviews. Before deploying either, the owner ran Agent Referee's own `review-3` on the code: **10 paid checks, $2.00**. An eleventh attempt was refused before payment because two commands had been pasted onto one line, so it cost nothing. Seven checks used a fixed panel (Claude Opus 5.5, GPT-6 Luna, Gemini 4 Argon). After the owner asked for variety, the last three used `panel: rotate`, which draws one reviewer per AI company at random.

Claude wrote the code, the briefs and this report. The owner chose what to run, ran every check and paid for it. As in Parts 1 to 3, the counts below come from the review output. "Real", "already handled" and "brief error" are Claude's own judgments from reading each issue against the code.

## 1. What the checks were

| Code checked | Panel | Runs | Verdict |
|---|---|---|---|
| Usage stats: ledger counters and the admin page | fixed | 1 | fail |
| Internal free-review route for the hosted server | fixed | 1 | needs_changes |
| Hosted server: review job, first version | fixed | 1 | needs_changes |
| Hosted server: the three MCP tools | fixed | 1 | needs_changes |
| Hosted server: HTTP entry point, same file each time | fixed | 3 | needs_changes |
| Hosted server: review job, after fixes, same file each time | rotate | 3 | needs_changes |

Across the day's ten checks there were no pass verdicts and no splits. Every vote, and each reviewer's totals, are in section 6.

## 2. What they caught that the tests didn't

The clearest catch was a privacy bug. The brief said ChatGPT's anonymous id for a person must never be stored as-is. The code stored it, alongside the task and output, for as long as each review was running. **All three reviewers flagged it.**

There was a test for exactly this, and it passed. It checked storage only *after* the review had finished, when the input record, id included, had already been deleted. So the test checked the right thing at the wrong moment. The fix stores only keyed hashes (HMAC) of the id, and the tests now check at every stage.

Other problems the reviewers found, all confirmed and fixed with a test:

- **Owner check:** a request sent without a person id could read someone else's result.
- **Unsigned fields:** the verdict and votes shown came from the unsigned part of the service's answer, not the signed receipt.
- **Body size:** the limit counted characters, not bytes. A body without a size header was read in full before being refused.
- **Alarm retries:** the review job re-raised errors, which makes Cloudflare retry it. The brief had ruled out this "retry storm". Claude had written that rethrow on purpose, with a comment explaining why it was safe. Reviewers rejected it in 3 of 3 rotated runs.
- **Deletion limit:** a cleanup loop could delete up to 127 keys past its 5,000-per-run limit.
- **Stats page:** a malformed ledger reply crashed it with a 500 instead of a clean 503.
- **Smaller points:** a race between two starts of the same job, expired results that could still be read, and bad-input errors that weren't counted.

## 3. Where the briefs, not the code, were wrong

**Briefs that asked about code in another file.** The stats brief listed a requirement (counting free-review outcomes) whose code was in the second file. All three reviewers marked it missing, and that drove most of the check's fail verdict. Part 3 already recommended sending each reviewer what it needs. Here Claude split the code by file but wrote each brief for the whole feature. The reviewers can't tell those apart.

**A requirement that was itself wrong.** One brief said every failure must say "your free review wasn't used". Reviewers enforced it literally, so Claude added the sentence to every failure path. But it isn't always true: after a timeout the service may have finished the review, and an answer that fails the receipt checks came from a review that did run. Claude rewrote the requirement and the code. Failures now say "not used", "may have been used" or "probably used". **Reviewers check work against the brief, so a wrong brief gets enforced as faithfully as a right one.**

**A stale file, again.** After Claude fixed the review job, the owner ran the rotating check twice more to see the variety. Both runs reviewed the file from *before* the fixes, because Claude hadn't regenerated it. Most of what those two runs flagged was already fixed. Part 1 recorded the same kind of mistake (five runs on an older report). The cause was the same both times: the file sent for review wasn't rebuilt from the code that had just changed.

## 4. What repeating a check on identical input showed

The owner ran two files three times each, without changing them.

**Entry point, fixed panel, 3 runs:**
- **Verdict:** needs_changes every time, with the same split: Argon pass, Opus and GPT needs_changes.
- **Opus and GPT** flagged the same core problems each time: body buffering, characters vs bytes, logging and missing headers.
- **Gemini 4 Argon** passed all three times with "no problems found", on code with problems the other two confirmed and Claude fixed.
- **The third run** added one new minor point (a second safety net around the request handler).

**Review job, rotating panel, 3 runs:**

| Run | Reviewers drawn | Votes | Flagged the alarm rethrow |
|---|---|---|---|
| 1 | GPT-6 Luna, Gemini 4 Argon, Claude Sonnet 5.5 | 1 pass, 2 needs_changes | GPT, Sonnet |
| 2 | GPT-6 Luna, Claude Opus 5.5, Gemini 4 Argon | 3 needs_changes | all three |
| 3 | Gemini 3.7 Flash, Claude Opus 5.5, GPT-6 Luna | 1 pass, 2 needs_changes | Opus, GPT |

What this small sample suggests (six runs on two files, so treat it as observation, not measurement):

- **The majority was steadier than any single reviewer.** Both files got the same verdict on every run, even when the reviewers changed.
- **One model can disagree with itself on identical code.** Gemini 4 Argon passed the review job in run 1 and flagged its main bug in run 2.
- **GPT-6 Luna was the most consistent.** It flagged the main bug in all 3 rotated runs and in every fixed run of the entry point.
- **The Gemini models were the most lenient,** as in Part 1. Gemini 3.7 Flash passed in its one seat, and Argon passed 5 of its 9 seats today. Part 2's research says judges lean toward passing on partly correct work; this fits, but doesn't prove it.
- **Rotation brought new findings.** Sonnet, which the fixed panel never used, was first to raise two points: the hashes weren't a proper HMAC (GPT raised it again in run 2), and a malformed start request wasn't guarded. Opus, absent from run 1, raised the start race and the missing 24-hour cleanup in runs 2 and 3.
- **Repeats added a little each time.** Each rerun of an unchanged file found about one new, usually minor, point. Rerunning helps tell which issues are stable (raised every time) from which are noise. Past about two runs, it mostly costs money.

## 5. Lessons, added to Part 3's list

1. **Scope each brief to its file.** If code is split across reviews, list only that file's requirements. Name the others as "handled elsewhere, not shown".
2. **Check the brief before the code.** A requirement that is impossible, or dishonest, gets enforced like any other. Reread it before paying for a review.
3. **Rebuild review files from the current code every time.** A script that generates the file right before sending it would have prevented both stale-file episodes.
4. **Test at the moment the guarantee matters.** "Never stored" has to be checked while the data is live, not after cleanup.
5. **Rotate the panel for anything important.** Different draws found different things. If one reviewer passes everything, that's a reason to replace it, not to trust it.
6. **Run twice, not five times.** A second run separates stable issues from noise. More runs mostly repeat themselves.

None of this replaces tests. Every fix above landed with a test. The ChatGPT server went from 9 to 13 tests and the main server from 165 to 170, all passing on the owner's PC.

## 6. The data

### Every vote

Fixed panel: Opus = Claude Opus 5.5, GPT = GPT-6 Luna, Argon = Gemini 4 Argon. nc = needs_changes, ca = cannot_assess.

| # | Code | Opus | GPT | Argon | Verdict |
|---|---|---|---|---|---|
| 1 | Usage stats | nc | fail | fail | fail |
| 2 | Internal route | nc | nc | ca | nc |
| 3 | Review job v1 | nc | nc | nc | nc |
| 4 | MCP tools | nc | nc | pass | nc |
| 5 | Entry point | nc | nc | pass | nc |
| 6 | Entry point (same file) | nc | nc | pass | nc |
| 7 | Entry point (same file) | nc | nc | pass | nc |

Rotating panel, review job v2, the same file each time:

| # | Anthropic | OpenAI | Google | Verdict |
|---|---|---|---|---|
| 8 | Sonnet: nc | GPT: nc | Argon: pass | nc |
| 9 | Opus: nc | GPT: nc | Argon: nc | nc |
| 10 | Opus: nc | GPT: nc | Flash: pass | nc |

**Totals: 1 fail and 9 needs_changes; no pass and no split.** By seat:

| Reviewer | Seats | pass | nc | fail | ca |
|---|---|---|---|---|---|
| Claude Opus 5.5 | 9 | 0 | 9 | 0 | 0 |
| GPT-6 Luna | 10 | 0 | 9 | 1 | 0 |
| Gemini 4 Argon | 9 | 5 | 2 | 1 | 1 |
| Claude Sonnet 5.5 | 1 | 0 | 1 | 0 | 0 |
| Gemini 3.7 Flash | 1 | 1 | 0 | 0 | 0 |

Every pass vote of the day (6 of 30) came from a Gemini model.

### How the rotation drew

`rotate` picks one model per company at random from the service's pool. The pool has Claude Opus, Sonnet and Haiku for Anthropic (Haiku is left out for long inputs like these), GPT-6 Luna only for OpenAI, and Gemini 4 Argon and Gemini 3.7 Flash for Google.

| Company | Drawn in 3 runs |
|---|---|
| Anthropic | Opus 2, Sonnet 1 |
| OpenAI | GPT-6 Luna 3 (the only OpenAI model in the pool) |
| Google | Argon 2, Flash 1 |

So GPT-6 Luna sits on every rotated panel; only the Anthropic and Google seats vary. Three draws say nothing about the draw's fairness.

### The most common findings

Each reviewer raising an issue counts once per run. "Could have" is how many seats saw code with that problem. Claude counted these by reading each issue, and reviewers word points differently, so treat them as close, not exact.

| Finding | Code | Raised | Could have | By |
|---|---|---|---|---|
| The alarm rethrows errors, so the platform retries it | review job | 8 | 12 | every model except Gemini 3.7 Flash |
| Requirements belong to another file, so they can't be checked | stats, internal route | 6 | 6 | all three, both times |
| Body size counted in characters, or read in full before refusing | entry point | 6 | 9 | Opus 3, GPT 3; Argon 0 |
| Logging could leak request content or the id | entry point | 6 | 9 | Opus 3, GPT 3; Argon 0 |
| Ids with spaces rejected | entry point, internal route | 6 | 12 | Opus 4, GPT 2 |
| A failure doesn't say the free review wasn't used | review job | 7 | 12 | GPT 3, Argon 2, Opus 1, Sonnet 1 |
| The id hash isn't a proper keyed hash (HMAC), or is unkeyed without the secret | review job v2 | 5 | 9 | Opus 2, GPT 2, Sonnet 1 |
| Size limit is 64,000 bytes, not 64 KiB | entry point | 4 | 9 | Opus 3, GPT 1 |
| The raw user id is stored | review job v1 | 3 | 3 | all three |
| Missing headers for allowed origins on GET / | entry point | 3 | 9 | GPT 3 |
| The `free` count shown comes from the unsigned answer | review job v2 | 3 | 9 | Opus 2, Sonnet 1 |
| Expired jobs can still be read, or aren't deleted | review job | 3 | 12 | Opus 1, GPT 2 |

One finding pointed the other way. In run 10, Opus noted that saying "your free review wasn't used" after a timeout may be untrue, while GPT in the same run asked for that sentence on more failures. Both were reading the same brief. Opus was right; Claude had reached the same conclusion after run 8 and changed the brief (section 3).

