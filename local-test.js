// 本機用 Playwright 腳本：開登入頁、幫你填 email、發 OTP，等你手動在頁面輸入 OTP，
// 然後開狀態頁讀取「工寮 Open Sensor」右邊按鈕文字並正規化成 OPEN/CLOSED。

import { chromium } from "playwright";
import dotenv from "dotenv";
import fs from "node:fs";
import readline from "node:readline";

// 從 .dev.vars 載入設定（wrangler 也用同一份）
if (fs.existsSync(".dev.vars")) {
  dotenv.config({ path: ".dev.vars" });
} else if (fs.existsSync(".env")) {
  dotenv.config();
}

const {
  LOGIN_URL,
  STATUS_URL,
  LOGIN_EMAIL,
  EMAIL_INPUT_SELECTOR,
  SEND_CODE_BUTTON_SELECTOR,
  OTP_INPUT_SELECTOR,
  LOCK_STATUS_SELECTOR,
  STATUS_OPEN_REGEX,
  STATUS_CLOSED_REGEX,
  SESSION_IMPORT_URL,
} = process.env;

const DEFAULT_OPEN_REGEX = "(unlocked|open|開門|未上鎖)";
const DEFAULT_CLOSED_REGEX = "(locked|closed|關門|上鎖)";

function assertEnv() {
  const required = [
    "LOGIN_URL",
    "STATUS_URL",
    "LOGIN_EMAIL",
    "EMAIL_INPUT_SELECTOR",
    "SEND_CODE_BUTTON_SELECTOR",
    "OTP_INPUT_SELECTOR",
    "LOCK_STATUS_SELECTOR",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`缺少必要環境變數: ${missing.join(", ")}`);
  }
}

function normalizeStatus(raw) {
  const text = raw.trim().toLowerCase();
  const closedRegex = new RegExp(
    STATUS_CLOSED_REGEX || DEFAULT_CLOSED_REGEX,
    "i",
  );
  const openRegex = new RegExp(
    STATUS_OPEN_REGEX || DEFAULT_OPEN_REGEX,
    "i",
  );
  if (openRegex.test(text)) return "OPEN";
  if (closedRegex.test(text)) return "CLOSED";
  return `UNKNOWN(${raw.trim()})`;
}

async function waitEnter(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();
}

async function main() {
  assertEnv();

  console.log("使用設定：");
  console.log(`LOGIN_URL = ${LOGIN_URL}`);
  console.log(`STATUS_URL = ${STATUS_URL}`);
  console.log(`EMAIL_INPUT_SELECTOR = ${EMAIL_INPUT_SELECTOR}`);
  console.log(`SEND_CODE_BUTTON_SELECTOR = ${SEND_CODE_BUTTON_SELECTOR}`);
  console.log(`OTP_INPUT_SELECTOR = ${OTP_INPUT_SELECTOR}`);
  console.log(`LOCK_STATUS_SELECTOR = ${LOCK_STATUS_SELECTOR}`);
  console.log("");

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    // 1. 開登入頁，填 email，按「發送驗證碼」
    console.log("打開登入頁...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    console.log("填入 email...");
    await page.fill(EMAIL_INPUT_SELECTOR, LOGIN_EMAIL);

    console.log("按下發送驗證碼按鈕...");
    await page.click(SEND_CODE_BUTTON_SELECTOR);

    console.log("");
    console.log("請到你的 email 收信，取得 4 碼 OTP。");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const code = await new Promise((resolve) =>
      rl.question("請在此輸入收到的 4 碼 OTP（只輸入數字）：", resolve),
    );
    rl.close();

    if (!code || !/^[0-9]{4}$/.test(code.trim())) {
      throw new Error(`OTP 格式不正確: ${code}`);
    }

    console.log("在頁面填入 OTP...");
    await page.fill(OTP_INPUT_SELECTOR, code.trim());

    console.log("等待登入完成（URL 不再是 /login）...");
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
    await page.waitForSelector(LOCK_STATUS_SELECTOR, { timeout: 15000 });

    console.log("讀取 lock status 元素文字...");
    const locator = page.locator(LOCK_STATUS_SELECTOR).first();
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

