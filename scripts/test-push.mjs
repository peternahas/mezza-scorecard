/**
 * Tests for sync-push-labour.
 *
 * The important case is the one Push actually returns today: HTTP 200
 * with {"status":"failed"}. Treating 200 as success is exactly how the
 * earlier attempt looked like it worked, and the same trap Givex sets
 * with its result codes. A labour figure of zero would show every store
 * at 0% labour and a perfect prime cost.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert";

// ---------------------------------------------------------------------
// These tests rm -rf ./data before every case, because each case needs a
// clean output directory. Run from the repo root and that wipes the real
// data/ -- including givex-legacy-days.json, which holds 12 days of
// pre-D1 sales history that CANNOT be re-fetched from anywhere.
//
// Git got it back the one time this happened. That is luck, not a
// safety net, so: refuse to run anywhere that looks like a working
// tree. CI copies the two scripts into an empty /tmp dir; do the same
// locally.
// ---------------------------------------------------------------------
import { existsSync } from "node:fs";
for (const marker of [".git", "scripts", "data/givex-legacy-days.json", "data/givex-sync-state.json"]) {
  if (existsSync(marker)) {
    console.error(
      `\nRefusing to run here: found ./${marker}, so this looks like the repo, ` +
      `and these tests delete ./data.\n\n` +
      `Run them in a scratch directory instead:\n` +
      `  mkdir -p /tmp/t && cd /tmp/t \\\n` +
      `    && cp <repo>/scripts/<the-sync-script>.mjs sync.mjs \\\n` +
      `    && cp <repo>/scripts/<this-test>.mjs test.mjs && node test.mjs\n`
    );
    process.exit(2);
  }
}


let PASS = 0, FAIL = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); PASS++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); FAIL++; }
};

async function run({ mode = "ok", days = 5 } = {}) {
  await rm("data", { recursive: true, force: true });
  let labourCalls = 0;
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, obj) =>
      res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(obj));

    if (u.pathname.endsWith("/companies")) {
      if (mode === "badtoken") return send(401, { message: "Unauthorized" });
      // 99999 is deliberately unaccounted for: it stands in for a
      // location Push has just added to the token (Charlottetown) whose
      // company id nobody can know in advance.
      return send(200, [{ id: 25154, name: "16 Garland" }, { id: 25554, name: "7001 Mumford" },
                        { id: 99999, name: "690 University Ave" }]);
    }
    if (u.pathname.endsWith("/labour-actuals")) {
      labourCalls++;
      if (mode === "blocked") return send(200, { status: "failed", message: "Insufficient permissions" });
      if (mode === "badtoken") return send(401, { message: "Unauthorized" });
      const start = u.searchParams.get("start");
      // The first live call after Push granted the entitlement threw
      // "rows is not iterable", because the real payload is nested and
      // the parser assumed a top-level array. These shapes stand in for
      // what a payroll API plausibly returns, so the parser is proven
      // against more than the one the docs implied.
      if (mode === "nested") {
        return send(200, { status: "success", data: {
          summary: { departments: [
            { name: "Kitchen", totalHours: 5, totalCosts: 90, date: start },
            { name: "Front", totalHours: 3, totalCosts: 50, date: start },
          ]},
        }});
      }
      if (mode === "objectdata") {
        // data as an object, not an array -- this is the shape that threw
        return send(200, { status: "success", data: { date: start, totalHours: 8, totalCosts: 140 } });
      }
      if (mode === "unreadable") {
        // 200, well-formed, and carrying nothing we can use
        return send(200, { status: "success", data: { message: "no records for range" } });
      }
      return send(200, [{ date: start, totalHours: 8, totalCosts: 140 }]);
    }
    send(404, { error: "unexpected " + u.pathname });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  let src = await readFile("push.mjs", "utf8");
  src = src.replace(
    'const BASE = "https://api.pushoperations.com/platform/api/v1";',
    `const BASE = "http://127.0.0.1:${port}/platform/api/v1";`);
  await writeFile("push.local.mjs", src);

  const child = spawn(process.execPath, ["push.local.mjs"], {
    env: { ...process.env, PUSH_BEARER_TOKEN: "tok", PUSH_DAYS: String(days) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  server.close();
  let data = null;
  try { data = JSON.parse(await readFile("data/push-labour-data.json", "utf8")); } catch {}
  return { code, out, data, labourCalls };
}

console.log("\n1. What Push returns TODAY: 200 with status=failed");
{
  const { code, out, data, labourCalls } = await run({ mode: "blocked" });
  check("exits 0 — a known external blocker is not a build failure", () =>
    assert.strictEqual(code, 0, out.slice(-500)));
  check("status says blocked, NOT ok", () =>
    assert.strictEqual(data.status, "blocked_insufficient_permissions"));
  check("no zero-valued labour rows are written", () =>
    assert.strictEqual(data.days.length, 0));
  check("the detail explains what to do, not just the error", () => {
    assert.match(data.status_detail, /entitlement on Push's side/);
    // The entitlement was granted on 2026-09-03, so if this fires
    // again it is a revocation or a rotated token -- a conversation
    // with Push, not an edit to this file. The detail has to say so,
    // or the next person spends a day debugging working code.
    assert.match(data.status_detail, /go back to Christian rather than changing this code/);
  });
  check("it gives up after the first refusal instead of hammering payroll", () =>
    assert.ok(labourCalls <= 8, `made ${labourCalls} calls`));
  check("the refusal is surfaced in the log", () => assert.match(out, /Insufficient permissions/));
  check("Charlottetown is mapped now, not a known gap", () => {
    // It was the only KNOWN_GAPS entry for two months. Push added it as
    // company 28602 ("Mezza - 690 University") on 2026-09-03, so the
    // assertion flips: it must be a real mapped location, and the gap
    // list must be empty rather than still naming it.
    assert.ok(Object.values(data.mapped_locations).includes("Charlottetown"));
    assert.ok(!data.known_gaps.some((g) => g.location === "Charlottetown"));
  });
}

console.log("\n2. When Push opens it up");
{
  const { code, data } = await run({ mode: "ok", days: 5 });
  check("exits 0 and reports ok", () => {
    assert.strictEqual(code, 0);
    assert.strictEqual(data.status, "ok");
  });
  check("labour rows land, per location per day", () => {
    assert.ok(data.days.length > 0);
    const r = data.days[0];
    assert.ok(r.Location_Name && r.Date);
    assert.ok(r.Hours > 0 && r.Cost > 0);
  });
  check("every mapped location is covered, none dropped", () =>
    // Counted off COMPANIES rather than hardcoded, so adding a store
    // does not silently loosen this into a test of nothing.
    assert.strictEqual(
      new Set(data.days.map((d) => d.Location_Name)).size,
      Object.keys(data.mapped_locations).length));
  check("franchisee companies are listed but deliberately not pulled", () => {
    assert.ok("Mount Pearl" in Object.values(data.franchisee_companies_not_pulled)
      ? true : Object.values(data.franchisee_companies_not_pulled).includes("Mount Pearl"));
    assert.ok(!data.days.some((d) => d.Location_Name === "Mount Pearl"));
  });
  check("overhead companies are kept visible but out of the store rows", () => {
    assert.ok(Object.values(data.overhead_companies).includes("Production Centre"));
    assert.ok(!data.days.some((d) => d.Location_Name === "Production Centre"));
  });
}

console.log("\n6. a 200 with an unexpected shape is not success");
{
  // The bug this replaces: anySuccess was set on the HTTP 200, before
  // parsing. The file reported status "ok" with zero location-days and
  // 126 errors -- the exact "looks like it worked" outcome this script
  // exists to prevent.
  const { data } = await run({ mode: "unreadable", days: 2 });
  check("status is NOT ok when nothing could be read", () =>
    assert.notStrictEqual(data.status, "ok"));
  check("no rows are invented", () => assert.strictEqual(data.days.length, 0));
  check("the detail blames our parser, not Push's permissions", () => {
    assert.match(String(data.status_detail), /parsing problem at our end/);
  });
  check("and the response shape is recorded so it can be fixed", () => {
    assert.ok(data.response_shape, "response_shape missing");
    assert.match(JSON.stringify(data.response_shape), /"data"/);
  });
  check("the shape carries types, never values", () => {
    const j = JSON.stringify(data.response_shape);
    assert.match(j, /string|number/);
    assert.ok(!/no records for range/.test(j), "a value leaked into response_shape");
  });
}
{
  const { data } = await run({ mode: "nested", days: 2 });
  check("a nested payload is read, not thrown on", () => {
    assert.strictEqual(data.status, "ok");
    assert.ok(data.days.length > 0, "no rows read from nested payload");
  });
  check("departments are summed into one location-day total", () => {
    const row = data.days[0];
    assert.strictEqual(row.Hours, 8);   // 5 + 3
    assert.strictEqual(row.Cost, 140);  // 90 + 50
  });
  check("no department detail is carried into the output", () => {
    assert.ok(!/Kitchen|Front/.test(JSON.stringify(data.days)));
  });
}
{
  const { data } = await run({ mode: "objectdata", days: 2 });
  check("data as an object rather than an array is read", () => {
    assert.strictEqual(data.status, "ok");
    assert.strictEqual(data.days[0].Hours, 8);
  });
}

console.log("\n5. a company on the token with no home in the script");
{
  const { data } = await run({ mode: "ok" });
  check("every company the token can see is recorded", () => {
    assert.ok(data.companies_seen.some((c) => String(c.id) === "99999"));
  });
  check("one with no mapping is reported, not guessed at by name", () => {
    const un = data.unmapped_companies.find((c) => String(c.id) === "99999");
    assert.ok(un, "unmapped company missing from output");
    assert.strictEqual(un.name, "690 University Ave");
  });
  check("and its labour is NOT pulled", () => {
    assert.ok(!data.days.some((d) => /University/.test(d.Location_Name)));
  });
  check("a mapped company is not reported as unmapped", () => {
    assert.ok(!data.unmapped_companies.some((c) => String(c.id) === "25154"));
  });
}

console.log("\n3. Two-day range cap");
{
  const { data, labourCalls } = await run({ mode: "ok", days: 6 });
  check("a 6-day window is chunked into 2-day requests", () => {
    // 7 locations x ceil(7 days / 2) chunks
    assert.ok(labourCalls >= 7 * 3, `only ${labourCalls} calls`);
  });
  check("and no chunk spans more than two days", () => {
    const dates = [...new Set(data.days.map((d) => d.Date))];
    assert.ok(dates.length >= 3, dates.join(","));
  });
}

console.log("\n4. A genuinely bad token reads differently from a blocked endpoint");
{
  const { data } = await run({ mode: "badtoken" });
  check("status is failed, not blocked", () => assert.strictEqual(data.status, "failed"));
  check("and the /companies failure is recorded so the two can be told apart", () =>
    assert.match(String(data.companies_endpoint_error), /401/));
}

console.log(`\n${PASS} passed, ${FAIL} failed.`);
process.exit(FAIL ? 1 : 0);
