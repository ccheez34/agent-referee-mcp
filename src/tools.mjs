// The Agent Referee tools: what each one accepts, what it tells the agent, and what it does.
import { RefereeError, Seat, verifyOutcome, verifyReviewOutcome, verifySignature } from "agent-referee-client";
import { ToolError } from "./protocol.mjs";
import { validate } from "./validate.mjs";
import { usd } from "./store.mjs";

/** What each paid call costs, in micro-USDC. Also the most a single request may pay, so a price change can never overcharge. */
export const PRICES = { review: 50_000, "review-3": 200_000, "review-3x2": 600_000, "review-3x3": 700_000 };
/** Multi-part tiers: how many pieces each takes. Paid only; three reviewers from three companies read every piece. */
export const MULTI_PIECES = { "review-3x2": 2, "review-3x3": 3 };
const companyOf = (m) => (m.includes("/") ? m.split("/")[0] : m.startsWith("claude") ? "anthropic" : "other");
/** The multi-part tiers take exactly three reviewers from three AI companies: "rotate", one set of 3 model ids, or up
 * to 5 such sets. Checked before any payment is set up (the service refuses the rest too, but only after the hold). */
function multiPanelProblem(panel) {
  if (panel === undefined || panel === "rotate") return null;
  const err = 'For review-3x2 and review-3x3, panel must be "rotate", 3 model ids from 3 different AI companies, or up to 5 such sets.';
  if (!Array.isArray(panel) || !panel.length) return err;
  const okSet = (x) => Array.isArray(x) && x.length === 3 && x.every((m) => typeof m === "string" && m.length > 0 && m.length <= 80) && new Set(x).size === 3 && new Set(x.map(companyOf)).size === 3;
  if (panel.every((x) => typeof x === "string")) return okSet(panel) ? null : err;
  return panel.length <= 5 && panel.every(okSet) ? null : err;
}
const reviewersLabel = (tier) => (tier === "review" ? "the reviewer" : "three reviewers");

const LABEL = { type: "string", pattern: "^[A-Za-z0-9_-]{1,32}$", description: "a seat label: letters, digits, _ or -, up to 32 characters" };
const RANDOM_TIERS = ["weighted", "rps", "rps-bo3"];
const MOVES = ["rock", "paper", "scissors"];

const seatsSchema = {
  type: "array",
  items: LABEL,
  minItems: 2,
  maxItems: 2,
  uniqueItems: true,
  description: 'Exactly two seat labels, e.g. ["alpha", "beta"].',
};
const weightsSchema = {
  type: "object",
  propertyNames: LABEL,
  additionalProperties: { type: "integer", minimum: 1, maximum: 1000 },
  minProperties: 2,
  maxProperties: 2,
  description: 'weighted tier only: the odds per seat as whole numbers, e.g. {"alpha": 70, "beta": 30}. Default 50/50.',
};
const titleSchema = { type: "string", maxLength: 200, description: "Optional short label stored in the receipt, e.g. \"Who drafts the summary\"." };
const modelId = { type: "string", minLength: 1, maxLength: 80 };

const panelSchema = {
  anyOf: [
    { type: "string", enum: ["rotate"] },
    { type: "array", items: modelId, minItems: 1, maxItems: 3, uniqueItems: true },
    { type: "array", items: { type: "array", items: modelId, minItems: 1, maxItems: 3, uniqueItems: true }, minItems: 1, maxItems: 5 },
  ],
  description:
    'Optional choice of reviewers. "rotate" picks one model per AI company at random; a list of model ids (1 for review, 3 for review-3) uses exactly those; a list of up to 5 such lists has one drawn at random. Leave it out for the default reviewers. Every panel uses different AI companies. Models: GET https://agentreferee.ai/reviewers',
};

const toFriendlySpec = ({ tier = "weighted", seats = ["alpha", "beta"], weights, title }) => {
  const spec = { tier, seats };
  if (tier === "weighted") spec.weights = weights ?? Object.fromEntries(seats.map((s) => [s, 50]));
  if (title) spec.title = title;
  return spec;
};

function checkWeights(args, seats) {
  if (args.weights === undefined) return;
  if ((args.tier ?? "weighted") !== "weighted") throw new ToolError("weights only apply to the weighted tier.");
  const keys = Object.keys(args.weights).sort();
  if (keys.join("|") !== [...seats].sort().join("|")) throw new ToolError(`weights must have exactly one entry per seat (${seats.join(", ")}).`);
}

function checkArgs(args, schema) {
  const problems = validate(args, schema);
  if (problems.length) throw new ToolError(`Invalid arguments: ${problems.join(" ")}`);
}

/** Turn a service or network error into a message an agent can act on. Never includes anything secret. */
function explain(e, { paid = false, demo = false, dropped = false, free = false } = {}) {
  const none = demo ? "This is a free demo, so nothing is ever charged." : free ? "Free reviews are never charged." : paid ? "Nothing was charged." : "";
  if (e instanceof RefereeError) {
    const msg = String(e.message || `HTTP ${e.status}`);
    const already = /nothing was charged|not charged/i.test(msg);
    if (e.status === 429) return `The service's limit was reached: ${msg}${already ? "" : ` ${none}`}`.trim();
    // 503 busy: the service refused before payment because its AI reviewers or judges are at capacity.
    if (e.status === 503 && (e.body?.busy || /^busy:/i.test(msg))) {
      const wait = Number(e.body?.retry_after_s);
      return `Agent Referee is busy right now, so it refused before taking payment. Nothing was charged and today's spending cap wasn't used.${Number.isFinite(wait) && wait > 0 ? ` Try again in about ${Math.round(wait)} s.` : " Try again in a minute."} (${msg.slice(0, 200)})`;
    }
    if (e.status === 402) return `Payment didn't go through: ${msg}. Check the wallet has enough USDC on Base. ${none}`.trim();
    return `${msg}${already || !none ? "" : ` ${none}`}`;
  }
  const msg = String(e?.message ?? e);
  if (/exceeds maximum|max(imum)? ?value|amount exceeds/i.test(msg))
    return `The service asked for more than this call's price cap, so the payment was refused before signing. Nothing was charged. Prices may have changed: update agent-referee-mcp. (${msg.slice(0, 200)})`;
  // A paid call that failed without an answer from the service: it may or may not have been charged.
  if (paid && dropped)
    return `The connection to Agent Referee failed before an answer came back (${msg.slice(0, 200)}). A payment only settles when a review completes, so if the request never got through, nothing was charged. If the connection dropped after the review finished, the wallet may have been charged without a receipt: run saved_receipts first, then check the wallet on basescan.org, and if there's a charge with no receipt, email hello@agentreferee.ai with the transaction hash to have the review re-run free. This call was counted against today's spending cap to be safe. Status page: https://stats.uptimerobot.com/dh6sVMvo3W`;
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network|socket|terminated/i.test(msg))
    return `The connection to Agent Referee failed (${msg.slice(0, 200)}). Status page: https://stats.uptimerobot.com/dh6sVMvo3W`;
  return msg.slice(0, 500);
}

function summarizeVotes(votes = []) {
  return votes.map((v) => {
    const out = { model: v.model, verdict: v.verdict, confidence: v.confidence, issues: v.issues ?? [], reasoning: v.reasoning };
    if (v.model_reported) out.model_reported = v.model_reported;
    if (v.scores) out.scores = v.scores;
    if (v.total !== undefined) out.total = v.total;
    if (v.issues_dropped) out.issues_dropped = v.issues_dropped;
    return out;
  });
}

function matchSummary(st, mySeat) {
  const r = st.result ?? {};
  const out = { phase: st.phase, winner: r.winner ?? null };
  if (mySeat) out.you_won = Seat.won(st, mySeat);
  if (r.by_forfeit) out.by_forfeit = true;
  if (r.forfeited?.length) out.forfeited = r.forfeited;
  if (r.no_result) out.no_result = r.no_result;
  if (r.weights) out.weights = r.weights;
  if (r.score) out.score = r.score;
  return out;
}

/**
 * Build the tool list.
 * @param {object} deps
 * @param {{ url?: string, publicKeys: string[], privateKey?: string, dailyLimitMicro: number }} deps.config
 * @param {(opts: object) => AgentReferee} deps.makeClient
 * @param {(privateKey: string, maxMicro: number) => Promise<{ fetch: typeof fetch, wallet?: string, lastSettlement: () => object|null }>} deps.makePayingFetch
 * @param {import("./store.mjs").Budget} deps.budget
 * @param {import("./store.mjs").ReceiptStore} deps.receipts
 */
export function createTools({ config, makeClient, makePayingFetch, budget, receipts }) {
  const pinned = config.publicKeys;
  const demoClient = (extra = {}) => makeClient({ url: config.url, demo: true, publicKeys: pinned, pollMs: 1000, ...extra });

  // ---------- demo_match: free, plays both seats in one call ----------
  const demoMatchSchema = {
    type: "object",
    properties: {
      tier: { type: "string", enum: RANDOM_TIERS, description: "weighted (a fair or weighted coin, the default), rps (one game of rock-paper-scissors, ties replay) or rps-bo3 (best of 3)." },
      seats: seatsSchema,
      weights: weightsSchema,
      title: titleSchema,
    },
    additionalProperties: false,
  };

  async function demoMatch(args, { progress }) {
    checkArgs(args, demoMatchSchema);
    const spec = toFriendlySpec(args);
    checkWeights(args, spec.seats);
    const ref = demoClient();
    try {
      progress("Creating a free demo match…");
      const match = await ref.create(spec);
      progress("Joining both seats…");
      const seats = await Promise.all(spec.seats.map((s) => ref.join(match.match_id, s)));
      progress("Committing and revealing…");
      const finished = await Promise.all(seats.map((s) => s.play()));
      const st = finished[0];
      const checks = Object.fromEntries(finished.map((f, i) => [spec.seats[i], { ok: f.check?.ok === true, problems: f.check?.problems ?? [] }]));
      return {
        summary: `Demo ${spec.tier} match: ${st.result?.winner ?? "no winner"} won.${Object.values(checks).every((c) => c.ok) ? " Both seats' checks passed." : " A check FAILED; see checks."}`,
        demo: true,
        match_id: st.match_id,
        tier: spec.tier,
        ...matchSummary(st),
        checks,
        receipt: st.receipt,
        what_this_shows:
          "Both seats were played by this one call, so this only shows how the protocol works. For a real decision between two agents, each agent calls tiebreak with the same key. Demo receipts are signed like paid ones but marked demo inside the signed part, so they can never pass for a paid result.",
      };
    } catch (e) {
      throw new ToolError(explain(e, { demo: true }));
    }
  }

  // ---------- tiebreak: your seat against another agent (free demo for now) ----------
  const tiebreakSchema = {
    type: "object",
    required: ["key", "my_seat"],
    properties: {
      key: {
        type: "string",
        pattern: "^[A-Za-z0-9._:-]{3,128}$",
        description: "A name both agents use for this decision, e.g. \"task-912-who-drafts\". Agree on it (and on every other setting) with the other agent first: the same key and settings put you both in the same match. 3-128 characters: letters, digits, . _ : -",
      },
      my_seat: { ...LABEL, description: "Your seat: one of the two seats. The other agent takes the other one." },
      seats: seatsSchema,
      tier: demoMatchSchema.properties.tier,
      weights: weightsSchema,
      title: titleSchema,
      move: { type: "string", enum: MOVES, description: "rps tiers only: your first move. Replays after a tie (and later games of rps-bo3) use random moves. Leave it out for random." },
      wait_seconds: { type: "integer", minimum: 15, maximum: 300, description: "How long to wait for the other agent to join (default 60). Waiting costs nothing." },
    },
    additionalProperties: false,
  };

  async function tiebreak(args, { progress }) {
    checkArgs(args, tiebreakSchema);
    const spec = toFriendlySpec(args);
    checkWeights(args, spec.seats);
    if (!spec.seats.includes(args.my_seat)) throw new ToolError(`my_seat must be one of the seats (${spec.seats.join(", ")}).`);
    if (args.move !== undefined && !spec.tier.startsWith("rps")) throw new ToolError("move only applies to the rps tiers.");
    spec.key = args.key;
    const wait = args.wait_seconds ?? 60;
    // The service holds each join open for 15 seconds; every retry is another 15-second wait.
    const ref = demoClient({ joinRetries: Math.max(0, Math.ceil(wait / 15) - 1) });
    let first = args.move;
    const chooseMove = spec.tier.startsWith("rps")
      ? () => {
          const m = first ?? MOVES[crypto.getRandomValues(new Uint8Array(1))[0] % 3];
          first = undefined;
          return m;
        }
      : undefined;
    try {
      progress("Creating or finding the match for this key…");
      const match = await ref.create(spec);
      progress(`Waiting up to ${wait} s for the other agent to join…`);
      const seat = await ref.join(match.match_id, args.my_seat);
      progress("Both agents are in. Committing and revealing…");
      const st = await seat.play(chooseMove);
      if (st.phase !== "done") throw new ToolError(`The match ended without a result (phase: ${st.phase}). ${st.error ?? ""}`.trim(), { match_id: st.match_id });
      const s = matchSummary(st, args.my_seat);
      const ok = st.check?.ok === true;
      return {
        summary: `${s.winner ?? "Nobody"} won${s.by_forfeit ? " by forfeit" : ""}. ${s.you_won ? "You won." : "You didn't win."}${ok ? " Your checks passed (signature, your own seed, the math, the agreed settings)." : " Your check FAILED: don't accept this result. See check.problems."}`,
        demo: true,
        match_id: st.match_id,
        tier: spec.tier,
        my_seat: args.my_seat,
        ...s,
        check: { ok, problems: st.check?.problems ?? [], trusts: st.check?.trusts ?? [] },
        receipt: st.receipt,
        acks: st.acks ?? seat.acks,
        note: "Free demo match: same protocol as a paid one, but the receipt is marked demo and nothing is recorded. Paid tie-breaks (from $0.01 per agent) are coming to this MCP server next.",
      };
    } catch (e) {
      if (e instanceof ToolError) throw e;
      if (e instanceof RefereeError && e.status === 408)
        throw new ToolError(`The other agent didn't join within about ${wait} seconds. Free demo, so nothing is charged. Call tiebreak again with the same key and settings to keep waiting.`);
      if (e instanceof RefereeError && e.status === 409)
        throw new ToolError(`This key is already used with different settings: ${e.message} Both agents must send exactly the same tier, seats, weights and title with the same key. Agree on them, or pick a new key.`);
      throw new ToolError(explain(e, { demo: true }));
    }
  }

  // ---------- sealed_review: paid, one agent's own output checked by independent AI reviewers ----------
  const reviewSchema = {
    type: "object",
    required: ["task"],
    properties: {
      task: {
        type: "string",
        minLength: 10,
        maxLength: 4000,
        description:
          "What the work was supposed to do: the instructions or spec it was produced from, with its requirements (10-4,000 characters). Reviewers judge the output against this. It is NOT a message to the reviewers: don't write \"check this for X\" (a reviewer may then fail the output for not being a check). Write \"Write a function that does A and B and never takes longer than C\", and put any claims to verify in as requirements.",
      },
      output: { type: "string", minLength: 1, maxLength: 12000, description: "The exact work to review (up to 12,000 characters), for review and review-3. The receipt is tied to this exact text." },
      pieces: {
        type: "array",
        minItems: 2,
        maxItems: 3,
        items: {
          type: "object",
          required: ["text"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80, description: "Optional label, e.g. a file name. It's part of the receipt, so keep it with the text." },
            text: { type: "string", minLength: 1, maxLength: 12000, description: "The exact text of this piece (up to 12,000 characters)." },
          },
          additionalProperties: false,
        },
        description: "For review-3x2 (exactly 2 pieces) and review-3x3 (exactly 3), instead of output: the work in parts that belong together, e.g. code and its tests. Up to 36,000 characters in all. Every reviewer reads every piece. The receipt is tied to each piece's exact text, its name and the order.",
      },
      tier: { type: "string", enum: ["review", "review-3", "review-3x2", "review-3x3"], description: "review: one reviewer (by default Claude Sonnet), $0.05. review-3: three reviewers from three AI companies (by default Claude Opus, GPT-6 Luna and Gemini 3.7 Flash), majority verdict, $0.20. review-3x2 / review-3x3: the work as 2 or 3 pieces (use pieces, not output), three reviewers from three companies each read every piece, $0.60 / $0.70, paid only (needs the owner's wallet; no free allowance). Default review. The exact models are in the receipt and at GET https://agentreferee.ai/reviewers." },
      title: titleSchema,
      criteria: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          required: ["name", "weight"],
          properties: { name: { type: "string", minLength: 1, maxLength: 60 }, weight: { type: "integer", minimum: 1, maximum: 100 } },
          additionalProperties: false,
        },
        description: 'Optional weighted criteria, e.g. [{"name": "accuracy", "weight": 3}]. Each reviewer scores 0-10 per criterion.',
      },
      panel: panelSchema,
      free: {
        type: "boolean",
        description:
          "Use one of today's free reviews instead of paying (each address gets 3 single-reviewer and 1 review-3 a day, inside a daily budget shared by everyone, so they can run out). Without a wallet set up, reviews are always free. With a wallet, reviews are paid unless this is true. Not available for review-3x2 and review-3x3.",
      },
    },
    additionalProperties: false,
  };

  /** A free review: the service pays (a small daily allowance per address). No wallet, no spend, nothing to settle. */
  async function freeReview(args, tier, progress) {
    const ref = makeClient({ url: config.url, publicKeys: pinned });
    if (typeof ref._call !== "function") throw new ToolError("This version of agent-referee-client can't reach the free review route. Update agent-referee-mcp. Nothing was charged.");
    const body = { task: args.task, output: args.output, title: args.title, criteria: args.criteria, panel: args.panel };
    let r;
    try {
      progress(`Sending to ${reviewersLabel(tier)} (free review)…`);
      r = await ref._call("POST", `/free/${tier}`, body);
    } catch (e) {
      throw new ToolError(explain(e, { free: true }));
    }
    if (!r?.result || !r?.receipt) throw new ToolError("The service answered, but its review couldn't be read. Nothing was charged (it was a free review); try again.");
    let check;
    try {
      check = await ref.verifyReview(r.receipt, { task: args.task, output: args.output, tier, panel: args.panel });
    } catch (e) {
      check = { ok: false, problems: [`The receipt couldn't be checked (${String(e?.message ?? e).slice(0, 200)}).`], trusts: [] };
    }
    check.problems = Array.isArray(check.problems) ? check.problems : [];
    if (r.receipt?.payload?.funding !== "free") {
      check.problems.push('A free review\'s receipt should say "funding": "free".');
      check.ok = false;
    }
    return { ...r, check };
  }

  async function sealedReview(args, { progress }) {
    checkArgs(args, reviewSchema);
    if (args.task.trim().length < 10) throw new ToolError("task must be at least 10 characters of actual text.");
    const tier = args.tier ?? "review";
    const n = MULTI_PIECES[tier];
    if (n) {
      // Multi-part: checked here, before any payment is set up, so a mistake costs nothing.
      if (args.output !== undefined) throw new ToolError(`${tier} takes the work as pieces ([{name?, text}], exactly ${n}), not output. Nothing was charged.`);
      if (!Array.isArray(args.pieces) || args.pieces.length !== n) throw new ToolError(`${tier} takes exactly ${n} pieces ([{name?, text}]). Nothing was charged.`);
      for (const [i, pc] of args.pieces.entries()) {
        if (!pc.text.trim()) throw new ToolError(`pieces[${i}] (piece ${i + 1}) is empty. Nothing was charged.`);
        if (pc.name !== undefined && (!pc.name.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(pc.name))) throw new ToolError(`pieces[${i}] (piece ${i + 1}): a name must be printable text with no line breaks. Nothing was charged.`);
      }
      const total = args.pieces.reduce((t, pc) => t + pc.text.length, 0);
      if (total > 36000) throw new ToolError(`The pieces add up to ${total} characters; the most in all is 36,000. Nothing was charged.`);
      if (args.free === true) throw new ToolError(`${tier} is paid only: there's no free allowance for multi-part reviews. Use review or review-3 for a free review. Nothing was charged.`);
      if (!config.privateKey) throw new ToolError(`${tier} is paid only (${usd(PRICES[tier])}), and no wallet is set up for this server. The owner can add one (AGENT_REFEREE_PRIVATE_KEY, see the README). For a free check, use review or review-3 with output. Nothing was charged.`);
      const pe = multiPanelProblem(args.panel);
      if (pe) throw new ToolError(`${pe} Nothing was charged.`);
    } else {
      if (args.pieces !== undefined) throw new ToolError(`pieces are for review-3x2 and review-3x3; ${tier} takes one output. Nothing was charged.`);
      if (typeof args.output !== "string" || !args.output.trim()) throw new ToolError("output is empty.");
    }
    if (args.criteria && new Set(args.criteria.map((c) => c.name.trim())).size !== args.criteria.length) throw new ToolError("criteria names must be unique.");
    if (args.criteria?.some((c) => !c.name.trim() || /[\n\r]/.test(c.name))) throw new ToolError("Each criteria name must be text on one line. Nothing was charged.");
    const price = PRICES[tier];

    if (!n && (args.free === true || !config.privateKey)) return reviewResult(args, tier, await freeReview(args, tier, progress), null, []);
    if (!/^0x[0-9a-fA-F]{64}$/.test(config.privateKey))
      throw new ToolError("AGENT_REFEREE_PRIVATE_KEY is set but isn't a 0x-prefixed 64-character hex key. The owner needs to fix it in the MCP server settings. Nothing was charged.");

    let hold;
    try {
      hold = await budget.reserve(price);
    } catch (e) {
      throw new ToolError(String(e.message));
    }

    // Recording the spend must never cost the agent its paid receipt. If the spend file can't be written, the
    // reservation stays on disk and counts as spent once it goes stale, so the cap still errs on the safe side.
    const warnings = [];
    const settle = async (charged) => {
      try {
        await (charged ? hold.commit() : hold.release());
      } catch (e) {
        warnings.push(`Couldn't update today's spend record (${String(e?.message ?? e).slice(0, 200)}). The daily cap counts this call as spent to be safe.`);
      }
    };

    let payer;
    try {
      payer = await makePayingFetch(config.privateKey, price);
    } catch (e) {
      await settle(false);
      throw new ToolError(`Couldn't set up payment: ${String(e?.message ?? e).slice(0, 300)}. Nothing was charged.`);
    }

    const ref = makeClient({ url: config.url, fetch: payer.fetch, publicKeys: pinned });
    let r;
    try {
      progress(`Sending to ${reviewersLabel(tier)} (${usd(price)}, charged only if the review completes)…`);
      r = await ref.review(n ? { tier, task: args.task, pieces: args.pieces, title: args.title, criteria: args.criteria, panel: args.panel } : { tier, task: args.task, output: args.output, title: args.title, criteria: args.criteria, panel: args.panel });
    } catch (e) {
      // A definite answer from the service (any HTTP error) means the payment never settled: release it.
      // Anything else (the connection dropped mid-request) is ambiguous, so keep it counted: the cap errs on the safe side.
      const dropped = !(e instanceof RefereeError) && !/exceeds maximum|max(imum)? ?value|amount exceeds/i.test(String(e?.message ?? e));
      await settle(dropped);
      throw new ToolError(explain(e, { paid: true, dropped }), payer.wallet ? { wallet: payer.wallet, ...(warnings.length ? { warnings } : {}) } : undefined);
    }
    // The service answered 200, so the payment settled.
    await settle(true);
    const settlement = payer.lastSettlement?.() ?? null;

    // A 200 whose body couldn't be read: the review was paid for, but there's no result to show.
    if (!r?.result || !r?.receipt) {
      throw new ToolError(
        "The service accepted the review and the payment settled, but its answer couldn't be read, so there's no receipt to show. Email hello@agentreferee.ai with the transaction hash below to have the review re-run free.",
        { wallet: payer.wallet ?? null, transaction: settlement?.transaction ?? null, ...(warnings.length ? { warnings } : {}) },
      );
    }

    return reviewResult(args, tier, r, paidRecord(price, payer, settlement), warnings);
  }

  const paidRecord = (price, payer, settlement) => ({ amount: usd(price), wallet: payer.wallet ?? null, transaction: settlement?.transaction ?? null, network: settlement?.network ?? null });

  /** Save the receipt and describe the review for the agent. paid is null for a free review. */
  async function reviewResult(args, tier, r, paid, warnings) {
    const record = {
      summary: `${tier} ${r.result.verdict}${args.title ? ` — ${args.title}` : ""}`,
      review_id: r.review_id,
      tier,
      title: args.title ?? null,
      result: r.result,
      votes: r.votes,
      receipt: r.receipt,
      check: r.check,
      ...(paid ? { paid } : { free: r.free ?? true }),
    };
    let receiptFile = null;
    let saveProblem = null;
    try {
      receiptFile = await receipts.save("review", r.review_id, record);
    } catch (e) {
      saveProblem = `Couldn't save the receipt to disk (${String(e?.message ?? e).slice(0, 200)}). Save the receipt from this response yourself: the service keeps no copy.`;
    }
    // A free review never touches the local spending cap, so it doesn't report it either.
    const today = paid ? await budget.status().catch(() => null) : null;

    const ok = r.check?.ok === true;
    return {
      summary: `${ok ? "" : "WARNING: the receipt check FAILED (see check.problems); don't rely on this review. "}Verdict: ${r.result.verdict}${tier !== "review" ? ` (${Object.entries(r.result.tally ?? {}).filter(([, n]) => n).map(([v, n]) => `${n} ${v}`).join(", ")})` : ""}.${paid ? "" : ` Free review${Number.isFinite(r.free?.left_today) ? ` (${r.free.left_today} of this kind left today)` : ""}.`}`,
      verdict: r.result.verdict,
      unanimous: r.result.unanimous,
      tally: r.result.tally,
      review_id: r.review_id,
      tier,
      votes: summarizeVotes(r.votes),
      check: r.check,
      receipt: r.receipt,
      receipt_file: receiptFile,
      ...(saveProblem ? { save_problem: saveProblem } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(paid ? { paid } : { free: { ...(r.free ?? {}), note: "A free review: nothing was charged, and the receipt says funding: free." } }),
      spent_today: today ? `${usd(today.spent_micro)} of ${usd(today.limit_micro)} (UTC day)` : undefined,
      how_to_share: MULTI_PIECES[tier]
        ? "Give the receipt to whoever receives the work, together with the exact task and every piece, with its name, in the same order. They can check it for free with the verify_receipt tool (task and pieces) or the client's verifyReview(receipt, { task, pieces }). The receipt holds SHA-256 fingerprints of the task and each piece, not the text."
        : "Give the receipt to whoever receives the work, together with the exact task and output. They can check it for free with the verify_receipt tool or the client's verifyReview(receipt, { task, output }). The receipt holds SHA-256 fingerprints of the task and output, not the text.",
      what_it_proves:
        "These models gave these verdicts about this exact task and output. It is not a guarantee the output is correct: reviewers see only the text, can miss things, and a re-run can differ. A receiver should also check the task is the one it actually asked for.",
      ...(r.result.verdict === "split" ? { split: "No majority: the reviewers disagreed. Treat it like cannot_assess and read each vote's issues. Re-running is a fresh sample, not a fix." } : {}),
    };
  }

  // ---------- verify_receipt: free, offline ----------
  const verifySchema = {
    type: "object",
    required: ["receipt"],
    properties: {
      receipt: {
        type: ["object", "string"],
        description: "The signed receipt: the object with payload, signature, algorithm and public_key (or that object as a JSON string). A saved record that contains a receipt works too.",
      },
      task: { type: "string", description: "Sealed review: the exact task you expect the review to be about. Strongly recommended." },
      output: { type: "string", description: "Sealed review: the exact output you received. Without it, the check can't confirm the review is about the work you have." },
      pieces: {
        type: "array",
        items: { type: "object", required: ["text"], properties: { name: { type: "string" }, text: { type: "string" } }, additionalProperties: false },
        description: "Multi-part review (review-3x2, review-3x3), instead of output: every piece you received, [{name?, text}], with the names and in the order given. Without them, the check can't confirm the review is about the work you have.",
      },
      acks: { type: "array", items: { type: "object" }, description: "Match: the signed step acknowledgments that came with the receipt (optional). Any contradiction between them and the receipt is reported." },
    },
    additionalProperties: false,
  };

  async function verifyReceiptTool(args) {
    checkArgs(args, verifySchema);
    let receipt = args.receipt;
    if (typeof receipt === "string") {
      try {
        receipt = JSON.parse(receipt);
      } catch {
        throw new ToolError("receipt is a string but not valid JSON.");
      }
    }
    if (receipt && !receipt.payload && receipt.receipt?.payload) receipt = receipt.receipt; // a saved record or a whole response
    if (!receipt?.payload || typeof receipt.payload !== "object") throw new ToolError("That isn't a receipt: it has no payload.");
    const p = receipt.payload;

    const signed = await verifySignature(receipt, pinned).catch(() => false);
    const keyNote = signed
      ? "Signed by Agent Referee's pinned key (checked offline)."
      : "The signature does NOT check out against Agent Referee's pinned key: this receipt may be forged or altered. Don't rely on it.";

    if (p.type === "review") {
      const res = await verifyReviewOutcome(receipt, { task: args.task, output: args.output, pieces: args.pieces });
      const problems = [...(signed ? [] : ["The receipt's signature doesn't check out against the service's key."]), ...res.problems];
      const notChecked = [];
      if (args.task === undefined) notChecked.push("task (pass task to confirm the review was about the task you set)");
      if (MULTI_PIECES[p.tier]) {
        if (args.pieces === undefined) notChecked.push("pieces (pass every piece, with its name and in order, to confirm the review is about the exact work you received)");
      } else if (args.output === undefined) notChecked.push("output (pass output to confirm the review is about the exact work you received)");
      const ok = problems.length === 0;
      return {
        summary: `${ok ? "Valid" : "NOT valid"} sealed review (${p.tier}): verdict ${p.result?.verdict}.${notChecked.length ? ` Not checked: ${notChecked.map((x) => x.split(" ")[0]).join(" and ")}.` : ""}`,
        kind: "review",
        ok,
        signature_valid: signed,
        verdict: p.result?.verdict,
        tier: p.tier,
        review_id: p.review_id,
        reviewers: p.reviewers?.models,
        problems,
        not_checked: notChecked,
        trusts: res.trusts,
        signature: keyNote,
      };
    }

    const res = await verifyOutcome(receipt, args.acks ? { acks: args.acks } : {});
    let acksSigned = true;
    for (const a of args.acks ?? []) if (!(await verifySignature(a, pinned).catch(() => false))) acksSigned = false;
    const problems = [...(signed ? [] : ["The receipt's signature doesn't check out against the service's key."]), ...res.problems];
    if (!acksSigned) problems.push("At least one acknowledgment isn't validly signed by the service.");
    const ok = problems.length === 0;
    const out = p.outcome ?? {};
    return {
      summary: `${ok ? "Valid" : "NOT valid"} ${p.demo ? "DEMO " : ""}${p.tier} match receipt: ${out.picked_option !== undefined ? `picked "${out.picked_option}"` : `winner ${out.winner ?? "none"}`}${out.mistrial ? " (mistrial)" : ""}.${res.recomputed ? " The result was recomputed from the agents' own commitments and reveals." : ""}`,
      kind: "match",
      ok,
      demo: p.demo === true,
      signature_valid: signed,
      tier: p.tier,
      match_id: p.match_id,
      parties: p.parties,
      outcome: out,
      recomputed: res.recomputed,
      problems,
      trusts: res.trusts,
      evidence: res.evidence?.length ? res.evidence : undefined,
      signature: keyNote,
      ...(p.demo ? { demo_note: "This is a free demo receipt. It's marked demo inside the signed part and is not a paid result." } : {}),
      limits: "Without the seat's own secret seed and nonce, this can't confirm a seat's inputs weren't swapped; each agent's own client checks that during play.",
    };
  }

  // ---------- saved_receipts: free, local ----------
  const savedSchema = {
    type: "object",
    properties: {
      id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$", description: "A review_id to fetch in full. Leave it out to list recent receipts." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "How many recent receipts to list (default 20)." },
    },
    additionalProperties: false,
  };

  async function savedReceipts(args) {
    checkArgs(args, savedSchema);
    if (!receipts.enabled) return { summary: "Receipt saving is turned off (AGENT_REFEREE_SAVE_RECEIPTS=false).", receipts: [] };
    if (args.id) {
      const r = await receipts.get(args.id);
      if (!r) throw new ToolError(`No saved receipt with id ${args.id} in ${receipts.dir}.`);
      return r;
    }
    const list = await receipts.list(args.limit ?? 20);
    const today = await budget.status().catch(() => null);
    return {
      summary: list.length ? `${list.length} saved receipt(s), newest first.` : "No saved receipts yet.",
      folder: receipts.dir,
      receipts: list,
      spent_today: today ? `${usd(today.spent_micro)} of ${usd(today.limit_micro)} (UTC day)` : undefined,
    };
  }

  return [
    {
      name: "demo_match",
      title: "Try a free demo tie-break",
      description:
        "Free, no wallet: runs a complete Agent Referee tie-break in one call, playing both seats, and returns the winner, the signed receipt and the checks. Use it to see how Agent Referee works or to test the connection. It is not a real decision between two agents (use tiebreak for that). Demo limit: 20 per day per IP address.",
      inputSchema: demoMatchSchema,
      annotations: { title: "Try a free demo tie-break", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: demoMatch,
    },
    {
      name: "tiebreak",
      title: "Settle a tie with another agent (free demo)",
      description:
        "Settle a deadlock with an agent from a different owner, when neither of you should decide alone (who goes first, which of two equal plans). Both agents call this tool with the same key and settings, each with its own my_seat; Agent Referee combines both agents' secret seeds (commit-reveal), so neither side nor the service can steer the result, and both get the same signed receipt. Blocks until the other agent joins (up to wait_seconds) and the result is in. Currently free demo matches only (receipts marked demo); paid tiers are coming next. Don't use it when both agents have the same owner: just decide in code.",
      inputSchema: tiebreakSchema,
      annotations: { title: "Settle a tie with another agent", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: tiebreak,
    },
    {
      name: "sealed_review",
      title: "Sealed review of your own output (free daily allowance, then paid)",
      description:
        "FREE OR PAID. Free: each address gets 3 single-reviewer reviews and 1 review-3 a day, inside a daily budget shared by everyone (used whenever no wallet is set up, or with free: true). Paid: $0.05, or $0.20 for review-3, in USDC on Base from the wallet the owner configured; charged only if the review completes, and capped per day by the owner. Multi-part (paid only, $0.60 for review-3x2, $0.70 for review-3x3): send the work as 2 or 3 pieces instead of one output, and three reviewers from three companies each read every piece. Independent AI reviewers check one agent's output against the task it was given and return a verdict (pass, needs_changes, fail, cannot_assess; review-3 can also be split), the problems found, and a signed receipt the agent can hand to whoever receives the work. Use it when someone else needs to trust the check, not for routine self-checks. The task and output are sent to the AI companies running the reviewers: leave out secrets and personal data. Can take up to a few minutes. The receipt is saved to disk automatically.",
      inputSchema: reviewSchema,
      annotations: { title: "Sealed review", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: sealedReview,
    },
    {
      name: "verify_receipt",
      title: "Check an Agent Referee receipt",
      description:
        "Free and offline: checks an Agent Referee receipt (a sealed review or a match) against the service's pinned signing key, recomputes what can be recomputed, and lists any problems. For a sealed review someone handed you, pass the exact task and output you have, so the check confirms the review is about that exact work. Flags demo receipts.",
      inputSchema: verifySchema,
      annotations: { title: "Check a receipt", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: verifyReceiptTool,
    },
    {
      name: "saved_receipts",
      title: "List saved review receipts",
      description:
        "Free and local: lists the sealed-review receipts this server saved on this machine (newest first), or returns one in full by its review_id, plus today's paid spend. Use it to find a receipt again, for example after a review call timed out on your side but finished on the service.",
      inputSchema: savedSchema,
      annotations: { title: "List saved receipts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: savedReceipts,
    },
  ];
}

/** Build an x402 paying fetch from a private key, capped at `maxMicro` per request, that remembers the last settlement. */
export async function defaultPayingFetch(privateKey, maxMicro, { load = () => import("x402-fetch"), baseFetch = globalThis.fetch.bind(globalThis) } = {}) {
  let mod;
  try {
    mod = await load();
  } catch {
    throw new Error("paid reviews need the x402-fetch package, which the free setup leaves out. Start the server with: npx -y -p agent-referee-mcp -p x402-fetch agent-referee-mcp");
  }
  const signer = await mod.createSigner("base", privateKey);
  let last = null;
  const base = baseFetch;
  const paying = mod.wrapFetchWithPayment(base, signer, BigInt(maxMicro));
  const fetchFn = async (input, init) => {
    const res = await paying(input, init);
    const header = res.headers.get("x-payment-response");
    if (header) {
      try {
        last = mod.decodeXPaymentResponse ? mod.decodeXPaymentResponse(header) : JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      } catch {}
    }
    return res;
  };
  return { fetch: fetchFn, wallet: signer?.account?.address, lastSettlement: () => last };
}
