import assert from "node:assert/strict";
import test from "node:test";
import { checkAndNotify } from "../src/index.js";

const completed = {
  tweet_id: "2112432076767289678", tweet_url: "https://x.com/example/status/2112432076767289678",
  text: "Reset completed.", announced_at: "2026-10-20T06:33:48.000Z", reset_type: "regular",
};
const upcoming = {
  tweet_id: "2113162413008884099", tweet_url: "https://x.com/example/status/2113162413008884099",
  text: "Lands tomorrow before 10am PST.", announced_at: "2026-10-22T06:55:54.000Z",
  scheduled_for: "2026-10-22T17:00:00.000Z", reset_type: "regular",
};
const nextReset = { ...completed, tweet_id: "new-reset", announced_at: "2026-10-23T01:00:00Z" };
const appId = "cli_test";
const recipient = "ou_owner";
const prefix = `feishu:${appId}:${recipient}:`;
const cursor = `${prefix}last_tweet_id`;
const notice = `${prefix}scheduled_notice:${upcoming.tweet_id}`;
const fingerprint = JSON.stringify({ scheduledFor: upcoming.scheduled_for, resetType: "regular", before: true });

function setup(t, { bootstrap = false } = {}) {
  const state = new Map([["last_tweet_id", completed.tweet_id]]);
  if (!bootstrap) state.set(cursor, completed.tweet_id);
  const calls = { wecom: [], tokens: [], messages: [] };
  const scenario = {
    payload: { events: [completed, nextReset], scheduled: null },
    wecomResponse: () => Response.json({ errcode: 0 }),
    tokenResponse: () => Response.json({ code: 0, access_token: "test-token", expires_in: 7200, token_type: "Bearer", scope: "im:message:send_as_bot" }),
    messageResponse: () => Response.json({ code: 0, data: { message_id: "om_test" } }),
    failPut: null,
  };
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    if (url === "https://codex-resets.com/api/resets") return Response.json(scenario.payload);
    const body = JSON.parse(options.body);
    if (["https://example.invalid/webhook", "https://example.invalid/scheduled-webhook"].includes(url)) {
      calls.wecom.push(body); return scenario.wecomResponse();
    }
    if (url === "https://accounts.feishu.cn/oauth/v3/token") {
      calls.tokens.push(body); return scenario.tokenResponse();
    }
    assert.equal(url, "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    calls.messages.push(body); return scenario.messageResponse();
  };
  const env = {
    WECOM_WEBHOOK_URL: "https://example.invalid/webhook",
    WECOM_SCHEDULED_WEBHOOK_URL: "https://example.invalid/scheduled-webhook",
    FEISHU_ENABLED: "true", FEISHU_APP_ID: appId,
    FEISHU_APP_SECRET: "test-app-secret", FEISHU_RECEIVER_OPEN_ID: recipient,
    RESET_STATE: {
      async get(key) { return state.get(key) ?? null; },
      async put(key, value) {
        if (scenario.failPut === key) throw new Error("KV temporarily unavailable");
        state.set(key, value);
      },
    },
  };
  return { state, calls, scenario, env, run: () => checkAndNotify(env, { now: Date.parse("2026-10-22T15:00:00Z") }) };
}

test("first Feishu activation silently baselines current resets and announcements", async (t) => {
  const s = setup(t, { bootstrap: true });
  s.scenario.payload = { events: [completed], scheduled: upcoming };
  s.state.set(`scheduled_notice:${upcoming.tweet_id}`, JSON.stringify({ fingerprint }));
  assert.equal((await s.run()).count, 0);
  assert.equal((await s.run()).count, 0);
  assert.equal(s.state.get(cursor), completed.tweet_id);
  assert.equal(JSON.parse(s.state.get(notice)).fingerprint, fingerprint);
  assert.equal(s.calls.wecom.length + s.calls.tokens.length + s.calls.messages.length, 0);
});

test("new resets reach both channels once and Feishu targets only the configured owner", async (t) => {
  const s = setup(t);
  assert.equal((await s.run()).count, 2);
  assert.equal((await s.run()).count, 0);
  assert.equal(s.calls.wecom.length, 1);
  assert.equal(s.calls.messages.length, 1);
  assert.equal(s.calls.messages[0].receive_id, recipient);
  assert.equal(s.calls.messages[0].msg_type, "post");
  assert.equal(s.calls.tokens[0].scope, "im:message:send_as_bot");
  assert.equal(s.calls.tokens[0].grant_type, "client_credentials");
  assert.ok(s.calls.messages[0].uuid.length <= 50);
  assert.equal(s.state.get(cursor), nextReset.tweet_id);
  assert.equal(s.state.get("last_tweet_id"), nextReset.tweet_id);
});

test("Feishu failure retries only Feishu with the same idempotency key", async (t) => {
  const s = setup(t);
  s.scenario.messageResponse = () => Response.json({ code: 999, msg: "test-app-secret test-token" });
  await assert.rejects(s.run(), (error) => /Feishu message rejected/.test(error.message) && !/test-app-secret|test-token/.test(error.message));
  assert.equal(s.state.get("last_tweet_id"), nextReset.tweet_id);
  assert.equal(s.state.get(cursor), completed.tweet_id);
  s.scenario.messageResponse = () => Response.json({ code: 0, data: { message_id: "om_retry" } });
  assert.equal((await s.run()).count, 1);
  assert.equal(s.calls.wecom.length, 1);
  assert.equal(s.calls.messages.length, 2);
  assert.equal(s.calls.messages[0].uuid, s.calls.messages[1].uuid);
});

test("WeCom failure does not block Feishu or cause Feishu to resend later", async (t) => {
  const s = setup(t);
  s.scenario.wecomResponse = () => new Response("unavailable", { status: 503 });
  await assert.rejects(s.run(), /WeCom webhook returned HTTP 503/);
  assert.equal(s.state.get(cursor), nextReset.tweet_id);
  assert.equal(s.state.get("last_tweet_id"), completed.tweet_id);
  s.scenario.wecomResponse = () => Response.json({ errcode: 0 });
  assert.equal((await s.run()).count, 1);
  assert.equal(s.calls.wecom.length, 2);
  assert.equal(s.calls.messages.length, 1);
});

test("new announcements and time changes preserve compact Beijing-time content", async (t) => {
  const s = setup(t);
  s.scenario.payload = { events: [completed], scheduled: upcoming };
  assert.equal((await s.run()).scheduledCount, 2);
  s.scenario.payload.scheduled = { ...upcoming, scheduled_for: "2026-10-22T18:00:00Z" };
  assert.equal((await s.run()).scheduledCount, 2);
  assert.equal((await s.run()).count, 0);
  const first = JSON.parse(s.calls.messages[0].content).zh_cn;
  const second = JSON.parse(s.calls.messages[1].content).zh_cn;
  assert.match(JSON.stringify(first), /2026-10-23 01:00 前（北京时间）/);
  assert.match(second.title, /预告更新/);
  assert.match(JSON.stringify(second), /2026-10-23 02:00 前/);
  assert.doesNotMatch(JSON.stringify(second), /<font|公告时间：|数据来源：|以上为数据源/);
  assert.notEqual(s.calls.messages[0].uuid, s.calls.messages[1].uuid);
  assert.equal(s.calls.wecom.length, 2);
});

test("reset and forecast within the same run reuse one scoped token", async (t) => {
  const s = setup(t);
  s.scenario.payload.scheduled = { ...upcoming, tweet_id: "next-forecast", announced_at: "2026-10-23T02:00:00Z", scheduled_for: "2026-10-24T17:00:00Z" };
  assert.equal((await s.run()).count, 4);
  assert.equal(s.calls.tokens.length, 1);
  assert.equal(s.calls.messages.length, 2);
  assert.notEqual(s.calls.messages[0].uuid, s.calls.messages[1].uuid);
});

test("a rejected expired token is refreshed once without changing message identity", async (t) => {
  const s = setup(t);
  s.scenario.messageResponse = () => s.calls.messages.length === 1
    ? Response.json({ code: 99991668 }, { status: 401 })
    : Response.json({ code: 0, data: { message_id: "om_fresh" } });
  await s.run();
  assert.equal(s.calls.tokens.length, 2);
  assert.equal(s.calls.messages.length, 2);
  assert.equal(s.calls.messages[0].uuid, s.calls.messages[1].uuid);
  assert.equal(s.state.get(cursor), nextReset.tweet_id);
});

test("invalid Feishu configuration leaves successful WeCom delivery recorded", async (t) => {
  const s = setup(t);
  delete s.env.FEISHU_APP_SECRET;
  await assert.rejects(s.run(), /Feishu configuration/);
  assert.equal(s.state.get("last_tweet_id"), nextReset.tweet_id);
  assert.equal(s.state.get(cursor), completed.tweet_id);
  assert.equal(s.calls.tokens.length + s.calls.messages.length, 0);
});

test("Feishu stays inactive until explicitly enabled", async (t) => {
  const s = setup(t);
  delete s.env.FEISHU_ENABLED;
  assert.equal((await s.run()).count, 1);
  assert.equal(s.calls.tokens.length + s.calls.messages.length, 0);
  assert.equal(s.state.get(cursor), completed.tweet_id);
});

test("incomplete Feishu success or broad token permissions cannot advance delivery", async (t) => {
  const s = setup(t);
  s.scenario.messageResponse = () => Response.json({ code: 0, data: {} });
  await assert.rejects(s.run(), /Feishu message rejected/);
  assert.equal(s.state.get(cursor), completed.tweet_id);
  s.scenario.tokenResponse = () => Response.json({ code: 0, access_token: "test-token", expires_in: 7200, token_type: "Bearer", scope: "im:message:send_as_bot docs:read" });
  await assert.rejects(s.run(), /invalid expiry or permissions/);
  assert.equal(s.calls.messages.length, 1);
  assert.equal(s.state.get(cursor), completed.tweet_id);
});

test("a failed bootstrap write never causes existing forecasts to be sent", async (t) => {
  const s = setup(t, { bootstrap: true });
  s.scenario.payload = { events: [completed], scheduled: upcoming };
  s.state.set(`scheduled_notice:${upcoming.tweet_id}`, JSON.stringify({ fingerprint }));
  s.scenario.failPut = cursor;
  await assert.rejects(s.run(), /KV temporarily unavailable/);
  assert.equal(s.state.has(cursor), false);
  assert.equal(s.state.has(notice), true);
  s.scenario.failPut = null;
  assert.equal((await s.run()).count, 0);
  assert.equal((await s.run()).count, 0);
  assert.equal(s.calls.messages.length + s.calls.tokens.length + s.calls.wecom.length, 0);
});
