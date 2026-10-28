# Part 4: Ten checks on the ChatGPT build, and what repeating them showed

Oct 28, 2026 · ccheez34. The day after the launch, Claude built two things: an admin stats page for the service, and a hosted MCP server so ChatGPT can use free reviews. Before deploying either, the owner ran Agent Referee's own `review-3` on the code: **10 paid checks, $2.00**. An eleventh attempt was refused before payment because two commands had been pasted onto one line, so it cost nothing. Seven checks used a fixed panel (Claude Opus 5.5, GPT-6 Luna, Gemini 4 Argon). After the owner asked for variety, the last three used `panel: rotate`, which draws one reviewer per AI company at random.

Claude wrote the code, the briefs and this report. The owner chose what to run, ran every check and paid for it. As in Parts 1 to 3, the counts below come from the review output. "Real", "already handled" and "brief error" are Claude's own judgments from reading each issue against the code.

## 1. What the checks were

| Code checked | Panel | Runs | Verdict each time |
|---|---|---|---|
| Usage stats: ledger counters and the admin page | fixed | 1 | fail (Opus needs_changes, GPT fail, Argon fail) |
| Internal free-review route for the hosted server | fixed | 1 | needs_changes (Argon cannot_assess) |
| Hosted server: review job, first version | fixed | 1 | needs_changes, 3 to 0 |
| Hosted server: the three MCP tools | fixed | 1 | needs_changes (Argon pass) |
| Hosted server: HTTP entry point, same file each time | fixed | 3 | needs_changes, 1 pass and 2 needs_changes |
| Hosted server: review job, after fixes, same file each time | rotate | 3 | needs_changes |

Across the day's ten checks there were no pass verdicts and no splits.

- **Opus:** needs_changes on all 9 of its seats.
- **GPT-6 Luna:** 1 fail and 9 needs_changes, out of 10.
- **Gemini 4 Argon:** 5 pass, 2 needs_changes, 1 fail and 1 cannot_assess, out of 9.
- **Rotation-only models:** Claude Sonnet 5.5 (1 seat, needs_changes) and Gemini 3.7 Flash (1 seat, pass).

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
