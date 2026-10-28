// One sealed review started from the hosted MCP server, as a Durable Object (one per job id).
//
// start_review stores the request and sets an alarm; the alarm sends it to Agent Referee's internal free-review
// route, checks the signed receipt against the pinned key and the exact text, then deletes the task and output.
// get_review reads the result (waiting up to ~40 s for it). Everything is deleted 24 hours after the job started.
import { verifyReviewOutcome, verifySignature } from "agent-referee-client";
import { publicKeys } from "./keys.mjs";

const KEEP_MS = 24 * 3600_000;
const REVIEW_TIMEOUT_MS = 330_000; // longer than the service's own reviewer budget plus its queue wait

const STUCK_MS = REVIEW_TIMEOUT_MS + 120_000; // a review still "running" after this was interrupted
const TIERS = ["review", "review-3"];
const NOT_USED = "Your free review wasn't used.";
const MAYBE_USED = "It may have used one of today's free reviews.";

/** HMAC-SHA256 keyed with INTERNAL_TOKEN (start_review refuses to run without it), hex. */
async function keyedHash(env, label, value) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(`agent-referee-remote|${env.INTERNAL_TOKEN ?? ""}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${label}|${value}`)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The id sent to Agent Referee for the person: a keyed hash of ChatGPT's id, so the raw id is never stored. */
export async function callerIdFor(env, subject) {
  return subject ? (await keyedHash(env, "caller", subject)).slice(0, 40) : null;
}
const ownerFor = (env, subject) => keyedHash(env, "owner", subject);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Calls the main Worker: through the service binding when there is one, else over HTTPS. */
export function callReferee(env, path, init) {
  const url = `${(env.REFEREE_URL || "https://agentreferee.ai").replace(/\/+$/, "")}${path}`;
  return env.REFEREE?.fetch ? env.REFEREE.fetch(new Request(url, init)) : fetch(url, init);
}

export class ReviewJob {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.now = () => Date.now();
  }

  async fetch(req) {
    const url = new URL(req.url);
    const st = this.state.storage;
    if (url.pathname === "/start" && req.method === "POST") {
      if (await st.get("job")) return json(409, { error: "This job already exists." });
      const b = await req.json().catch(() => null);
      if (!b || typeof b.id !== "string" || !TIERS.includes(b.tier) || typeof b.task !== "string" || typeof b.output !== "string") return json(400, { error: "Bad job request." });
      const created = this.now();
      await st.put("job", {
        id: b.id,
        status: "queued",
        tier: b.tier,
        created,
        expires: created + KEEP_MS,
        // Only a hash of the person's id is kept, to make sure the same person reads the result.
        owner: b.subject ? await ownerFor(this.env, b.subject) : null,
      });
      // Kept only until the review has been sent and checked. The person's id is kept only as a keyed hash.
      await st.put("input", { task: b.task, output: b.output, title: b.title, criteria: b.criteria, panel: b.panel, caller: await callerIdFor(this.env, b.subject) });
      await st.setAlarm(created);
      return json(200, { ok: true });
    }
    if (url.pathname === "/status") {
      const waitMs = Math.max(0, Math.min(40_000, Number(url.searchParams.get("wait")) || 0));
      const subject = req.headers.get("x-subject");
      const deadline = this.now() + waitMs;
      const missing = json(404, { error: "No review with that job_id for you (results are kept for 24 hours)." });
      let job = await st.get("job");
      if (!job || this.now() >= job.expires) return missing;
      // A job started by a known person can only be read with that person's id.
      if (job.owner && (!subject || job.owner !== (await ownerFor(this.env, subject)))) return missing;
      while ((job.status === "queued" || job.status === "running") && this.now() < deadline) {
        await sleep(Math.min(1000, Math.max(1, deadline - this.now())));
        job = (await st.get("job")) ?? job;
        if (this.now() >= job.expires) return missing;
      }
      // A review that never finished (its alarm couldn't complete) is reported as interrupted, not running forever.
      if ((job.status === "queued" || job.status === "running") && this.now() - (job.started_at ?? job.created) > STUCK_MS)
        job = { ...job, status: "failed", error: `The review was interrupted before it finished. ${MAYBE_USED} Start a new one with start_review.`, free_review_used: "maybe" };
      const { owner, expires, attempted, started_at, ...visible } = job;
      return json(200, visible);
    }
    return json(404, { error: "Unknown job action." });
  }

  async alarm() {
    try {
      await this.runAlarm();
    } catch (e) {
      // Never rethrown, so the platform doesn't retry it. A job left unfinished is reported as interrupted by
      // /status, and the attempted flag (written before any review is sent) means nothing is ever sent twice.
      console.error(`review job alarm: ${String(e?.message ?? e).slice(0, 200)}`);
      try {
        const job = await this.state.storage.get("job");
        if (job) await this.state.storage.setAlarm(job.expires); // still clean up after 24 hours
      } catch {}
    }
  }

  async runAlarm() {
    const st = this.state.storage;
    const job = await st.get("job");
    if (!job) return;
    if (job.status === "done" || job.status === "failed") {
      if (this.now() >= job.expires) await st.deleteAll();
      else await st.setAlarm(job.expires);
      return;
    }
    if (job.attempted) {
      // The alarm ran before and didn't finish (the object restarted mid-review). Never send the review twice.
      await this.finish(job, { status: "failed", error: `The review was interrupted before it finished. ${MAYBE_USED} Start a new one with start_review.`, free_review_used: "maybe" });
      return;
    }
    job.attempted = true;
    job.status = "running";
    job.started_at = this.now();
    await st.put("job", job);
    const input = await st.get("input");
    let outcome;
    try {
      outcome = input ? await this.run(job.tier, input) : { status: "failed", error: `The review's input is missing. ${NOT_USED} Start a new one.`, free_review_used: "no" };
    } catch (e) {
      outcome = { status: "failed", error: `The review couldn't be completed (${String(e?.message ?? e).slice(0, 200)}). ${MAYBE_USED}`, free_review_used: "maybe" };
    }
    await this.finish(job, outcome);
  }

  async finish(job, outcome) {
    const st = this.state.storage;
    await st.delete("input");
    await st.put("job", { ...job, ...outcome, finished_at: new Date(this.now()).toISOString() });
    await st.setAlarm(job.expires);
  }

  async run(tier, input) {
    const env = this.env;
    const body = JSON.stringify({ task: input.task, output: input.output, title: input.title, criteria: input.criteria, panel: input.panel });
    let res;
    try {
      res = await callReferee(env, `/internal/free/${tier}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-auth": env.INTERNAL_TOKEN ?? "",
          ...(input.caller ? { "x-caller-id": `chatgpt:${input.caller}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
      });
    } catch (e) {
      // The service gives the allowance back when a review doesn't complete, but it may still have been running.
      return { status: "failed", error: `Agent Referee didn't answer in time (${String(e?.message ?? e).slice(0, 120)}). ${MAYBE_USED} Try again later.`, free_review_used: "maybe" };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const retry = Number(res.headers.get("retry-after")) || undefined;
      const said = String(data?.error ?? `Agent Referee answered ${res.status}.`).slice(0, 600);
      return {
        status: "failed",
        http_status: res.status,
        busy: res.status === 503 && !!data?.busy,
        ...(retry ? { retry_after_seconds: retry } : {}),
        error: res.status === 401 || res.status === 404 ? `The hosted server isn't connected to Agent Referee correctly (an operator problem). ${NOT_USED}` : /wasn't used/.test(said) ? said : `${said} ${NOT_USED}`,
        free_review_used: "no",
      };
    }
    const receipt = data?.receipt;
    const signed = await verifySignature(receipt, publicKeys(env)).catch(() => false);
    const check = receipt?.payload
      ? await verifyReviewOutcome(receipt, { task: input.task, output: input.output, tier, ...(Array.isArray(input.panel) && input.panel.every((m) => typeof m === "string") ? { panel: input.panel } : {}) }).catch(() => ({ problems: ["The receipt's review data is malformed."] }))
      : { problems: ["The answer has no receipt."] };
    const problems = [...(signed ? [] : ["The receipt's signature doesn't check out against Agent Referee's pinned key."]), ...check.problems];
    if (receipt?.payload?.funding !== "free") problems.push('The receipt doesn\'t say funding: "free".');
    // The service did run a review here (and counted it), but its answer can't be trusted, so it isn't shown.
    if (problems.length) return { status: "failed", error: "Agent Referee's answer didn't pass the checks, so it isn't shown as a result. This probably used one of today's free reviews.", problems, free_review_used: "yes" };
    // Everything shown comes from the signed, checked receipt, not from the rest of the answer.
    const p = receipt.payload;
    return {
      status: "done",
      review_id: p.review_id,
      verdict: p.result?.verdict,
      tally: p.result?.tally,
      votes: p.votes,
      free: data.free, // the allowance left today, as the service reported it (not part of the signed receipt)
      receipt,
      checked: "The receipt's signature was checked against Agent Referee's pinned key, and it was confirmed to be about exactly the task and output that were sent.",
    };
  }
}
