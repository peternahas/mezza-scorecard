#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 * GOOGLE REVIEWS + BUSINESS PROFILE PERFORMANCE → data/google-data.json
 * ═══════════════════════════════════════════════════════════════════
 *
 * Why this exists: both of these were built and working, in Apps
 * Script, against the Google Sheet that has since been retired as the
 * scorecard's source. They are stranded rather than lost. This moves
 * them onto the same footing as the Givex sync — a GitHub Action that
 * commits a JSON file the dashboard reads — so they stop being
 * hostage to a spreadsheet nobody updates.
 *
 * ── WHY THE BUSINESS PROFILE API AND NOT THE PLACES API ──────────
 *
 * The earlier Reviews integration used the public Places API with a
 * bare key. That returns a star rating and a review count and nothing
 * else. Mezza already has OAuth approval for the Business Profile
 * suite (granted 2026-07-03, 300 QPM), which reads Mezza's OWN data
 * and returns:
 *
 *   - every review, with its text, star rating, reviewer, timestamp,
 *     AND whether the business has replied
 *   - profile views, searches, calls, direction requests, website
 *     clicks, menu clicks and food orders, per location per day
 *
 * Reply status is the part worth having. A star rating is a lagging
 * number nobody can act on this week. "Eleven reviews unanswered,
 * four of them one-star, oldest nineteen days" is a task list.
 *
 * ── WHAT PETER NEEDS TO SUPPLY ───────────────────────────────────
 *
 * Three GitHub repo secrets. See scripts/GOOGLE-OAUTH-SETUP.md for
 * how to get the third one, which is the only fiddly part:
 *
 *   GOOGLE_CLIENT_ID       already exists (Apps Script properties)
 *   GOOGLE_CLIENT_SECRET   already exists (Apps Script properties)
 *   GOOGLE_REFRESH_TOKEN   needs a one-time consent flow
 *
 * The refresh token is long-lived. Nothing here is stored in a file
 * or in this repo — same discipline as the Givex secret.
 *
 * ── THREE APIS, BECAUSE GOOGLE SPLIT THEM UP ─────────────────────
 *
 *   mybusinessaccountmanagement  which accounts this login can see
 *   mybusinessbusinessinformation  the locations under an account
 *   mybusiness v4                  reviews (still the only path)
 *   businessprofileperformance     the metrics
 *
 * All four need to be individually enabled on the Cloud project even
 * though the access approval covers the whole suite. If a call comes
 * back 403 with SERVICE_DISABLED, that is which one to enable.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

const OUTPUT_PATH = "data/google-data.json";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPPING_PATH = path.join(__dirname, "google-location-mapping.json");

// How much history to pull. The Performance API keeps ~18 months but
// only serves a limited window per call, and the scorecard's trends
// are 28-day, so 120 days is generous without being slow.
const PERF_DAYS = 120;
// Reviews are paged 50 at a time. Enough pages to cover a first full
// pull for a location with a long history, then it is incremental in
// practice because the newest come first.
const REVIEW_PAGES = 8;

const PERF_METRICS = [
  // Impressions are split four ways by Google (maps/search x
  // desktop/mobile) and are meaningless apart, so they get summed
  // back into one "profile views" figure below.
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_CONVERSATIONS",
  "BUSINESS_DIRECTION_REQUESTS",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "BUSINESS_BOOKINGS",
  "BUSINESS_FOOD_ORDERS",
  "BUSINESS_FOOD_MENU_CLICKS",
];
const IMPRESSION_METRICS = new Set(PERF_METRICS.filter((m) => m.startsWith("BUSINESS_IMPRESSIONS")));

/* ── auth ────────────────────────────────────────────────────────── */

let accessToken = null;
async function token() {
  if (accessToken) return accessToken;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    // invalid_grant almost always means the refresh token was revoked
    // or the consent was granted to a different client. Say so, rather
    // than letting it read as a transient failure someone retries.
    throw new Error(
      `OAuth refresh failed (${res.status}): ${JSON.stringify(body)}` +
        (body.error === "invalid_grant"
          ? "\n  invalid_grant means the refresh token is no longer valid — redo the one-time consent in GOOGLE-OAUTH-SETUP.md."
          : "")
    );
  }
  accessToken = body.access_token;
  return accessToken;
}

// Google's Business Profile quota is per-minute and it answers 429
// rather than queueing. Backing off is not optional at 22 locations x
// several endpoints.
async function api(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 5) throw new Error(`${url} -> ${res.status} after ${attempt} retries`);
      const wait = Math.min(60000, 2000 * Math.pow(2, attempt));
      console.log(`  ${res.status} — backing off ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const hint = /SERVICE_DISABLED/.test(text)
        ? " — this API is not enabled on the Cloud project; enable it and re-run."
        : "";
      throw new Error(`${url} -> ${res.status} ${text.slice(0, 400)}${hint}`);
    }
    return text ? JSON.parse(text) : {};
  }
}

/* ── discovery ───────────────────────────────────────────────────── */

async function listAccounts() {
  const out = [];
  let pageToken = "";
  do {
    const qs = new URLSearchParams({ pageSize: "20", ...(pageToken ? { pageToken } : {}) });
    const d = await api(`https://mybusinessaccountmanagement.googleapis.com/v1/accounts?${qs}`);
    out.push(...(d.accounts || []));
    pageToken = d.nextPageToken || "";
  } while (pageToken);
  return out;
}

async function listLocations(accountName) {
  const out = [];
  let pageToken = "";
  do {
    const qs = new URLSearchParams({
      readMask: "name,title,storefrontAddress,metadata",
      pageSize: "100",
      ...(pageToken ? { pageToken } : {}),
    });
    const d = await api(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?${qs}`
    );
    out.push(...(d.locations || []));
    pageToken = d.nextPageToken || "";
  } while (pageToken);
  return out;
}

/* ── reviews ─────────────────────────────────────────────────────── */

const STAR = { STAR_RATING_UNSPECIFIED: 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

async function fetchReviews(accountName, locationId) {
  // Reviews live only on the legacy v4 API. There is no v1 equivalent;
  // this is not an oversight to be corrected later.
  const all = [];
  let pageToken = "";
  for (let page = 0; page < REVIEW_PAGES; page++) {
    const qs = new URLSearchParams({
      pageSize: "50",
      orderBy: "updateTime desc",
      ...(pageToken ? { pageToken } : {}),
    });
    const d = await api(
      `https://mybusiness.googleapis.com/v4/${accountName}/${locationId}/reviews?${qs}`
    );
    all.push(...(d.reviews || []));
    pageToken = d.nextPageToken || "";
    if (!pageToken) break;
  }
  return all;
}

/* ── performance ─────────────────────────────────────────────────── */

function ymd(d) {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

async function fetchPerformance(locationId) {
  const end = new Date();
  const start = new Date(end.getTime() - PERF_DAYS * 86400000);
  const s = ymd(start), e = ymd(end);
  const qs = new URLSearchParams();
  for (const m of PERF_METRICS) qs.append("dailyMetrics", m);
  qs.set("daily_range.start_date.year", String(s.year));
  qs.set("daily_range.start_date.month", String(s.month));
  qs.set("daily_range.start_date.day", String(s.day));
  qs.set("daily_range.end_date.year", String(e.year));
  qs.set("daily_range.end_date.month", String(e.month));
  qs.set("daily_range.end_date.day", String(e.day));
  const d = await api(
    `https://businessprofileperformance.googleapis.com/v1/${locationId}:fetchMultiDailyMetricsTimeSeries?${qs}`
  );

  // Flatten into one row per day, with the four impression variants
  // summed into a single Profile_Views. Nobody makes a decision off
  // "desktop maps impressions" separately from "mobile maps".
  const byDate = {};
  for (const series of d.multiDailyMetricTimeSeries || []) {
    for (const one of series.dailyMetricTimeSeries || []) {
      const metric = one.dailyMetric;
      for (const p of one.timeSeries?.datedValues || []) {
        const date = `${p.date.year}-${String(p.date.month).padStart(2, "0")}-${String(p.date.day).padStart(2, "0")}`;
        const row = byDate[date] || (byDate[date] = { Date: date, Profile_Views: 0 });
        const v = Number(p.value || 0);
        if (IMPRESSION_METRICS.has(metric)) row.Profile_Views += v;
        else row[metric] = (row[metric] || 0) + v;
      }
    }
  }
  return Object.values(byDate).sort((a, b) => a.Date.localeCompare(b.Date));
}

/* ── main ────────────────────────────────────────────────────────── */

async function main() {
  // All three are checked together rather than one at a time. Failing
  // on the first missing secret means each run teaches you exactly one
  // fact, and three runs to learn three -- when the script already
  // knows all of it on the first.
  const missing = [
    ["GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID],
    ["GOOGLE_CLIENT_SECRET", GOOGLE_CLIENT_SECRET],
    ["GOOGLE_REFRESH_TOKEN", GOOGLE_REFRESH_TOKEN],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
      `Set them as REPOSITORY secrets on peternahas/mezza-scorecard ` +
      `(Settings -> Secrets and variables -> Actions -> New repository secret). ` +
      `Names are case-sensitive and must not have trailing whitespace. ` +
      `Note that environment secrets and organisation secrets are not the same thing ` +
      `as repository secrets, and this workflow reads repository secrets.`
    );
  }

  // Google's own location titles will not match the Location_Name the
  // Givex feed uses ("7001 Mumford" vs "Halifax Shopping Centre"), and
  // guessing is how a store's reviews get filed under another store.
  // Unmapped locations are reported, never guessed at — the same rule
  // the Givex outlet mapping follows.
  let mapping = { byTitle: {}, byLocationId: {} };
  try {
    mapping = JSON.parse(await readFile(MAPPING_PATH, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    console.log("No google-location-mapping.json yet — every location will be reported as unmapped, with its Google title, so the file can be filled in.");
  }

  const accounts = await listAccounts();
  console.log(`${accounts.length} Business Profile account(s) visible.`);

  const locations = [];
  const reviewsOut = [];
  const perfOut = [];
  const unmapped = [];
  const fetchErrors = [];

  // The SAME location is reachable through more than one account:
  // Mezza has one organisation account holding every location, plus a
  // per-location account for each store. Processing each account/
  // location pair therefore fetched every location twice and counted
  // its metrics twice -- 5,445 performance rows where 2,760 was the
  // truth. Deduplicate on the location id, which is stable, and keep
  // the first account that yields it.
  const seenLocationIds = new Set();
  let duplicatesSkipped = 0;

  for (const acct of accounts) {
    const locs = await listLocations(acct.name);
    console.log(`  ${acct.accountName || acct.name}: ${locs.length} location(s)`);

    for (const loc of locs) {
      const dedupeId = (loc.name || "").split("/").pop();
      if (seenLocationIds.has(dedupeId)) {
        duplicatesSkipped++;
        continue;
      }
      seenLocationIds.add(dedupeId);
      const locationId = loc.name;                    // "locations/12345"
      const shortId = locationId.split("/").pop();
      const title = loc.title || "";
      const mezza =
        mapping.byLocationId?.[shortId] ||
        mapping.byLocationId?.[locationId] ||
        mapping.byTitle?.[title] ||
        null;

      if (!mezza) unmapped.push({ google_location_id: shortId, google_title: title,
        address: (loc.storefrontAddress?.addressLines || []).join(", "),
        locality: loc.storefrontAddress?.locality || "" });

      let reviews = [], perf = [];
      try {
        reviews = await fetchReviews(acct.name, locationId);
      } catch (err) {
        console.warn(`    [!] reviews failed for ${title}: ${err.message}`);
        fetchErrors.push({ kind: "reviews", location: title, id: shortId,
                           error: String(err.message).slice(0, 400) });
      }
      try {
        perf = await fetchPerformance(locationId);
      } catch (err) {
        console.warn(`    [!] performance failed for ${title}: ${err.message}`);
        fetchErrors.push({ kind: "performance", location: title, id: shortId,
                           error: String(err.message).slice(0, 400) });
      }

      const stars = reviews.map((r) => STAR[r.starRating] || 0).filter(Boolean);
      const unanswered = reviews.filter((r) => !r.reviewReply);
      const now = Date.now();
      const recent = (days) => reviews.filter((r) => now - new Date(r.updateTime || r.createTime).getTime() <= days * 86400000);

      locations.push({
        Location_Name: mezza,
        Google_Title: title,
        Google_Location_Id: shortId,
        Account: acct.name,
        Locality: loc.storefrontAddress?.locality || "",
        Rating: stars.length ? Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 100) / 100 : null,
        Review_Count: reviews.length,
        // The count Google shows publicly can exceed what the API
        // returns, because the API pages and this stops at
        // REVIEW_PAGES. Reported as "reviews read", not "all reviews".
        Reviews_Read: reviews.length,
        Unanswered: unanswered.length,
        Unanswered_Negative: unanswered.filter((r) => (STAR[r.starRating] || 0) <= 2).length,
        Oldest_Unanswered_Days: unanswered.length
          ? Math.max(...unanswered.map((r) => Math.floor((now - new Date(r.createTime).getTime()) / 86400000)))
          : null,
        Reviews_30d: recent(30).length,
        Reviews_7d: recent(7).length,
        Rating_30d: (() => {
          const s = recent(30).map((r) => STAR[r.starRating] || 0).filter(Boolean);
          return s.length ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 100) / 100 : null;
        })(),
      });

      for (const r of reviews) {
        reviewsOut.push({
          Location_Name: mezza,
          Google_Title: title,
          Review_Id: (r.name || "").split("/").pop(),
          Stars: STAR[r.starRating] || 0,
          Created: r.createTime || null,
          Updated: r.updateTime || null,
          // Reviewer display name is kept because a reply has to
          // address someone; the profile photo URL and any other
          // reviewer detail is deliberately dropped.
          Reviewer: r.reviewer?.displayName || "",
          Comment: r.comment || "",
          Replied: !!r.reviewReply,
          Replied_At: r.reviewReply?.updateTime || null,
          Reply_Lag_Days: r.reviewReply
            ? Math.round((new Date(r.reviewReply.updateTime) - new Date(r.createTime)) / 86400000)
            : null,
        });
      }
      for (const p of perf) perfOut.push(Object.assign({ Location_Name: mezza, Google_Title: title }, p));
    }
  }

  const output = {
    generated_at: new Date().toISOString(),
    source: "google-business-profile",
    schema_version: 1,
    perf_days: PERF_DAYS,
    locations,
    duplicate_locations_skipped: duplicatesSkipped,
    // Per-location failures, so a whole data class failing cannot hide
    // behind an overall "ok". reviews_ok / performance_ok say plainly
    // whether each half of this integration actually worked.
    reviews_ok: reviewsOut.length > 0,
    performance_ok: perfOut.length > 0,
    fetch_errors: fetchErrors.slice(0, 40),
    fetch_error_count: fetchErrors.length,
    reviews: reviewsOut.sort((a, b) => String(b.Created).localeCompare(String(a.Created))),
    performance: perfOut.sort((a, b) =>
      String(a.Location_Name).localeCompare(String(b.Location_Name)) || a.Date.localeCompare(b.Date)),
    unmapped_locations: unmapped,
  };

  await mkdir("data", { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output) + "\n", "utf8");
  console.log(
    `Wrote ${OUTPUT_PATH}: ${locations.length} location(s), ${reviewsOut.length} review(s), ` +
    `${perfOut.length} performance row(s), ${duplicatesSkipped} duplicate location(s) skipped.`
  );
  // Half this integration silently returning nothing is not "ok".
  if (!reviewsOut.length) {
    const why = fetchErrors.filter((e) => e.kind === "reviews")[0];
    throw new Error(
      "No reviews were returned for ANY location, so the review half of this " +
      "integration is not working. Performance metrics " +
      (perfOut.length ? "DID" : "did not") + " come through. " +
      (why ? `First reviews error: ${why.error}` :
             "No error was raised either -- the API returned empty review lists.")
    );
  }
  if (unmapped.length) {
    console.warn(`\nWARNING: ${unmapped.length} Google location(s) are not mapped to a Mezza Location_Name.`);
    console.warn("Their reviews and metrics are still in the file but cannot be joined to sales. Add them to scripts/google-location-mapping.json:");
    for (const u of unmapped) console.warn(`  "${u.google_location_id}": ""   // ${u.google_title} — ${u.locality}`);
  }
}

/* ── Never fail without leaving a reason behind ──────────────────
   The workflow's commit step is skipped when this throws, which means
   a failed run leaves nothing but an Actions log -- and an Actions log
   is not readable from every environment this gets debugged from. So
   the reason is written into the repo, next to the data, where anyone
   (or any tool) can see it.

   Redacted first. Google's error bodies do not normally carry
   credentials, but "does not normally" is not a basis for committing
   an error string to a repo. */

function redact(text) {
  let out = String(text == null ? "" : text);
  for (const secret of [GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_SECRET, GOOGLE_CLIENT_ID]) {
    if (secret && secret.length > 8) out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/ya29\.[\w.\-]+/g, "[redacted access token]")
    .replace(/1\/\/[\w.\-]+/g, "[redacted refresh token]")
    .replace(/GOCSPX-[\w.\-]+/g, "[redacted client secret]");
}

async function writeStatus(status, err) {
  const body = {
    ran_at: new Date().toISOString(),
    status,
    error: err ? redact(err.message || String(err)) : null,
    // The likely cause, named. A 403 SERVICE_DISABLED and an
    // invalid_grant need completely different fixes, and the person
    // reading this at 8am should not have to work out which they have.
    likely_cause: err ? diagnose(err.message || String(err)) : null,
    what_to_do: err ? remedy(err.message || String(err)) : null,
  };
  try {
    await mkdir("data", { recursive: true });
    await writeFile("data/google-sync-status.json", JSON.stringify(body, null, 2) + "\n", "utf8");
  } catch { /* nothing useful left to do */ }
}

function diagnose(msg) {
  if (/invalid_grant/.test(msg)) return "The refresh token is no longer valid, or it was issued to a different OAuth client.";
  if (/invalid_client/.test(msg)) return "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET do not match each other.";
  if (/SERVICE_DISABLED|has not been used in project/.test(msg)) {
    const which = (msg.match(/([A-Za-z ]*API) has not been used/) || [])[1];
    return `A required Google API is not enabled on the Cloud project${which ? ": " + which.trim() : ""}.`;
  }
  if (/PERMISSION_DENIED|\b403\b/.test(msg)) return "Authenticated, but this Google account may not have access to the Mezza Business Profile locations.";
  if (/Missing required environment variable/.test(msg)) return "One or more repo secrets are not set. The error names which.";
  if (/\b401\b/.test(msg)) return "The access token was rejected.";
  if (/\b429\b/.test(msg)) return "Google rate-limited us past the retry budget.";
  return "Unrecognised failure — see the error text.";
}

function remedy(msg) {
  if (/invalid_grant/.test(msg)) return "Re-run google-oauth/Get Google Refresh Token.command and update the GOOGLE_REFRESH_TOKEN secret.";
  if (/invalid_client/.test(msg)) return "Re-copy both values from Cloud Console -> APIs & Services -> Credentials into the repo secrets.";
  if (/SERVICE_DISABLED|has not been used in project/.test(msg)) return "Cloud Console -> APIs & Services -> Library -> enable it, wait a minute, re-run. All four are needed: Account Management, Business Information, Google My Business (legacy, for reviews), Business Profile Performance.";
  if (/Missing required environment variable/.test(msg)) return "Add the named secrets as REPOSITORY secrets: Settings -> Secrets and variables -> Actions -> New repository secret, on peternahas/mezza-scorecard.";
  return "See scripts/GOOGLE-OAUTH-SETUP.md.";
}

try {
  await main();
  await writeStatus("ok", null);
} catch (err) {
  console.error(err);
  await writeStatus("failed", err);
  process.exit(1);
}
