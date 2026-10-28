// The hosted server's tools. Reviews take 10-120 s and ChatGPT stops waiting for a tool after about 60 s, so a
// review is started with start_review and read with get_review (each waits a bounded time for the result).
import { randomHex, verifyReviewOutcome, verifySignature } from "agent-referee-client";
import { ToolError } from "../../src/protocol.mjs";
import { publicKeys } from "./keys.mjs";

const JOB_ID = /^[0-9a-f]{32}$/;
const PRIVACY =
  "The task and output are sent to Agent Referee and from there to the AI providers of the reviewers (Anthropic directly; OpenAI, Google and others through OpenRouter). Don't send secrets or personal data. This server deletes the text once the review is done and keeps the result for 24 hours.";

const modelId = { type: "string", minLength: 1, maxLength: 80 };
const reviewSchema = {
  type: "object",
  required: ["task", "output"],
  properties: {
    task: {
      type: "string",
      minLength: 10,
      maxLength: 4000,
      description:
        'What the work was supposed to do: the instructions or spec it was produced from, with its requirements (10-4,000 characters). Reviewers judge the output against this. It is NOT a message to the reviewers: write "Write a function that does A and B", not "check this for X".',
    },
    output: { type: "string", minLength: 1, maxLength: 12000, description: "The exact work to review (up to 12,000 characters). The receipt is tied to this exact text." },
    tier: { type: "string", enum: ["review", "review-3"], description: "review: one reviewer. review-3: three reviewers from three AI companies, majority verdict. Default review." },
    title: { type: "string", maxLength: 200, description: "Optional short label stored in the receipt." },
    panel: {
      anyOf: [{ type: "string", enum: ["rotate"] }, { type: "array", items: modelId, minItems: 1, maxItems: 3, uniqueItems: true }],
      description: 'Optional reviewers: "rotate" for one model per AI company at random, or exact model ids (1 for review, 3 for review-3). Leave it out for the defaults. Models: https://agentreferee.ai/reviewers',
    },
  },
  additionalProperties: false,
};

function checkReviewArgs(a) {
  const bad = (m) => {
    throw new ToolError(`Invalid arguments: ${m}`);
  };
  for (const k of Object.keys(a)) if (!(k in reviewSchema.properties)) bad(`unknown argument "${k}".`);
  if (typeof a.task !== "string" || a.task.length < 10 || a.task.length > 4000) bad("task must be 10-4,000 characters.");
  if (typeof a.output !== "string" || a.output.length < 1 || a.output.length > 12000) bad("output must be 1-12,000 characters.");
  if (a.tier !== undefined && !["review", "review-3"].includes(a.tier)) bad('tier must be "review" or "review-3".');
  if (a.title !== undefined && (typeof a.title !== "string" || a.title.length > 200)) bad("title must be a string of up to 200 characters.");
  if (a.panel !== undefined && a.panel !== "rotate" && !(Array.isArray(a.panel) && a.panel.length >= 1 && a.panel.length <= 3 && a.panel.every((m) => typeof m === "string" && m.length >= 1 && m.length <= 80)))
    bad('panel must be "rotate" or a list of 1-3 model ids.');
}

/** What get_review / start_review return for a job. */
function present(job) {
  if (job.status === "done")
    return {
      summary: `Sealed review (${job.tier}) done: verdict ${job.verdict}.`,
      ...job,
      next: "Report the verdict and the problems each reviewer found; don't overstate it. Keep the receipt with the exact task and output: anyone holding all three can check it (verify_receipt). A review is not a guarantee the output is correct, and a re-run can differ.",
    };
  if (job.status === "failed") return { summary: `The review didn't complete: ${job.error}`, ...job, free_review_used: false };
  return { summary: "The review is still running.", job_id: job.id, status: job.status, tier: job.tier, next: "Call get_review again with the same job_id. Reviews usually take 10-90 seconds, sometimes up to about 5 minutes." };
}

/** @param {{ env: any, subject?: string }} deps  subject: ChatGPT's anonymous id for the person, when it sent one. */
export function buildTools({ env, subject }) {
  const waitStart = Number(env.START_WAIT_MS ?? 20_000);
  const waitPoll = Number(env.POLL_WAIT_MS ?? 40_000);
  const job = (id) => env.JOBS.get(env.JOBS.idFromName(id));
  const status = async (id) => {
    const r = await job(id).fetch(`https://job/status?wait=${waitPoll}`, { headers: subject ? { "x-subject": subject } : {} });
    const body = await r.json();
    if (r.status === 404) throw new ToolError(body.error);
    return body;
  };

  return [
    {
      name: "start_review",
      title: "Start a sealed review",
      description:
        `FREE. Starts an independent check of a piece of work against the task it was for: one reviewer, or three from three AI companies (review-3), who don't see each other's verdicts. Returns a job_id (or, if it finishes within about 20 seconds, the result); then call get_review with the job_id. The result has a verdict (pass, needs_changes, fail or cannot_assess), the problems each reviewer found, and an Ed25519-signed receipt tied to the exact text. A few free reviews per person per day (3 single, 1 review-3, inside a shared daily budget, so they can run out). Use it when someone other than the author needs to trust the work; for things tests can check, run the tests instead. ${PRIVACY}`,
      inputSchema: reviewSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
      handler: async (args) => {
        checkReviewArgs(args);
        if (String(env.REMOTE_PAUSED ?? "").toLowerCase() === "true") throw new ToolError("New reviews are paused on this server right now. Try again later.");
        if (!env.INTERNAL_TOKEN) throw new ToolError("This server isn't connected to Agent Referee yet (an operator setting). Nothing was used.");
        const id = randomHex(16);
        const tier = args.tier ?? "review";
        const r = await job(id).fetch("https://job/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, tier, ...args, subject: subject ?? null }) });
        if (!r.ok) throw new ToolError("The review couldn't be started. Try again.");
        if (waitStart > 0) {
          const now = await job(id).fetch(`https://job/status?wait=${Math.min(waitStart, 40_000)}`, { headers: subject ? { "x-subject": subject } : {} });
          return present(await now.json());
        }
        return present({ id, status: "queued", tier });
      },
    },
    {
      name: "get_review",
      title: "Get a sealed review's result",
      description: "FREE. Gets the result of a review started with start_review, waiting up to about 40 seconds if it's still running. Results are kept for 24 hours.",
      inputSchema: {
        type: "object",
        required: ["job_id"],
        properties: { job_id: { type: "string", pattern: "^[0-9a-f]{32}$", description: "The job_id start_review returned." } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      handler: async (args) => {
        if (!JOB_ID.test(String(args?.job_id ?? ""))) throw new ToolError("job_id must be the 32-character id start_review returned.");
        return present(await status(args.job_id));
      },
    },
    {
      name: "verify_receipt",
      title: "Verify a sealed-review receipt",
      description:
        "FREE and offline. Checks an Agent Referee sealed-review receipt against the service's pinned signing key, recomputes the verdict from the votes, and, when you pass the exact task and output, confirms the receipt is about exactly that work.",
      inputSchema: {
        type: "object",
        required: ["receipt"],
        properties: {
          receipt: { anyOf: [{ type: "object" }, { type: "string" }], description: "The receipt (or the JSON text of it)." },
          task: { type: "string", description: "The exact task text, to confirm the receipt is about it." },
          output: { type: "string", description: "The exact output text, to confirm the receipt is about it." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      handler: async (args) => {
        let receipt = args?.receipt;
        if (typeof receipt === "string") {
          try {
            receipt = JSON.parse(receipt);
          } catch {
            throw new ToolError("receipt is a string but not valid JSON.");
          }
        }
        if (receipt && !receipt.payload && receipt.receipt?.payload) receipt = receipt.receipt;
        if (!receipt?.payload || typeof receipt.payload !== "object") throw new ToolError("That isn't a receipt: it has no payload.");
        const p = receipt.payload;
        const signed = await verifySignature(receipt, publicKeys(env)).catch(() => false);
        if (p.type !== "review")
          return { summary: `${signed ? "Validly signed" : "NOT validly signed"} ${p.type ?? "unknown"} receipt. Only sealed-review receipts are checked in full here; the agent-referee-mcp package checks match receipts too.`, ok: false, signature_valid: signed };
        const res = await verifyReviewOutcome(receipt, { task: args.task, output: args.output });
        const problems = [...(signed ? [] : ["The receipt's signature doesn't check out against Agent Referee's pinned key: it may be forged or altered."]), ...res.problems];
        const notChecked = [...(args.task === undefined ? ["task"] : []), ...(args.output === undefined ? ["output"] : [])];
        const ok = problems.length === 0;
        return {
          summary: `${ok ? "Valid" : "NOT valid"} sealed review (${p.tier}): verdict ${p.result?.verdict}.${notChecked.length ? ` Not checked: ${notChecked.join(" and ")} (pass them to confirm the receipt is about that exact text).` : ""}`,
          ok,
          signature_valid: signed,
          verdict: p.result?.verdict,
          tier: p.tier,
          review_id: p.review_id,
          funding: p.funding ?? "paid",
          reviewers: p.reviewers?.models,
          problems,
          not_checked: notChecked,
          trusts: res.trusts,
        };
      },
    },
  ];
}
