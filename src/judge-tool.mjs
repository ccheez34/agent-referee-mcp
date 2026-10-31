// judge_match: a paid judge match between two agents (judge-2 or judge-3), off unless the owner switches it on
// (AGENT_REFEREE_JUDGE=on). Made for one owner's own sessions settling a dispute: the session that opens the match
// pays for both seats from the owner's wallet (an invite match), within its own daily cap counted per local day; the
// other session joins free with the link. Each submits its position, and the named panel's verdict comes back with
// a signed receipt. The verdict is advice: the owner decides.
import { randomBytes } from "node:crypto";
import { RefereeError, captureFetch, sha256Hex } from "agent-referee-client";
import { ToolError } from "./protocol.mjs";
import { validate } from "./validate.mjs";
import { usd } from "./store.mjs";

/** Price per seat, in micro-USDC (GET /pricing). The host pays both seats, and never more than twice this. */
export const JUDGE_SEAT_PRICES = { "judge-2": 200_000, "judge-3": 350_000 };
const PANEL_SIZE = { "judge-2": 2, "judge-3": 3 };
const companyOf = (m) => (m.includes("/") ? m.split("/")[0].toLowerCase() : m.toLowerCase().startsWith("claude") ? "anthropic" : "other");

const LABEL = { type: "string", pattern: "^[A-Za-z0-9_-]{1,32}$" };
const judgeSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["open", "join", "result"],
      description:
        'open: start a match and pay for both seats (needs the owner\'s wallet); returns an invite link at once, for the other agent. join: take the free seat with an invite link. result: get a match that was still running (job_id).',
    },
    tier: { type: "string", enum: ["judge-2", "judge-3"], description: `open and join. judge-2: two judges from two AI companies, both must agree or it's a mistrial (${usd(JUDGE_SEAT_PRICES["judge-2"])} a seat). judge-3: three judges from three companies, majority wins (${usd(JUDGE_SEAT_PRICES["judge-3"])} a seat). The opener pays both seats.` },
    panel: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 80 },
      minItems: 2,
      maxItems: 3,
      uniqueItems: true,
      description: "open and join: the judges both agents agreed on, as model ids (2 for judge-2, 3 for judge-3), each from a different AI company. Models: GET https://agentreferee.ai/judge. On join, it must match the invite's judges exactly.",
    },
    rules: { type: "string", minLength: 10, maxLength: 4000, description: "open and join: the question and the rules both agents agreed to, exactly. The judges decide by these. On join, it must match the invite's rules exactly." },
    seats: { type: "array", items: LABEL, minItems: 2, maxItems: 2, uniqueItems: true, description: 'open: the two seat labels, e.g. ["agent-a", "agent-b"].' },
    my_seat: { ...LABEL, description: "open: your seat (one of seats). You pay for both." },
    position: { type: "string", minLength: 1, maxLength: 6000, description: "open and join: your side, up to 6,000 characters. The judges read both sides." },
    title: { type: "string", maxLength: 200, description: "open: an optional short label stored in the receipt." },
    invite: { type: "string", maxLength: 500, description: "join: the invite link the opener sent you." },
    job_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$", description: "result: the job_id open or join returned." },
    invite_wait_minutes: { type: "integer", minimum: 1, maximum: 120, description: "open: how long to wait for the other agent to join (default 30). Nothing is charged until it does." },
    wait_seconds: { type: "integer", minimum: 0, maximum: 300, description: "join and result: how long this call waits for the verdict (default 45; keep it under 60 through a link that gives up after 60 seconds). open returns at once with the invite." },
  },
  additionalProperties: false,
};

/** Why a named panel can't be used, or null. Exactly the tier's size, distinct companies, none the owner excludes. */
export function judgePanelProblem(tier, panel, exclude = []) {
  const n = PANEL_SIZE[tier];
  if (!Array.isArray(panel) || panel.length !== n || !panel.every((m) => typeof m === "string" && m.trim() === m && m.length > 0))
    return `${tier} needs a named panel of exactly ${n} model ids (the judges both agents agreed on).`;
  if (new Set(panel).size !== n) return "The panel names the same model twice.";
  const companies = panel.map(companyOf);
  if (companies.includes("other")) return `Name each judge by its full model id with its company, e.g. "openai/gpt-6-luna" (got ${panel.join(", ")}).`;
  if (new Set(companies).size !== n) return `Each judge must be from a different AI company (got ${companies.join(", ")}).`;
  const barred = panel.filter((m) => exclude.includes(companyOf(m)));
  if (barred.length) return `The owner's settings exclude ${barred.map((m) => `${m} (${companyOf(m)})`).join(", ")} from judge panels (AGENT_REFEREE_JUDGE_EXCLUDE).`;
  return null;
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
const panelOf = (st) => (st?.judge?.panel ? st.judge.panel.map((p) => p?.model) : st?.judge?.model ? [st.judge.model] : []);

/**
 * @param {object} deps
 * @param {{ url?: string, privateKey?: string, judge: { dailyLimitMicro: number, exclude: string[], timeZone: string } }} deps.config
 * @param {string[]} deps.pinned the service's pinned receipt keys
 * @param {(opts: object) => object} deps.makeClient
 * @param {(privateKey: string, maxMicro: number, opts?: { baseFetch?: typeof fetch }) => Promise<{ fetch: typeof fetch, wallet?: string, lastSettlement: () => object|null }>} deps.makePayingFetch
 * @param {import("./store.mjs").Budget} deps.judgeBudget
 * @param {import("./store.mjs").ReceiptStore} deps.receipts
 * @param {(e: unknown, o?: object) => string} deps.explain
 */
export function createJudgeTool({ config, pinned, makeClient, makePayingFetch, judgeBudget, receipts, explain, baseFetch, pollMs = 2000 }) {
  const jc = config.judge;
  const jobs = new Map();
  const DEFAULT_WAIT_S = 45;
  const newJobId = () => `jm_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;

  const check = (args) => {
    const problems = validate(args, judgeSchema);
    if (problems.length) throw new ToolError(`Invalid arguments: ${problems.join(" ")}`);
  };
  const need = (args, names, action) => {
    const missing = names.filter((k) => args[k] === undefined);
    if (missing.length) throw new ToolError(`${action} needs ${missing.join(", ")}. Nothing was charged.`);
  };

  async function savePending(job, extra = {}) {
    try {
      await receipts.save("pending", job.id, {
        summary: `${job.tier} judge match (${job.role}) ${job.status}`,
        job_id: job.id,
        role: job.role,
        status: job.status,
        tier: job.tier,
        match_id: job.match_id ?? null,
        started_at: job.started_at,
        rules_sha256: job.rules_sha256,
        note: 'Saved before anything was paid or submitted. If status is still "running" and no match receipt followed, the server stopped mid-match: check the match at GET /matches/<match_id>.',
        ...extra,
      });
      return null;
    } catch (e) {
      return `Couldn't update the pending record ${job.id} (${String(e?.message ?? e).slice(0, 200)}); the match's own receipt is unaffected.`;
    }
  }

  /** Saves the receipt and describes the verdict. */
  async function finish(job, st, args, extra = {}) {
    if (st.phase !== "done" || !st.receipt) throw new ToolError(`The match ended without a verdict (phase: ${st.phase}). ${String(st.error ?? "").slice(0, 300)}`.trim(), { match_id: job.match_id });
    const problems = [...(st.check?.problems ?? [])];
    const p = st.receipt.payload ?? {};
    const judged = panelOf({ judge: p.proof?.judge }).length ? panelOf({ judge: p.proof?.judge }) : panelOf(st);
    if (!sameSet(judged, args.panel)) problems.push(`The judges in the receipt (${judged.join(", ") || "none"}) aren't the panel you agreed on (${args.panel.join(", ")}).`);
    if (p.tier !== job.tier) problems.push(`The receipt is for ${p.tier}, not ${job.tier}.`);
    if (p.demo === true) problems.push("The receipt is a demo receipt, not a paid result.");
    const ok = st.check?.ok === true && problems.length === 0;
    const r = st.result ?? {};
    const youWon = r.winner === job.seat;
    const record = {
      summary: `${job.tier} ${r.mistrial ? "mistrial" : `winner ${r.winner ?? "none"}`} (${job.role}, seat ${job.seat})${args.title ? ` — ${args.title}` : ""}`,
      match_id: job.match_id,
      tier: job.tier,
      my_seat: job.seat,
      result: r,
      receipt: st.receipt,
      acks: st.acks ?? [],
      check: { ok, problems },
      ...extra,
    };
    let receiptFile = null;
    let saveProblem = null;
    try {
      receiptFile = await receipts.save("match", job.match_id, record);
    } catch (e) {
      saveProblem = `Couldn't save the receipt to disk (${String(e?.message ?? e).slice(0, 200)}). Save the receipt and acks from this response yourself.`;
    }
    const advisory = typeof p.advisory === "string" ? p.advisory : null;
    return {
      summary: `${ok ? "" : "WARNING: the receipt check FAILED (see check.problems); don't rely on this verdict. "}${r.mistrial ? "Mistrial: no fair verdict was possible; it goes back to the owner." : `${r.winner ?? "Nobody"} won. ${youWon ? "You won." : "You didn't win."}`} The verdict is advice: the owner decides.`,
      match_id: job.match_id,
      tier: job.tier,
      my_seat: job.seat,
      winner: r.winner ?? null,
      you_won: youWon,
      ...(r.mistrial ? { mistrial: true, mistrial_code: r.mistrial_code ?? null } : {}),
      votes: r.votes ?? r.panel ?? undefined,
      check: { ok, problems },
      ...(advisory ? { advisory } : {}),
      ...(p.human_review ? { human_review: p.human_review } : {}),
      receipt: st.receipt,
      acks: st.acks ?? [],
      receipt_file: receiptFile,
      ...(saveProblem ? { save_problem: saveProblem } : {}),
      ...extra,
    };
  }

  /** Waits up to `seconds` for the job; returns its result, throws its error, or says it's still running. */
  async function awaitJob(job, seconds) {
    if (job.status === "running" && seconds > 0) {
      let timer;
      await Promise.race([job.settled, new Promise((r) => (timer = setTimeout(r, seconds * 1000)))]);
      clearTimeout(timer);
    }
    if (job.status === "done") return { ...job.result, job_id: job.id, status: "done" };
    if (job.status === "failed") throw job.error instanceof ToolError ? job.error : new ToolError(String(job.error?.message ?? job.error));
    return {
      summary: `The ${job.tier} match is still running (${job.stage}). Call judge_match with action "result" and job_id "${job.id}" in a little while; nothing more is charged.${job.invite ? " Send the invite link to the other agent if you haven't." : ""}`,
      job_id: job.id,
      status: "running",
      stage: job.stage,
      tier: job.tier,
      match_id: job.match_id ?? null,
      ...(job.invite ? { invite: job.invite } : {}),
      started_at: job.started_at,
    };
  }

  function track(job, run) {
    job.settled = run().then(
      async (result) => {
        job.status = "done";
        job.result = result;
        const also = await savePending(job, { match_receipt: job.match_id });
        if (also) job.result.pending_record_problem = also;
      },
      async (e) => {
        job.status = "failed";
        job.error = e;
        await savePending(job, { error: String(e?.message ?? e).slice(0, 500) });
      },
    );
    jobs.set(job.id, job);
    for (const [id, j] of jobs) {
      if (jobs.size <= 100) break;
      if (j.status !== "running") jobs.delete(id);
    }
  }

  // ---------- open: create an invite match and pay for both seats ----------
  async function open(args) {
    need(args, ["tier", "panel", "rules", "seats", "my_seat", "position"], "open");
    for (const k of ["invite", "job_id"]) if (args[k] !== undefined) throw new ToolError(`open doesn't take ${k}. Nothing was charged.`);
    if (!args.seats.includes(args.my_seat)) throw new ToolError(`my_seat must be one of the seats (${args.seats.join(", ")}). Nothing was charged.`);
    if (!args.rules.trim() || args.rules.trim().length < 10) throw new ToolError("rules must be at least 10 characters of actual text. Nothing was charged.");
    if (!args.position.trim()) throw new ToolError("position is empty. Nothing was charged.");
    const pe = judgePanelProblem(args.tier, args.panel, jc.exclude);
    if (pe) throw new ToolError(`${pe} Nothing was charged.`);
    if (!config.privateKey) throw new ToolError("Opening a judge match pays for both seats, and no wallet is set up for this server (AGENT_REFEREE_PRIVATE_KEY). The owner sets it in the MCP server's settings. The other agent can open it instead, or you can join theirs free. Nothing was charged.");
    if (!/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) throw new ToolError("AGENT_REFEREE_PRIVATE_KEY is set but isn't a 0x-prefixed 64-character hex key. The owner needs to fix it in the MCP server settings. Nothing was charged.");
    const price = 2 * JUDGE_SEAT_PRICES[args.tier];

    // The cap first: refused here, nothing is created or signed.
    let hold;
    try {
      hold = await judgeBudget.reserve(price);
    } catch (e) {
      throw new ToolError(String(e?.message ?? e));
    }
    const warnings = [];
    let settled = false;
    const settle = async (charged) => {
      if (settled) return;
      settled = true;
      try {
        await (charged ? hold.commit() : hold.release());
      } catch (e) {
        warnings.push(`Couldn't update the judge-match spend record (${String(e?.message ?? e).slice(0, 200)}). The daily cap counts this match as spent to be safe.`);
      }
    };

    const job = { id: newJobId(), role: "host", status: "running", stage: "creating the match", tier: args.tier, seat: args.my_seat, started_at: new Date().toISOString(), rules_sha256: await sha256Hex(args.rules) };
    let payer, ref, created;
    try {
      const capture = captureFetch(baseFetch ?? globalThis.fetch.bind(globalThis));
      payer = await makePayingFetch(config.privateKey, price, { baseFetch: capture.fetch });
      ref = makeClient({ url: config.url, fetch: payer.fetch, capture, publicKeys: pinned, pollMs });
      created = await ref.create({ tier: args.tier, seats: args.seats, rules: args.rules, panel: args.panel, ...(args.title ? { title: args.title } : {}), hostPays: args.my_seat });
    } catch (e) {
      await settle(false);
      throw new ToolError(`Couldn't open the match: ${explain(e, { paid: true })}`.replace(/Nothing was charged\.\s*Nothing was charged\./, "Nothing was charged."));
    }
    const invite = created?.invite?.url;
    job.match_id = created?.match_id;
    if (!job.match_id || typeof invite !== "string") {
      await settle(false);
      throw new ToolError("The service created the match but sent no invite link, so the other agent can't join. Nothing was charged.");
    }
    // The judges are drawn and shown before anyone pays: check them now.
    const shown = panelOf(created);
    if (shown.length && !sameSet(shown, args.panel)) {
      await settle(false);
      throw new ToolError(`The service's judges for this match (${shown.join(", ")}) aren't the panel you named. Nothing was charged; don't use this match.`, { match_id: job.match_id });
    }
    job.invite = invite;
    job.stage = "waiting for the other agent to join";
    const extraOk = await savePending(job, { invite_sent: true });
    if (extraOk) warnings.push(extraOk);

    track(job, async () => {
      let seat;
      try {
        seat = await ref.join(job.match_id, args.my_seat, { inviteWaitMs: (args.invite_wait_minutes ?? 30) * 60_000 });
      } catch (e) {
        // A definite answer (any HTTP error, including the other agent never joining) means the payment never
        // settled. No answer at all is ambiguous: keep it counted, so the cap errs on the safe side.
        const dropped = !(e instanceof RefereeError) && !/exceeds maximum|max(imum)? ?value|amount exceeds/i.test(String(e?.message ?? e));
        await settle(dropped);
        if (e instanceof RefereeError && e.status === 408) throw new ToolError(`The other agent didn't join within ${args.invite_wait_minutes ?? 30} minutes. Nothing was charged. Open a new match when you're both ready.`, { match_id: job.match_id });
        throw new ToolError(explain(e, { paid: true, dropped }), { match_id: job.match_id, wallet: payer.wallet ?? null, ...(warnings.length ? { warnings } : {}) });
      }
      // Both seats are filled, so the payment settled.
      await settle(true);
      job.stage = "waiting for both positions and the verdict";
      const settlement = payer.lastSettlement?.() ?? null;
      const paid = { amount: usd(price), for: "both seats", wallet: payer.wallet ?? null, transaction: settlement?.transaction ?? null };
      let st;
      try {
        st = await seat.submit(args.position);
      } catch (e) {
        throw new ToolError(`Your seat is paid, but submitting or judging failed: ${explain(e)}. The match id is ${job.match_id}; a paid match that can't be judged goes on the operator's refund list.`, { match_id: job.match_id, paid });
      }
      const today = await judgeBudget.status().catch(() => null);
      return finish(job, st, args, { paid, ...(warnings.length ? { warnings } : {}), ...(today ? { judge_spend_today: `${usd(today.spent_micro)} of ${usd(today.limit_micro)} (${jc.timeZone} day)` } : {}) });
    });

    return {
      summary: `Match opened (${args.tier}, ${usd(price)} for both seats, charged only once the other agent joins). Send the invite link to the other agent: it calls judge_match with action "join", this link, the same tier, panel and rules, and its own position. Then call judge_match with action "result" and job_id "${job.id}".`,
      job_id: job.id,
      status: "running",
      stage: job.stage,
      match_id: job.match_id,
      invite,
      price: usd(price),
      ...(warnings.length ? { warnings } : {}),
      note: "Anyone holding the invite link can take the other seat: send it only to the agent you mean.",
    };
  }

  // ---------- join: take the free seat of an invite match ----------
  async function join(args) {
    need(args, ["invite", "tier", "panel", "rules", "position"], "join");
    for (const k of ["seats", "my_seat", "title", "job_id", "invite_wait_minutes"]) if (args[k] !== undefined) throw new ToolError(`join doesn't take ${k}: the match's own settings are used, and checked against what you agreed.`);
    if (!args.position.trim()) throw new ToolError("position is empty.");
    const pe = judgePanelProblem(args.tier, args.panel, jc.exclude);
    if (pe) throw new ToolError(pe);
    const ref = makeClient({ url: config.url, publicKeys: pinned, pollMs });
    let inv;
    try {
      inv = await ref.openInvite(args.invite);
    } catch (e) {
      throw new ToolError(`Couldn't read the invite: ${explain(e)}`);
    }
    const m = inv?.match ?? {};
    // Accept only exactly what was agreed: the receipt is about these settings.
    const wrong = [];
    if (m.tier !== args.tier) wrong.push(`the tier is ${m.tier}, not ${args.tier}`);
    if (m.rules !== args.rules) wrong.push("the rules aren't exactly the ones you agreed to");
    if (!sameSet(panelOf(m), args.panel)) wrong.push(`the judges are ${panelOf(m).join(", ") || "not shown"}, not ${args.panel.join(", ")}`);
    if (m.demo === true) wrong.push("it's a demo match");
    const barred = panelOf(m).filter((x) => jc.exclude.includes(companyOf(x)));
    if (barred.length) wrong.push(`the owner's settings exclude ${barred.join(", ")}`);
    const guest = (m.seats ?? []).map((x) => x?.seat ?? x).find((x) => x !== m.host_pays);
    if (!m.host_pays || !guest) wrong.push("it isn't an invite match");
    if (wrong.length) throw new ToolError(`Not joining: ${wrong.join("; ")}. Nothing was joined.`, { match_id: m.match_id ?? null });

    const job = { id: newJobId(), role: "guest", status: "running", stage: "joining", tier: args.tier, seat: guest, match_id: m.match_id, started_at: new Date().toISOString(), rules_sha256: await sha256Hex(args.rules) };
    const pend = await savePending(job);
    track(job, async () => {
      let seat;
      try {
        seat = await ref.acceptInvite(args.invite, { inviteWaitMs: 30 * 60_000 });
      } catch (e) {
        throw new ToolError(`Couldn't take the seat: ${explain(e)}. Nothing was charged (your seat is free).`, { match_id: job.match_id });
      }
      job.stage = "waiting for both positions and the verdict";
      let st;
      try {
        st = await seat.submit(args.position);
      } catch (e) {
        throw new ToolError(`Submitting or judging failed: ${explain(e)}. Your seat was free. The match id is ${job.match_id}.`, { match_id: job.match_id });
      }
      return finish(job, st, args, { free_seat: "The other agent paid for both seats.", ...(pend ? { pending_record_problem: pend } : {}) });
    });
    return awaitJob(job, args.wait_seconds ?? DEFAULT_WAIT_S);
  }

  async function result(args) {
    need(args, ["job_id"], "result");
    const job = jobs.get(args.job_id);
    if (!job) {
      const saved = await receipts.get(args.job_id).catch(() => null);
      if (saved) return { ...saved, summary: `That job isn't in this server's memory any more (the server restarted, or the job is old); its saved record is below.${saved.match_id ? ` Look for the match receipt ${saved.match_id} in saved_receipts, or GET /matches/${saved.match_id}.` : ""}` };
      throw new ToolError(`No judge match job ${args.job_id} on this server. Check saved_receipts.`);
    }
    return awaitJob(job, args.wait_seconds ?? DEFAULT_WAIT_S);
  }

  async function handler(args) {
    check(args ?? {});
    if (args.action === "open") return open(args);
    if (args.action === "join") return join(args);
    return result(args);
  }

  return {
    name: "judge_match",
    title: "Settle a dispute with a paid judge match (judge-2 or judge-3)",
    description:
      `PAID, switched on by the owner. Settles a real disagreement between two agents with independent AI judges from different companies, by rules both agreed to; returns the verdict and a signed receipt. The verdict is advice: the owner decides. One agent opens the match (action "open") and pays for BOTH seats from the owner's wallet (judge-2 ${usd(2 * JUDGE_SEAT_PRICES["judge-2"])}, judge-3 ${usd(2 * JUDGE_SEAT_PRICES["judge-3"])} in all), charged only once the other agent joins, within this server's own daily cap for judge matches (${usd(jc.dailyLimitMicro)} per ${jc.timeZone} day). It gets an invite link to send to the other agent, which joins free (action "join") with the same tier, panel and rules. Both agents agree on the tier, the named panel (exactly 2 or 3 model ids from different companies) and the rules before anyone opens. Positions go to the AI companies running the judges: leave out secrets and personal data. A match can take minutes: use action "result" with the job_id.`,
    inputSchema: judgeSchema,
    annotations: { title: "Paid judge match", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler,
  };
}
