// The JSONC reader the stand-in uses for the server's wrangler.jsonc (test/fake-service.mjs): comments and trailing
// commas go, strings stay whole (a URL's "//" and a ", }" inside a string included).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonc, modelSettings, MODEL_KEYS, serverAvailable } from "./fake-service.mjs";

test("parseJsonc: comments and trailing commas dropped, strings kept whole", () => {
  const text = '{\n  // a line comment, with "quotes"\n  "url": "https://x.example//y", /* a block */ "s": "a, }",\n  "list": [1, 2, /* x */ ],\n  "esc": "a \\"quoted\\" // not a comment",\n}';
  assert.deepEqual(parseJsonc(text), { url: "https://x.example//y", s: "a, }", list: [1, 2], esc: 'a "quoted" // not a comment' });
  assert.throws(() => parseJsonc("{ \"a\": }"));
});

test("modelSettings: the server's own model settings, only the known keys", { skip: !serverAvailable() && "needs the server repo" }, () => {
  const s = modelSettings();
  assert.ok(s.JUDGE_MODEL_POOL, "a judge pool");
  for (const k of Object.keys(s)) assert.ok(MODEL_KEYS.includes(k), k);
});
