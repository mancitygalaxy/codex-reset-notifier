const TOKEN_URL = "https://accounts.feishu.cn/oauth/v3/token";
const MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id";
const SEND_SCOPE = "im:message:send_as_bot";

function buildFeishuPost(markdown) {
  const [heading, ...body] = markdown.split("\n");
  const content = body.filter((line) => line.trim()).map((line) => {
    const plain = line.replace(/^>\s?/, "").replace(/<\/?font\b[^>]*>/g, "");
    const link = plain.match(/^\[查看原公告\]\((https:\/\/[^\s)]+)\)$/);
    return [link
      ? { tag: "a", text: "查看原公告", href: link[1] }
      : { tag: "text", text: plain }];
  });
  return { zh_cn: { title: heading.replace(/^#{1,6}\s*/, ""), content } };
}

async function deliveryUuid(identity, eventKey) {
  const bytes = new TextEncoder().encode(`${identity}\0${eventKey}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "codex-" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

function createFeishuSender(env) {
  const { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret, FEISHU_RECEIVER_OPEN_ID: recipient } = env;
  if (!/^cli_[a-zA-Z0-9]+$/.test(appId ?? "") || typeof appSecret !== "string" || !appSecret.trim() || !/^ou_[a-zA-Z0-9]+$/.test(recipient ?? "")) {
    throw new Error("Feishu configuration is incomplete or invalid");
  }
  // Tokens are reused within this run and never written to KV or logs.
  let cachedToken;
  async function token(force = false) {
    if (!force && cachedToken?.expiresAt > Date.now() + 60_000) return cachedToken.value;
    let response;
    try {
      response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials", client_id: appId,
          client_secret: appSecret, scope: SEND_SCOPE,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error("Feishu token request failed");
    }
    let data;
    try { data = await response.json(); } catch { throw new Error("Feishu token response is invalid"); }
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu token rejected: HTTP ${response.status}, code=${Number.isFinite(data.code) ? data.code : "unknown"}`);
    }
    if (typeof data.access_token !== "string" || !data.access_token ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 60 || data.token_type !== "Bearer" ||
      data.scope?.trim() !== SEND_SCOPE) {
      throw new Error("Feishu token response has invalid expiry or permissions");
    }
    cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return cachedToken.value;
  }

  return async (markdown, eventKey) => {
    const uuid = await deliveryUuid(`${appId}:${recipient}`, eventKey);
    const body = JSON.stringify({
      receive_id: recipient, msg_type: "post",
      content: JSON.stringify(buildFeishuPost(markdown)), uuid,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await token(attempt > 0);
      let response;
      try {
        response = await fetch(MESSAGE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=utf-8" },
          body, signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new Error("Feishu message request failed; delivery state was not advanced");
      }
      let data;
      try { data = await response.json(); } catch { throw new Error("Feishu message response is invalid"); }
      if (attempt === 0 && (response.status === 401 || [99991663, 99991668].includes(data.code))) continue;
      if (!response.ok || data.code !== 0 || typeof data.data?.message_id !== "string" || !data.data.message_id) {
        // Do not log response text: an upstream error may echo credentials or content.
        throw new Error(`Feishu message rejected: HTTP ${response.status}, code=${Number.isFinite(data.code) ? data.code : "unknown"}`);
      }
      return data.data.message_id;
    }
  };
}

function createFeishuWebhookSender(webhookUrl) {
  if (typeof webhookUrl !== "string" || !/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(webhookUrl)) {
    throw new Error("Feishu group webhook configuration is incomplete or invalid");
  }
  return async (markdown) => {
    let response;
    try {
      response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ msg_type: "post", content: { post: buildFeishuPost(markdown) } }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error("Feishu group webhook request failed; delivery state was not advanced");
    }
    if (!response.ok) {
      throw new Error(`Feishu group webhook returned HTTP ${response.status}`);
    }
    let result;
    try { result = await response.json(); } catch { throw new Error("Feishu group webhook response is invalid"); }
    if (result.code !== 0) {
      throw new Error(`Feishu group webhook rejected: HTTP ${response.status}, code=${Number.isFinite(result.code) ? result.code : "unknown"}`);
    }
  };
}

export { buildFeishuPost, createFeishuSender, createFeishuWebhookSender };
