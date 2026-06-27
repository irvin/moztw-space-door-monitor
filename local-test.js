// 本機用 Playwright 腳本：開登入頁，讓你手動完成登入，
// 然後透過 Candy House WebSocket（PubedCompanyDevice）讀取工寮 Open Sensor 狀態，
// 最後以 wrangler 直接寫入 LOCK_STATE KV（不經 HTTP，避開 workers.dev Access）。
//
// 登入完成後會自動偵測（離開 /login）。

import { chromium } from "playwright";
import { execFile } from "node:child_process";
import dotenv from "dotenv";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  OPEN_SENSOR_DEVICE_UUID_DEFAULT,
  WS_STATUS_TIMEOUT_MS_DEFAULT,
  attachOpenSensorWebSocketListener,
  waitForFirstWsCapture,
} from "./src/open-sensor-ws.js";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL(".", import.meta.url));

if (fs.existsSync(".dev.vars")) {
  dotenv.config({ path: ".dev.vars" });
} else if (fs.existsSync(".env")) {
  dotenv.config();
}

const LOGIN_URL_DEFAULT = "https://biz.candyhouse.co/login";
const STATUS_URL_DEFAULT = "https://biz.candyhouse.co";
const SESSION_LOGIN_TIMEOUT_MS_DEFAULT = 10 * 60 * 1000;
const SESSION_POLL_INTERVAL_MS_DEFAULT = 2000;
const SESSION_COOKIE_TTL_SEC_DEFAULT = 7 * 24 * 3600;
const SESSION_LOGIN_STABLE_POLLS_DEFAULT = 3;
const SESSION_LOCAL_STORAGE_KV_KEY = "session_local_storage";

const {
  OPEN_SENSOR_DEVICE_UUID,
  WS_STATUS_TIMEOUT_MS,
  SESSION_LOGIN_TIMEOUT_MS,
  SESSION_POLL_INTERVAL_MS,
  SESSION_COOKIE_TTL_SEC,
  SESSION_LOGIN_STABLE_POLLS,
} = process.env;

const SESSION_COOKIES_KV_KEY = "session_cookies";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoginUrl(url) {
  try {
    return new URL(String(url)).pathname.includes("/login");
  } catch {
    return String(url).includes("/login");
  }
}

function logSessionEvent(event, detail = {}) {
  console.log(`SESSION_${event}:`, JSON.stringify(detail));
}

/** 自 wrangler.toml LOCK_STATE binding 讀 namespace id（僅供 log 確認）。 */
function readLockStateKvNamespaceIdFromWranglerToml() {
  const tomlPath = join(PROJECT_ROOT, "wrangler.toml");
  const toml = fs.readFileSync(tomlPath, "utf8");
  const blocks = toml.split("[[kv_namespaces]]");
  for (const block of blocks.slice(1)) {
    if (!/binding\s*=\s*"LOCK_STATE"/.test(block)) continue;
    const idMatch = block.match(/^\s*id\s*=\s*"([^"]+)"/m);
    if (idMatch) return idMatch[1];
  }
  throw new Error("找不到 wrangler.toml 內 LOCK_STATE KV namespace id");
}

async function runWrangler(args) {
  await execFileAsync("npx", ["wrangler", ...args], { cwd: PROJECT_ROOT });
}

async function wranglerKvPut(key, jsonText, ttlSec) {
  const dir = await mkdtemp(join(tmpdir(), "moztw-session-kv-"));
  try {
    const filePath = join(dir, `${key}.json`);
    await writeFile(filePath, jsonText, "utf8");
    await runWrangler([
      "kv",
      "key",
      "put",
      key,
      "--binding",
      "LOCK_STATE",
      "--remote",
      "--path",
      filePath,
      "--ttl",
      String(ttlSec),
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function wranglerKvDelete(key) {
  await runWrangler([
    "kv",
    "key",
    "delete",
    key,
    "--binding",
    "LOCK_STATE",
    "--remote",
  ]);
}

/**
 * 與 Worker /import-session 相同：寫入 session_cookies；localStorage 空則刪除鍵。
 * @param {unknown[]} cookies
 * @param {{ key: string; value: string | null }[]} localStorageEntries
 */
async function saveSessionToKv(cookies, localStorageEntries) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error("cookies 必須是非空陣列");
  }

  const namespaceId = readLockStateKvNamespaceIdFromWranglerToml();
  const expirationTtl = Math.max(
    60,
    Number(SESSION_COOKIE_TTL_SEC || SESSION_COOKIE_TTL_SEC_DEFAULT),
  );

  console.log(`寫入 KV（LOCK_STATE / ${namespaceId}，--remote --ttl ${expirationTtl}）...`);
  await wranglerKvPut(
    SESSION_COOKIES_KV_KEY,
    JSON.stringify(cookies),
    expirationTtl,
  );

  if (Array.isArray(localStorageEntries) && localStorageEntries.length > 0) {
    await wranglerKvPut(
      SESSION_LOCAL_STORAGE_KV_KEY,
      JSON.stringify(localStorageEntries),
      expirationTtl,
    );
  } else {
    try {
      await wranglerKvDelete(SESSION_LOCAL_STORAGE_KV_KEY);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found|does not exist|10009/i.test(message)) {
        throw error;
      }
    }
  }

  return {
    ok: true,
    upload_method: "wrangler_kv",
    kv_namespace_id: namespaceId,
    cookies_count: cookies.length,
    local_storage_count: Array.isArray(localStorageEntries)
      ? localStorageEntries.length
      : 0,
    expiration_ttl_sec: expirationTtl,
  };
}

async function waitForStableLoggedIn(page, pollMs, stablePolls) {
  let consecutiveOk = 0;
  while (consecutiveOk < stablePolls) {
    if (isLoginUrl(page.url())) {
      consecutiveOk = 0;
    } else {
      consecutiveOk += 1;
    }
    if (consecutiveOk < stablePolls) {
      await sleep(pollMs);
    }
  }
  if (isLoginUrl(page.url())) {
    throw new Error("登入後又回到登入頁，請重試");
  }
}

/**
 * 等候使用者完成登入（自動輪詢 URL 離開 /login）。
 * @param {import("playwright").Page} page
 */
async function waitForLoginComplete(page) {
  const timeoutMs = Math.max(
    30_000,
    Number(SESSION_LOGIN_TIMEOUT_MS || SESSION_LOGIN_TIMEOUT_MS_DEFAULT),
  );
  const pollMs = Math.max(
    500,
    Number(SESSION_POLL_INTERVAL_MS || SESSION_POLL_INTERVAL_MS_DEFAULT),
  );
  const stablePolls = Math.max(
    2,
    Number(SESSION_LOGIN_STABLE_POLLS || SESSION_LOGIN_STABLE_POLLS_DEFAULT),
  );

  logSessionEvent("WAITING", {
    login_timeout_ms: timeoutMs,
    poll_interval_ms: pollMs,
    login_stable_polls: stablePolls,
  });
  console.log("");
  console.log("請在瀏覽器視窗中手動完成 Candy House 登入（完成後會自動繼續）。");
  console.log("");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLoginUrl(page.url())) {
      await waitForStableLoggedIn(page, pollMs, stablePolls);
      logSessionEvent("LOGIN_DETECTED", { reason: "auto" });
      return;
    }
    await sleep(pollMs);
  }
  throw new Error(`登入等候逾時（${timeoutMs}ms）`);
}

async function main() {
  const deviceUuid = OPEN_SENSOR_DEVICE_UUID || OPEN_SENSOR_DEVICE_UUID_DEFAULT;
  const wsTimeoutMs = Math.max(
    5000,
    Number(WS_STATUS_TIMEOUT_MS || WS_STATUS_TIMEOUT_MS_DEFAULT),
  );
  const kvNamespaceId = readLockStateKvNamespaceIdFromWranglerToml();

  console.log("使用設定：");
  console.log(`LOGIN_URL = ${LOGIN_URL_DEFAULT}`);
  console.log(`STATUS_URL = ${STATUS_URL_DEFAULT}`);
  console.log(`OPEN_SENSOR_DEVICE_UUID = ${deviceUuid}`);
  console.log(`WS_STATUS_TIMEOUT_MS = ${wsTimeoutMs}`);
  console.log(`LOCK_STATE KV namespace id（wrangler.toml）= ${kvNamespaceId}`);
  console.log("");

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  const wsListener = attachOpenSensorWebSocketListener(page, deviceUuid);

  /** @type {{ ok: boolean; error?: string; upload_method?: string; kv_namespace_id?: string; cookies_count?: number; local_storage_count?: number }} */
  let importResult = { ok: false };
  let keepBrowserOpen = false;

  try {
    console.log("打開登入頁...");
    await page.goto(LOGIN_URL_DEFAULT, { waitUntil: "domcontentloaded" });
    await waitForLoginComplete(page);

    console.log("重新載入狀態頁並等待 WebSocket 裝置列表...");
    await page.goto(STATUS_URL_DEFAULT, { waitUntil: "domcontentloaded" });

    const { status, raw } = await waitForFirstWsCapture(
      wsListener.getCaptured,
      wsTimeoutMs,
      "WebSocket PubedCompanyDevice（工寮 Open Sensor）",
    );
    console.log("stateInfo：", raw);
    console.log("正規化後狀態：", status);

    const cookies = await page.context().cookies();
    const localStorageEntries = await page.evaluate(() => {
      const items = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key == null) continue;
        items.push({ key, value: localStorage.getItem(key) });
      }
      return items;
    });

    try {
      importResult = await saveSessionToKv(cookies, localStorageEntries);
      console.log("KV 寫入完成：", importResult);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      importResult = { ok: false, error: message };
      console.log("寫入 session 失敗：", message);
    }

    logSessionEvent("IMPORT_RESULT", {
      ok: importResult.ok,
      upload_method: importResult.upload_method || "wrangler_kv",
      kv_namespace_id: importResult.kv_namespace_id || kvNamespaceId,
      door_status: status,
      cookies_count: importResult.cookies_count ?? cookies.length,
      local_storage_count:
        importResult.local_storage_count ?? localStorageEntries.length,
      error: importResult.error || null,
    });

    if (!importResult.ok) {
      keepBrowserOpen = true;
      process.exitCode = 1;
    }
  } finally {
    wsListener.detach();
    if (keepBrowserOpen) {
      console.log("寫入 KV 失敗，瀏覽器保持開啟；請修正後重跑 npm run session:update。");
      return;
    }
    console.log("關閉瀏覽器...");
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  logSessionEvent("FAILED", {
    error: err instanceof Error ? err.message : String(err),
  });
  console.error("local-test.js 發生錯誤：", err);
  process.exit(1);
});
