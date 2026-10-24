import assert from "node:assert/strict";
import test from "node:test";

import { checkAndNotify } from "../src/index.js";

const oldEvent = {
  tweet_id: "2081940052154933696",
  tweet_url: "https://x.com/example/status/2081940052154933696",
  text: "Old reset",
  announced_at: "2026-07-28T04:09:02.000Z",
  reset_type: "regular",
};

const newEvent = {
  tweet_id: "2082317452755751098",
  tweet_url: "https://x.com/example/status/2082317452755751098",
  text: "New reset",
  announced_at: "2026-07-29T04:09:02.000Z",
  reset_type: "regular",
};

test("saves a successfully sent reset and does not send it twice", async () => {
  let savedId = oldEvent.tweet_id;
  let webhookCalls = 0;
  const operations = [];

  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/resets")) {
      operations.push("fetch-events");
      return Response.json({ events: [newEvent, oldEvent] });
    }

    operations.push("send-webhook");
    webhookCalls += 1;
    return Response.json({ errcode: 0, errmsg: "ok" });
  };

  const env = {
    WECOM_WEBHOOK_URL: "https://example.invalid/webhook",
    RESET_STATE: {
      async get() {
        operations.push("get-state");
        return savedId;
      },
      async put(_key, value) {
        operations.push("put-state");
        savedId = value;
      },
    },
  };

  const first = await checkAndNotify(env);
  const second = await checkAndNotify(env);

  assert.equal(first.status, "notifications_sent");
  assert.equal(second.status, "no_change");
  assert.equal(webhookCalls, 1);
  assert.equal(savedId, newEvent.tweet_id);
  assert.ok(operations.indexOf("send-webhook") < operations.indexOf("put-state"));
});

test("does not resend an older event when the saved ID is absent from the API window", async () => {
  let webhookCalls = 0;

  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/resets")) {
      return Response.json({ events: [oldEvent] });
    }

    webhookCalls += 1;
    return Response.json({ errcode: 0, errmsg: "ok" });
  };

  const result = await checkAndNotify({
    WECOM_WEBHOOK_URL: "https://example.invalid/webhook",
    RESET_STATE: {
      async get() {
        return newEvent.tweet_id;
      },
      async put() {
        throw new Error("state must not be updated");
      },
    },
  });

  assert.equal(result.status, "no_change");
  assert.equal(webhookCalls, 0);
});

test("retries an event when the webhook request fails", async () => {
  let savedId = oldEvent.tweet_id;
  let webhookCalls = 0;

  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/resets")) {
      return Response.json({ events: [newEvent, oldEvent] });
    }

    webhookCalls += 1;
    return webhookCalls === 1
      ? new Response("unavailable", { status: 503 })
      : Response.json({ errcode: 0, errmsg: "ok" });
  };

  const env = {
    WECOM_WEBHOOK_URL: "https://example.invalid/webhook",
    RESET_STATE: {
      async get() {
        return savedId;
      },
      async put(_key, value) {
        savedId = value;
      },
    },
  };

  await assert.rejects(checkAndNotify(env), /WeCom webhook returned HTTP 503/);
  assert.equal(savedId, oldEvent.tweet_id);

  const second = await checkAndNotify(env);
  assert.equal(second.status, "notifications_sent");
  assert.equal(savedId, newEvent.tweet_id);
  assert.equal(webhookCalls, 2);
});

test("does not mark an event delivered when WeCom rejects the message", async () => {
  let savedId = oldEvent.tweet_id;

  globalThis.fetch = async (url) =>
    String(url).includes("/api/resets")
      ? Response.json({ events: [newEvent, oldEvent] })
      : Response.json({ errcode: 93000, errmsg: "invalid webhook" });

  await assert.rejects(
    checkAndNotify({
      WECOM_WEBHOOK_URL: "https://example.invalid/webhook",
      RESET_STATE: {
        async get() {
          return savedId;
        },
        async put(_key, value) {
          savedId = value;
        },
      },
    }),
    /WeCom rejected message: errcode=93000/,
  );
  assert.equal(savedId, oldEvent.tweet_id);
});

test("recovers when the saved announcement disappears and observed IDs remain", async () => {
  const savedId = "2097752790177370535"; // 2026-09-09, absent from the API response.
  const observedEvent = {
    ...oldEvent,
    tweet_id: "observed-2097043464538264003",
    announced_at: "2026-09-08T01:56:57.501Z",
  };
  const septemberEvent = {
    ...oldEvent,
    tweet_id: "2098685367058612394",
    announced_at: "2026-09-12T08:09:17.000Z",
  };
  const latestEvent = {
    ...newEvent,
    tweet_id: "2102463847714247142",
    announced_at: "2026-09-22T18:23:37.000Z",
    reset_type: "banked",
  };
  let state = savedId;
  const sent = [];

  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/api/resets")) {
      return Response.json({ events: [latestEvent, observedEvent, septemberEvent] });
    }
    sent.push(JSON.parse(options.body).markdown.content);
    return Response.json({ errcode: 0, errmsg: "ok" });
  };

  const result = await checkAndNotify({
    WECOM_WEBHOOK_URL: "https://example.invalid/webhook",
    RESET_STATE: {
      async get() {
        return state;
      },
      async put(_key, value) {
        state = value;
      },
    },
  });

  assert.equal(result.count, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /2026-09-23 02:23:37/);
  assert.equal(state, latestEvent.tweet_id);
});

test("uses distinct copy for a direct reset and a banked reset", async () => {
  const sent = [];
  const bankedEvent = { ...newEvent, reset_type: "banked" };
  let currentEvent = newEvent;

  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/api/resets")) {
      return Response.json({ events: [currentEvent, oldEvent] });
    }
    sent.push(JSON.parse(options.body).markdown.content);
    return Response.json({ errcode: 0, errmsg: "ok" });
  };

  const env = {
    WECOM_WEBHOOK_URL: "https://example.invalid/webhook",
    RESET_STATE: {
      async get() {
        return oldEvent.tweet_id;
      },
      async put() {},
    },
  };

  await checkAndNotify(env);
  currentEvent = bankedEvent;
  await checkAndNotify(env);

  assert.match(sent[0], /Codex 又重置啦/);
  assert.match(sent[0], /这次是直接重置额度。/);
  assert.match(sent[0], /> 重置时间：/);
  assert.doesNotMatch(sent[0], /公告时间：|发卡时间：/);
  assert.doesNotMatch(sent[0], /重置卡/);
  assert.match(sent[1], /Codex 发重置卡啦/);
  assert.match(sent[1], /这次发的是重置卡，留着按需使用。/);
  assert.match(sent[1], /> 发卡时间：/);
  assert.doesNotMatch(sent[1], /公告时间：|> 重置时间：/);
  assert.doesNotMatch(sent[1], /又重置啦/);
});

test("does not resend a banked reset already saved as delivered", async () => {
  const bankedEvent = { ...newEvent, reset_type: "banked" };
  let webhookCalls = 0;

  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/resets")) {
      return Response.json({ events: [bankedEvent, oldEvent] });
    }
    webhookCalls += 1;
    return Response.json({ errcode: 0, errmsg: "ok" });
  };

  const result = await checkAndNotify({
    WECOM_WEBHOOK_URL: "https://example.invalid/webhook",
    RESET_STATE: {
      async get() {
        return bankedEvent.tweet_id;
      },
      async put() {
        throw new Error("state must not be updated");
      },
    },
  });

  assert.equal(result.status, "no_change");
  assert.equal(webhookCalls, 0);
});
