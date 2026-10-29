---
name: code-review-panel
description: Get code reviewed by an Agent Referee panel from three AI companies, using panels picked for code reviews and multi-part review for changes that span files. Use before merging or shipping code someone else needs to trust.
---

# Code review with an Agent Referee panel

Agent Referee's sealed review sends code and the task it was written for to three AI reviewers from three companies. It returns their issues and an Ed25519-signed receipt tied to the exact bytes reviewed. This skill sets up that review for code: which panel, which tier, what to send, and how to read the answer. The general rules (spending caps, batch runs, keeping and verifying receipts) are in the `independent-check` skill. Follow it wherever this one says "as in independent-check".

**What a panel can and can't do.** Reviewers read text. They can't run anything. In this project's checks, panels found real bugs, such as an operator-precedence error on a payment path and a redirect that could resend a signed payment header to another host. They missed problems that only show at runtime, such as a per-address limit that was too strict under load, and a bug spanning three files that no single-file review could see. So use a panel to decide what to test, and use tests to decide what ships.

## Spending: the user agrees first, every time

Every paid review needs the user's yes in the chat first, with the number of runs and the total cost. Take prices from `GET /reviewers`, not from memory. The rest of the spending rules are as in independent-check.

## 1. Before paying

1. **Run the tests and the type check.** A failing test is a cheaper finding than any review.
2. **Read the whole change yourself first,** or with a free subagent, across all the files. That's where bugs spanning several files show up. In this project, the highest-severity bug of one round spanned three files and was found this way; its authors judged that no single-piece review could have found it.
3. **Check the code against your own brief.** In one round, nine paid votes went on a mismatch between the code and the author's own requirements, which a read before paying would have caught.

## 2. The panels

These panels come from 76 paid checks on this one project over two days, all from one author (Claude). They describe how these models behaved on that work, not a general ranking. Use them as defaults, and change them when the user asks.

- **Panel A (default for one piece):** `claude-opus-5-5`, `openai/gpt-6-luna`, `google/gemini-4-argon`
- **Panel B (a second run, and the panel for multi-part):** `claude-sonnet-5-5`, `openai/gpt-6-luna`, `google/gemini-4-argon`

The multi-part tiers leave Opus out, because its answer costs could exceed their price in the worst case, so use Panel B there. Confirm the model names against `GET /reviewers` before sending; it lists the models each tier accepts.

Left out on purpose:
- **`google/gemini-3.7-flash`:** passed 32 of 33 seats, with 1 issue in total over 17 seats, including a check where two other reviewers found the same real bug. In these checks, its pass rarely added information.
- **`claude-haiku-5-5`:** failed on a page of about 7,500 characters, and the service leaves light models out of long inputs anyway.
- **DeepSeek, Qwen and Mistral (opt-in models):** they often ran out of answer room or timed out on pieces of about 11,000 characters. Use them only on short pieces, and only if the user asks. GLM hasn't been tried on long pieces; treat it the same way.
- **`moonshotai/kimi-k3` (opt-in):** kept up on long pieces. It can take the Google seat's place on a single `review-3` if the user asks. It's used only when named, and its provider (Moonshot) is based in China, so say that before sending their code there.

How to read the seats:
- **GPT-6 Luna asks for changes almost every time** (4 passes in 60 seats). Its objections are often literal readings of one word in a requirement. Check each one; don't count it as a vote against shipping. It's in both panels because it's the only OpenAI model in the default pool, and every panel needs three companies.
- **Gemini 4 Argon leans pass but has caught real bugs.** Its pass is weak evidence, not none.
- **If Claude wrote the code, the Claude seat shares the author's model family.** Keep its findings, but don't let its pass be the deciding vote, and say so in the report.

## 3. Pick the tier

The limits, all counted in characters:
- **`review-3`:** a task (the brief) of up to 4,000 and code of up to 12,000. Above 6,000 for task and code together, the light models are left out, and refused if named.
- **The multi-part tiers:** up to 12,000 per piece and 36,000 in all.

Keep about 1,000 characters of margin under each limit. Every review is charged only if it completes.

- **One file or change that fits:** `review-3` with Panel A.
- **2 or 3 related files whose behaviour depends on each other:** `review-3x2` or `review-3x3` (every reviewer reads every piece), with Panel B. Use them only when all of these hold:
  - `GET /reviewers` lists the tier as open, with its price. They opened on Oct 28, 2026, at $0.60 for 2 pieces and $0.70 for 3, and are paid only (the free daily reviews don't cover them).
  - the user's tool accepts `pieces`: the MCP `sealed_review` from `agent-referee-mcp` 0.3.0, or `agent-referee-client` 0.9.0 (JS) or 0.2.0 (Python). With an older version, use one `review-3` per file.
  - the user has agreed the price
- **Otherwise:** one `review-3` per file. Each piece is reviewed alone, so its brief must state the contracts of the functions it calls and is called by. A requirement whose code sits in another file gets marked missing otherwise.

## 4. What to send

- **The exact current files,** rebuilt right before sending. In this project, five runs reviewed a stale copy. Afterwards, check each receipt with `verify_receipt`, passing the exact brief and file, which confirms the review is about that exact text.
- **A brief of checkable requirements,** in neutral wording, with no stakes or praise:
  - what the code must do
  - its limits and failure behaviour
  - security and money rules
  - what it must never do
- **The facts reviewers can't see:** the framework, the runtime, which neighbouring code already handles what. Without them, true design choices get flagged as bugs.
- **Evidence:** test output and load-test results. Ask whether the evidence supports each claim.
- **Choices made on purpose,** stated as such. Record anything settled this way as "accepted by design", never as "fixed".
- **No secrets** (keys, tokens, wallet keys) and no personal data. The code goes to three AI companies.

## 5. Runs

- **One run with Panel A** for an ordinary change.
- **Two runs (Panel A, then Panel B)** for code on a money, security or data path, planned before the first run and agreed with the user. Runs planned beforehand are fine, as in independent-check; a run added after an unwanted verdict isn't.
- **After about two runs, fix and re-check;** don't keep rerunning the same code.

## 6. Read the issues, not the verdict

The verdict mostly reflects which models sat on the panel. The issues are what you can check.

- **Triage every issue** against the code and the tests, as one of:
  - **fixed**
  - **accepted by design**
  - **false:** say what context was missing, and add it to the next brief
  - **needs a test**
- **Consistent isn't correct; rare can be important.** One finding raised by seven votes turned out false. The most important finding of one round came from a single reviewer.
- **A split is a work order:** turn the dissenting reviewer's main claim into a test or a question for a person. Don't rerun to break the tie.
- **Anything about limits, concurrency, rate limits, retries or money goes to a test,** including any fix a reviewer suggested. A panel pass is not evidence for those.

## 7. Record and report

- **Keep the check folder as in independent-check,** plus a FINDINGS note listing each issue and its triage label.
- **Report:**
  - the verdict, then the issues that held up, most serious first
  - what was false, and why
  - what still needs a test
  - whether the receipts verify (`verify_receipt` with the exact brief and files, or the client's `check.ok`)
- **Say what the receipts cover:** these files at these hashes, reviewed by these models. Code changed after the review isn't covered.
