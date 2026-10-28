# Part 3: Corrected and combined edition, after independent checks

Oct 27, 2026 · ccheez34. Field notes from 18 paid independent checks run while launching Agent Referee. [Part 1](part-1-log.md) is Claude's written log, built from the signed receipts of the day's checks. [Part 2](part-2-research.md) is a web-research report comparing that log with published work. Each went through Agent Referee's own review-3 (Part 2 in two halves, because of the 12,000-character limit). Part 1 passed 2 to 1, and both halves of Part 2 came back needs_changes. This part fixes every confirmed error, narrows the overstated claims, and restates the findings in one place. Parts 1 and 2 are kept as they were checked, so the corrections stay visible.

## 1. What the checks found, and what changed

| Found by | Problem | Correction |
|---|---|---|
| Opus (Part 1); Opus and GPT (Part 2, half A) | Part 1 said GPT-6 Luna gave "all 5" fail votes and that it failed the readiness report five times. Part 2 then explained the splits from that wrong count. | There were **6 fail votes**: GPT-6 Luna 5 (checks 6, 7, 8, 9 and 14) and Gemini 3.7 Flash 1 (check 1). Only 3 of GPT's fails were on the readiness report (8, 9, 14); 6 was the build plan, 7 the payment code. |
| Opus (Part 1) | "Nine drafts" of the readiness report | **Nine runs on seven versions** (v1, v2, v3, v5, v6, v8 and v9); v8 was reviewed three times, once as a draft. The reviewer counted six; the receipts show seven. |
| Opus (Part 1) | Claude's share stated only as "9" | **9 of 18** checks were proposed by Claude, 5 were requested by the owner, and 4 came from an earlier session (who in that session asked for them isn't recorded). |
| Opus (Part 1) | "The owner ran every paid check" | The test wallet paid all 18. The owner ran checks 5 to 18; who ran checks 1 to 4 isn't recorded. |
| Opus (Part 1) | 202 issues didn't add up | 202 = Opus 144 + GPT 53 + Gemini Flash 1 + DeepSeek 4 + Gemini 4 Argon 0. |
| GPT (Part 2, half A) | GPT and Gemini Flash have 17 votes, against 18 checks | Check 16 used a different panel (DeepSeek V4 Pro, Claude Opus 5.5, Gemini 4 Argon), so neither sat on it. |
| Opus (Part 1) | "Most fixes came from Opus's lists" and "new findings were mostly wording from about the sixth run" | Neither is measured. Both are Claude's judgment from reading the issues, and are now labelled that way. |
| Opus and GPT (Part 2) | "Repeated rounds give one real issue per nine false ones" | That ratio was not in the source. The study (one author, one model) found a second review round raised recall from 0.53 to 0.61 while false findings rose from 5.2 to 8.5 per document. No per-issue ratio follows from that. |
| Opus (Part 2, half B) | The 23-per-IP miss called a "well-documented cause" of over-correction | It is an inference: the study measured over-repair of code correctness, not rate limits. |
| Opus (Part 2, half B) | "The one defect that reached real money" | It was found during the owner's own real-money test. No customer was affected, and no money was lost beyond the test reviews it charged. |
| Opus and GPT (Part 2) | "The log hit every one of the limits"; "out of reach for any reviewer"; "the literature is silent" | Narrowed: several limits are documented risks, not effects this log shows. Text review rarely catches load behaviour. "Silent" means only that the sources reviewed don't cover it. |
| GPT (Part 2, half B) | Second half didn't name itself as Part 1's companion | This part states the relationship at the top. |

Part 2's split analysis rested on the wrong fail count; section 3 redoes it with the correct one.

## 2. The corrected log in brief

- **Checks:** 18 paid, $3.60. Two more attempts were refused before payment: one hit the script's own spending cap, and in the other Claude Haiku returned no usable verdict on a 12,000-character report.
- **Results:** 2 pass, 10 needs_changes, 6 split. A split means no 2-of-3 majority; here, each split had one pass, one needs_changes and one fail.
- **Votes, default panel:**
  - Gemini 3.7 Flash: 16 pass and 1 fail, of 17
  - Claude Opus 5.5: 3 pass and 15 needs_changes, of 18
  - GPT-6 Luna: 1 pass, 11 needs_changes and 5 fail, of 17
- **What they caught:**
  - an operator-precedence bug that would have sent broken 429 error messages
  - a deploy order that opened paid routes before the alerts were proven
  - a phone alert path that had never been tested
  - a 100x load test that wasn't simultaneous; a later 6-machine test sent 3,000 requests within 0.13 s
- **What they missed:** check 7's advice was to count in-flight reviews against the failure allowance. It was applied as written and capped one IP address at 23 parallel reviews. Only the live load test showed this.
- **Weak points:**
  - Claude wrote every brief.
  - Claude Opus shares the author's model family.
  - Five runs (checks 10 to 13 and 15) reviewed an older copy of the report, because of a file-transfer bug on Claude's side.
  - Each check is a single sample.

## 3. What the published research adds (corrected)

**Single AI judges are noisy, lean toward passing, and follow the brief.**
- **Agreement with experts is low.** Across 20 tasks, GPT-4o's agreement with human labels, corrected for chance, averaged only 0.28 on a scale where 1 is perfect (Bavaresco et al., 2024-25). On checkable right-or-wrong pairs, GPT-4o did no better than chance, while a reasoning model reached 81% (JudgeBench, ICLR 2025).
- **They lean toward passing when unsure, smaller models more so.** Judges caught wholly wrong answers about 97% of the time but partly correct ones only 23-34% of the time (Thakur et al., 2024). Plans and reports are nearly always "partly correct", so Flash's 16 of 17 passes fits this pattern. The log can't show Flash was wrong on any one item.
- **Wording and stakes move verdicts.** Changing only the prompt's wording moved GPT-4's agreement from 0.52 to 0.73 (Verga et al.). In a 2026 study, one sentence about stakes made judges more lenient in 58 of 72 conditions, and the judges' reasoning never mentioned it (Gupta et al.).
- **The author-written brief stays an open question.** No study tests a brief written by the author of the work. Its pieces are documented, which makes it the log's largest unmeasured risk.
- **Same family, but not lenient here.** Same-family preference is documented: about 9% score inflation within one family (Li et al., ICLR 2026). Yet in this log Claude Opus raised by far the most issues (144) and passed only 3 of 18, though GPT-6 Luna was stricter on verdicts (1 pass, 5 fails). Any family effect would more likely show as blind spots shared with the author, and a vote count can't reveal those.

**A three-company panel controls bias more than it adds independent votes.**
- **What favours panels:** a panel of three small models from three companies beat a single GPT-4 judge at 7-8 times lower cost (Verga et al., 2024). Simple majority voting explains most of the gains credited to models debating each other (Choi et al., NeurIPS 2025).
- **Why three seats aren't three checks:**
  - Strong models increasingly make the same mistakes. When two models were both wrong, they chose the same wrong answer about 60% of the time, against 33% by chance (Kim et al., ICML 2025).
  - A May 2026 preprint found nine frontier judges worth about two independent votes. It is single-author and unreplicated (Kohli).
- **Corrected split reading:**
  - Five of the six splits had GPT-6 Luna voting fail. Gemini Flash's one fail (check 1) produced the sixth, where Opus voted pass.
  - Where Flash voted pass, which was every check but one, the panel passed once either Opus or GPT also passed.
  - So Flash's seat lowered the effective bar for a pass. That is Claude's inference from the votes, not a published finding.
  - No published base rate exists for split rates on three-company panels.

**Reviewers catch what is written down and rarely catch runtime behaviour.**
- **Low detection on real pull requests.** The best tool found 23% of issues on 1,000 verified pull requests (SWR-Bench, 2025). Another benchmark found no model above 31% (SWE-PRBench, single-author, scored by an AI).
- **Company figures measure something else.** They report useful-comment rates after filtering, about 75% at Uber and ByteDance, not how many real defects get missed.
- **Load and performance bugs are a documented weak spot.** A 2026 negative-results paper at SANER reports AI models do poorly at detecting performance bugs from source code.
- **The log fits this line:**
  - **Caught:** the precedence bug sat in the changed lines, and the deploy-order and alert problems were contradictions between written steps.
  - **Missed:** the 23-per-IP limit depended on real traffic.
- **Suggested fixes over-correct.** Reviewer-suggested fixes can wrongly change correct code, and running both versions against tests catches much of this (Jin and Chen, 2026). Seeing the 23-per-IP limit as a case of this is an inference. The live load test did what those tests do.

**Repeated rounds add noise faster than real findings.** In the only study found, a single model (Claude Opus 4.6, on 30 documents with planted errors) did best with one fresh review. A second round found a few more real issues but many more false ones (Song, 2026, single-author). A weak source (Yagubyan, 2026, single-author) also found a judge reversing 13.6% of its verdicts between identical runs. So rerunning an unchanged document mostly samples noise. That fits Claude's judgment that later runs found less, but the log did not measure it.

## 4. Recommendations

1. **Pin the artifact:** put a content hash in the brief and refuse the review before payment if the text doesn't match. This would have prevented the five stale-copy runs.
2. **Use a neutral brief template:** acceptance criteria only, with no description of the work's quality, no stakes and no argued case.
3. **Attach evidence:** send test output, load-test logs or reference answers, and have reviewers judge whether the evidence supports each claim. GPT's objection to the load test ended only when real evidence arrived.
4. **Fix the lenient seat:** use a stronger third reviewer, or require a pass to include at least one strict reviewer's pass and no fail. Both are untested and should be tried against real outcomes.
5. **Show model-family overlap on the receipt.**
6. **Treat a split as a question to settle with a test or a person,** not with another run.
7. **Check each finding before revising, and rerun only after a real change.** Stop when a round turns up nothing new that holds up.
8. **Load-test anything that changes limits or capacity,** especially when a reviewer suggested it, with realistic clients such as many agents behind one IP address.
9. **Split documents over about 5,000 characters,** or refuse them before charging. Consistency-check recall fell from 0.89 to 0.47 as design documents grew past about 5,000 characters (Fujitsu, 2025), and in this log Claude Haiku returned nothing usable at 12,000.
10. **Keep a person deciding what to apply,** and record on each receipt who asked for the check.
11. **Record whether each issue turned out real,** so each reviewer's accuracy can be measured before votes are weighted.

## 5. Bottom line

The panel's value was in its specific findings, not its verdict labels. At $0.20 a check it found a real bug, a deploy-order risk and a missing test, and it pushed for real load evidence. Its one miss came from its own advice and was caught by running the system. The corrected record supports a simple rule: **use reviewers to decide what to test, and use tests to decide what ships.**

## 6. This part's own check

Part 3 went through review-3 on Oct 27 at 9:39 PM. The result was needs_changes: Opus and GPT asked for changes, and Gemini Flash passed it. They raised six points, and all six were fixed:

- Opus is now described as raising the most issues, not as the strictest reviewer. On verdicts, GPT-6 Luna was stricter.
- The initiator split is given as 9, 5 and 4 out of 18, with no "known" denominator.
- A sentence that contradicted itself about the split analysis was rewritten.
- The performance-bug paper and the 13.6% source are now named.
- Thakur et al. now has its year.
- The 5,000-character threshold now cites its evidence.
