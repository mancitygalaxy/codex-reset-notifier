import { createFeishuSender, createFeishuWebhookSender } from "./feishu.js";

const RESET_API_URL = "https://codex-resets.com/api/resets";
const STATE_KEY = "last_tweet_id";
const SCHEDULED_STATE_PREFIX = "scheduled_notice:";

function parseTime(value, field = "announced_at") {
  const timestamp = Date.parse(value);
  if (typeof value !== "string" || Number.isNaN(timestamp)) {
    throw new Error(`Invalid ${field} value`);
  }
  return timestamp;
}

function cleanText(value, limit = 900) {
  const compact = String(value).replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

function formatBeijingTime(value) {
  const shifted = new Date(parseTime(value) + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 19).replace("T", " ");
}

function buildMarkdown(event) {
  let title;
  let summary;
  if (event.reset_type === "banked") {
    title = "### 🎫 Codex 发重置卡啦，留着按需用！";
    summary = "> 这次发的是重置卡，留着按需使用。";
  } else if (event.reset_type === "regular") {
    title = "### 🚲 Codex 又重置啦，使劲蹬～！！";
    summary = "> 这次是直接重置额度。";
  } else {
    throw new Error(`Unknown reset_type: ${event.reset_type}`);
  }

  return [
    title,
    summary,
    `> ${event.reset_type === "banked" ? "发卡" : "重置"}时间：<font color="info">${formatBeijingTime(event.announced_at)}（北京时间）</font>`,
    `> 原公告：${cleanText(event.text)}`,
    "",
    `[查看原公告](${event.tweet_url})`,
  ].join("\n");
}

function scheduledDetails(event) {
  if (
    !event || typeof event !== "object" ||
    !["tweet_id", "tweet_url", "text", "announced_at"].every(
      (field) => typeof event[field] === "string" && event[field].trim(),
    ) || !["regular", "banked"].includes(event.reset_type)
  ) {
    throw new Error("Reset API scheduled event schema is invalid");
  }
  parseTime(event.announced_at);
  let scheduledFor = null;
  if (event.scheduled_for != null) {
    // Never interpret a timestamp in the deployment host's local timezone.
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(event.scheduled_for)) {
      throw new Error("scheduled_for must include a timezone");
    }
    scheduledFor = new Date(parseTime(event.scheduled_for, "scheduled_for")).toISOString();
  }
  const before = /\b(?:before|by|within)\b|之前|以前|以内|之内/i.test(event.text);
  return { scheduledFor, resetType: event.reset_type, before: scheduledFor ? before : false };
}

function buildScheduledMarkdown(event, { updated = false, now = Date.now() } = {}) {
  const details = scheduledDetails(event);
  const banked = details.resetType === "banked";
  const subject = banked ? "重置卡" : "重置";
  const expected = details.scheduledFor
    ? `${formatBeijingTime(details.scheduledFor).slice(0, 16)}${details.before ? " 前" : " 左右"}（北京时间）`
    : "时间待定（公告未给出明确时间）";
  const lines = [
    `### ⏰ Codex ${subject}预告${updated ? "更新" : "，先报个信～"}`,
    banked
      ? "> 接下来预计发放重置卡，到账后可按需使用。"
      : "> 接下来预计直接重置额度。",
    `> 预计${banked ? "发卡" : "重置"}时间：<font color="info">${expected}</font>`,
  ];
  if (details.scheduledFor && parseTime(details.scheduledFor) <= now) {
    lines.push("> 预告时间已到，仍待后续重置公告确认。");
  }
  lines.push(
    `> 原公告：${cleanText(event.text)}`,
    "",
    `[查看原公告](${event.tweet_url})`,
  );
  return lines.join("\n");
}

async function fetchResetStatus() {
  const response = await fetch(RESET_API_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "codex-reset-notifier/1.0.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Reset API returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload.events) || payload.events.length === 0) {
    throw new Error("Reset API returned no events");
  }

  const required = ["tweet_id", "tweet_url", "text", "announced_at"];
  const events = payload.events.filter(
    (event) =>
      event &&
      typeof event === "object" &&
      required.every((field) => event[field] !== undefined),
  );
  if (events.length === 0) {
    throw new Error("Reset API event schema is invalid");
  }
  return {
    events: events.sort((a, b) => parseTime(a.announced_at) - parseTime(b.announced_at)),
    // `watch` is a probabilistic forecast, not an explicit reset announcement.
    scheduled: payload.scheduled ?? null,
  };
}

async function sendWeComMarkdown(webhookUrl, content) {
  if (typeof webhookUrl !== "string" || !webhookUrl.trim()) {
    throw new Error("WeCom webhook is not configured");
  }
  let response;
  try {
    response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "codex-reset-notifier/1.0.0",
      },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { content },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("WeCom webhook request failed; delivery state was not advanced");
  }
  if (!response.ok) {
    throw new Error(`WeCom webhook returned HTTP ${response.status}`);
  }

  let result;
  try { result = await response.json(); } catch {
    throw new Error("WeCom webhook response is invalid");
  }
  if (result.errcode !== 0) {
    throw new Error(
      `WeCom rejected message: errcode=${Number.isFinite(result.errcode) ? result.errcode : "unknown"}`,
    );
  }
}

function getPendingEvents(events, lastTweetId) {
  const ids = events.map((event) => String(event.tweet_id));
  const index = ids.indexOf(String(lastTweetId));
  if (index !== -1) {
    return events.slice(index + 1);
  }

  // The API can remove an announcement and also contains observed-* IDs.
  // Compare the saved announcement's time with the latest one, then send at
  // most one event if the baseline is no longer in the API response.
  const rawId = String(lastTweetId).replace(/^observed-/, "");
  let savedTime;
  if (/^\d{8}T\d{6}Z$/.test(rawId)) {
    const compact = rawId;
    savedTime = Date.parse(
      `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T` +
        `${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`,
    );
  } else if (/^\d+$/.test(rawId)) {
    // X/Twitter Snowflake IDs encode milliseconds since 2010-11-04.
    savedTime = Number((BigInt(rawId) >> 22n) + 1288834974657n);
  }
  if (!Number.isFinite(savedTime)) {
    throw new Error(`Cannot determine saved announcement time: ${lastTweetId}`);
  }

  const latest = events[events.length - 1];
  return parseTime(latest.announced_at) > savedTime ? [latest] : [];
}

async function notifyScheduled(env, scheduled, events, now, channel) {
  if (!scheduled) return 0;
  const details = scheduledDetails(scheduled);
  const latest = events[events.length - 1];
  if (
    events.some((event) => String(event.tweet_id) === scheduled.tweet_id) ||
    parseTime(latest.announced_at) >= parseTime(scheduled.announced_at)
  ) {
    console.log(`Superseded scheduled announcement skipped: tweet_id=${scheduled.tweet_id}`);
    return 0;
  }

  // Keep each announcement's latest delivered time/type separate from the
  // executed-reset cursor. A disappearing/reappearing announcement stays deduped.
  const key = `${channel.scheduledPrefix}${scheduled.tweet_id}`;
  const fingerprint = JSON.stringify(details);
  const previous = await env.RESET_STATE.get(key);
  if (previous && JSON.parse(previous).fingerprint === fingerprint) return 0;

  await (channel.sendScheduled ?? channel.send)(
    buildScheduledMarkdown(scheduled, { updated: Boolean(previous), now }),
    `scheduled:${scheduled.tweet_id}:${fingerprint}`,
  );
  await env.RESET_STATE.put(key, JSON.stringify({
    fingerprint,
    announcedAt: scheduled.announced_at,
    notifiedAt: new Date(now).toISOString(),
  }));
  console.log(`Scheduled notification sent: channel=${channel.name}, tweet_id=${scheduled.tweet_id}, updated=${Boolean(previous)}, scheduled_for=${details.scheduledFor ?? "unknown"}, delivery_code=0`);
  return 1;
}

async function checkChannel(env, { events, scheduled }, now, channel) {
  const latest = events[events.length - 1];
  const lastTweetId = await env.RESET_STATE.get(channel.stateKey);

  if (!lastTweetId) {
    if (channel.silentBaseline && scheduled) {
      const details = scheduledDetails(scheduled);
      // Write the announcement baseline first. If either KV write fails, retry
      // initialization without sending historical or already-visible content.
      await env.RESET_STATE.put(`${channel.scheduledPrefix}${scheduled.tweet_id}`, JSON.stringify({
        fingerprint: JSON.stringify(details), announcedAt: scheduled.announced_at,
        baselineAt: new Date(now).toISOString(),
      }));
    }
    await env.RESET_STATE.put(channel.stateKey, String(latest.tweet_id));
    console.log(`Baseline initialized: channel=${channel.name}, tweet_id=${latest.tweet_id}`);
    if (channel.silentBaseline) {
      return { status: "baseline_initialized", count: 0, resetCount: 0, scheduledCount: 0, latestTweetId: String(latest.tweet_id) };
    }
  }

  const pending = lastTweetId ? getPendingEvents(events, lastTweetId) : [];
  for (const event of pending) {
    // Each channel advances only its own cursor after acknowledged delivery.
    await channel.send(buildMarkdown(event), `reset:${event.tweet_id}`);
    await env.RESET_STATE.put(channel.stateKey, String(event.tweet_id));
    console.log(`Notification sent: channel=${channel.name}, tweet_id=${event.tweet_id}`);
  }
  const scheduledCount = await notifyScheduled(env, scheduled, events, now, channel);
  const count = pending.length + scheduledCount;
  if (!count) {
    console.log(`No new reset or scheduled announcement: channel=${channel.name}, tweet_id=${latest.tweet_id}`);
  }
  return {
    status: count ? "notifications_sent" : lastTweetId ? "no_change" : "baseline_initialized",
    count,
    resetCount: pending.length,
    scheduledCount,
    latestTweetId: String(latest.tweet_id),
  };
}

async function checkAndNotify(env, { now = Date.now() } = {}) {
  const status = await fetchResetStatus();
  const results = [];
  const errors = [];
  const wecom = {
    name: "wecom", stateKey: STATE_KEY, scheduledPrefix: SCHEDULED_STATE_PREFIX,
    send: (content) => sendWeComMarkdown(env.WECOM_WEBHOOK_URL, content),
    sendScheduled: (content) => sendWeComMarkdown(env.WECOM_SCHEDULED_WEBHOOK_URL, content),
  };
  try { results.push(await checkChannel(env, status, now, wecom)); } catch (error) { errors.push(error); }

  if (env.FEISHU_ENABLED === "true") {
    try {
      if (env.FEISHU_DELIVERY_MODE === "group_webhook") {
        if (!/^oc_[a-zA-Z0-9]+$/.test(env.FEISHU_GROUP_ID ?? "")) {
          throw new Error("Feishu group identity is incomplete or invalid");
        }
        const prefix = `feishu-group:${env.FEISHU_GROUP_ID}:`;
        results.push(await checkChannel(env, status, now, {
          name: "feishu-group", stateKey: `${prefix}${STATE_KEY}`,
          scheduledPrefix: `${prefix}${SCHEDULED_STATE_PREFIX}`, silentBaseline: true,
          send: createFeishuWebhookSender(env.FEISHU_WEBHOOK_URL),
          sendScheduled: createFeishuWebhookSender(env.FEISHU_SCHEDULED_WEBHOOK_URL),
        }));
      } else if (!env.FEISHU_DELIVERY_MODE || env.FEISHU_DELIVERY_MODE === "app") {
        const send = createFeishuSender(env);
        const prefix = `feishu:${env.FEISHU_APP_ID}:${env.FEISHU_RECEIVER_OPEN_ID}:`;
        results.push(await checkChannel(env, status, now, {
          name: "feishu", stateKey: `${prefix}${STATE_KEY}`,
          scheduledPrefix: `${prefix}${SCHEDULED_STATE_PREFIX}`, silentBaseline: true, send,
        }));
      } else {
        throw new Error("Feishu delivery mode is invalid");
      }
    } catch (error) { errors.push(error); }
  }

  // Process both destinations before reporting failures. A Feishu error cannot
  // prevent WeCom delivery, and successful destinations will not be retried.
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
  if (results.length === 1) return results[0];
  const count = results.reduce((sum, result) => sum + result.count, 0);
  return {
    status: count ? "notifications_sent" : results.some((result) => result.status === "baseline_initialized") ? "baseline_initialized" : "no_change",
    count, resetCount: results.reduce((sum, result) => sum + result.resetCount, 0),
    scheduledCount: results.reduce((sum, result) => sum + result.scheduledCount, 0),
    latestTweetId: results[0].latestTweetId,
  };
}

export { checkAndNotify, buildScheduledMarkdown };

export default {
  async scheduled(_controller, env) {
    await checkAndNotify(env);
  },
};
