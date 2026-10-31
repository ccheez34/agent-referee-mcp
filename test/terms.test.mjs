// AGENT_REFEREE_ACCEPT_TERMS (option A of the terms-binding spec): the owner's accepted Terms version goes to the
// service on every request, through any fetch (team and paying ones included), and never to another host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTools, makeTermsFetch } from "../src/tools.mjs";
import { loadConfig } from "../src/server.mjs";

test("config: unset by default; a malformed version is refused", () => {
  assert.equal(loadConfig({}).acceptTerms, undefined);
  assert.equal(loadConfig({ AGENT_REFEREE_ACCEPT_TERMS: " v2026-11-01 " }).acceptTerms, "v2026-11-01");
  for (const bad of ["2026-11-01", "latest", "v2026-11-01x"]) assert.throws(() => loadConfig({ AGENT_REFEREE_ACCEPT_TERMS: bad }), /ACCEPT_TERMS/);
});

test("makeTermsFetch: the header only under the service's own address, kept with other headers, through a wrapper", async () => {
  const seen = [];
  const base = async (url, init) => (seen.push({ url: String(url?.href ?? url), h: Object.fromEntries(new Headers(init.headers ?? {})) }), new Response("{}"));
  // A stand-in payment wrapper: sends once, then again with X-PAYMENT, keeping the caller's headers.
  const paying = async (url, init) => {
    await base(url, init);
    const h = new Headers(init.headers);
    h.set("x-payment", "proof");
    return base(url, { ...init, headers: h });
  };
  const f = makeTermsFetch("v2026-11-01", "https://agentreferee.ai", paying);
  await f("https://agentreferee.ai/review-3", { headers: { "content-type": "application/json" } });
  await f("https://elsewhere.example/review-3", { headers: {} });
  assert.equal(seen[0].h["x-accept-terms"], "v2026-11-01");
  assert.equal(seen[0].h["content-type"], "application/json");
  assert.equal(seen[1].h["x-accept-terms"], "v2026-11-01", "kept on the paid retry");
  assert.equal(seen[1].h["x-payment"], "proof");
  assert.equal(seen[2].h["x-accept-terms"], undefined, "never to another host");
});

test("createTools: every client gets the terms fetch only when the owner set a version (no network)", async () => {
  const seen = [];
  const recordingFetch = async (url, init) => (seen.push(Object.fromEntries(new Headers(init.headers ?? {}))), new Response("{}"));
  const base = { publicKeys: [], dailyLimitMicro: 0, url: "https://agentreferee.ai", team: { member: "3.0" } };
  for (const acceptTerms of [undefined, "v2026-11-01"]) {
    const made = [];
    const makeClient = (o) => (made.push(o), { _call: async () => ({}) });
    createTools({ config: { ...base, acceptTerms }, makeClient, makePayingFetch: () => null, budget: {}, receipts: {}, baseFetch: recordingFetch })
      .find((t) => t.name === "team_allowance").handler({}).catch(() => {});
    await made[0].fetch("https://agentreferee.ai/team/allowance", {});
    const h = seen.at(-1);
    assert.equal(h["x-accept-terms"], acceptTerms, String(acceptTerms));
    assert.equal(h["x-team-member"], "3.0", "the team headers are still there");
  }
});
