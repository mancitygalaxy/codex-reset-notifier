import assert from "node:assert/strict";
import test from "node:test";
import { checkAndNotify } from "../src/index.js";

const prior = {
  tweet_id: "prior", tweet_url: "https://example.invalid/prior",
  text: "Previous reset.", announced_at: "2026-10-20T00:00:00Z", reset_type: "regular",
};
const next = { ...prior, tweet_id: "next", announced_at: "2026-10-21T00:00:00Z" };
const webhook = "https://example.invalid/private-webhook-fixture";
const sensitive = "fixture-sensitive-text";

for (const failure of ["network", "invalid-json", "rejected", "invalid-code"]) {
  test(`WeCom ${failure} errors do not echo credentials or advance the cursor`, async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let cursor = prior.tweet_id;
    globalThis.fetch = async (url) => {
      if (url === "https://codex-resets.com/api/resets") {
        return Response.json({ events: [prior, next] });
      }
      assert.equal(url, webhook);
      if (failure === "network") throw new Error(`${webhook} ${sensitive}`);
      if (failure === "invalid-json") return new Response(`Invalid ${webhook} ${sensitive}`);
      if (failure === "invalid-code") return Response.json({ errcode: sensitive });
      return Response.json({ errcode: 93000, errmsg: `${webhook} ${sensitive}` });
    };
    await assert.rejects(checkAndNotify({
      WECOM_WEBHOOK_URL: webhook,
      RESET_STATE: {
        async get() { return cursor; },
        async put(_key, value) { cursor = value; },
      },
    }), (error) => {
      assert.match(error.message, /WeCom/);
      assert.equal(error.message.includes(webhook), false);
      assert.equal(error.message.includes(sensitive), false);
      return true;
    });
    assert.equal(cursor, prior.tweet_id);
  });
}
