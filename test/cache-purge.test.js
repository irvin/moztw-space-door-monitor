import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { purgeZoneApiCache } from "../src/zone-cache.js";

const zoneId = "a".repeat(32);
const token = "test-purge-token";
const purgeUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`;
const credentials = {
  CLOUDFLARE_ZONE_ID: zoneId,
  CLOUDFLARE_CACHE_PURGE_API_TOKEN: token,
};

describe("zone API cache purge", () => {
  it("authenticates and purges only the public API URL", async t => {
    const request = t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(url, purgeUrl);
      assert.equal(options.method, "POST");
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      assert.equal(options.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(options.body), { files: ["https://moztw.space/api"] });
      assert.equal(options.signal.aborted, false);
      return Response.json({ success: true });
    });
    await purgeZoneApiCache(credentials);
    assert.equal(request.mock.callCount(), 1);
  });

  for (const env of [{}, { CLOUDFLARE_ZONE_ID: zoneId }, { CLOUDFLARE_CACHE_PURGE_API_TOKEN: token }]) {
    it(`rejects incomplete configuration (${Object.keys(env).join(", ") || "empty"}) without making a request`, async t => {
      const request = t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected network request"));
      await assert.rejects(purgeZoneApiCache(env), /未設定/);
      assert.equal(request.mock.callCount(), 0);
    });
  }

  it("rejects an invalid zone ID before making a request", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected network request"));
    await assert.rejects(purgeZoneApiCache({ ...credentials, CLOUDFLARE_ZONE_ID: "invalid/zone" }), /格式無效/);
  });

  for (const status of [200, 403, 429, 500]) {
    it(`reports Cloudflare failure with HTTP ${status} without logging response text or credentials`, async t => {
      t.mock.method(globalThis, "fetch", async () => Response.json({
        success: false,
        errors: [{ code: 10000, message: token }],
      }, { status }));
      await assert.rejects(purgeZoneApiCache(credentials), error => {
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.match(error.message, /10000/);
        assert.equal(error.message.includes(token), false);
        return true;
      });
    });
  }

  it("does not accept a successful HTTP response with invalid JSON", async t => {
    t.mock.method(globalThis, "fetch", async () => new Response("not JSON"));
    await assert.rejects(purgeZoneApiCache(credentials), /HTTP 200/);
  });

  it("aborts a stalled request after five seconds", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const pending = assert.rejects(purgeZoneApiCache(credentials), /逾時/);
    t.mock.timers.tick(5000);
    await pending;
    assert.equal(signal.aborted, true);
  });
});

// Exercise the real webhook and Cron handlers without starting Browser Rendering.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@cloudflare/playwright") {
      return {
        url: "data:text/javascript,export function launch() { throw new Error('Browser unavailable in test'); }",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
let worker;
try {
  ({ default: worker } = await import("../src/index.js"));
} finally {
  hooks.deregister();
}

function setup(t, { status = "CLOSED", workerFailure = false, zoneFailure = false, missingConfig = false, telegramFailure = false } = {}) {
  const records = new Map([
    ["last_status", status],
    ["last_effective_status", status],
    ["last_ch_sensor_status", status],
    ["last_sb_sensor_status", status],
  ]);
  const env = {
    ...(missingConfig ? {} : credentials),
    TELEGRAM_ENABLED: telegramFailure ? "true" : "false",
    TELEGRAM_BOT_TOKEN: "test-telegram-token",
    TELEGRAM_CHAT_ID: "123",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    BROWSER_INIT_RETRY: "0",
    LOCK_STATE: {
      async get(key) { return records.get(key) ?? null; },
      async put(key, value) { records.set(key, value); },
      async delete(key) { records.delete(key); },
    },
  };
  const purges = [];
  const pending = [];
  const ctx = {
    waitUntil(promise) { pending.push(promise); },
    cache: {
      async purge(options) {
        purges.push({ options, status: records.get("last_effective_status") });
        if (workerFailure) throw new Error("Workers purge failed");
      },
    },
  };
  const zoneRequests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === purgeUrl) {
      zoneRequests.push({ body: JSON.parse(options.body), status: records.get("last_effective_status") });
      if (zoneFailure) throw new Error("Zone network failure");
      return Response.json({ success: true });
    }
    if (telegramFailure && String(url).startsWith("https://api.telegram.org/")) {
      const body = JSON.parse(options.body);
      if (body.text?.startsWith("#工寮開門 已於")) {
        return new Response("Telegram failure", { status: 503 });
      }
      return Response.json({ ok: true });
    }
    assert.fail(`Unexpected fetch: ${url}`);
  });
  const warnings = t.mock.method(console, "warn", () => {});
  async function drain() {
    while (pending.length) await Promise.all(pending.splice(0));
  }
  async function command(text) {
    const response = await worker.fetch(new Request("https://moztw.space/telegram-webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET },
      body: JSON.stringify({ message: { chat: { id: 123 }, message_id: 1, text } }),
    }), env, ctx);
    await drain();
    return response;
  }
  return { records, env, ctx, purges, zoneRequests, warnings, drain, command };
}

describe("state updates invalidate both cache layers", () => {
  for (const [command, before, after] of [["/manual_open", "CLOSED", "OPEN"], ["/manual_close", "OPEN", "CLOSED"]]) {
    it(`${command} purges both caches after persisting ${after}`, async t => {
      const test = setup(t, { status: before });
      assert.equal((await test.command(command)).status, 200);
      assert.equal(test.records.get("last_effective_status"), after);
      assert.deepEqual(test.purges, [{ options: { tags: ["door-monitor-status", "door-monitor-api"] }, status: after }]);
      assert.deepEqual(test.zoneRequests, [{ body: { files: ["https://moztw.space/api"] }, status: after }]);
      assert.equal(test.warnings.mock.callCount(), 0);
    });
  }

  for (const failure of ["workerFailure", "zoneFailure", "missingConfig"]) {
    it(`preserves state and the other purge when ${failure} occurs`, async t => {
      const test = setup(t, { [failure]: true });
      assert.equal((await test.command("/manual_open")).status, 200);
      assert.equal(test.records.get("last_effective_status"), "OPEN");
      assert.equal(test.purges.length, 1);
      assert.equal(test.zoneRequests.length, failure === "missingConfig" ? 0 : 1);
      assert.equal(test.warnings.mock.callCount(), 1);
    });
  }

  it("still purges both caches if the Telegram reply fails after the state update", async t => {
    const test = setup(t, { telegramFailure: true });
    assert.equal((await test.command("/manual_open")).status, 500);
    assert.equal(test.records.get("last_effective_status"), "OPEN");
    assert.equal(test.purges.length, 1);
    assert.equal(test.zoneRequests.length, 1);
  });

  for (const open of [true, false]) {
    it(`Cron ${open ? "state change purges both caches" : "unchanged state does not purge"}`, async t => {
      const test = setup(t);
      test.records.set("sensors_cache", JSON.stringify({
        fetched_at: Date.now(), data: { door_open: [{ value: open }] },
      }));
      await worker.scheduled({}, test.env, test.ctx);
      await test.drain();
      assert.equal(test.records.get("last_effective_status"), open ? "OPEN" : "CLOSED");
      assert.equal(test.purges.length, open ? 1 : 0);
      assert.equal(test.zoneRequests.length, open ? 1 : 0);
    });
  }
});
