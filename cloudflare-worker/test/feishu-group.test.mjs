import assert from "node:assert/strict";
import test from "node:test";
import { checkAndNotify } from "../src/index.js";

const old = { tweet_id: "2112432076767289678", tweet_url: "https://x.com/example/status/2112432076767289678", text: "Reset completed.", announced_at: "2026-10-20T06:33:48Z", reset_type: "regular" };
const reset = { ...old, tweet_id: "new-reset", announced_at: "2026-10-23T01:00:00Z" };
const scheduled = { ...old, tweet_id: "next-forecast", announced_at: "2026-10-23T02:00:00Z", scheduled_for: "2026-10-24T17:00:00Z", text: "Next reset before tomorrow." };
const prefix = "feishu-group:oc_test:";
const cursor = `${prefix}last_tweet_id`;
const notice = `${prefix}scheduled_notice:${scheduled.tweet_id}`;
const resetUrl = "https://open.feishu.cn/open-apis/bot/v2/hook/reset-test";
const scheduledUrl = "https://open.feishu.cn/open-apis/bot/v2/hook/scheduled-test";

function setup(t, { bootstrap = false } = {}) {
  const state = new Map([["last_tweet_id", old.tweet_id], ["feishu:cli_legacy:ou_owner:last_tweet_id", old.tweet_id]]);
  if (!bootstrap) state.set(cursor, old.tweet_id);
  const calls = [];
  const scenario = { payload: { events: [old, reset], scheduled }, failUrl: null, rawReply: null };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    if (url === "https://codex-resets.com/api/resets") return Response.json(scenario.payload);
    assert.ok([resetUrl, scheduledUrl, "https://example.invalid/wecom-reset", "https://example.invalid/wecom-scheduled"].includes(url), "No legacy app authentication or private message request is allowed");
    calls.push({ url, body: JSON.parse(options.body) });
    if (url === scenario.failUrl) return new Response("temporary failure", { status: 503 });
    if (url.startsWith("https://example.invalid")) return Response.json({ errcode: 0 });
    return Response.json(scenario.rawReply ?? { code: 0, msg: "success", data: {} });
  };
  const env = {
    WECOM_WEBHOOK_URL: "https://example.invalid/wecom-reset", WECOM_SCHEDULED_WEBHOOK_URL: "https://example.invalid/wecom-scheduled",
    FEISHU_ENABLED: "true", FEISHU_DELIVERY_MODE: "group_webhook", FEISHU_GROUP_ID: "oc_test",
    FEISHU_WEBHOOK_URL: resetUrl, FEISHU_SCHEDULED_WEBHOOK_URL: scheduledUrl,
    FEISHU_APP_ID: "cli_legacy", FEISHU_APP_SECRET: "legacy-secret", FEISHU_RECEIVER_OPEN_ID: "ou_owner",
    RESET_STATE: { async get(key) { return state.get(key) ?? null; }, async put(key, value) { state.set(key, value); } },
  };
  return { state, calls, scenario, env, run: () => checkAndNotify(env, { now: Date.parse("2026-10-23T05:00:00Z") }) };
}

test("group activation quietly baselines existing records and never calls the old private bot", async (t) => {
  const s = setup(t, { bootstrap: true });
  await s.run();
  await s.run();
  assert.equal(s.calls.filter(c => c.url.startsWith("https://open.feishu.cn")).length, 0);
  assert.equal(s.state.get(cursor), reset.tweet_id);
  assert.ok(JSON.parse(s.state.get(notice)).baselineAt);
  assert.equal(s.state.get("feishu:cli_legacy:ou_owner:last_tweet_id"), old.tweet_id);
});

test("new reset and forecast use separate group robots exactly once", async (t) => {
  const s = setup(t);
  assert.equal((await s.run()).count, 4);
  assert.equal((await s.run()).count, 0);
  const calls = s.calls.filter(c => c.url.startsWith("https://open.feishu.cn"));
  assert.deepEqual(calls.map(c => c.url), [resetUrl, scheduledUrl]);
  assert.equal(calls[0].body.msg_type, "post");
  assert.match(JSON.stringify(calls[0].body.content.post), /这次是直接重置额度。/);
  assert.match(JSON.stringify(calls[0].body.content.post), /重置时间：/);
  assert.match(JSON.stringify(calls[1].body.content.post), /接下来预计直接重置额度。/);
  assert.match(JSON.stringify(calls[1].body.content.post), /预计重置时间：/);
  assert.equal(s.state.get(cursor), reset.tweet_id);
});

test("banked events use the reset robot and banked forecast updates use the forecast robot", async (t) => {
  const s = setup(t);
  s.scenario.payload = { events: [old, { ...reset, reset_type: "banked" }], scheduled: { ...scheduled, reset_type: "banked" } };
  await s.run();
  s.scenario.payload.scheduled.scheduled_for = "2026-10-24T18:00:00Z";
  await s.run();
  const calls = s.calls.filter(c => c.url.startsWith("https://open.feishu.cn"));
  assert.deepEqual(calls.map(c => c.url), [resetUrl, scheduledUrl, scheduledUrl]);
  assert.match(JSON.stringify(calls[0].body), /这次发的是重置卡，留着按需使用。/);
  assert.match(JSON.stringify(calls[0].body), /发卡时间：/);
  assert.match(JSON.stringify(calls[2].body), /重置卡预告更新/);
  assert.match(JSON.stringify(calls[2].body), /接下来预计发放重置卡，到账后可按需使用。/);
});

test("a failed forecast retries only the undelivered forecast after reset success", async (t) => {
  const s = setup(t);
  s.scenario.failUrl = scheduledUrl;
  await assert.rejects(s.run(), /Feishu group webhook returned HTTP 503/);
  assert.equal(s.state.get(cursor), reset.tweet_id);
  assert.equal(s.state.has(notice), false);
  s.scenario.failUrl = null;
  assert.equal((await s.run()).count, 1);
  assert.equal(s.calls.filter(c => c.url === resetUrl).length, 1);
  assert.equal(s.calls.filter(c => c.url === scheduledUrl).length, 2);
});

test("missing group configuration cannot silently resume old private messages", async (t) => {
  const s = setup(t);
  delete s.env.FEISHU_SCHEDULED_WEBHOOK_URL;
  await assert.rejects(s.run(), /group webhook configuration/);
  assert.equal(s.calls.filter(c => c.url.startsWith("https://open.feishu.cn")).length, 0);
  assert.equal(s.state.get("last_tweet_id"), reset.tweet_id);
  assert.equal(s.state.get(cursor), old.tweet_id);
});

test("invalid delivery modes do not fall back to private messages", async (t) => {
  const s = setup(t);
  s.env.FEISHU_DELIVERY_MODE = "invalid";
  await assert.rejects(s.run(), /delivery mode is invalid/);
  assert.equal(s.calls.filter(c => c.url.startsWith("https://open.feishu.cn")).length, 0);
});

test("only an explicit success code advances group state and errors hide echoed secrets", async (t) => {
  const s = setup(t);
  s.scenario.rawReply = { code: 19024, msg: resetUrl + " legacy-secret" };
  await assert.rejects(s.run(), error => /code=19024/.test(error.message) && !error.message.includes(resetUrl) && !error.message.includes("legacy-secret"));
  assert.equal(s.state.get(cursor), old.tweet_id);
  s.scenario.rawReply = { StatusCode: 0 };
  await assert.rejects(s.run(), /code=unknown/);
  assert.equal(s.state.get(cursor), old.tweet_id);
});
