// Reads a wallet's private key from a file for the test scripts. The key is returned to the caller only: never printed.
import { readFile } from "node:fs/promises";

const HEX64 = /0x[0-9a-fA-F]{64}/g;

/** The single 0x-prefixed 64-hex value in the file; if there are several (a transaction hash, say), the one on a line that mentions "key". */
export async function readWalletKey(path) {
  const text = await readFile(path, "utf8");
  const all = [...new Set(text.match(HEX64) ?? [])];
  if (all.length === 1) return all[0];
  if (!all.length) throw new Error("No 0x-prefixed 64-character key found in the wallet file.");
  const onKeyLines = [...new Set(text.split(/\r?\n/).filter((l) => /key/i.test(l)).flatMap((l) => l.match(HEX64) ?? []))];
  if (onKeyLines.length === 1) return onKeyLines[0];
  throw new Error("The wallet file has several 64-character hex values and it isn't clear which is the private key. Use a file that holds only the key (or put it on a line with the word \"key\").");
}
