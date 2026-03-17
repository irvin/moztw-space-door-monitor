// 本機用 Playwright 腳本：開登入頁，讓你手動完成登入，
// 然後在登入後的狀態頁讀取「工寮 Open Sensor」那一列的文字並正規化成 OPEN/CLOSED，
// 最後把 cookies + localStorage 上傳到 Cloudflare Worker。

import { chromium } from "playwright";
import dotenv from "dotenv";
import fs from "node:fs";
import readline from "node:readline";

// 從 .dev.vars 載入本機 secret（例如 LOGIN_EMAIL / SESSION_IMPORT_URL）
if (fs.existsSync(".dev.vars")) {
  dotenv.config({ path: ".dev.vars" });
} else if (fs.existsSync(".env")) {
  dotenv.config();
}

// 與線上 Worker 對齊的固定設定
const LOGIN_URL_DEFAULT = "https://biz.candyhouse.co/login";
const STATUS_URL_DEFAULT = "https://biz.candyhouse.co";
const LOCK_STATUS_SELECTOR_DEFAULT =
  'li:has-text("工寮 Open Sensor")';
const STATUS_OPEN_REGEX_DEFAULT = "(Open)";
const STATUS_CLOSED_REGEX_DEFAULT = "(Closed)";

// 本機僅從環境讀取需要保密的值
const { SESSION_IMPORT_URL } = process.env;

function normalizeStatus(raw) {
  const text = raw.trim().toLowerCase();
  const closedRegex = new RegExp(STATUS_CLOSED_REGEX_DEFAULT, "i");
  const openRegex = new RegExp(STATUS_OPEN_REGEX_DEFAULT, "i");
  if (openRegex.test(text)) return "OPEN";
  if (closedRegex.test(text)) return "CLOSED";
  return `UNKNOWN(${raw.trim()})`;
}

async function main() {
  const loginUrl = LOGIN_URL_DEFAULT;
  const statusUrl = STATUS_URL_DEFAULT;
  const lockStatusSelector = LOCK_STATUS_SELECTOR_DEFAULT;

  console.log("使用設定：");
  console.log(`LOGIN_URL = ${loginUrl}`);
  console.log(`STATUS_URL = ${statusUrl}`);
  console.log(`LOCK_STATUS_SELECTOR = ${lockStatusSelector}`);
  console.log("");

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    // 1. 開登入頁，改為「你手動完成整個登入流程」
    console.log("打開登入頁...");
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

    console.log("");
    console.log("請在剛開啟的瀏覽器視窗中手動完成登入流程，");
    console.log("直到你看到包含「工寮 Open Sensor」那一列的狀態頁為止。");
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
          return !url.includes("/login");
        }
      },
      { timeout: 30000 },
    );

    // 2. 直接在目前頁面讀取 LOCK_STATUS_SELECTOR（你剛登入後看到的那頁）
    console.log("等待 lock status 元素出現...");
    await page.waitForSelector(lockStatusSelector, { timeout: 15000 });

    console.log("讀取 lock status 元素文字...");
    const locator = page.locator(lockStatusSelector).first();
    const count = await locator.count();
    if (count === 0) {
      throw new Error(
        `找不到 LOCK_STATUS_SELECTOR: ${LOCK_STATUS_SELECTOR}`,
      );
    }
    const rawStatus = (await locator.textContent()) || "";
    console.log("原始文字：", JSON.stringify(rawStatus));

    const status = normalizeStatus(rawStatus);
    console.log("正規化後狀態：", status);

    // 將目前登入 session 的 cookies + localStorage 上傳到 Worker，寫入遠端 KV
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

    const importUrl = SESSION_IMPORT_URL || "http://localhost:8787/import-session";
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
    console.log("關閉瀏覽器...");
    await browser.close();
  }
}

main().catch((err) => {
  console.error("local-test.js 發生錯誤：", err);
  process.exit(1);
});

