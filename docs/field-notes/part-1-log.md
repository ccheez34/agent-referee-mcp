# Part 1: Claude's written log of the Agent Referee independent checks

Oct 27, 2026 · ccheez34

> This is Part 1 of 3, kept as it was independently checked. [Part 2](part-2-research.md) is the web-research report, and [Part 3](part-3-corrected.md) is the corrected and combined edition. The checks found errors here. The main one: there were 6 fail votes, not 5. GPT-6 Luna gave 5 and Gemini 3.7 Flash gave 1, on check 1. Use Part 3's figures.

## Summary

On Oct 27, 2026, 18 paid independent checks ran through Agent Referee's own sealed review, for $3.60 in all. Two more attempts were refused before payment and cost nothing. Only 2 of the 18 came back pass; 10 were needs_changes and 6 were split.

- **What was checked:** the scale plan and Phase 1 build plan, two handoff docs, the payment-path code, nine drafts of the pre-deploy readiness report, and a live bug fix.
- **What they caught that tests did not:** a broken error message in the in-flight limit fix (check 17), unpaused paid routes in the deploy order, an unconfirmed phone alert, and a 100x test that wasn't simultaneous.
- **The reviewers disagreed in a stable way:** Gemini 3.7 Flash passed 16 of its 17 checks. Claude Opus 5.5 asked for changes in 15 of 18. GPT-6 Luna gave all 5 of the fail votes.
- **One gap no check caught:** a fix that check 7 prompted (counting in-flight reviews against the failure allowance) was too strict. The live real-money test found it, and checks 17 and 18 reviewed the repair.

**Who started them.** In this session the owner asked for 5 checks (5, 6, 8, 16 and 17). Claude proposed and set up the other 9 on its own initiative: the payment-path code review (7), the re-runs after each report revision (9 to 15), and the re-check of the repaired fix (18). The owner ran every paid check from the test wallet. Checks 1 to 4 came from an earlier session, and who asked for them isn't recorded here.

## Method

Every check was one paid **review-3** on the live service: three AI reviewers from three companies, run in parallel, never seeing each other's verdicts. Each cost $0.20, charged only when all three answered.

1. **Inputs.** Claude wrote the task as the owner's requirements, not as instructions to the reviewers, and sent the work itself as the output: a plan, a report, a handoff doc or a code diff. Limits: task up to 4,000 characters, output up to 12,000.
2. **Panel.** The default panel was Claude Opus 5.5, GPT-6 Luna and Gemini 3.7 Flash. Check 16 used five agreed sets, each with DeepSeek V4 Pro plus two other companies, and the service drew one at random before payment.
3. **Rule.** A verdict with 2 or more of the 3 votes wins; otherwise the result is split.
4. **Receipts.** Each check returned an Ed25519-signed receipt with hashes of the exact task and output. The owner's MCP server verified every receipt offline, and all 18 checked out.
5. **Response.** Claude read every issue and either changed the work or wrote down why not, then re-ran the check when the change was material.

## Log

The 18 paid checks are listed in order, oldest first. Times are Mountain Time on Oct 27, receipt ids are their first 8 characters, and "changes" means a needs_changes vote.

| # | Time (MT) | What was checked | Asked by | Result | Votes | What changed | Receipt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1:26 PM | Reviewer retry fix (deployed 4054fd6d) | Earlier session | split | Opus pass, GPT changes, Gemini Flash fail | Not recorded here | fc7ab175 |
| 2 | 2:16 PM | Scale-readiness plan | Earlier session | needs changes | Opus changes, GPT changes, Gemini Flash pass | Fed into the Phase 1 build plan | 053cd4f3 |
| 3 | 2:21 PM | Python client handoff doc | Earlier session | pass | Opus pass, GPT changes, Gemini Flash pass | Passed; follow-up not recorded here | 6874c205 |
| 4 | 2:22 PM | MCP server handoff doc | Earlier session | needs changes | Opus changes, GPT changes, Gemini Flash pass | Handoff fixed in the earlier session (rollback command and others) | d492a1a2 |
| 5 | 3:59 PM | Phase 1 build plan v1 | Owner | needs changes | Opus changes, GPT changes, Gemini Flash pass | Plan v2 applied the findings | fa2f1627 |
| 6 | 4:28 PM | Phase 1 build plan v2 (exact panel of the same 3 models) | Owner | split | Opus changes, GPT fail, Gemini Flash pass | Plan v3: fake payment headers can't take slots; settle failures block the wallet and auto-pause; unjudged refunds alert | 5fc2e116 |
| 7 | 4:56 PM | Phase 1 payment-path code | Claude | split | Opus changes, GPT fail, Gemini Flash pass | Plan v4: in-flight reservations; budget capped by validBefore; cleanup can't 5xx | 09c9eb8c |
| 8 | 6:20 PM | Pre-deploy report v1 (5,592 chars) | Owner | split | Opus changes, GPT fail, Gemini Flash pass | Report v2: payment-path tests, rollback package, ramp spend cap and stop rules, monitor before money | acd9ecfa |
| 9 | 6:45 PM | Pre-deploy report v2 (8,920 chars) | Claude | split | Opus changes, GPT fail, Gemini Flash pass | Report v3: phone push made a blocker; no money before alerts; deploy from the tested folder | 23abbb1d |
| 10 | 6:54 PM | Pre-deploy report v3 (11,909 chars) | Claude | needs changes | Opus changes, GPT changes, Gemini Flash pass | Push fixed and proven; report v4 | b328fb6b |
| 11 | 7:01 PM | Pre-deploy report v5 (11,893); v7 not yet saved | Claude | needs changes | Opus changes, GPT changes, Gemini Flash pass | Report v7: deploy starts paused; all payment paths checked; refund drill | 4ae2b4d0 |
| 12 | 7:05 PM | Pre-deploy report v6 (11,897); v7 not yet saved | Claude | needs changes | Opus changes, GPT changes, Gemini Flash pass | Live slots raised to Sonnet 20 and Opus 10; report v8 | b9098cfd |
| 13 | 7:15 PM | Pre-deploy report v8 draft (11,843) | Claude | needs changes | Opus changes, GPT changes, Gemini Flash pass | Findings carried into report v9 | d6bc84a2 |
| 14 | 7:16 PM | Pre-deploy report v8 (11,887) | Claude | split | Opus changes, GPT fail, Gemini Flash pass | Report v9: step order fixed; refund drill made real; OpenRouter cap | 36deffdb |
| 15 | 7:20 PM | Pre-deploy report v8 again; DeepSeek option not yet on the PC | Claude | needs changes | Opus changes, GPT changes, Gemini Flash pass | Owner set a $25 monthly OpenRouter limit | b01c45d3 |
| 16 | 7:35 PM | Pre-deploy report v9 (11,992), DeepSeek panel | Owner | needs changes | DeepSeek changes, Opus changes, Gemini Argon pass | Report v10: step 5 order fixed; many-machine 100x test run and passed | 340a5b7c |
| 17 | 9:08 PM | In-flight limit fix, first version | Owner | needs changes | Opus changes, GPT changes, Gemini Flash pass | Operator-precedence bug in the 429 message fixed, with unit and route tests | 7ca4cc80 |
| 18 | 9:15 PM | In-flight limit fix, second version | Claude | pass | Opus pass, GPT pass, Gemini Flash pass | Two small fixes: an empty setting falls back to 20; a test comment | 8b46ed4d |

Two attempts were refused before payment and charged nothing. At 6:44 PM the script's own $0.20 daily cap blocked a second run that day, so each run now gets its own cap. At 7:21 PM the first DeepSeek draw seated Claude Haiku, which returned no usable verdict on the 12,000-character report; long reviews now leave Haiku out of random draws.

## Findings

The three default reviewers behaved like three different standards, and the outcome mostly tracked which of them broke the tie.

[Chart: votes per reviewer. Gemini 3.7 Flash: 16 pass, 1 fail of 17. Claude Opus 5.5: 3 pass, 15 needs changes of 18. GPT-6 Luna: 1 pass, 11 needs changes, 5 fail of 17. DeepSeek V4 Pro (1 needs changes) and Gemini 4 Argon (1 pass) sat on one check each.]

- **Volume of issues differed tenfold.** Opus raised 144 issues across 18 checks, GPT 53 across 17, and Gemini Flash 1 across 17. Most fixes came from Opus's lists.
- **GPT held one objection to the end.** It failed the pre-deploy report five times, mostly on the 100x burst not being simultaneous. It stopped only after the many-machine test showed 3,000 requests sent within 0.13 s.
- **Checks caught real defects that tests and Claude missed:** unpaused paid routes in the deploy order, an alert path never proven, a deploy plan copying files by hand, and a precedence bug that would have sent broken 429 messages (check 17).
- **A reviewed fix can still be wrong.** Check 7's advice to count in-flight reviews against the failure allowance was applied as written. It was too strict for 25 parallel reviews, and only the live real-money ramp showed it.
- **Repeats had diminishing returns.** Nine runs on the pre-deploy report cost $1.80; from about the sixth on, new findings were mostly wording and ordering.

## Caveats and raw data

Read these results as one day of field notes, not a controlled study.

- **Some checks saw an older copy.** Checks 10 to 13 and 15 reviewed a report older than the latest draft. Claude's file transfer to the PC delivered each file's previous version until it was fixed at 7:22 PM, so findings there can repeat issues already fixed.
- **The author wrote the brief.** Claude, whose work was under review, wrote every task statement. A brief can steer reviewers, even when it lists requirements rather than instructions.
- **One reviewer shares the author's family.** Claude Opus reviewed work written by Claude. This log can't tell whether that made it harsher, softer or neither.
- **Each check is one sample.** Re-running the same input gives a fresh draw, and the reviewers saw only text: no code execution, no web.
- **Raw receipts** are kept by the owner. Each is signed and holds every reviewer's full issues and reasoning; any of them can be checked offline with `verify_receipt`.

All 202 issues, copied word for word from the receipts and grouped by check, and the same 18 checks as structured data, are available on request.
