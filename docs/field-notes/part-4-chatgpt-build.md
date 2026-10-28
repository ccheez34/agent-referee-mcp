# Part 4: Fifteen checks on the ChatGPT build, and what repeating them showed

Oct 28, 2026 · ccheez34. The day after the launch, Claude built two things: an admin stats page for the service, and a hosted MCP server so ChatGPT can use free reviews. Before deploying either, the owner ran Agent Referee's own `review-3` on the code: **15 paid checks, $3.00**. One more attempt was refused before payment because two commands had been pasted onto one line, so it cost nothing.

- **Fixed panel:** the first seven checks used Claude Opus 5.5, GPT-6 Luna and Gemini 4 Argon.
- **Rotating panel:** after the owner asked for variety, the last eight used `panel: rotate`, which draws one reviewer per AI company at random. Three of those ran on one version of the code and five on the next.

Claude wrote the code, the briefs and this report. The owner chose what to run, ran every check and paid for it. The counts come from the review output. "Real", "already handled" and "brief error" are Claude's own judgments from reading each issue against the code. Every vote, the rotation draws and the most common findings are in [Part 4 data](part-4-data.md).

## 1. What the checks were

| Code checked | Panel | Runs | Verdicts |
|---|---|---|---|
| Usage stats | fixed | 1 | fail |
| Internal free-review route | fixed | 1 | needs_changes |
| Review job, version 1 | fixed | 1 | needs_changes |
| The three MCP tools | fixed | 1 | needs_changes |
| HTTP entry point, same file each time | fixed | 3 | needs_changes ×3 |
| Review job, version 2, same file | rotate | 3 | needs_changes ×3 |
| Review job, version 3, same file | rotate | 5 | needs_changes ×4, pass ×1 |

That's 1 fail, 13 needs_changes and 1 pass, with no splits. The one pass came on a file that four other runs, on identical text, said needed changes (section 5).

## 2. What they caught that the tests didn't

The clearest catch was a privacy bug. The brief said ChatGPT's anonymous id for a person must never be stored as-is. The code stored it, alongside the task and output, for as long as each review was running. **All three reviewers flagged it.**

There was a test for exactly this, and it passed. It checked storage only *after* the review had finished, when the input record, id included, had already been deleted. So the test checked the right thing at the wrong moment. The fix stores only keyed hashes of the id (made a proper HMAC after a later review), and the tests now check at every stage.

Other problems the reviewers found, all confirmed and fixed with a test:

- **Owner check:** a request sent without a person id could read someone else's result.
- **Unsigned fields:** the verdict and votes shown came from the unsigned part of the service's answer, not the signed receipt.
- **Body size:** the limit counted characters, not bytes. A body without a size header was read in full before being refused.
- **Alarm retries:** the review job re-raised errors, which makes Cloudflare retry it. The brief had ruled out this "retry storm". Claude had written that rethrow on purpose, with a comment explaining why it was safe. Reviewers rejected it in all three runs on version 2.
- **Cleanup on failure (version 3):** a job found stuck was only *reported* as interrupted. Its task and output stayed stored until the 24-hour cleanup. GPT or Sonnet raised this in all five runs.
- **Honest labels (version 3):** every server error was labelled "free review not used", but a 502 can arrive after a review ran. A 200 whose body couldn't be read was labelled "probably used" when "maybe" was right.
- **Smaller points:**
  - a cleanup loop could delete up to 127 keys past its 5,000-per-run limit
  - the stats page crashed on a malformed reply
  - a job that only woke after expiry could still be sent
  - bad-input errors weren't counted

## 3. Where Claude was at fault, not the code

**Briefs that asked about code in another file.** The stats brief listed a requirement (counting free-review outcomes) whose code was in the second file. All three reviewers marked it missing, and that drove most of the check's fail verdict. Claude had split the code by file but written each brief for the whole feature.

**A requirement that was itself wrong.** One brief said every failure must say "your free review wasn't used". Reviewers enforced it, and Claude added the sentence everywhere. But it isn't always true: after a timeout the review may have run anyway. Claude rewrote the requirement and the code, so failures now say "not used", "maybe used" or "probably used". In version 3, Sonnet then pointed out that the code's field said "yes" where the new brief said "probably". **Reviewers check work against the brief, so a wrong brief gets enforced as faithfully as a right one.**

**A stale file, again.** The owner ran the version-2 check twice more after Claude had already fixed that code. Both runs reviewed the file from before the fixes, because Claude hadn't regenerated it. Part 1 recorded the same mistake (five runs on an older report).

**Fixes that made new problems.** Each round of fixes added edge cases the next round found:
- **Stuck jobs:** the version-2 fix for them only *reported* the interruption instead of cleaning up.
- **The start race:** the fix carried a code comment claiming "no gap between the check and the writes". That wasn't true, because hashing happened in between. GPT or Sonnet caught the race in four of the five version-3 runs, and twice called out the comment itself.

## 4. A limit of the service: one review, one piece

A single review reads up to 4,000 characters of task and 12,000 of output, so anything longer has to be split. Splitting changes what a review can see:

- **Each piece goes to a fresh review.** Naming the same models for part 1 and part 2 gets the same *models*, not the same reviewer. Nothing carries over between reviews, so no reviewer ever reads both parts.
- **Problems that span pieces get missed or wrongly flagged.** That's what happened to the stats check (section 3): its requirement sat in one file and its code in the other. All three reviewers marked it missing.
- **Reviewers say when they can't see enough.** In check 2, Gemini 4 Argon voted cannot_assess: it saw the file was labelled "File 2 of 2", and the code it needed was in the other file. Opus and GPT made the same point inside their needs_changes votes.
- **Even this report was split.** Part 4 and its data page are reviewed separately, and the data page's reviewers never see this story.

Until the service can review one piece of work in parts, the workaround is in the brief. Say what the other parts do, list only the requirements this part can show, and check cross-part claims yourself.

## 5. What repeating a check on identical input showed

The owner ran three files several times each, without changing them: the entry point three times on the fixed panel, version 2 three times on the rotating panel, and version 3 five times on the rotating panel.

**In these runs, the verdict was steadier than any one reviewer.** Every file got the same verdict on every run, except one run in five on version 3.

**That one exception is the warning.** Version 3 passed once, 2 to 1, in run 13: Gemini 4 Argon passed it, and so did Sonnet, while still listing six issues. In the other four runs the same text got needs_changes, and Sonnet voted needs_changes in all of them. So one of five runs passed code with real gaps. Five runs are too few to put a number on how often that happens, but a single run can clearly come out either way.

**One reviewer can disagree with itself.** On identical text:
- Gemini 4 Argon passed version 2 in one run and flagged its main bug in the next.
- Sonnet voted needs_changes four times and pass once on version 3.

**The Gemini models passed most often.**
- Across all 15 checks, Gemini cast 11 of the 12 pass votes. Gemini 4 Argon passed 9 of its 13 seats, and Gemini 3.7 Flash passed both of its seats.
- On version 3, the Google seat passed all five times. Meanwhile GPT and Sonnet flagged the cleanup gap in 9 of their 10 seats (see the data page).
- Part 2's research says judges lean toward passing on partly correct work. This fits, but doesn't prove it.

**GPT-6 Luna never passed anything** (0 of 15 seats) and flagged the alarm problem in all four runs where it was present. It wasn't perfect: it missed the start race in two of the five version-3 runs. Because it is the only OpenAI model in the pool, it sat on every rotated panel.

**A finding that comes up every time isn't necessarily important.** Sonnet flagged the `chatgpt:` label on the caller id in all six of its seats. That label was a deliberate design choice, so the flag is stable noise. Stable tells you a reviewer reliably notices something, not that it matters.

**Rotation brought new findings, and the draw can cluster.**
- **New findings:** Sonnet, which the fixed panel never used, raised the HMAC and the honest-label points first. Opus raised the start race on version 2.
- **Clustering:** version 3 drew Sonnet all five times, and Opus never. If each draw is a fair 50/50, that happens about 3% of the time. It's worth a look, but five draws can't show the draw is biased.

**Past two runs, repeats mostly repeated.** Later runs on unchanged code mostly raised points earlier runs had already raised. Fixing the code and checking the new version found more.

## 6. Lessons, added to Part 3's list

1. **Scope each brief to its file.** If code is split across reviews, list only that file's requirements. Name the others as "handled elsewhere, not shown".
2. **Check the brief before the code.** A requirement that is impossible or dishonest gets enforced like any other.
3. **Rebuild review files from the current code every time,** right before sending. That would have prevented both stale-file episodes.
4. **Test at the moment the guarantee matters.** "Never stored" has to be checked while the data is live, not after cleanup.
5. **Don't trust one run, even a pass.** One run in five passed code that the other four flagged. For anything important, run it twice, and look harder if the two disagree.
6. **Rotate the panel for anything important,** and weigh a pass from a reviewer that passes most things (Argon passed 9 of 13 seats here) less than a pass from one that rarely does.
7. **Treat "raised every time" as reliable, not as important.** Weigh what a finding would break.
8. **Split work knowing no reviewer sees the whole.** Brief each part about the others, and check cross-part claims yourself.
9. **After two runs, fix and re-check rather than rerun.** Each fix round found more than extra runs on unchanged code did.

None of this replaces tests. Every fix above landed with a test. The ChatGPT server went from 9 to 14 tests and the main server from 165 to 170. All pass, and the owner's PC confirmed the main server's 170 and the ChatGPT server's 12 before the last round of fixes.

## 7. Checking this report

The owner had this page and its data page checked three times each, on the rotating panel ($1.00 for the five that completed). This page was checked before section 4 existed.

- **This page:** 1 pass (2 to 1) and 2 needs_changes. The points raised were all wording:
  - a probability read into one pass in five
  - a claim about GPT-6 Luna that its own start-race count contradicted
  - lessons stated more firmly than the runs support

  All were fixed above. Gemini 3.7 Flash passed it all three times.
- **The data page:** 2 passes, both 2 to 1. The points: "no splits" needed defining, the 3% figure was for one model only, and two columns weren't explained. All fixed.
- **One check didn't complete.** The draw picked Claude Haiku, a lighter model. It ran out of room on the data page's roughly 7,500 characters, and nothing was charged. The service leaves light models out only above 8,000 characters, so that cutoff is too high. It's being lowered to 6,000.

That makes 20 paid checks and $4.00 for the day.
