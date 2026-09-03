// ─────────────────────────────────────────────────────────────────
// MEZZA SYNC CRON — a watchdog for the scorecard's data pipeline
//
// ── THE PROBLEM ──────────────────────────────────────────────────
// The scorecard chain is:
//
//   Givex → Worker → D1 → GitHub Actions → raw.githubusercontent → dashboard
//
// The GitHub Actions link is the weakest and it fails SILENTLY. Both
// syncs are nominally on a 15-minute cron; observed intervals are
// 30–95 minutes, and on the night of 2026-08-26 both stopped for about
// ten hours. Every run before that had succeeded. No failure, no
// error, no banner — the page just kept showing older numbers.
//
// That is documented GitHub behaviour, not a bug in the repo:
// scheduled workflows are best-effort on free runners and get
// deprioritised or skipped under load. It is also exactly how the
// week-26 staleness went unnoticed for nine weeks.
//
// ── WHY THIS DOES NOT PORT THE SYNC ITSELF ───────────────────────
// The obvious-looking move is to run the whole sync in a Worker next
// to the data. Deliberately not doing that:
//
//   - The sync's state lives in a git-committed 8.8 MB file. A Worker
//     would have to pull it, parse it and push it back through the
//     GitHub Contents API on every run, base64 round-tripping 8.8 MB
//     inside a 128 MB memory budget. That trades a reliability problem
//     for a fragility problem.
//   - The sync is ~1,000 lines with 68 tests behind it, and it works.
//     The broken part is the TRIGGER, not the job.
//
// So this Worker replaces only the trigger. It is ~120 lines, it asks
// GitHub to run the workflow that already exists, and the rollback is
// deleting one cron trigger.
//
// ── IT IS A WATCHDOG, NOT A BLIND CRON ───────────────────────────
// A blind cron every 15 minutes would fire ~96 dispatches a day and
// tell us nothing about whether the data is actually current. Instead
// this reads the published feed's own `generated_at`, and:
//
//   - if the feed is fresh, it does nothing and says so
//   - if the feed is stale past STALE_MINUTES, it dispatches the
//     workflow
//   - if the feed is stale past ALERT_MINUTES, something is wrong
//     beyond a skipped run, and it says so loudly in the response and
//     the logs
//
// The Worker therefore has an opinion about pipeline health, which is
// the thing nothing in the chain had before.
//
// ── KEEP THE GITHUB SCHEDULE TOO ─────────────────────────────────
// Do NOT delete the workflow's own `schedule:` block. Two triggers is
// strictly more reliable than one, and a double fire is harmless: the
// workflow's `concurrency` group queues the second run, and it then
// finds the cursor unchanged and processes zero payloads. Belt and
// braces, at no cost.
//
// ── SETUP ────────────────────────────────────────────────────────
// Secret (Worker → Settings → Variables → Encrypt):
//   GITHUB_TOKEN   fine-grained PAT, repo peternahas/mezza-scorecard,
//                  permissions: Actions read/write, Contents read.
//                  Nothing else. This is the only credential it holds.
//
// Cron trigger:  */15 * * * *
// ─────────────────────────────────────────────────────────────────

const OWNER = "peternahas";
const REPO = "mezza-scorecard";

// Which workflows to keep alive, and how stale each feed may get
// before this asks for a run. The Givex feed is near-real-time and
// matters most; the others move on a scale of days.
const WATCHED = [
  {
    name: "Givex sales",
    workflow: "sync-givex-data.yml",
    feed: "data/givex-sales-data.json",
    staleMinutes: 45,
    alertMinutes: 180,
  },
  {
    name: "Excel scorecard",
    workflow: "sync-scorecard-data.yml",
    feed: "data/scorecard-data.json",
    staleMinutes: 120,
    alertMinutes: 600,
  },
];

// raw.githubusercontent is cached at the edge, so the feed's own
// generated_at is read from the API instead — otherwise a cached copy
// makes a stalled pipeline look healthy, which is the exact failure
// this Worker exists to catch.
async function feedAge(job, env) {
  const url =
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${job.feed}?ref=main`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github.raw",
      "User-Agent": "mezza-sync-cron",
      "Cache-Control": "no-cache",
    },
  });
  if (!res.ok) {
    return { error: `feed read failed: ${res.status} ${(await res.text()).slice(0, 160)}` };
  }
  let generatedAt;
  try {
    // These feeds are ~1 MB. Only `generated_at` is needed, and it sits
    // in the first few hundred bytes, so it is pulled out with a regex
    // rather than parsing the whole document in a Worker.
    const head = (await res.text()).slice(0, 400);
    generatedAt = (head.match(/"generated_at"\s*:\s*"([^"]+)"/) || [])[1];
  } catch (err) {
    return { error: `feed parse failed: ${err.message}` };
  }
  if (!generatedAt) return { error: "no generated_at in the feed" };
  const ageMin = Math.round((Date.now() - new Date(generatedAt).getTime()) / 60000);
  return { generatedAt, ageMin };
}

async function dispatch(job, env) {
  const url =
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${job.workflow}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "mezza-sync-cron",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  // 204 is the documented success. Anything else is reported rather
  // than swallowed -- a watchdog that fails quietly is worse than none,
  // because it also removes the reason anyone would look.
  if (res.status !== 204) {
    return { dispatched: false, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  }
  return { dispatched: true };
}

async function check(env) {
  const out = { checked_at: new Date().toISOString(), jobs: [], alerts: [] };

  for (const job of WATCHED) {
    const age = await feedAge(job, env);
    const row = { name: job.name, workflow: job.workflow, ...age };

    if (age.error) {
      // Cannot read the feed at all -- dispatch anyway. Being unable to
      // tell whether the data is current is itself a reason to run.
      row.action = "dispatched (could not read the feed)";
      Object.assign(row, await dispatch(job, env));
      out.alerts.push(`${job.name}: ${age.error}`);
    } else if (age.ageMin >= job.staleMinutes) {
      row.action = `dispatched (${age.ageMin} min old, threshold ${job.staleMinutes})`;
      Object.assign(row, await dispatch(job, env));
      if (age.ageMin >= job.alertMinutes) {
        // Past this point a skipped scheduled run does not explain it.
        // Either the Action is failing, Givex has stopped pushing, or
        // the Worker's own credential has expired.
        out.alerts.push(
          `${job.name} feed is ${age.ageMin} min old — past the ${job.alertMinutes} min alert threshold. ` +
          `A dispatch has been requested, but something beyond a skipped run is likely wrong: ` +
          `check the Actions tab for failures, and check that Givex is still pushing.`
        );
      }
    } else {
      row.action = `ok (${age.ageMin} min old)`;
    }
    out.jobs.push(row);
  }

  out.healthy = out.alerts.length === 0;
  return out;
}

export default {
  // Cron entry point. Logs are visible in the Worker's live logs, and
  // the alert lines are written at error level so they are filterable.
  async scheduled(event, env, ctx) {
    const result = await check(env);
    for (const j of result.jobs) console.log(`${j.name}: ${j.action}`);
    for (const a of result.alerts) console.error(`ALERT: ${a}`);
  },

  // GET / returns the same check as JSON, so pipeline health can be
  // read on demand without waiting for a cron tick -- and so a uptime
  // monitor can be pointed at it. Authenticated with the same secret
  // the webhook Worker uses for its own endpoints, so it cannot be
  // used by anyone else to spam dispatches.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    const provided = request.headers.get("Authorization") || "";
    if (!env.CRON_SHARED_SECRET || provided !== env.CRON_SHARED_SECRET) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const result = await check(env);
    return new Response(JSON.stringify(result, null, 2), {
      status: result.healthy ? 200 : 503,
      headers: { "Content-Type": "application/json" },
    });
  },
};
