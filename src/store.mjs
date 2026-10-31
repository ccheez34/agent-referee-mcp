// Local state kept on the user's machine: today's paid spend (for the daily cap) and saved receipts.
// Amounts are whole micro-USDC (1,000,000 = $1) so nothing is lost to floating point.
import { mkdir, readFile, writeFile, readdir, rename, open, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const MICRO = 1_000_000;
export const toMicro = (usd) => Math.round(Number(usd) * MICRO);
export const usd = (micro) => `$${(micro / MICRO).toFixed(micro % 10_000 === 0 ? 2 : 3)}`;
const today = (now = new Date()) => now.toISOString().slice(0, 10); // UTC day, like the service's own limits
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A reservation older than this belongs to a server that was killed mid-call: its payment may have gone through, so it counts as spent. */
export const STALE_RESERVATION_MS = 10 * 60_000;
/** A lock file older than this was left by a crashed process and is taken over. Every locked step takes milliseconds. */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

async function writeJsonAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  // On Windows a rename can briefly fail while another program (often antivirus) has the file open: retry a few times.
  for (let i = 0; ; i++) {
    try {
      return await rename(tmp, path);
    } catch (e) {
      if (i >= 9 || !["EPERM", "EACCES", "EBUSY"].includes(e?.code)) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
      await sleep(25 * (i + 1));
    }
  }
}

class CorruptSpendFile extends Error {}

/**
 * Daily spending cap for paid calls, shared by every copy of this server that uses the same data folder (Claude
 * Desktop, Claude Code and Cursor each start their own). Before paying, a call reserves its price in spend.json; the
 * reservation becomes spend when the call succeeds (the service only settles a payment when a request succeeds) and is
 * released when it definitely failed. Reservations count against the cap, and every change to spend.json happens under
 * a lock file, so parallel calls, in this process or in others, can't overshoot it together.
 */
export class Budget {
  /** @param {{ dir: string, dailyLimitMicro: number, now?: () => Date }} opts */
  constructor({ dir, dailyLimitMicro, now = () => new Date() }) {
    this.path = join(dir, "spend.json");
    this.lockPath = join(dir, "spend.lock");
    this.dir = dir;
    this.limit = dailyLimitMicro;
    this.now = now;
    this.queue = Promise.resolve(); // calls in this process take turns before contending for the file lock
  }

  _serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Runs fn(state) under the lock file; if fn returns a state, it is saved. */
  async _locked(fn) {
    await mkdir(this.dir, { recursive: true });
    const started = Date.now();
    let handle;
    for (;;) {
      try {
        handle = await open(this.lockPath, "wx");
        break;
      } catch (e) {
        if (e?.code !== "EEXIST") throw e;
        try {
          const s = await stat(this.lockPath);
          if (Date.now() - s.mtimeMs > STALE_LOCK_MS) {
            await unlink(this.lockPath).catch(() => {});
            continue;
          }
        } catch {
          continue; // the lock was just released
        }
        if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`Couldn't lock ${this.lockPath}: another copy of the server seems stuck. Nothing was charged. If no other copy is running, delete that file.`);
        await sleep(10 + Math.random() * 30);
      }
    }
    try {
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await handle.close();
      const state = await this._load();
      const out = await fn(state);
      if (out) await writeJsonAtomic(this.path, out);
      return out ?? state;
    } finally {
      await unlink(this.lockPath).catch(() => {});
    }
  }

  async _load() {
    const day = today(this.now());
    let d;
    try {
      d = JSON.parse(await readFile(this.path, "utf8"));
    } catch (e) {
      if (e?.code === "ENOENT") return { day, spent_micro: 0, paid_calls: 0, pending: {} };
      throw new CorruptSpendFile(
        `The spend record ${this.path} can't be read (${e?.code ?? "not valid JSON"}). To keep the daily cap safe, paid calls are paused. Nothing was charged. Check the file, or delete it to start the day's count from zero.`,
      );
    }
    if (!d || typeof d !== "object" || !Number.isInteger(d.spent_micro))
      throw new CorruptSpendFile(`The spend record ${this.path} has an unexpected shape. To keep the daily cap safe, paid calls are paused. Nothing was charged. Check the file, or delete it to start the day's count from zero.`);
    // A new UTC day starts from zero; reservations from yesterday belonged to yesterday.
    if (d.day !== day) return { day, spent_micro: 0, paid_calls: 0, pending: {} };
    d.pending = d.pending && typeof d.pending === "object" ? d.pending : {};
    d.unconfirmed = d.unconfirmed && typeof d.unconfirmed === "object" ? d.unconfirmed : {};
    // A reservation from a server that was killed mid-call may have been paid: count it as spent, to be safe,
    // and remember it, so a late answer for it neither counts it twice nor loses it.
    const nowMs = this.now().getTime();
    for (const [id, p] of Object.entries(d.pending)) {
      if (!Number.isInteger(p?.micro) || !(nowMs - Date.parse(p.at) <= STALE_RESERVATION_MS)) {
        if (Number.isInteger(p?.micro)) {
          d.spent_micro += p.micro;
          d.paid_calls = (d.paid_calls ?? 0) + 1;
          d.unconfirmed[id] = p.micro;
        }
        delete d.pending[id];
      }
    }
    if (!Object.keys(d.unconfirmed).length) delete d.unconfirmed;
    return d;
  }

  static pendingMicro(d) {
    return Object.values(d.pending ?? {}).reduce((n, p) => n + (p?.micro ?? 0), 0);
  }

  /** Today's totals: { day, spent_micro, paid_calls, limit_micro, reserved_micro, left_micro }. */
  status() {
    return this._serial(async () => {
      const d = await this._locked(async () => undefined); // read only
      const reserved = Budget.pendingMicro(d);
      return { day: d.day, spent_micro: d.spent_micro, paid_calls: d.paid_calls ?? 0, limit_micro: this.limit, reserved_micro: reserved, left_micro: Math.max(0, this.limit - d.spent_micro - reserved) };
    });
  }

  /** Reserve `priceMicro` or throw an Error explaining the cap. Returns { commit(), release() }, each safe to call once. */
  reserve(priceMicro) {
    return this._serial(async () => {
      if (this.limit <= 0) throw new Error("Paid calls are turned off (AGENT_REFEREE_DAILY_LIMIT_USD is 0).");
      const id = randomUUID();
      await this._locked(async (d) => {
        const reserved = Budget.pendingMicro(d);
        if (d.spent_micro + reserved + priceMicro > this.limit)
          throw new Error(
            `Daily spending cap reached: ${usd(d.spent_micro)} spent today (UTC)${reserved ? ` and ${usd(reserved)} in progress` : ""}, cap ${usd(this.limit)}, this call costs ${usd(priceMicro)}. The owner can raise AGENT_REFEREE_DAILY_LIMIT_USD in the MCP server's settings. Nothing was charged.`,
          );
        d.pending[id] = { micro: priceMicro, at: this.now().toISOString(), pid: process.pid };
        return d;
      });
      let done = false;
      const finish = (charged) => {
        if (done) return Promise.resolve();
        done = true;
        return this._serial(() =>
          this._locked(async (d) => {
            const countedStale = d.unconfirmed && id in d.unconfirmed;
            delete d.pending[id];
            if (countedStale) {
              // It went stale and already counts as spent. Confirmed: keep it. Definitely failed: give it back.
              delete d.unconfirmed[id];
              if (!charged) {
                d.spent_micro = Math.max(0, d.spent_micro - priceMicro);
                d.paid_calls = Math.max(0, (d.paid_calls ?? 1) - 1);
              }
            } else if (charged) {
              // Normal case, or a reservation from before midnight finishing after: count it (on the safe side).
              d.spent_micro += priceMicro;
              d.paid_calls = (d.paid_calls ?? 0) + 1;
            }
            if (d.unconfirmed && !Object.keys(d.unconfirmed).length) delete d.unconfirmed;
            return d;
          }),
        );
      };
      return { commit: () => finish(true), release: () => finish(false) };
    });
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Saved receipts: the service keeps no copy of a review, so the receipt on disk may be the only record. */
export class ReceiptStore {
  constructor({ dir, enabled = true }) {
    this.dir = join(dir, "receipts");
    this.enabled = enabled;
  }

  /** Saves { kind, id, ... } as <kind>-<id>.json. Returns the file path, or null when saving is off. */
  async save(kind, id, record) {
    if (!this.enabled) return null;
    if (!SAFE_ID.test(String(id))) throw new Error(`Refusing to save a receipt with an unexpected id: ${String(id).slice(0, 80)}`);
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${kind}-${id}.json`);
    await writeJsonAtomic(path, { kind, id, saved_at: new Date().toISOString(), ...record });
    return path;
  }

  /** Newest first: [{ file, kind, id, saved_at, summary }]. */
  async list(limit = 20) {
    let names;
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const items = [];
    for (const name of names) {
      try {
        const r = JSON.parse(await readFile(join(this.dir, name), "utf8"));
        items.push({ file: join(this.dir, name), kind: r.kind, id: r.id, saved_at: r.saved_at, summary: r.summary ?? null });
      } catch {}
    }
    items.sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)));
    return items.slice(0, limit);
  }

  /** The full saved record for an id (any kind), or null. */
  async get(id) {
    if (!SAFE_ID.test(String(id))) return null;
    for (const kind of ["review", "match", "pending"]) {
      try {
        return JSON.parse(await readFile(join(this.dir, `${kind}-${id}.json`), "utf8"));
      } catch {}
    }
    return null;
  }
}
