// 本機用 Playwright 腳本：開登入頁，讓你手動完成登入，
// 然後透過 Candy House WebSocket（PubedCompanyDevice）讀取工寮 Open Sensor 狀態，
// 最後把 cookies + localStorage 上傳到 Cloudflare Worker。

import { chromium } from "playwright";
import dotenv from "dotenv";
import fs from "node:fs";
import readline from "node:readline";
import {
  OPEN_SENSOR_DEVICE_UUID_DEFAULT,
  WS_STATUS_TIMEOUT_MS_DEFAULT,
  attachOpenSensorWebSocketListener,
  waitForFirstWsCapture,
} from "./src/open-sensor-ws.js";

// 從 .dev.vars 載入本機 secret（例如 SESSION_IMPORT_URL）
if (fs.existsSync(".dev.vars")) {
  dotenv.config({ path: ".dev.vars" });
} else if (fs.existsSync(".env")) {
  dotenv.config();
}

const LOGIN_URL_DEFAULT = "https://biz.candyhouse.co/login";
const STATUS_URL_DEFAULT = "https://biz.candyhouse.co";

const { SESSION_IMPORT_URL, OPEN_SENSOR_DEVICE_UUID, WS_STATUS_TIMEOUT_MS } =
  process.env;

async function main() {
  const deviceUuid = OPEN_SENSOR_DEVICE_UUID || OPEN_SENSOR_DEVICE_UUID_DEFAULT;
  const wsTimeoutMs = Math.max(
    5000,
    Number(WS_STATUS_TIMEOUT_MS || WS_STATUS_TIMEOUT_MS_DEFAULT),
  );

  console.log("使用設定：");
  console.log(`LOGIN_URL = ${LOGIN_URL_DEFAULT}`);
  console.log(`STATUS_URL = ${STATUS_URL_DEFAULT}`);
  console.log(`OPEN_SENSOR_DEVICE_UUID = ${deviceUuid}`);
  console.log(`WS_STATUS_TIMEOUT_MS = ${wsTimeoutMs}`);
  console.log("");

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  const wsListener = attachOpenSensorWebSocketListener(page, deviceUuid);

  try {
    console.log("打開登入頁...");
    await page.goto(LOGIN_URL_DEFAULT, { waitUntil: "domcontentloaded" });

    console.log("");
    console.log("請在剛開啟的瀏覽器視窗中手動完成登入流程，");
    console.log("直到進入 Candy House 裝置／狀態頁為止。");
    console.log("完成後回到此終端機，按 Enter 繼續。");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await new Promise((resolve) =>
      rl.question("登入完成後請按 Enter 繼續...", () => resolve()),
    );
    rl.close();

    console.log("確認目前頁面已不在 /login...");
    await page.waitForURL(
      (url) => {
        try {
          const u = new URL(url);
          return !u.pathname.includes("/login");
        } catch {
          return !String(url).includes("/login");
        }
      },
      { timeout: 30000 },
    );

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
    console.log("SESSION_COOKIES_JSON:", JSON.stringify(cookies));
    const localStorageEntries = await page.evaluate(() => {
      const items = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key == null) continue;
        items.push({ key, value: localStorage.getItem(key) });
      }
      return items;
    });
    console.log("SESSION_LOCAL_STORAGE:", JSON.stringify(localStorageEntries));

    const importUrl =
      SESSION_IMPORT_URL || "http://localhost:8787/import-session";
    try {
      console.log(`上傳 session cookies 到 ${importUrl} ...`);
      const resp = await fetch(importUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cookies, localStorage: localStorageEntries }),
      });
      const text = await resp.text();
      console.log("import-session 回應：", resp.status, text);
    } catch (e) {
      console.log("上傳 session cookies 失敗（不影響本機測試）：", e);
    }
  } finally {
    wsListener.detach();
    console.log("關閉瀏覽器...");
    await browser.close();
  }
}

main().catch((err) => {
  console.error("local-test.js 發生錯誤：", err);
  process.exit(1);
});
