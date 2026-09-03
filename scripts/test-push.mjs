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
      if (mode === "real") {
        // The shape a probe run actually returned. Note that BOTH levels
        // carry hours and costs -- that is what produced the
        // double-count. Two departments per calendar day, over the
        // distinct days the request actually covers (the last chunk of a
        // window can be a single day, where start === end).
        const end = u.searchParams.get("end");
        const dates = start === end ? [start] : [start, end];
        const rows = [];
        for (const dt of dates) {
          rows.push({ date: dt, hours: 5, costs: 90, departmentId: 1, departmentName: null });
          rows.push({ date: dt, hours: 3, costs: 50, departmentId: 2, departmentName: null });
        }
        return send(200, { data: {
          companyId: 25154,
          totalHours: 8 * dates.length,
          totalCosts: 140 * dates.length,
          labourActualByDate: rows,
        }});
      }
      if (mode === "totalsdrift") {
        // Per-date rows that do not add up to Push's own range total.
        return send(200, { data: {
          companyId: 25154, totalHours: 99, totalCosts: 999,
          labourActualByDate: [{ date: start, hours: 5, costs: 90, departmentId: 1, departmentName: null }],
        }});
      }
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
    env: { ...process.env, PUSH_BEARER_TOKEN: "tok", PUSH_DAYS: String(days), PUSH_PACE_MS: "0",
           LABOUR_TARGETS_PATH: "labour-targets.json" },
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

console.log("\n8. budgeted labour targets travel with the data");
{
  await writeFile("labour-targets.json", JSON.stringify({
    network_target: 26,
    targets: { "Burnside": 24.5, "Barrington": null, "Charlottetown": 0 },
  }));
  const { data, out } = await run({ mode: "real", days: 2 });
  check("a set target is carried into the feed", () =>
    assert.strictEqual(data.labour_targets["Burnside"], 24.5));
  check("an unset target is NOT silently turned into zero", () => {
    // A store with no budget must read as "no target", never as a
    // target of 0% -- which would show it as catastrophically over.
    assert.ok(!("Barrington" in data.labour_targets));
    assert.ok(!("Charlottetown" in data.labour_targets));
  });
  check("stores without a target are named", () => {
    assert.deepStrictEqual(data.labour_targets_unset.sort(), ["Barrington", "Charlottetown"]);
    assert.match(out, /No labour target set for 2 location/);
  });
  check("the network fallback is carried too", () =>
    assert.strictEqual(data.labour_target_network, 26));
  await rm("labour-targets.json", { force: true });
}
{
  const { data } = await run({ mode: "real", days: 2 });
  check("no targets file at all degrades quietly", () => {
    assert.deepStrictEqual(data.labour_targets, {});
    assert.strictEqual(data.labour_target_network, null);
  });
}

console.log("\n7. the real response shape, and the double-count it caused");
{
  // REGRESSION. The tolerant walker stopped at `data` -- which itself
  // carries totalHours/totalCosts -- and never descended into
  // labourActualByDate. Each 2-day request produced ONE row holding the
  // 2-day total, filed under the first date: every other calendar day
  // missing, every present day roughly double. Burnside read 103 hours
  // on a Thursday. Wrong in a way that looks entirely plausible.
  const { data } = await run({ mode: "real", days: 4 });
  const one = data.days.filter((r) => r.Location_Name === "Burnside");
  check("status ok", () => assert.strictEqual(data.status, "ok"));
  check("EVERY calendar day in the window gets its own row", () => {
    // The bug lost every second day. A 4-day window must produce 4 (or
    // 5, counting today) consecutive dates for one store -- never 2.
    const dates = one.map((r) => r.Date).sort();
    assert.ok(dates.length >= 4, `only ${dates.length} day(s): ${dates.join(",")}`);
    assert.strictEqual(new Set(dates).size, dates.length, "duplicate dates: " + dates.join(","));
  });
  check("each day holds ONE day of labour, not a 2-day total", () => {
    for (const r of one) {
      assert.strictEqual(r.Hours, 8, `${r.Date} -> ${r.Hours}h`);   // 5 + 3, two departments
      assert.strictEqual(r.Cost, 140);
    }
  });
  check("the range total is not added as a row of its own", () => {
    // Doubling would show as 16h days; a phantom total row would show
    // as an extra date carrying a multiple of a day.
    assert.ok(one.every((r) => r.Hours === 8));
  });
  check("the documented path was used, not the fallback walker", () =>
    assert.strictEqual(data.fallback_walk_used, 0));
  check("no department detail reaches the output", () =>
    assert.ok(!/department/i.test(JSON.stringify(data.days))));
  check("sum matches Push's own range total, so no mismatch recorded", () =>
    assert.strictEqual(data.totals_mismatch_count, 0));
}
{
  const { data } = await run({ mode: "totalsdrift", days: 2 });
  check("rows that do not add up to Push's total are flagged", () => {
    assert.ok(data.totals_mismatch_count > 0);
    const m = data.totals_mismatches[0];
    assert.strictEqual(m.push_total_hours, 99);
    assert.strictEqual(m.summed_hours, 5);
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
