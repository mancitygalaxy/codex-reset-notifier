import assert from "node:assert/strict";
import test from "node:test";
import { checkAndNotify, buildScheduledMarkdown } from "../src/index.js";

const completed = {
  tweet_id: "2112432076767289678",
  tweet_url: "https://x.com/example/status/2112432076767289678",
  text: "Reset completed.",
  announced_at: "2026-10-20T06:33:48.000Z",
  reset_type: "regular",
};
const upcoming = {
  tweet_id: "2113162413008884099",
  tweet_url: "https://x.com/example/status/2113162413008884099",
  text: "Lands tomorrow before 10am PST.",
  announced_at: "2026-10-22T06:55:54.000Z",
  scheduled_for: "2026-10-22T17:00:00.000Z",
  reset_type: "regular",
};
const now = Date.parse("2026-10-22T13:00:00Z");
const noticeKey = `scheduled_notice:${upcoming.tweet_id}`;

function setup(t, initial = { last_tweet_id: completed.tweet_id }) {
  const kv = new Map(Object.entries(initial));
  const sent = [];
  const destinations = [];
  const operations = [];
  const scenario = {
    payload: { events: [completed], scheduled: { ...upcoming } },
    response: () => Response.json({ errcode: 0, errmsg: "ok" }),
  };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    if (url === "https://codex-resets.com/api/resets") return Response.json(scenario.payload);
    assert.ok(["https://example.invalid/webhook", "https://example.invalid/scheduled-webhook"].includes(url));
    destinations.push(url);
    operations.push("send");
    sent.push(JSON.parse(options.body).markdown.content);
    return scenario.response();
  };
  const env = {
    WECOM_WEBHOOK_URL: "https://example.invalid/webhook",
    WECOM_SCHEDULED_WEBHOOK_URL: "https://example.invalid/scheduled-webhook",
    RESET_STATE: {
      async get(key) { return kv.get(key) ?? null; },
      async put(key, value) { operations.push(`put:${key}`); kv.set(key, value); },
    },
  };
  return { kv, sent, destinations, operations, scenario, env, run: (time = now) => checkAndNotify(env, { now: time }) };
}

test("completed resets and forecasts use their assigned robots in the same run", async (t) => {
  const s = setup(t);
  s.scenario.payload.events.push({ ...completed, tweet_id: "next-reset", announced_at: "2026-10-21T06:00:00Z" });
  const result = await s.run();
  assert.equal(result.resetCount, 1);
  assert.equal(result.scheduledCount, 1);
  assert.deepEqual(s.destinations, ["https://example.invalid/webhook", "https://example.invalid/scheduled-webhook"]);
  assert.match(s.sent[0], /又重置啦/);
  assert.match(s.sent[1], /重置预告/);
});

test("banked resets keep the original robot while forecast updates use the new robot", async (t) => {
  const s = setup(t);
  s.scenario.payload.events.push({ ...completed, tweet_id: "next-card", announced_at: "2026-10-21T06:00:00Z", reset_type: "banked" });
  s.scenario.payload.scheduled.reset_type = "banked";
  await s.run();
  s.scenario.payload.scheduled.scheduled_for = "2026-10-22T18:00:00Z";
  await s.run();
  assert.deepEqual(s.destinations, ["https://example.invalid/webhook", "https://example.invalid/scheduled-webhook", "https://example.invalid/scheduled-webhook"]);
  assert.match(s.sent[0], /发重置卡啦/);
  assert.match(s.sent[2], /重置卡预告更新/);
});

test("switching forecast robots preserves existing delivery records without replay", async (t) => {
  const s = setup(t);
  await s.run();
  const before = new Map(s.kv);
  s.sent.length = 0;
  s.destinations.length = 0;
  assert.equal((await s.run()).count, 0);
  assert.deepEqual(s.kv, before);
  assert.equal(s.sent.length, 0);
  s.scenario.payload.scheduled.scheduled_for = "2026-10-22T18:00:00Z";
  await s.run();
  assert.deepEqual(s.destinations, ["https://example.invalid/scheduled-webhook"]);
});

test("a missing forecast webhook cannot fall back to the original robot", async (t) => {
  const s = setup(t);
  delete s.env.WECOM_SCHEDULED_WEBHOOK_URL;
  s.scenario.payload.events.push({ ...completed, tweet_id: "next-reset", announced_at: "2026-10-21T06:00:00Z" });
  await assert.rejects(s.run(), /WeCom webhook is not configured/);
  assert.deepEqual(s.destinations, ["https://example.invalid/webhook"]);
  assert.equal(s.kv.get("last_tweet_id"), "next-reset");
  assert.equal(s.kv.has(noticeKey), false);
  s.env.WECOM_SCHEDULED_WEBHOOK_URL = "https://example.invalid/scheduled-webhook";
  assert.equal((await s.run()).scheduledCount, 1);
  assert.deepEqual(s.destinations, ["https://example.invalid/webhook", "https://example.invalid/scheduled-webhook"]);
});

test("backfills the current announcement once, with a Beijing date rollover", async (t) => {
  const s = setup(t);
  assert.equal((await s.run()).scheduledCount, 1);
  assert.equal((await s.run()).status, "no_change");
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /2026-10-23 01:00 前（北京时间）/);
  assert.match(s.sent[0], /预计重置时间/);
  assert.match(s.sent[0], /接下来预计直接重置额度。/);
  assert.doesNotMatch(s.sent[0], /又重置啦|已经重置/);
  assert.equal(s.kv.get("last_tweet_id"), completed.tweet_id);
  assert.ok(s.operations.indexOf("send") < s.operations.indexOf(`put:${noticeKey}`));
});

test("a revised time sends one update; equivalent timezone notation does not", async (t) => {
  const s = setup(t);
  await s.run();
  s.scenario.payload.scheduled.scheduled_for = "2026-10-22T18:00:00Z";
  await s.run();
  s.scenario.payload.scheduled.scheduled_for = "2026-10-23T02:00:00+08:00";
  await s.run();
  assert.equal(s.sent.length, 2);
  assert.match(s.sent[1], /预告更新/);
  assert.match(s.sent[1], /2026-10-23 02:00 前/);
});

test("a missing time stays unknown, and a later explicit time triggers an update", async (t) => {
  const s = setup(t);
  s.scenario.payload.scheduled.scheduled_for = null;
  s.scenario.payload.scheduled.text = "A reset is coming later.";
  await s.run();
  await s.run();
  assert.match(s.sent[0], /时间待定/);
  assert.doesNotMatch(s.sent[0], /2026-10-23/);
  s.scenario.payload.scheduled = { ...upcoming };
  await s.run();
  assert.equal(s.sent.length, 2);
  assert.match(s.sent[1], /预告更新/);
});

test("a temporarily disappearing announcement is not resent when it returns", async (t) => {
  const s = setup(t);
  await s.run();
  s.scenario.payload.scheduled = null;
  await s.run();
  s.scenario.payload.scheduled = { ...upcoming, text: `  ${upcoming.text}  ` };
  await s.run();
  assert.equal(s.sent.length, 1);
});

test("a new announcement is sent even when its expected time matches an older one", async (t) => {
  const s = setup(t);
  await s.run();
  s.scenario.payload.scheduled = { ...upcoming, tweet_id: "new-announcement", tweet_url: "https://x.com/example/status/new-announcement" };
  await s.run();
  assert.equal(s.sent.length, 2);
  assert.doesNotMatch(s.sent[1], /预告更新/);
});

test("the later executed reset still notifies, even if it uses the same post ID", async (t) => {
  const s = setup(t);
  await s.run();
  s.scenario.payload.events.push({ ...upcoming, text: "Reset all propagated." });
  const result = await s.run();
  await s.run();
  assert.equal(result.resetCount, 1);
  assert.equal(result.scheduledCount, 0);
  assert.equal(s.sent.length, 2);
  assert.match(s.sent[1], /Codex 又重置啦/);
  assert.equal(s.kv.get("last_tweet_id"), upcoming.tweet_id);
});

test("a newer execution suppresses a stale scheduled announcement", async (t) => {
  const s = setup(t);
  s.scenario.payload.events.push({ ...completed, tweet_id: "executed-later", announced_at: "2026-10-22T18:00:00Z" });
  await s.run();
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /又重置啦/);
  assert.equal(s.kv.has(noticeKey), false);
});

for (const failure of ["http", "wecom"]) {
  test(`failed scheduled delivery (${failure}) remains retryable`, async (t) => {
    const s = setup(t);
    s.scenario.response = () => failure === "http"
      ? new Response("unavailable", { status: 503 })
      : Response.json({ errcode: 93000, errmsg: "rejected" });
    await assert.rejects(s.run(), /WeCom/);
    assert.equal(s.kv.has(noticeKey), false);
    assert.equal(s.kv.get("last_tweet_id"), completed.tweet_id);
    s.scenario.response = () => Response.json({ errcode: 0 });
    await s.run();
    assert.equal((await s.run()).status, "no_change");
    assert.equal(s.sent.length, 2);
  });
}

test("a failed time update preserves the prior delivered state until retry succeeds", async (t) => {
  const s = setup(t);
  await s.run();
  const before = s.kv.get(noticeKey);
  s.scenario.payload.scheduled.scheduled_for = "2026-10-22T18:00:00Z";
  s.scenario.response = () => new Response("unavailable", { status: 503 });
  await assert.rejects(s.run());
  assert.equal(s.kv.get(noticeKey), before);
  s.scenario.response = () => Response.json({ errcode: 0 });
  await s.run();
  assert.notEqual(s.kv.get(noticeKey), before);
  assert.match(s.sent[2], /预告更新/);
});

test("passing the estimated time never turns a scheduled announcement into a reset", async (t) => {
  const s = setup(t);
  await s.run(Date.parse("2026-10-22T19:00:00Z"));
  await s.run(Date.parse("2026-10-22T20:00:00Z"));
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /预告时间已到，仍待后续重置公告确认/);
  assert.doesNotMatch(s.sent[0], /又重置啦/);
  assert.equal(s.kv.get("last_tweet_id"), completed.tweet_id);
});

test("the first run baselines history but delivers a current scheduled announcement", async (t) => {
  const s = setup(t, {});
  const result = await s.run();
  assert.equal(result.resetCount, 0);
  assert.equal(result.scheduledCount, 1);
  assert.equal(s.kv.get("last_tweet_id"), completed.tweet_id);
  assert.equal(s.sent.length, 1);
});

test("probabilistic watch data never produces an explicit announcement", async (t) => {
  const s = setup(t);
  s.scenario.payload.scheduled = null;
  s.scenario.payload.watch = { level: "strong", reset_chance_percent: 90, text: "Maybe later" };
  assert.equal((await s.run()).status, "no_change");
  assert.equal(s.sent.length, 0);
});

test("banked announcements and type corrections use distinct copy", async (t) => {
  const s = setup(t);
  await s.run();
  s.scenario.payload.scheduled.reset_type = "banked";
  await s.run();
  assert.match(s.sent[1], /重置卡预告更新/);
  assert.match(s.sent[1], /预计发卡时间/);
  assert.match(s.sent[1], /到账后可按需使用/);
  assert.match(s.sent[1], /接下来预计发放重置卡，到账后可按需使用。/);
  assert.doesNotMatch(s.sent[1], /又重置啦|发重置卡啦/);
});

test("invalid or timezone-free estimates are rejected, not guessed", async (t) => {
  const s = setup(t);
  for (const invalid of ["2026-10-22T17:00:00", "not-a-dateZ", 123]) {
    s.scenario.payload.scheduled.scheduled_for = invalid;
    await assert.rejects(s.run(), /scheduled_for/);
  }
  assert.equal(s.sent.length, 0);
  assert.equal(s.kv.has(noticeKey), false);
});

test("a malformed announcement cannot stop the valid completed-reset notification", async (t) => {
  const s = setup(t);
  s.scenario.payload.events.push({ ...completed, tweet_id: "other-reset", announced_at: "2026-10-21T06:00:00Z" });
  s.scenario.payload.scheduled.reset_type = "unexpected";
  await assert.rejects(s.run(), /schema is invalid/);
  assert.equal(s.sent.length, 1);
  assert.equal(s.kv.get("last_tweet_id"), "other-reset");
  await assert.rejects(s.run(), /schema is invalid/);
  assert.equal(s.sent.length, 1);
});

test("both summer and winter offsets format in Beijing time without host timezone dependence", () => {
  const summer = buildScheduledMarkdown({ ...upcoming, scheduled_for: "2026-07-22T10:00:00-07:00" }, { now });
  const winter = buildScheduledMarkdown({ ...upcoming, scheduled_for: "2026-12-22T10:00:00-08:00" }, { now });
  assert.match(summer, /2026-07-23 01:00 前/);
  assert.match(winter, /2026-12-23 02:00 前/);
});
