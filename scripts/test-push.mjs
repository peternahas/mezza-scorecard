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
      return send(200, [{ id: 25154, name: "16 Garland" }, { id: 25554, name: "7001 Mumford" }]);
    }
    if (u.pathname.endsWith("/labour-actuals")) {
      labourCalls++;
      if (mode === "blocked") return send(200, { status: "failed", message: "Insufficient permissions" });
      if (mode === "badtoken") return send(401, { message: "Unauthorized" });
      const start = u.searchParams.get("start");
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
  check("the detail explains the ask, not just the error", () => {
    assert.match(data.status_detail, /entitlement on Push's side/);
    assert.match(data.status_detail, /department-level/);
  });
  check("it gives up after the first refusal instead of hammering payroll", () =>
    assert.ok(labourCalls <= 8, `made ${labourCalls} calls`));
  check("the refusal is surfaced in the log", () => assert.match(out, /Insufficient permissions/));
  check("Charlottetown is recorded as a known gap, not silently absent", () => {
    assert.ok(data.known_gaps.some((g) => g.location === "Charlottetown"));
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
  check("all seven Corp locations are covered", () =>
    assert.strictEqual(new Set(data.days.map((d) => d.Location_Name)).size, 7));
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
