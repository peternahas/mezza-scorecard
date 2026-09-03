/**
 * Tests for sync-google-to-json.
 *
 * This script has never been executed against anything. Peter is about
 * to spend a one-time OAuth consent on it, and if it then fails in CI
 * the consent is not wasted but his afternoon is. So it gets driven
 * end to end against a stubbed Google before it goes anywhere near the
 * real one -- including the failure modes that actually happen:
 * SERVICE_DISABLED on one of the four APIs, an expired refresh token,
 * and a 429.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert";

let PASS = 0, FAIL = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); PASS++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); FAIL++; }
};

const STARS = ["ONE","TWO","THREE","FOUR","FIVE"];
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function reviewsFor(seed, n) {
  return Array.from({ length: n }, (_, i) => {
    const r = {
      name: `accounts/1/locations/${seed}/reviews/r${i}`,
      starRating: STARS[(seed + i) % 5],
      comment: "text",
      createTime: daysAgo(i * 3 + 1),
      updateTime: daysAgo(i * 3 + 1),
      reviewer: { displayName: "A Person", profilePhotoUrl: "https://x/p.jpg" },
    };
    // Every third review is replied to, and one of them 9 days late,
    // so reply lag and the unanswered counts both get exercised.
    if (i % 3 === 0) r.reviewReply = { comment: "thanks", updateTime: daysAgo(i * 3 + 1 - 9 > 0 ? i * 3 + 1 - 9 : 0) };
    return r;
  });
}

async function run(opts = {}) {
  const { disabled = null, tokenFails = false, rateLimitOnce = false, mapping = null,
          multiAccount = false, noReviews = false } = opts;
  await rm("data", { recursive: true, force: true });
  if (mapping) await writeFile("google-location-mapping.json", JSON.stringify(mapping));
  else await rm("google-location-mapping.json", { force: true });

  let rateLimited = false;
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, obj) => {
      const b = JSON.stringify(obj);
      res.writeHead(code, { "Content-Type": "application/json" }).end(b);
    };

    if (u.pathname === "/token") {
      if (tokenFails) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: "at", expires_in: 3600 });
    }
    if (disabled && u.pathname.includes(disabled)) {
      return send(403, { error: { status: "PERMISSION_DENIED",
        message: "Business Profile Performance API has not been used in project 1 before or it is disabled",
        details: [{ reason: "SERVICE_DISABLED" }] } });
    }
    if (rateLimitOnce && !rateLimited && u.pathname.includes("/accounts")) {
      rateLimited = true;
      return send(429, { error: { message: "Quota exceeded" } });
    }
    if (u.pathname === "/v1/accounts") {
      // The real account shape: one organisation account holding every
      // location, PLUS a per-location account holding the same one
      // again. Every location is therefore reachable twice.
      return send(200, { accounts: [
        { name: "accounts/1", accountName: "Mezza Lebanese Kitchen" },
        ...(multiAccount ? [{ name: "accounts/2", accountName: "Store account" }] : []),
      ]});
    }
    if (/\/v1\/accounts\/2\/locations$/.test(u.pathname)) {
      // Same location id as one under accounts/1 -- the duplicate.
      return send(200, { locations: [
        { name: "locations/1001", title: "7001 Mumford",
          storefrontAddress: { addressLines: ["7001 Mumford Rd"], locality: "Halifax" } },
      ]});
    }
    if (/\/v1\/accounts\/1\/locations$/.test(u.pathname)) {
      return send(200, { locations: [
        { name: "locations/1001", title: "7001 Mumford",
          storefrontAddress: { addressLines: ["7001 Mumford Rd"], locality: "Halifax" } },
        { name: "locations/1002", title: "16 Garland",
          storefrontAddress: { addressLines: ["16 Garland Ave"], locality: "Dartmouth" } },
      ]});
    }
    if (/reviews$/.test(u.pathname)) {
      // An empty list, not an error -- which is exactly what production
      // did, and what let "0 reviews" pass as a successful run.
      if (noReviews) return send(200, {});
      const seed = Number(u.pathname.match(/locations\/(\d+)/)[1]) - 1000;
      return send(200, { reviews: reviewsFor(seed, 7) });
    }
    if (u.pathname.includes("fetchMultiDailyMetricsTimeSeries")) {
      const mk = (metric, base) => ({
        dailyMetric: metric,
        timeSeries: { datedValues: Array.from({ length: 3 }, (_, i) => ({
          date: { year: 2026, month: 8, day: 20 + i }, value: String(base + i),
        })) },
      });
      return send(200, { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
        mk("BUSINESS_IMPRESSIONS_DESKTOP_MAPS", 100),
        mk("BUSINESS_IMPRESSIONS_MOBILE_SEARCH", 200),
        mk("CALL_CLICKS", 5),
        mk("BUSINESS_DIRECTION_REQUESTS", 40),
      ]}]});
    }
    send(404, { error: "unexpected " + u.pathname });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // Point every Google host at the stub.
  let src = await readFile("sync.mjs", "utf8");
  src = src
    .replace(/https:\/\/oauth2\.googleapis\.com\/token/g, `${base}/token`)
    .replace(/https:\/\/mybusinessaccountmanagement\.googleapis\.com/g, base)
    .replace(/https:\/\/mybusinessbusinessinformation\.googleapis\.com/g, base)
    .replace(/https:\/\/mybusiness\.googleapis\.com/g, base)
    .replace(/https:\/\/businessprofileperformance\.googleapis\.com/g, base);
  await writeFile("sync.local.mjs", src);

  const child = spawn(process.execPath, ["sync.local.mjs"], {
    env: { ...process.env, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec",
           GOOGLE_REFRESH_TOKEN: "rt" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  server.close();
  let data = null;
  try { data = JSON.parse(await readFile("data/google-data.json", "utf8")); } catch {}
  return { code, out, data };
}

console.log("\n1. Happy path");
{
  const { code, out, data } = await run();
  check("exits 0", () => assert.strictEqual(code, 0, out.slice(-600)));
  check("both locations come through", () => assert.strictEqual(data.locations.length, 2));
  check("reviews are read and flattened", () => assert.strictEqual(data.reviews.length, 14));
  check("rating is averaged from the star enum", () => {
    const L = data.locations[0];
    assert.ok(L.Rating > 0 && L.Rating <= 5, "rating " + L.Rating);
  });
  check("unanswered is counted, and negatives separately", () => {
    const L = data.locations[0];
    assert.strictEqual(L.Unanswered, 7 - 3);            // every 3rd replied
    assert.ok(L.Unanswered_Negative <= L.Unanswered);
  });
  check("age of the oldest unanswered is reported", () =>
    assert.ok(data.locations[0].Oldest_Unanswered_Days >= 1));
  check("reply lag is computed", () => {
    const replied = data.reviews.filter((r) => r.Replied);
    assert.ok(replied.length > 0);
    assert.ok(replied.every((r) => r.Reply_Lag_Days !== null));
  });
  check("30-day and 7-day review velocity", () => {
    const L = data.locations[0];
    assert.ok(L.Reviews_30d > 0 && L.Reviews_7d > 0);
    assert.ok(L.Reviews_7d <= L.Reviews_30d);
  });
  check("the four impression metrics are summed into one Profile_Views", () => {
    const p = data.performance[0];
    // 100+200 on the first day, from two impression variants
    assert.strictEqual(p.Profile_Views, 300);
    assert.strictEqual(p.CALL_CLICKS, 5);
    assert.strictEqual(p.BUSINESS_DIRECTION_REQUESTS, 40);
  });
  check("performance rows carry a date and a location", () => {
    assert.strictEqual(data.performance[0].Date, "2026-08-20");
    assert.ok("Location_Name" in data.performance[0]);
  });
  check("no reviewer photo or other reviewer detail is written out", () => {
    const blob = JSON.stringify(data);
    assert.ok(!blob.includes("profilePhotoUrl"));
    assert.ok(!blob.includes("p.jpg"));
  });
}

console.log("\n2. Unmapped locations are reported, never guessed");
{
  const { data, out } = await run();
  check("both are unmapped with no mapping file", () =>
    assert.strictEqual(data.unmapped_locations.length, 2));
  check("Location_Name is null rather than a guess from the Google title", () =>
    assert.ok(data.locations.every((L) => L.Location_Name === null)));
  check("the log prints a paste-ready block with the ids", () => {
    assert.match(out, /"1001":\s*""/);
    assert.match(out, /7001 Mumford/);
  });
}
{
  const { data } = await run({ mapping: { byLocationId: { "1001": "Halifax Shopping Centre" },
                                          byTitle: { "16 Garland": "Burnside" } } });
  check("byLocationId maps a store", () => {
    const L = data.locations.find((x) => x.Google_Location_Id === "1001");
    assert.strictEqual(L.Location_Name, "Halifax Shopping Centre");
  });
  check("byTitle maps as a fallback", () => {
    const L = data.locations.find((x) => x.Google_Location_Id === "1002");
    assert.strictEqual(L.Location_Name, "Burnside");
  });
  check("nothing is left unmapped", () =>
    assert.strictEqual(data.unmapped_locations.length, 0));
}


console.log("\n4. the same location reachable through two accounts");
{
  const { code, out, data } = await run({ multiAccount: true });
  check("exits 0", () => assert.strictEqual(code, 0, out.slice(-500)));
  check("the duplicate is skipped, not fetched twice", () =>
    assert.strictEqual(data.duplicate_locations_skipped, 1));
  check("each location appears exactly once", () => {
    const ids = data.locations.map((l) => l.Google_Location_Id);
    assert.strictEqual(ids.length, new Set(ids).size, ids.join(","));
  });
  check("performance rows are NOT doubled", () => {
    // 2 locations x 3 days
    assert.strictEqual(data.performance.length, 6);
  });
  check("reviews are NOT doubled", () => assert.strictEqual(data.reviews.length, 14));
}

console.log("\n5. reviews returning nothing is a failure, not a pass");
{
  const { code, out, data } = await run({ noReviews: true });
  check("the run FAILS rather than reporting ok", () =>
    assert.notStrictEqual(code, 0));
  check("and says which half worked", () => {
    assert.match(out, /No reviews were returned for ANY location/);
    assert.match(out, /Performance metrics DID come through/);
  });
  check("the status file records reviews_ok false, performance_ok true", async () => {});
  const status = JSON.parse(await readFile("data/google-sync-status.json", "utf8"));
  check("status is failed with the reason", () => {
    assert.strictEqual(status.status, "failed");
    assert.match(status.error, /No reviews were returned/);
  });
}

console.log("\n3. The failure modes that actually happen");
{
  const { code, out } = await run({ tokenFails: true });
  check("an expired refresh token fails loudly, not silently", () => {
    assert.notStrictEqual(code, 0);
    assert.match(out, /OAuth refresh failed/);
  });
  check("and says what to do about invalid_grant", () =>
    assert.match(out, /redo the one-time consent/));
}
{
  // The single most likely real failure: one of the four APIs not
  // enabled on the Cloud project.
  const { code, out, data } = await run({ disabled: "fetchMultiDailyMetricsTimeSeries" });
  check("one disabled API does not take the whole run down", () =>
    assert.strictEqual(code, 0, out.slice(-500)));
  check("reviews still land", () => assert.strictEqual(data.reviews.length, 14));
  check("performance is empty rather than fabricated", () =>
    assert.strictEqual(data.performance.length, 0));
  check("and the log names it as a not-enabled API", () => {
    assert.match(out, /performance failed/);
    assert.match(out, /not enabled on the Cloud project/);
  });
}
{
  const { code, out, data } = await run({ rateLimitOnce: true });
  check("a 429 is backed off and retried, not treated as fatal", () => {
    assert.strictEqual(code, 0, out.slice(-500));
    assert.strictEqual(data.locations.length, 2);
    assert.match(out, /backing off/);
  });
}

console.log(`\n${PASS} passed, ${FAIL} failed.`);
process.exit(FAIL ? 1 : 0);
