import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

// /api does not use Browser Rendering; stub only its Worker-only dependency.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@cloudflare/playwright") {
      return {
        url: "data:text/javascript,export function launch() { throw new Error('Unexpected browser launch'); }",
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

const CACHE_KEY = "sensors_cache";
const LOCK_KEY = "sensors_refresh_inflight";
const freshSensors = { door_open: [{ value: true }], temperature: [{ value: 25 }] };

function setup(t, { cold = false, inflight = false, failure } = {}) {
  const oldCache = JSON.stringify({
    fetched_at: Date.now() - 15 * 60 * 1000,
    data: { door_open: [{ value: true }], temperature: [{ value: 20 }] },
  });
  const records = new Map([
    ["last_status", "OPEN"],
    ["last_effective_status", "OPEN"],
  ]);
  if (!cold) records.set(CACHE_KEY, oldCache);
  if (inflight) records.set(LOCK_KEY, "another refresh");
  const operations = [];
  const env = {
    LOCK_STATE: {
      async get(key) {
        operations.push({ operation: "get", key });
        if (key === LOCK_KEY && failure === "lock read") throw new Error("lock read failed");
        return records.get(key) ?? null;
      },
      async put(key, value, options) {
        operations.push({ operation: "put", key, options });
        if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
          throw new Error("Cloudflare KV expirationTtl must be at least 60");
        }
        if (key === LOCK_KEY && failure === "lock write") throw new Error("lock write failed");
        if (key === CACHE_KEY && failure === "cache write") throw new Error("cache write failed");
        records.set(key, value);
      },
      async delete(key) {
        operations.push({ operation: "delete", key });
        if (failure === "lock delete") throw new Error("lock delete failed");
        records.delete(key);
      },
    },
  };
  const upstream = t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, "https://moztw-co2.yuaner.tw/sensors");
    if (failure === "network") throw new Error("network failed");
    if (failure === "HTTP") return new Response("Unavailable", { status: 503 });
    if (failure === "JSON") return new Response("{", { status: 200 });
    return Response.json(freshSensors);
  });
  const warnings = t.mock.method(console, "warn", () => {});
  async function request() {
    const background = [];
    const response = await worker.fetch(new Request("https://moztw.space/api"), env, {
      waitUntil(promise) { background.push(promise); },
    });
    await Promise.all(background);
    assert.equal(response.status, 200);
    return { response, payload: await response.json() };
  }
  return { records, operations, oldCache, upstream, warnings, request };
}

describe("/api sensor refresh", () => {
  it("uses a valid lock TTL, updates stale cache, and releases its lock", async t => {
    const test = setup(t);
    const { payload, response } = await test.request();
    assert.equal(payload.sensors_meta.stale, true);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(test.upstream.mock.callCount(), 1);
    const lockWrite = test.operations.find(item => item.operation === "put" && item.key === LOCK_KEY);
    assert.equal(lockWrite.options.expirationTtl, 60);
    assert.equal(test.records.has(LOCK_KEY), false);
    assert.deepEqual(JSON.parse(test.records.get(CACHE_KEY)).data, freshSensors);
    const next = await test.request();
    assert.equal(next.payload.sensors_meta.stale, false);
    assert.deepEqual(next.payload.sensors, freshSensors);
    assert.equal(test.upstream.mock.callCount(), 1);
  });

  it("skips an existing refresh without deleting its lock", async t => {
    const test = setup(t, { inflight: true });
    assert.equal((await test.request()).payload.sensors_meta.stale, true);
    assert.equal(test.upstream.mock.callCount(), 0);
    assert.equal(test.records.get(LOCK_KEY), "another refresh");
    assert.equal(test.operations.some(item => item.operation === "delete"), false);
  });

  for (const failure of ["lock read", "lock write"]) {
    it(`handles ${failure} failure without rejecting background work or deleting a lock`, async t => {
      const test = setup(t, { failure });
      assert.equal((await test.request()).payload.sensors_meta.stale, true);
      assert.equal(test.records.get(CACHE_KEY), test.oldCache);
      assert.equal(test.upstream.mock.callCount(), 0);
      assert.equal(test.operations.some(item => item.operation === "delete"), false);
      assert.equal(test.warnings.mock.callCount(), 1);
    });
  }

  for (const failure of ["network", "HTTP", "JSON", "cache write"]) {
    it(`preserves stale data and releases its lock after ${failure} failure`, async t => {
      const test = setup(t, { failure });
      assert.equal((await test.request()).payload.sensors_meta.stale, true);
      assert.equal(test.records.get(CACHE_KEY), test.oldCache);
      assert.equal(test.records.has(LOCK_KEY), false);
      assert.equal(test.upstream.mock.callCount(), 1);
      assert.equal(test.warnings.mock.callCount(), 1);
    });
  }

  it("logs cleanup failure while preserving successfully refreshed cache", async t => {
    const test = setup(t, { failure: "lock delete" });
    await test.request();
    assert.deepEqual(JSON.parse(test.records.get(CACHE_KEY)).data, freshSensors);
    assert.equal(test.warnings.mock.callCount(), 1);
    assert.equal((await test.request()).payload.sensors_meta.stale, false);
  });

  it("refreshes a cold cache without reading, writing, or removing a refresh lock", async t => {
    const test = setup(t, { cold: true, inflight: true });
    const { payload } = await test.request();
    assert.equal(payload.sensors_meta.stale, false);
    assert.deepEqual(payload.sensors, freshSensors);
    assert.equal(test.upstream.mock.callCount(), 1);
    assert.equal(test.records.get(LOCK_KEY), "another refresh");
    assert.equal(test.operations.some(item => item.key === LOCK_KEY), false);
  });

  it("keeps the cold-cache response safe when upstream fails, without creating a lock", async t => {
    const test = setup(t, { cold: true, failure: "network" });
    const { payload } = await test.request();
    assert.equal(payload.sensors, undefined);
    assert.equal(test.records.has(CACHE_KEY), false);
    assert.equal(test.operations.some(item => item.key === LOCK_KEY), false);
    assert.equal(test.warnings.mock.callCount(), 1);
  });
});
