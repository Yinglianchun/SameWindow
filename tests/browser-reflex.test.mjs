import assert from 'node:assert/strict';
import test from 'node:test';
import { runReflex, jevDecision } from '../src/browser-reflex.mjs';
test('bounded decisions reject stale and forged input, uncertain retries, and late completion', async () => {
const url = "http://127.0.0.1:9876/";
const input = { tabRef: "tab-1", goal: "Show the result", expectedText: "RESULT_READY",
  allowedUrls: [url], approvedActions: [{ kind: "click", name: "Show result", role: "button", url }] };
const initial = { tabRef: "tab-1", url, visibleText: "Choose a button", stamp: "initial",
  elements: [{ ref: "e1", role: "button", name: "Show result", type: null }] };
const options = { mode: "bounded", allowedOrigins: [new URL(url).origin] };
let mutations = 0, changed = false;
const host = { checkControl() {}, observe: async () => changed ? { ...initial, stamp: "result", visibleText: "RESULT_READY" } : initial,
  fresh: async () => true, act: async (_a, _s, guard) => { await guard(); mutations++; changed = true; } };
assert.equal((await runReflex(input, host)).stopReason, "reflex_off");
assert.equal(mutations, 0);
const pressInput = { ...input, approvedActions: [{ kind: "press", key: "Enter", url, requiresInputText: "rain" }] };
await runReflex(pressInput, host, { ...options, mode: "shadow", decide: async (_state, candidates) => {
  assert.equal(candidates.some(c => c.kind === "press"), false);
  return { choice: "HANDOFF" };
} });
await assert.rejects(runReflex({ ...input, allowedUrls: ["https://example.com/"] }, host,
  { ...options, allowedSiteOrigins: ["https://example.com"] }), /local_fixture/);
assert.equal((await runReflex({ ...input, maxSteps: 1, expectedText: "never", allowedUrls: ["https://x.com/home"], approvedActions: [] },
  { ...host, observe: async () => ({ ...initial, url: "https://x.com/home" }) },
  { ...options, mode: "shadow", allowedSiteOrigins: ["https://x.com"], decide: async () => ({ choice: "HANDOFF" }) })).stopReason, "shadow_only");
assert.equal((await runReflex({ ...input, approvedActions: [] }, { ...host,
  observe: async () => ({ ...initial, elements: [...initial.elements, { ...initial.elements[0], ref: "e2" }] }),
  candidateRules: async () => [{ ...input.approvedActions[0], observedRef: "e2" }],
}, { ...options, mode: "shadow", decide: async (_state, candidates) => {
  assert.equal(candidates.find(c => c.id === "a1")?.ref, "e2"); return { choice: "a1" };
} })).stopReason, "shadow_only");
assert.equal((await runReflex({ ...input, approvedActions: [] }, { ...host,
  allowUrl: () => true,
  candidateRules: async () => [{ ...input.approvedActions[0], url: "https://example.com/" }],
}, { ...options, allowedSiteOrigins: ["https://example.com"] })).stopReason, "pilot_requires_local_fixture");
assert.equal((await runReflex(input, host, { ...options, mode: "shadow", decide: async () => ({ choice: "a1" }) })).stopReason, "shadow_only");
assert.equal(mutations, 0);
assert.equal((await runReflex(input, host, { ...options, decide: async () => ({ choice: "forged" }) })).stopReason, "unknown_candidate");
assert.equal(mutations, 0);
assert.equal((await runReflex(input, host, { ...options, decide: async () => ({ choice: "DONE" }) })).stopReason, "completion_not_verified");
assert.equal((await runReflex(input, { ...host, fresh: async () => false }, { ...options, decide: async () => ({ choice: "a1" }) })).stopReason, "page_keeps_changing");
assert.equal(mutations, 0);
assert.equal((await runReflex(input, host, { ...options, decide: async () => ({ choice: "a1" }) })).status, "completed");
assert.equal(mutations, 1);
changed = false;
assert.equal((await runReflex(input, { ...host, act: async () => { throw new Error("uncertain"); } },
  { ...options, decide: async () => ({ choice: "a1" }) })).executedSteps[0].outcome, "uncertain");
assert.equal((await runReflex({ ...input, maxSteps: 1 }, host, { ...options, decide: async () => ({ choice: "WAIT" }) })).stopReason, "step_budget");
const cancellation = new AbortController(); cancellation.abort();
assert.equal((await runReflex(input, host, { ...options, signal: cancellation.signal })).status, "cancelled");
changed = false;
assert.equal((await runReflex({ ...input, deadlineMs: 500 }, host, { ...options,
  decide: async () => { await new Promise(r => setTimeout(r, 550)); return { choice: "a1" }; } })).status, "timed_out");
assert.equal((await runReflex({ ...input, deadlineMs: 500 }, { ...host,
  verify: async () => { await new Promise(r => setTimeout(r, 550)); return true; } }, options)).status, "timed_out");
await assert.rejects(runReflex({ ...input, allowedUrls: ["https://example.com/"] }, host, options), /local_fixture/);

});

test('Jev accepts only validated receipts from the fixed endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const candidates = [{id: 'a1', description: 'approved click'}];
  let receipt = {model: 'jev-1.13.0', answers: {next_action: {type: 'choice', choice: 'a1', confidence: 0.9}}, usage: {input_tokens: 10}};
  try {
    globalThis.fetch = async (endpoint, options) => {
      assert.equal(endpoint, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body).questions.next_action.criteria, {a1: 'approved click'});
      return new Response(JSON.stringify(receipt), {status: 200});
    };
    assert.equal((await jevDecision({trusted_goal: 'search'}, candidates, undefined, 'fixture-key')).choice, 'a1');
    receipt.answers.next_action.choice = 'invented-action';
    await assert.rejects(jevDecision({}, candidates, undefined, 'fixture-key'), /invalid_jev_receipt/);
    globalThis.fetch = async () => new Response('denied', {status: 401});
    await assert.rejects(jevDecision({}, candidates, undefined, 'fixture-key'), /jev_http_401/);
  } finally { globalThis.fetch = originalFetch; }
});

