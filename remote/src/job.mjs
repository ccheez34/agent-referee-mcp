// One sealed review started from the hosted MCP server, as a Durable Object (one per job id).
//
// start_review stores the request and sets an alarm; the alarm sends it to Agent Referee's internal free-review
// route, checks the signed receipt against the pinned key and the exact text, then deletes the task and output.
// get_review reads the result (waiting up to ~40 s for it). Everything is deleted 24 hours after the job started.
import { sha256Hex, verifyReviewOutcome, verifySignature } from "agent-referee-client";
import { publicKeys } from "./keys.mjs";

const KEEP_MS = 24 * 3600_000;
const REVIEW_TIMEOUT_MS = 330_000; // longer than the service's own reviewer budget plus its queue wait

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
      const b = await req.json();
      const created = this.now();
      await st.put("job", {
        id: b.id,
        status: "queued",
        tier: b.tier,
        created,
        expires: created + KEEP_MS,
        // Only a hash of the person's id is kept, to make sure the same person reads the result.
        owner: b.subject ? await sha256Hex(`owner|${b.subject}`) : null,
      });
      // Kept only until the review has been sent and checked.
      await st.put("input", { task: b.task, output: b.output, title: b.title, criteria: b.criteria, panel: b.panel, subject: b.subject ?? null });
      await st.setAlarm(created);
      return json(200, { ok: true });
    }
    if (url.pathname === "/status") {
      const waitMs = Math.max(0, Math.min(40_000, Number(url.searchParams.get("wait")) || 0));
      const subject = req.headers.get("x-subject");
      const deadline = this.now() + waitMs;
      let job = await st.get("job");
      if (!job) return json(404, { error: "No review with that job_id (results are kept for 24 hours)." });
      if (job.owner && subject && job.owner !== (await sha256Hex(`owner|${subject}`))) return json(404, { error: "No review with that job_id (results are kept for 24 hours)." });
      while ((job.status === "queued" || job.status === "running") && this.now() < deadline) {
        await sleep(Math.min(1000, Math.max(1, deadline - this.now())));
        job = (await st.get("job")) ?? job;
      }
      const { owner, expires, ...visible } = job;
      return json(200, visible);
    }
    return json(404, { error: "Unknown job action." });
  }

  async alarm() {
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
      await this.finish(job, { status: "failed", error: "The review was interrupted before it finished. Start a new one with start_review." });
      return;
    }
    job.attempted = true;
    job.status = "running";
    await st.put("job", job);
    const input = await st.get("input");
    let outcome;
    try {
      outcome = input ? await this.run(job.tier, input) : { status: "failed", error: "The review's input is missing. Start a new one." };
    } catch (e) {
      outcome = { status: "failed", error: `The review couldn't be completed: ${String(e?.message ?? e).slice(0, 200)}` };
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
          ...(input.subject ? { "x-caller-id": `chatgpt:${input.subject}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
      });
    } catch (e) {
      return { status: "failed", error: `Agent Referee didn't answer in time (${String(e?.message ?? e).slice(0, 120)}). Your free review wasn't used; try again.` };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const retry = Number(res.headers.get("retry-after")) || undefined;
      return {
        status: "failed",
        http_status: res.status,
        busy: res.status === 503 && !!data?.busy,
        ...(retry ? { retry_after_seconds: retry } : {}),
        error: res.status === 401 || res.status === 404 ? "The hosted server isn't connected to Agent Referee correctly (an operator problem). Nothing was used." : String(data?.error ?? `Agent Referee answered ${res.status}.`).slice(0, 600),
      };
    }
    const receipt = data?.receipt;
    const signed = await verifySignature(receipt, publicKeys(env)).catch(() => false);
    const check = await verifyReviewOutcome(receipt, { task: input.task, output: input.output, tier, ...(Array.isArray(input.panel) && input.panel.every((m) => typeof m === "string") ? { panel: input.panel } : {}) });
    const problems = [...(signed ? [] : ["The receipt's signature doesn't check out against Agent Referee's pinned key."]), ...check.problems];
    if (receipt?.payload?.funding !== "free") problems.push('The receipt doesn\'t say funding: "free".');
    if (problems.length) return { status: "failed", error: "Agent Referee's answer didn't pass the checks, so it isn't shown as a result.", problems };
    return {
      status: "done",
      review_id: data.review_id,
      verdict: data.result?.verdict,
      tally: data.result?.tally,
      votes: data.votes,
      free: data.free,
      receipt,
      checked: "The receipt's signature was checked against Agent Referee's pinned key, and it was confirmed to be about exactly the task and output that were sent.",
    };
  }
}
