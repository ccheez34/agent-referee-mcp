# Part 4 data: every vote, the rotation draws and the most common findings

Oct 28, 2026 · ccheez34. The numbers behind [Part 4](part-4-chatgpt-build.md): 15 paid `review-3` checks on the ChatGPT build ($0.20 each, $3.00 in total). The votes come straight from the review output. The finding counts are Claude's, made by reading every issue each reviewer listed (see the note on the last table).

Short names: Opus = Claude Opus 5.5, Sonnet = Claude Sonnet 5.5, GPT = GPT-6 Luna, Argon = Gemini 4 Argon, Flash = Gemini 3.7 Flash. nc = needs_changes, ca = cannot_assess.

## Every vote

**Fixed panel (Opus, GPT, Argon):**

| # | Code | Opus | GPT | Argon | Verdict |
|---|---|---|---|---|---|
| 1 | Usage stats | nc | fail | fail | fail |
| 2 | Internal route | nc | nc | ca | nc |
| 3 | Review job v1 | nc | nc | nc | nc |
| 4 | MCP tools | nc | nc | pass | nc |
| 5 | Entry point | nc | nc | pass | nc |
| 6 | Entry point, same file | nc | nc | pass | nc |
| 7 | Entry point, same file | nc | nc | pass | nc |

**Rotating panel, review job, the same file within each version:**

| # | Version | Anthropic | OpenAI | Google | Verdict |
|---|---|---|---|---|---|
| 8 | v2 | Sonnet nc | GPT nc | Argon pass | nc |
| 9 | v2 | Opus nc | GPT nc | Argon nc | nc |
| 10 | v2 | Opus nc | GPT nc | Flash pass | nc |
| 11 | v3 | Sonnet nc | GPT nc | Argon pass | nc |
| 12 | v3 | Sonnet nc | GPT nc | Argon pass | nc |
| 13 | v3 | Sonnet pass | GPT nc | Argon pass | **pass** |
| 14 | v3 | Sonnet nc | GPT nc | Argon pass | nc |
| 15 | v3 | Sonnet nc | GPT nc | Flash pass | nc |

**Verdicts:** 1 fail, 13 needs_changes, 1 pass. Reviewers disagreed in most runs, but every run had a 2-of-3 majority, so none ended as a `split` verdict.

**By reviewer (45 seats):**

| Reviewer | Seats | pass | nc | fail | ca |
|---|---|---|---|---|---|
| Opus | 9 | 0 | 9 | 0 | 0 |
| GPT | 15 | 0 | 14 | 1 | 0 |
| Argon | 13 | 9 | 2 | 1 | 1 |
| Sonnet | 6 | 1 | 5 | 0 | 0 |
| Flash | 2 | 2 | 0 | 0 | 0 |

Of the 12 pass votes, 11 came from a Gemini model. The Google seat passed every time it saw version 3 (5 of 5).

## How the rotation drew

`rotate` picks one model per AI company at random from the service's pool:
- **Anthropic:** Claude Opus, Sonnet and Haiku. Haiku is left out for inputs over 8,000 characters, and every input here was longer.
- **OpenAI:** GPT-6 Luna only.
- **Google:** Gemini 4 Argon and Gemini 3.7 Flash.

| Company | v2 (3 runs) | v3 (5 runs) | All 8 |
|---|---|---|---|
| Anthropic | Opus 2, Sonnet 1 | Sonnet 5 | Opus 2, Sonnet 6 |
| OpenAI | GPT 3 | GPT 5 | GPT 8 |
| Google | Argon 2, Flash 1 | Argon 4, Flash 1 | Argon 6, Flash 2 |

- **What actually varies:** GPT-6 Luna sits on every rotated panel, so rotation varies only the Anthropic and Google seats.
- **The draw clustered:** version 3 drew Sonnet five times in a row. If each draw is a fair 50/50, five Sonnets in a row happens about 3% of the time, and five of either model about 6%. The pattern was noticed after the fact, and eight draws can't show whether the draw is fair.

## The most common findings

How to read this table:
- **Raised:** each reviewer that raised the issue counts once per run.
- **Could have:** how many seats saw code that had the problem.
- **Code:** which file, and which version of the review job, had the problem.
- **By:** how many times each reviewer raised it.
- **How the counts were made:** Claude counted them by reading every issue. Reviewers word the same point differently, so treat the numbers as close, not exact. The issue lists themselves aren't reproduced here.

| Finding | Code | Raised | Could have | By |
|---|---|---|---|---|
| The alarm rethrows errors, so the platform retries it | job v1, v2 | 8 | 12 | GPT 4, Opus 2, Sonnet 1, Argon 1 |
| A stuck or failed job keeps its text until the 24-hour cleanup | job v3 | 9 | 15 | Sonnet 5, GPT 4; Google 0 |
| A failure doesn't say the free review wasn't used | job v1, v2 | 7 | 12 | GPT 3, Argon 2, Opus 1, Sonnet 1 |
| Two starts of the same job can race | job v2, v3 | 7 | 24 | GPT 3, Opus 2, Sonnet 2 |
| Requirements belong to another file, so can't be checked | stats, internal route | 6 | 6 | all three, both times |
| Body size counted in characters, or read in full first | entry point | 6 | 9 | Opus 3, GPT 3; Argon 0 |
| Logging could leak request content or the id | entry point | 6 | 9 | Opus 3, GPT 3; Argon 0 |
| Ids with spaces rejected | entry point, internal route | 6 | 12 | Opus 4, GPT 2 |
| The `chatgpt:` label on the caller id isn't in the brief | job v2, v3 | 6 | 24 | Sonnet 6 (every seat it had) |
| The id hash isn't a proper HMAC, or is unkeyed without the secret | job v2 | 5 | 9 | Opus 2, GPT 2, Sonnet 1 |
| Server errors labelled "not used" though a review may have run | job v3 | 5 | 15 | Sonnet 4, GPT 1 |
| The `free` count shown isn't from the signed receipt | job v2, v3 | 5 | 24 | Sonnet 3, Opus 2 |
| The field says "yes" where the brief says "probably" | job v3 | 4 | 15 | Sonnet 4 |
| Size limit is 64,000 bytes, not 64 KiB | entry point | 4 | 9 | Opus 3, GPT 1 |
| Rotating the shared secret locks owners out of their results | job v2, v3 | 4 | 24 | Sonnet 3, Opus 1 |
| The raw user id is stored | job v1 | 3 | 3 | all three |
| Missing headers for allowed origins on GET / | entry point | 3 | 9 | GPT 3 |
| Expired jobs can still be read, or aren't deleted | job v1, v2 | 3 | 12 | GPT 2, Opus 1 |
| A job that wakes after it expires could still be sent | job v3 | 2 | 15 | GPT 1, Sonnet 1 |
| A body read that times out is labelled "probably used" | job v3 | 2 | 15 | Sonnet 2 |

**Two findings pointed in opposite directions.** In run 10, Opus noted that saying "your free review wasn't used" after a timeout may be untrue. GPT, in the same run, asked for that sentence on more failures. Both read the version-2 brief, which still had the old requirement. Opus was right: Claude had reached the same conclusion after run 8, and the version-3 brief (runs 11 to 15) dropped it.

**What Claude didn't change:**
- **The `chatgpt:` label.** It's deliberate: it keeps ChatGPT users separate from any future source.
- **Using one shared secret for both the connection and the hashes.** Rotating it makes open jobs unreadable, but jobs only last 24 hours.
- **Receipt checks done by the published client library.** Several reviewers couldn't see that code; it has its own tests.
