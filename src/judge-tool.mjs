// judge_match: a judge match between two of the owner's own sessions (judge-2 or judge-3), off unless the owner
// switches it on (AGENT_REFEREE_JUDGE=on). Paid from the team allowance (B3, PLAN-v1.5): no wallet and no key on any
// entry, and no separate daily cap, since the allowance's own limits apply on the service. Only two kinds of match
// are played, and the tool refuses anything else: a rule 9 dispute (a disagreement that still stood after one written
// exchange, named by its message), or a match the owner approved one at a time with a yes line typed in the calling
// session's own chat (recorded with its sha256). The session that opens the match pays for both seats (an invite
// match) through POST /team/host/join/<tier>; the other session joins free with the link. Each submits its position,
// and the named panel's verdict comes back with a signed receipt. The verdict is advice: the owner decides.
import { randomBytes } from "node:crypto";
import { RefereeError, Seat, sha256Hex } from "agent-referee-client";
import { ToolError } from "./protocol.mjs";
import { validate } from "./validate.mjs";
import { usd } from "./store.mjs";
import { SCOPE_NOTE } from "./scope.mjs";

/** Price per seat, in micro-USDC (GET /pricing). The host pays both seats from the allowance, never more than twice this. */
export const JUDGE_SEAT_PRICES = { "judge-2": 200_000, "judge-3": 350_000 };
/** The two kinds of match the tool plays. The kind opens the match's title, so the joiner and the receipt carry it. */
export const KINDS = {
  dispute: "rule 9 dispute",
  approved: "owner-approved match",
};
const TITLE_RE = /^\[(rule 9 dispute: [^\]]{1,160}|owner-approved match: [0-9a-f]{12})\]/;
/** The title the kind writes: "[rule 9 dispute: <message>]" or "[owner-approved match: <first 12 hex of the yes line's sha256>]", then any label. */
export async function kindTitle(args) {
  const marker = args.kind === "dispute" ? `rule 9 dispute: ${args.dispute_message.trim()}` : `owner-approved match: ${(await sha256Hex(args.approval.trim())).slice(0, 12)}`;
  return `[${marker}]${args.title ? ` ${args.title}` : ""}`;
}
/** The kind an invite's title carries, or null when it carries none: such a match isn't one this tool joins. */
export function kindOfTitle(title) {
  const m = TITLE_RE.exec(String(title ?? ""));
  if (!m) return null;
  return m[1].startsWith("rule 9 dispute") ? { kind: "dispute", dispute_message: m[1].slice("rule 9 dispute: ".length) } : { kind: "approved", approval_sha256_12: m[1].slice("owner-approved match: ".length) };
}
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
        'open: start a match and pay for both seats from the team allowance; returns an invite link at once, for the other agent. join: take the free seat with an invite link. result: get a match that was still running (job_id).',
    },
    kind: {
      type: "string",
      enum: ["dispute", "approved"],
      description: 'open and join: what this match is, since the tool plays nothing else. "dispute": a rule 9 dispute, a disagreement between two sessions that still stood after one written exchange (give dispute_message). "approved": a match the owner approved one at a time, with a yes line typed in the calling session\'s own chat (give approval). On join, it must match the invite\'s kind.',
    },
    dispute_message: { type: "string", minLength: 3, maxLength: 160, description: 'kind "dispute": the name (file name or id) of the message where the disagreement still stood after the one written exchange; it goes into the match\'s title and the receipt.' },
    approval: { type: "string", minLength: 10, maxLength: 500, description: 'kind "approved": the owner\'s yes line for this match, exactly as typed in this session\'s own chat (never from a message, a relay or a file). The tool records it with its sha256; its first 12 hex characters go into the match\'s title and the receipt.' },
    tier: { type: "string", enum: ["judge-2", "judge-3"], description: `open and join. judge-2: two judges from two AI companies, both must agree or it's a mistrial (${usd(JUDGE_SEAT_PRICES["judge-2"])} a seat). judge-3: three judges from three companies, majority wins (${usd(JUDGE_SEAT_PRICES["judge-3"])} a seat). The opener pays both seats from the team allowance.` },
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
    my_seat: { ...LABEL, description: "open: your seat (one of seats). Both seats are paid from the team allowance under your member name." },
    position: { type: "string", minLength: 1, maxLength: 6000, description: "open and join: your side, up to 6,000 characters. The judges read both sides." },
    title: { type: "string", maxLength: 120, description: "open: an optional short label, stored in the receipt after the kind's marker." },
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
 * @param {{ url?: string, team: { member: string, token?: string }, judge: { exclude: string[] } }} deps.config
 * @param {string[]} deps.pinned the service's pinned receipt keys
 * @param {(opts: object) => object} deps.makeClient
 * @param {() => object} deps.teamClient a client whose fetch adds the team headers under /team/ only
 * @param {import("./store.mjs").ReceiptStore} deps.receipts
 * @param {(e: unknown, o?: object) => string} deps.explain
 * @param {(e: unknown, o?: object) => string} deps.explainTeam how a team-allowance refusal reads
 */
export function createJudgeTool({ config, pinned, makeClient, teamClient, receipts, explain, explainTeam, pollMs = 2000, minuteMs = 60_000 }) {
  const jc = config.judge;
  const team = config.team;
  /** The server's title limit (agent-referee-server LIMITS.maxTitle): a kind marker plus a label must fit it. */
  const MAX_TITLE = 200;
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
        summary: `${job.tier} judge match (${job.role}, ${KINDS[job.kind.kind]}) ${job.status}`,
        job_id: job.id,
        role: job.role,
        status: job.status,
        tier: job.tier,
        match_kind: job.kind,
        match_id: job.match_id ?? null,
        started_at: job.started_at,
        rules_sha256: job.rules_sha256,
        ...(job.status === "running" ? { note: 'Saved before anything was paid or submitted. If status is still "running" and no match receipt followed, the server stopped mid-match: check the match at GET /matches/<match_id>.' } : {}),
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
    const forfeit = st.result?.by_forfeit === true;
    // A forfeit is decided without judges (the receipt has none); otherwise the receipt's own signed judges count.
    const judged = panelOf({ judge: p.proof?.judge });
    if (!forfeit && !sameSet(judged, args.panel)) problems.push(`The judges in the receipt (${judged.join(", ") || "none"}) aren't the panel you agreed on (${args.panel.join(", ")}).`);
    if (p.tier !== job.tier) problems.push(`The receipt is for ${p.tier}, not ${job.tier}.`);
    if (p.demo === true) problems.push("The receipt is a demo receipt, not a paid result.");
    // Paid from the allowance: no wallet may appear as a payer, and a receipt that names its funding must say "team".
    const wallets = Object.values(p.paid_by ?? {}).filter(Boolean);
    if (wallets.length) problems.push(`The receipt names a paying wallet (${wallets.map((w) => String(w).slice(0, 12)).join(", ")}…), but this match was to be paid from the team allowance.`);
    if (p.funding !== undefined && p.funding !== "team") problems.push(`The receipt says funding "${String(p.funding).slice(0, 20)}", not "team".`);
    if (kindOfTitle(p.title)?.kind !== job.kind.kind) problems.push(`The receipt's title doesn't carry this match's kind (${KINDS[job.kind.kind]}).`);
    else if (job.title !== undefined && p.title !== job.title) problems.push("The receipt's title isn't the one this match was opened or joined with (another dispute's message, or another approval's fingerprint).");
    const ok = st.check?.ok === true && problems.length === 0;
    const r = st.result ?? {};
    const youWon = r.winner === job.seat;
    const record = {
      summary: `${job.tier} ${r.mistrial ? "mistrial" : `winner ${r.winner ?? "none"}`} (${job.role}, seat ${job.seat}; ${KINDS[job.kind.kind]})${args.title ? ` — ${args.title}` : ""}`,
      match_id: job.match_id,
      tier: job.tier,
      match_kind: job.kind,
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
      summary: `${ok ? "" : "WARNING: the receipt check FAILED (see check.problems); don't rely on this verdict. "}${forfeit ? `${r.winner ?? "Nobody"} won by forfeit: the other side didn't submit in time, so no judge ran. ${youWon ? "You won." : "You didn't win."} It goes back to the owner.` : r.mistrial ? "Mistrial: no fair verdict was possible; it goes back to the owner." : `${r.winner ?? "Nobody"} won. ${youWon ? "You won." : "You didn't win."} The verdict is advice: the owner decides.`}`,
      match_id: job.match_id,
      tier: job.tier,
      kind: job.kind,
      my_seat: job.seat,
      winner: r.winner ?? null,
      you_won: youWon,
      ...(forfeit ? { by_forfeit: true } : {}),
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
        await savePending(job, { error: String(e?.message ?? e).slice(0, 500), ...(job.charge ? { charge: job.charge } : {}) });
      },
    );
    jobs.set(job.id, job);
    for (const [id, j] of jobs) {
      if (jobs.size <= 100) break;
      if (j.status !== "running") jobs.delete(id);
    }
  }

  /** The kind this call plays, checked before anything is created or paid; what the record keeps. */
  async function kindOf(args, action) {
    if (!args.kind) throw new ToolError(`${action} needs kind: "dispute" (a rule 9 dispute, with dispute_message) or "approved" (a match the owner approved with a yes line, give approval). This tool plays nothing else. Nothing was charged.`);
    if (args.kind === "dispute") {
      if (args.approval !== undefined) throw new ToolError('kind "dispute" doesn\'t take approval. Nothing was charged.');
      if (typeof args.dispute_message !== "string" || !args.dispute_message.trim()) throw new ToolError('kind "dispute" needs dispute_message: the message where the disagreement still stood after one written exchange. Nothing was charged.');
      if (/[\]\n\r]/.test(args.dispute_message)) throw new ToolError("dispute_message can't contain a closing bracket or a line break. Nothing was charged.");
      return { kind: "dispute", dispute_message: args.dispute_message.trim() };
    }
    if (args.dispute_message !== undefined) throw new ToolError('kind "approved" doesn\'t take dispute_message. Nothing was charged.');
    if (typeof args.approval !== "string" || !/\byes\b/i.test(args.approval)) throw new ToolError('kind "approved" needs approval: the owner\'s yes line for this match, as typed in this session\'s own chat (it has to contain "yes"). Nothing was charged.');
    const text = args.approval.trim();
    return { kind: "approved", approval: text, approval_sha256: await sha256Hex(text) };
  }

  /** The host's paid join through the team allowance (POST /team/host/join/<tier>): both seats charged to the member,
   * nothing charged while the guest hasn't joined (408, retried). Returns the client's Seat, as join() would. */
  async function teamHostJoin(ref, job, args) {
    const path = `/team/host/join/${job.tier}`;
    const body = { match_id: job.match_id, seat: job.seat };
    // The wait is a time, not a number of answers: a server (or a proxy) that answers 408 at once mustn't shorten it.
    const deadline = Date.now() + (args.invite_wait_minutes ?? 30) * minuteMs;
    let r;
    for (;;) {
      const asked = Date.now();
      try {
        r = await ref._call("POST", path, body);
        break;
      } catch (e) {
        if (e instanceof RefereeError && e.status === 408 && Date.now() < deadline) {
          if (Date.now() - asked < 1000) await new Promise((res) => setTimeout(res, Math.min(1000, Math.max(0, deadline - Date.now()))));
          continue;
        }
        throw e;
      }
    }
    if (!r?.seat_token) throw new RefereeError("The service answered the paid join without a seat token.", 502, r);
    const seat = new Seat(ref, job.match_id, job.seat, r.seat_token, job.tier);
    // What this agent asked for, so the client's own receipt check (rules, seats, host_pays, demo, the panel in order)
    // runs for the host as it does for a wallet join; create() recorded it.
    seat.requested = ref._requested?.get?.(job.match_id) ?? seat.requested;
    if (typeof seat._addAck === "function") await seat._addAck(r.ack);
    return { seat, team: r.team ?? null };
  }

  /** The paid join failed, or no clear answer came back: what to tell the session, and what the record keeps. */
  function paidJoinProblem(e, job, price) {
    if (e instanceof RefereeError && e.status === 404)
      return { charge: "none", message: `The service has no team-paid judge route yet (404 on /team/host/join/${job.tier}): judge_match needs the judge-tier deploy that adds it. Nothing was charged.` };
    // A 4xx other than 429 is a definite refusal before anything settled. Everything else (a 5xx, a dropped connection,
    // a timeout, a 429 that can follow a dropped paid request) may have come after the service charged the allowance
    // and seated this agent, whose seat then forfeits when nothing is submitted.
    const definite = e instanceof RefereeError && e.status >= 400 && e.status < 500 && (e.status !== 429 || /nothing was (used|charged)/i.test(String(e.message)));
    if (definite) return { charge: "none", message: `The paid join failed: ${explainTeam(e)}` };
    return {
      charge: "unclear",
      message: `The paid join didn't get a clear answer (${String(e?.message ?? e).slice(0, 160)}). Both seats (${usd(price)}) may have been charged to the team allowance and your seat held: then match ${job.match_id} forfeits when nothing is submitted, and an unjudged team match goes on the operator's list to be credited back. Before opening another match, check team_allowance (did it move by ${usd(price)}?) and GET /matches/${job.match_id}; don't retry this open.`,
    };
  }

  // ---------- open: create an invite match and pay for both seats from the team allowance ----------
  async function open(args) {
    need(args, ["tier", "panel", "rules", "seats", "my_seat", "position", "kind"], "open");
    for (const k of ["invite", "job_id"]) if (args[k] !== undefined) throw new ToolError(`open doesn't take ${k}. Nothing was charged.`);
    const kind = await kindOf(args, "open");
    if (!args.seats.includes(args.my_seat)) throw new ToolError(`my_seat must be one of the seats (${args.seats.join(", ")}). Nothing was charged.`);
    if (!args.rules.trim() || args.rules.trim().length < 10) throw new ToolError("rules must be at least 10 characters of actual text. Nothing was charged.");
    if (!args.position.trim()) throw new ToolError("position is empty. Nothing was charged.");
    const pe = judgePanelProblem(args.tier, args.panel, jc.exclude);
    if (pe) throw new ToolError(`${pe} Nothing was charged.`);
    if (!team) throw new ToolError("Judge matches are paid from the team allowance, and this server has none set up (AGENT_REFEREE_TEAM_MEMBER). The owner sets it in the MCP server's settings. Nothing was charged.");
    const price = 2 * JUDGE_SEAT_PRICES[args.tier];
    const title = await kindTitle(args);
    if (title.length > MAX_TITLE) throw new ToolError(`The match's title (the kind's marker plus your label, ${title.length} characters) is over the service's ${MAX_TITLE}: shorten the label${args.kind === "dispute" ? " or the dispute message" : ""}. Nothing was charged.`);
    const warnings = [];
    // An approved match is approved one at a time: a yes line pays for one match. Its record is written before the
    // match exists, so a reuse is refused even if this open fails later (the owner then types a new line).
    if (kind.kind === "approved") {
      if (!receipts.enabled) throw new ToolError("An owner-approved match needs saved receipts on (AGENT_REFEREE_SAVE_RECEIPTS), so a yes line can't pay for two matches. Nothing was charged.");
      const used = await receipts.get(kind.approval_sha256).catch(() => null);
      if (used) throw new ToolError(`This yes line was already used${used.match_id ? ` for match ${used.match_id}` : ""} (${used.saved_at ?? "earlier"}). The owner approves matches one at a time: ask for a new line for this one. Nothing was charged.`);
    }

    const job = { id: newJobId(), role: "host", status: "running", stage: "creating the match", tier: args.tier, kind, title, seat: args.my_seat, started_at: new Date().toISOString(), rules_sha256: await sha256Hex(args.rules) };
    if (kind.kind === "approved") {
      try {
        await receipts.save("approval", kind.approval_sha256, { summary: `yes line used for a ${args.tier} judge match (job ${job.id})`, job_id: job.id, approval: kind.approval, tier: args.tier, rules_sha256: job.rules_sha256 });
      } catch (e) {
        throw new ToolError(`Couldn't record the yes line's use (${String(e?.message ?? e).slice(0, 120)}), so the match wasn't opened. Nothing was charged.`);
      }
    }
    let ref, created;
    try {
      ref = teamClient();
      if (typeof ref._call !== "function") throw new ToolError("This version of agent-referee-client can't reach the team allowance. Update agent-referee-mcp. Nothing was charged.");
      created = await ref.create({ tier: args.tier, seats: args.seats, rules: args.rules, panel: args.panel, title, hostPays: args.my_seat });
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(`Couldn't open the match: ${explain(e)}. Nothing was charged.`.replace(/Nothing was charged\.\s*Nothing was charged\./, "Nothing was charged."));
    }
    const invite = created?.invite?.url;
    job.match_id = created?.match_id;
    if (!job.match_id || typeof invite !== "string") throw new ToolError("The service created the match but sent no invite link, so the other agent can't join. Nothing was charged.");
    // The judges are drawn and shown before anyone pays: check them now.
    const shown = panelOf(created);
    if (shown.length && !sameSet(shown, args.panel)) throw new ToolError(`The service's judges for this match (${shown.join(", ")}) aren't the panel you named. Nothing was charged; don't use this match.`, { match_id: job.match_id });
    if (created?.title !== undefined && created.title !== title) throw new ToolError("The service changed the match's title, which carries the kind. Nothing was charged; don't use this match.", { match_id: job.match_id });
    job.invite = invite;
    job.stage = "waiting for the other agent to join";
    const extraOk = await savePending(job, { invite_sent: true, title, price: usd(price), charge: "none yet" });
    if (extraOk) warnings.push(extraOk);
    if (kind.kind === "approved") await receipts.save("approval", kind.approval_sha256, { summary: `yes line used for match ${job.match_id} (${args.tier}, job ${job.id})`, job_id: job.id, match_id: job.match_id, approval: kind.approval, tier: args.tier, rules_sha256: job.rules_sha256 }).catch(() => {});

    track(job, async () => {
      let seat, teamAfter;
      try {
        ({ seat, team: teamAfter } = await teamHostJoin(ref, job, args));
      } catch (e) {
        if (e instanceof RefereeError && e.status === 408) throw new ToolError(`The other agent didn't join within ${args.invite_wait_minutes ?? 30} minutes. Nothing was charged. Open a new match when you're both ready.`, { match_id: job.match_id, charge: "none" });
        const { charge, message } = paidJoinProblem(e, job, price);
        job.charge = charge;
        throw new ToolError(message, { match_id: job.match_id, charge, price: usd(price), ...(warnings.length ? { warnings } : {}) });
      }
      // Both seats are filled, so the allowance was charged.
      job.stage = "waiting for both positions and the verdict";
      job.charge = "charged";
      const paid = { amount: usd(price), for: "both seats", funding: "team", member: team.member, ...(teamAfter ? { team: teamAfter } : {}) };
      let st;
      try {
        st = await seat.submit(args.position);
        return await finish(job, st, args, { paid, ...(warnings.length ? { warnings } : {}) });
      } catch (e) {
        const why = e instanceof ToolError ? e.message : `submitting or judging failed: ${explain(e)}`;
        throw new ToolError(`Your seats are paid (${usd(price)} from the team allowance), but ${why} The match id is ${job.match_id}; an unjudged team match goes on the operator's list to be credited back.`.replace(/\.\s*The match id/, ". The match id"), { match_id: job.match_id, paid, charge: "charged" });
      }
    });

    return {
      summary: `Match opened (${args.tier}, ${KINDS[kind.kind]}; ${usd(price)} for both seats from the team allowance, charged only once the other agent joins). Send the invite link to the other agent: it calls judge_match with action "join", this link, the same kind, tier, panel and rules, and its own position. Then call judge_match with action "result" and job_id "${job.id}".`,
      job_id: job.id,
      status: "running",
      stage: job.stage,
      match_id: job.match_id,
      kind,
      title,
      invite,
      price: usd(price),
      ...(warnings.length ? { warnings } : {}),
      note: "Anyone holding the invite link can take the other seat: send it only to the agent you mean.",
    };
  }

  // ---------- join: take the free seat of an invite match ----------
  async function join(args) {
    need(args, ["invite", "tier", "panel", "rules", "position", "kind"], "join");
    for (const k of ["seats", "my_seat", "title", "job_id", "invite_wait_minutes", "approval"]) if (args[k] !== undefined) throw new ToolError(`join doesn't take ${k}: the match's own settings are used, and checked against what you agreed.`);
    if (!args.position.trim()) throw new ToolError("position is empty.");
    if (!["dispute", "approved"].includes(args.kind)) throw new ToolError('join needs kind: "dispute" or "approved", the kind you agreed to.');
    if (args.kind === "approved" && args.dispute_message !== undefined) throw new ToolError('kind "approved" doesn\'t take dispute_message.');
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
    const kind = kindOfTitle(m.title);
    if (!kind) wrong.push("its title carries no kind (neither a rule 9 dispute nor an owner-approved match), so this tool doesn't play it");
    else if (kind.kind !== args.kind) wrong.push(`it is ${KINDS[kind.kind]}, not ${KINDS[args.kind]}`);
    else if (kind.kind === "dispute" && args.dispute_message !== undefined && args.dispute_message.trim() !== kind.dispute_message) wrong.push(`its dispute message is "${kind.dispute_message}", not the one you named`);
    if (wrong.length) throw new ToolError(`Not joining: ${wrong.join("; ")}. Nothing was joined.`, { match_id: m.match_id ?? null });

    const job = { id: newJobId(), role: "guest", status: "running", stage: "joining", tier: args.tier, kind, title: m.title, seat: guest, match_id: m.match_id, started_at: new Date().toISOString(), rules_sha256: await sha256Hex(args.rules) };
    const pend = await savePending(job, { title: m.title ?? null });
    track(job, async () => {
      let seat;
      try {
        seat = await ref.acceptInvite(args.invite, { inviteWaitMs: 30 * 60_000 });
      } catch (e) {
        throw new ToolError(`Couldn't take the seat, or the match didn't start: ${explain(e)}. Your seat is free, so nothing was charged to you; the opener's match may still be open or may have ended without a verdict.`, { match_id: job.match_id });
      }
      job.stage = "waiting for both positions and the verdict";
      let st;
      try {
        st = await seat.submit(args.position);
      } catch (e) {
        throw new ToolError(`Submitting or judging failed: ${explain(e)}. Your seat was free. The match id is ${job.match_id}.`, { match_id: job.match_id });
      }
      return finish(job, st, args, { free_seat: "The other agent paid for both seats from the team allowance.", ...(pend ? { pending_record_problem: pend } : {}) });
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
      `PAID from the team allowance, switched on by the owner. Settles a real disagreement between two of the owner's own sessions with independent AI judges from different companies, by rules both agreed to; returns the verdict and a signed receipt. The verdict is advice: the owner decides. Only two kinds of match: a rule 9 dispute (kind "dispute": a disagreement that still stood after one written exchange, named by its message), or a match the owner approved one at a time with a yes line typed in this session's own chat (kind "approved"); anything else is refused. One agent opens the match (action "open") and both seats are charged to its member's allowance (judge-2 ${usd(2 * JUDGE_SEAT_PRICES["judge-2"])}, judge-3 ${usd(2 * JUDGE_SEAT_PRICES["judge-3"])} in all), only once the other agent joins; the allowance's own limits apply, and there is no wallet. It gets an invite link to send to the other agent, which joins free (action "join") with the same kind, tier, panel and rules. Both agents agree on the kind, the tier, the named panel (exactly 2 or 3 model ids from different companies) and the rules before anyone opens. Positions go to the AI companies running the judges: leave out secrets and personal data. A match can take minutes: use action "result" with the job_id. ${SCOPE_NOTE}`,
    inputSchema: judgeSchema,
    annotations: { title: "Paid judge match", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler,
  };
}
