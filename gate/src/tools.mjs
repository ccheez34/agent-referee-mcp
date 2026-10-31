// The gate's tools. Who is calling comes from the gate's own settings (GATE_MEMBER, set by the owner per session's
// entry), never from an argument, so a session can't act as another member.
import { readFile } from "node:fs/promises";
import { ToolError } from "../../src/protocol.mjs";
import { validate } from "../../src/validate.mjs";
import { loadApprovalRecords, sortRecords, mismatch } from "./approvals.mjs";
import { normalizeSubject, receiptId, receiptProblem } from "./receipts.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
const LOCK = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createGateTools({ policy, state, member, approvalsSource, now = () => Date.now(), fetchImpl = fetch }) {
  if (!member || !/^[A-Za-z0-9._-]{1,40}$/.test(member)) throw new Error("GATE_MEMBER must name this session's member (letters, digits, . _ -), set by the owner.");
  const skewMs = policy.clock_skew_seconds * 1000;
  const check = (args, schema) => {
    const problems = validate(args ?? {}, schema);
    if (problems.length) throw new ToolError(problems.join(" "));
  };

  // ---------- check_action ----------
  const actionSchema = {
    type: "object",
    required: ["action", "target"],
    properties: {
      action: { type: "string", enum: Object.keys(policy.actions), description: "The kind of step, from the policy's list." },
      target: { type: "string", minLength: 1, maxLength: 500, description: 'Exactly what it acts on, e.g. "production" or "npm:agent-referee-mcp@0.5.0". Must match the approval byte for byte.' },
      target_sha256: { type: "string", pattern: "^[0-9a-f]{64}$", description: "The sha256 of the exact thing (a commit's tree, a package tarball, a file), if the approval names one." },
      dry_run: { type: "boolean", description: "true: only say whether it would be allowed; no use is spent. Default false: an allowed check spends one use of the approval, so call it right before the step." },
    },
    additionalProperties: false,
  };

  async function checkAction(args) {
    check(args, actionSchema);
    const req = { action: args.action, target: args.target, target_sha256: args.target_sha256 ?? null };
    const base = { action: req.action, target: req.target, member, policy_version: policy.version };
    if (policy.actions[req.action] === "open") {
      await state.log({ tool: "check_action", ...base, allowed: true, why: "open" });
      return { ...base, allowed: true, owner_only: false, summary: `"${req.action}" isn't owner-only under policy ${policy.version}.` };
    }
    let records;
    try {
      records = await loadApprovalRecords({ ...approvalsSource, fetchImpl, readText: (f) => readFile(f, "utf8") });
    } catch (e) {
      await state.log({ tool: "check_action", ...base, allowed: false, why: "approvals unreachable" });
      return { ...base, allowed: false, owner_only: true, summary: `Not allowed: the approvals record can't be read (${String(e?.message ?? e).slice(0, 160)}). Gated steps wait until it can; the owner can still act himself.` };
    }
    const { approvals, revoked, rejected } = await sortRecords(records, policy.approval_keys);
    // A revocation, once seen, is remembered here, so removing it from the record later doesn't reopen the approval.
    for (const n of revoked) await state.createOnce(`revoked-${n}`, { seen_at: new Date(now()).toISOString() });
    let remembered;
    try {
      remembered = new Set([...revoked, ...(await state.list("revoked-")).map((f) => f.slice("revoked-".length))]);
    } catch (e) {
      await state.log({ tool: "check_action", ...base, allowed: false, why: "state unreadable" }).catch(() => {});
      return { ...base, allowed: false, owner_only: true, summary: `Not allowed: the gate can't read its own records (${String(e?.code ?? e?.message ?? e).slice(0, 60)}), so it can't rule out a revocation. Tell the owner.` };
    }
    const reasons = [];
    for (const a of approvals) {
      const m = mismatch(a, req, { policyVersion: policy.version, now: now(), skewMs, revoked: remembered });
      if (m === null) continue;
      if (m) {
        reasons.push(m);
        continue;
      }
      // A fitting approval: spend a use (or, for a dry run, only count what's left).
      const used = (await state.list(`use-${a.nonce}-`)).length;
      if (used >= a.max_uses) {
        reasons.push(`approval ${a.nonce.slice(0, 8)} is used up (${a.max_uses} of ${a.max_uses})`);
        continue;
      }
      if (args.dry_run) return { ...base, allowed: true, owner_only: true, dry_run: true, approval_nonce: a.nonce, uses_left: a.max_uses - used, expires_at: a.expires_at, summary: `Would be allowed by the owner's approval ${a.nonce.slice(0, 8)} (${a.max_uses - used} use(s) left). Nothing was spent.` };
      for (let k = 1; k <= a.max_uses; k++) {
        if (await state.createOnce(`use-${a.nonce}-${k}`, { member, at: new Date(now()).toISOString(), action: req.action, target: req.target, target_sha256: req.target_sha256 })) {
          await state.log({ tool: "check_action", ...base, target_sha256: req.target_sha256, allowed: true, approval_nonce: a.nonce, use: k });
          return { ...base, allowed: true, owner_only: true, approval_nonce: a.nonce, uses_left: a.max_uses - k, expires_at: a.expires_at, summary: `Allowed by the owner's approval ${a.nonce.slice(0, 8)}: use ${k} of ${a.max_uses}. Do the step now.` };
        }
      }
      reasons.push(`approval ${a.nonce.slice(0, 8)} is used up (${a.max_uses} of ${a.max_uses})`);
    }
    for (const r of rejected) reasons.push(`a record ${r.nonce ? String(r.nonce).slice(0, 8) + " " : ""}was ignored: ${r.why}`);
    await state.log({ tool: "check_action", ...base, target_sha256: req.target_sha256, allowed: false, why: reasons.slice(0, 5) });
    return {
      ...base,
      allowed: false,
      owner_only: true,
      reasons: reasons.slice(0, 20),
      summary: `Not allowed: "${req.action}" is owner-only and no approval from the owner fits this exact target${reasons.length ? ` (${reasons[0]})` : ""}. Ask ccheez34; only his signed approval opens it.`,
    };
  }

  // ---------- submit_done ----------
  const doneSchema = {
    type: "object",
    required: ["kind", "subject", "receipts"],
    properties: {
      kind: { type: "string", enum: Object.keys(policy.done).length ? Object.keys(policy.done) : ["none"], description: "Which kind of done, from the policy's list." },
      subject: { type: "object", description: "What is done: {repo, sha} for a commit (full 40 hex), and/or {sha256} for the exact file or diff." },
      receipts: { type: "array", minItems: 1, maxItems: 10, items: { type: "object" }, description: "The signed receipts, one per requirement of this kind." },
      note: { type: "string", maxLength: 500, description: "Optional: what was done, for the record." },
    },
    additionalProperties: false,
  };

  async function submitDone(args) {
    check(args, doneSchema);
    const rule = policy.done[args.kind];
    if (!rule) throw new ToolError(`The policy has no done kind "${args.kind}".`);
    const ns = normalizeSubject(args.subject);
    if (ns.error) throw new ToolError(ns.error);
    const subject = ns.subject;
    const t = now();
    const matched = [];
    const unmet = [];
    const taken = new Set();
    for (const req of rule.require) {
      const why = [];
      let hit = null;
      for (let i = 0; i < args.receipts.length; i++) {
        if (taken.has(i)) continue;
        const problem = await receiptProblem(args.receipts[i], req, subject, { receiptKeys: policy.receipt_keys, now: t, skewMs });
        if (problem) {
          why.push(`receipt ${i + 1}: ${problem}`);
          continue;
        }
        const id = receiptId(args.receipts[i]);
        if (!id) {
          why.push(`receipt ${i + 1}: it has no id`);
          continue;
        }
        if (await state.exists(`accepted-${id}`)) {
          why.push(`receipt ${i + 1}: this gate already accepted it once`);
          continue;
        }
        hit = { i, id };
        break;
      }
      const label = `${req.level} ${req.check ?? "panel_pass"}`;
      if (hit) {
        taken.add(hit.i);
        matched.push({ requirement: label, receipt: hit.i + 1, id: hit.id });
      } else unmet.push({ requirement: label, why: why.slice(0, 5) });
    }
    if (unmet.length) {
      await state.log({ tool: "submit_done", member, kind: args.kind, subject, accepted: false, unmet: unmet.map((u) => u.requirement) });
      return { accepted: false, kind: args.kind, subject, member, unmet, summary: `Not accepted: ${unmet.length} of ${rule.require.length} requirement(s) unmet (${unmet.map((u) => u.requirement).join(", ")}). The done stays open.` };
    }
    // Every requirement is met: record each receipt as used here. If another submit got one first, undo ours.
    const recorded = [];
    for (const m of matched) {
      if (await state.createOnce(`accepted-${m.id}`, { member, kind: args.kind, subject, at: new Date(t).toISOString() })) recorded.push(m.id);
      else {
        for (const id of recorded) await state.remove(`accepted-${id}`);
        return { accepted: false, kind: args.kind, subject, member, summary: `Not accepted: receipt ${m.receipt} was accepted by another submission a moment ago.` };
      }
    }
    const review = (i) => args.receipts[i]?.payload?.type === "review" ? args.receipts[i].payload.task_sha256 : undefined;
    const record = {
      member,
      kind: args.kind,
      subject,
      receipts: matched.map((m) => m.id),
      ...(matched.some((m) => review(m.receipt - 1)) ? { review_task_sha256: matched.map((m) => review(m.receipt - 1)).filter(Boolean) } : {}),
      ...(rule.allow_unbound_pair ? { pair_bound: false } : {}),
      note: args.note ?? null,
      at: new Date(t).toISOString(),
    };
    await state.log({ tool: "submit_done", ...record, accepted: true });
    return { accepted: true, ...record, summary: `Accepted: ${args.kind} for ${subject.repo ? `${subject.repo}@${subject.sha.slice(0, 7)}` : subject.sha256.slice(0, 12)}, with ${matched.length} receipt(s). Each is now used at this gate.` };
  }

  // ---------- locks ----------
  const lockSchema = {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", pattern: LOCK.source, description: 'What is locked, e.g. "deploy-server" or "wallet-main".' },
      expected_minutes: { type: "integer", minimum: 1, maximum: 720, description: "take_lock: how long it should take (required there)." },
      note: { type: "string", maxLength: 300 },
    },
    additionalProperties: false,
  };

  async function takeLock(args) {
    check(args, lockSchema);
    if (!args.expected_minutes) throw new ToolError("take_lock needs expected_minutes.");
    const t = now();
    const rec = { name: args.name, holder: member, taken_at: new Date(t).toISOString(), expected_end: new Date(t + args.expected_minutes * 60_000).toISOString(), note: args.note ?? null };
    if (await state.createOnce(`lock-${args.name}`, rec)) {
      await state.log({ tool: "take_lock", ...rec });
      return { taken: true, ...rec, summary: `Lock ${args.name} is yours until about ${rec.expected_end}. Release it when done.` };
    }
    const held = await state.read(`lock-${args.name}`);
    const staleAt = held ? Date.parse(held.expected_end) + policy.lock_stale_minutes * 60_000 : 0;
    const stale = held && t > staleAt;
    return {
      taken: false,
      held_by: held?.holder ?? "unknown",
      expected_end: held?.expected_end ?? null,
      stale: Boolean(stale),
      summary: stale
        ? `Lock ${args.name} is held by ${held.holder} and is stale (${policy.lock_stale_minutes} minutes past its expected end). Message ${held.holder} once, then tell the owner; only the holder or the owner clears it.`
        : `Lock ${args.name} is held by ${held?.holder ?? "someone"} until about ${held?.expected_end ?? "?"}. Wait, or work on something else.`,
    };
  }

  async function releaseLock(args) {
    check(args, lockSchema);
    const held = await state.read(`lock-${args.name}`);
    if (!held) return { released: false, summary: `Lock ${args.name} isn't held.` };
    if (held.holder !== member) throw new ToolError(`Lock ${args.name} is held by ${held.holder}, not ${member}. Only the holder or the owner can release it.`);
    await state.remove(`lock-${args.name}`);
    await state.log({ tool: "release_lock", name: args.name, holder: member });
    return { released: true, name: args.name, summary: `Lock ${args.name} released.` };
  }

  // ---------- budget ----------
  const budgetSchema = {
    type: "object",
    properties: {
      spend_usd: { type: "number", minimum: 0.01, maximum: 1000, description: "Optional: reserve this much before spending it (for example 0.20 for a review-3). Refused if it would pass today's limit." },
      what: { type: "string", maxLength: 200, description: "What the spend is for (required with spend_usd)." },
    },
    additionalProperties: false,
  };

  async function budget(args) {
    check(args, budgetSchema);
    const limit = Object.hasOwn(policy.budgets.daily_usd, member) ? policy.budgets.daily_usd[member] : policy.budgets.default_daily_usd;
    if (!Number.isFinite(limit) || limit < 0) throw new ToolError("The policy gives this member no valid daily limit.");
    const today = day(now());
    const key = `spend-${member}-${today}`;
    return state.withMutex(key, async () => {
      const rec = (await state.read(key)) ?? { member, day: today, spent_micro: 0, items: [] };
      const toMicro = (usd) => Math.round(usd * 1e6);
      const view = (extra) => ({ member, day: today, limit_usd: limit, spent_usd: rec.spent_micro / 1e6, left_usd: Math.max(0, toMicro(limit) - rec.spent_micro) / 1e6, ...extra });
      if (args.spend_usd === undefined) return view({ summary: `${member}: $${(rec.spent_micro / 1e6).toFixed(2)} of $${limit.toFixed(2)} reserved today (UTC).` });
      if (!args.what) throw new ToolError("Say what the spend is for (what).");
      const want = toMicro(args.spend_usd);
      if (rec.spent_micro + want > toMicro(limit)) {
        await state.log({ tool: "budget", member, refused_usd: args.spend_usd, what: args.what });
        return view({ reserved: false, summary: `Refused: $${args.spend_usd.toFixed(2)} would pass ${member}'s daily limit of $${limit.toFixed(2)} ($${(rec.spent_micro / 1e6).toFixed(2)} already reserved). Spending more needs the owner.` });
      }
      rec.spent_micro += want;
      rec.items.push({ usd: args.spend_usd, what: args.what, at: new Date(now()).toISOString() });
      await state.writeAtomic(key, rec);
      await state.log({ tool: "budget", member, reserved_usd: args.spend_usd, what: args.what });
      return view({ reserved: true, summary: `Reserved $${args.spend_usd.toFixed(2)} for ${args.what}. ${member} has $${((toMicro(limit) - rec.spent_micro) / 1e6).toFixed(2)} left today.` });
    });
  }

  const NOT_APPROVAL = "A receipt can pass a quality step; it never stands in for the owner's yes.";
  return [
    {
      name: "check_action",
      title: "Is this step allowed?",
      description: `Call right before any step on the policy's list (deploy, publish, payment, delete, secret, install, rule_change, …). Owner-only steps are allowed only by an approval the owner signed for this exact action and target, unexpired, unrevoked and not used up; an allowed call spends one use. ${NOT_APPROVAL} Policy ${policy.version}.`,
      inputSchema: actionSchema,
      annotations: { title: "Check an action", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: checkAction,
    },
    {
      name: "submit_done",
      title: "Mark work done, with its receipts",
      description: `Marks a kind of work done only if every receipt the policy requires for that kind checks out offline: the pinned signature, the exact subject, the required level, fresh, and not used at this gate before. L2 needs a review-3 with three "pass" votes from three companies; 2-1 is a list of work to do. ${NOT_APPROVAL}`,
      inputSchema: doneSchema,
      annotations: { title: "Submit done", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: submitDone,
    },
    {
      name: "take_lock",
      title: "Take a lock (one deploy or paid batch at a time)",
      description: "Takes a named lock for this member, or says who holds it and whether it's stale. Locks are shared by every session using this gate.",
      inputSchema: lockSchema,
      annotations: { title: "Take a lock", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: takeLock,
    },
    {
      name: "release_lock",
      title: "Release a lock you hold",
      description: "Releases a named lock. Only its holder can (the owner clears others by hand).",
      inputSchema: lockSchema,
      annotations: { title: "Release a lock", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: releaseLock,
    },
    {
      name: "budget",
      title: "Today's budget, or reserve a spend",
      description: "Shows this member's daily limit and what's reserved today (UTC). With spend_usd, reserves that amount first, and refuses if it would pass the owner's limit.",
      inputSchema: budgetSchema,
      annotations: { title: "Budget", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: budget,
    },
  ];
}
