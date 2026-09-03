/**
 * Tests for the sync watchdog.
 *
 * A watchdog that fails quietly is worse than no watchdog, because it
 * also removes the reason anyone would look. So the cases that matter
 * most here are the failure ones: feed unreadable, dispatch refused,
 * token expired.
 */
import assert from "node:assert";

const mod = (await import("./worker.js")).default;
let PASS = 0, FAIL = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); PASS++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); FAIL++; }
};

const realFetch = globalThis.fetch;
function stub({ ages = {}, feedStatus = 200, dispatchStatus = 204 }) {
  const calls = { reads: [], dispatches: [] };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/dispatches")) {
      calls.dispatches.push(u.match(/workflows\/([^/]+)\//)[1]);
      return dispatchStatus === 204
        ? new Response(null, { status: 204 })
        : new Response("nope", { status: dispatchStatus });
    }
    if (u.includes("/contents/")) {
      const path = decodeURIComponent(u.match(/contents\/([^?]+)/)[1]);
      calls.reads.push(path);
      if (feedStatus !== 200) return new Response("bad credentials", { status: feedStatus });
      const min = ages[path];
      if (min === "nogen") return new Response(JSON.stringify({ hello: 1 }), { status: 200 });
      const gen = new Date(Date.now() - min * 60000).toISOString();
      return new Response(JSON.stringify({ generated_at: gen, source: "x", days: [] }), { status: 200 });
    }
    throw new Error("unexpected fetch " + u);
  };
  return calls;
}
const env = { GITHUB_TOKEN: "tok", CRON_SHARED_SECRET: "s3cret" };
const get = (auth) =>
  mod.fetch(new Request("https://x/", { headers: auth ? { Authorization: auth } : {} }), env);

const FRESH = { "data/givex-sales-data.json": 10, "data/scorecard-data.json": 30 };
const STALE = { "data/givex-sales-data.json": 90, "data/scorecard-data.json": 30 };
const DEAD  = { "data/givex-sales-data.json": 400, "data/scorecard-data.json": 30 };

console.log("\n1. A healthy pipeline costs one read and no workflow run");
{
  const calls = stub({ ages: FRESH });
  const res = await get("s3cret");
  const body = await res.json();
  check("returns 200 and reports healthy", () => {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.healthy, true);
  });
  check("nothing was dispatched", () => assert.strictEqual(calls.dispatches.length, 0));
  check("both feeds were read", () => assert.strictEqual(calls.reads.length, 2));
  check("says why it did nothing", () => assert.match(body.jobs[0].action, /^ok \(10 min old\)/));
}

console.log("\n2. A stale feed gets the workflow dispatched");
{
  const calls = stub({ ages: STALE });
  const body = await (await get("s3cret")).json();
  check("only the stale workflow is dispatched", () =>
    assert.deepStrictEqual(calls.dispatches, ["sync-givex-data.yml"]));
  check("the dispatch is recorded", () => assert.strictEqual(body.jobs[0].dispatched, true));
  check("the reason names the age and the threshold", () =>
    assert.match(body.jobs[0].action, /90 min old, threshold 45/));
  check("still healthy — a skipped run is not an emergency", () =>
    assert.strictEqual(body.healthy, true));
}

console.log("\n3. Past the alert threshold it says so loudly");
{
  stub({ ages: DEAD });
  const res = await get("s3cret");
  const body = await res.json();
  check("returns 503 so an uptime monitor notices", () => assert.strictEqual(res.status, 503));
  check("not healthy", () => assert.strictEqual(body.healthy, false));
  check("the alert explains what to check, not just that it is broken", () => {
    assert.strictEqual(body.alerts.length, 1);
    assert.match(body.alerts[0], /400 min old/);
    assert.match(body.alerts[0], /Actions tab/);
    assert.match(body.alerts[0], /Givex is still pushing/);
  });
}

console.log("\n4. Failure modes — the cases that actually matter");
{
  // An expired or wrongly-scoped token is the most likely real failure,
  // and it must not look like a healthy pipeline.
  const calls = stub({ ages: FRESH, feedStatus: 401 });
  const res = await get("s3cret");
  const body = await res.json();
  check("an unreadable feed dispatches anyway", () =>
    assert.strictEqual(calls.dispatches.length, 2));
  check("and is reported as an alert, not as healthy", () => {
    assert.strictEqual(body.healthy, false);
    assert.strictEqual(res.status, 503);
    assert.match(body.alerts[0], /feed read failed: 401/);
  });
}
{
  const calls = stub({ ages: STALE, dispatchStatus: 403 });
  const body = await (await get("s3cret")).json();
  check("a refused dispatch is surfaced, not swallowed", () => {
    assert.strictEqual(body.jobs[0].dispatched, false);
    assert.match(body.jobs[0].error, /403/);
  });
}
{
  stub({ ages: { "data/givex-sales-data.json": "nogen", "data/scorecard-data.json": 30 } });
  const body = await (await get("s3cret")).json();
  check("a feed with no generated_at is an alert", () =>
    assert.match(body.alerts[0], /no generated_at/));
}

console.log("\n5. The on-demand endpoint cannot be used by anyone else");
{
  const calls = stub({ ages: STALE });
  const res = await get(null);
  check("no secret means 401", () => assert.strictEqual(res.status, 401));
  check("and no dispatch happens", () => assert.strictEqual(calls.dispatches.length, 0));
  const res2 = await get("wrong");
  check("a wrong secret means 401 too", () => assert.strictEqual(res2.status, 401));
  const res3 = await mod.fetch(new Request("https://x/health"), env);
  check("but /health stays open for uptime monitoring", async () =>
    assert.strictEqual(res3.status, 200));
}

console.log("\n6. The cron path runs the same check and logs it");
{
  const calls = stub({ ages: DEAD });
  const logs = [], errs = [];
  const [ol, oe] = [console.log, console.error];
  console.log = (m) => logs.push(String(m));
  console.error = (m) => errs.push(String(m));
  await mod.scheduled({}, env, {});
  console.log = ol; console.error = oe;
  check("the cron dispatches", () => assert.strictEqual(calls.dispatches.length, 1));
  check("logs each job", () => assert.ok(logs.some((l) => /Givex sales:/.test(l))));
  check("writes alerts at error level so they can be filtered", () =>
    assert.ok(errs.some((l) => /^ALERT:/.test(l))));
}

globalThis.fetch = realFetch;
console.log(`\n${PASS} passed, ${FAIL} failed.`);
process.exit(FAIL ? 1 : 0);
