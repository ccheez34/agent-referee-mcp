// The gate's own state: used approval nonces, accepted receipts, revocations seen, locks, spends and a decision log.
// Every record that must happen once is a file created with "wx" (fails if it exists), so two gate processes sharing
// the folder can't both win. The folder must be out of reach of the sessions the gate binds (DESIGN §3B, §3D):
// a session that can delete files here can undo its own used-nonce records.
import { mkdir, open, readFile, readdir, unlink, writeFile, appendFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const SAFE = /^[A-Za-z0-9._-]{1,200}$/;

export class GateState {
  constructor(dir) {
    if (!dir) throw new Error("The gate needs a state folder (GATE_STATE_DIR).");
    this.dir = dir;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
  }

  path(name) {
    if (!SAFE.test(name)) throw new Error(`Unsafe state file name: ${String(name).slice(0, 80)}`);
    return join(this.dir, name);
  }

  /** Creates the file only if it doesn't exist. Returns true if this call created it. */
  async createOnce(name, record) {
    let h;
    try {
      h = await open(this.path(name), "wx");
    } catch (e) {
      if (e?.code === "EEXIST") return false;
      throw e;
    }
    try {
      await h.writeFile(JSON.stringify(record));
    } finally {
      await h.close();
    }
    return true;
  }

  async read(name) {
    try {
      return JSON.parse(await readFile(this.path(name), "utf8"));
    } catch (e) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }

  async exists(name) {
    return (await this.read(name)) !== null;
  }

  async remove(name) {
    try {
      await unlink(this.path(name));
      return true;
    } catch (e) {
      if (e?.code === "ENOENT") return false;
      throw e;
    }
  }

  async list(prefix) {
    const names = await readdir(this.dir).catch(() => []);
    return names.filter((n) => n.startsWith(prefix));
  }

  async writeAtomic(name, record) {
    const tmp = this.path(`${name}.${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(tmp, JSON.stringify(record));
    await rename(tmp, this.path(name));
  }

  /** Runs fn while holding a short-lived mutex file (for read-modify-write such as budgets). */
  async withMutex(name, fn, { timeoutMs = 5000, staleMs = 30_000 } = {}) {
    const lock = `mutex-${name}`;
    const started = Date.now();
    for (;;) {
      if (await this.createOnce(lock, { at: Date.now() })) break;
      const held = await this.read(lock).catch(() => null);
      if (held && Date.now() - held.at > staleMs) await this.remove(lock); // a crashed holder
      if (Date.now() - started > timeoutMs) throw new Error(`The gate's ${name} record is busy; try again.`);
      await new Promise((r) => setTimeout(r, 25));
    }
    try {
      return await fn();
    } finally {
      await this.remove(lock);
    }
  }

  /** One line per decision, for the records. Never holds secrets: actions, targets, hashes, ids and reasons only. */
  async log(entry) {
    await appendFile(this.path("decisions.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  }
}
