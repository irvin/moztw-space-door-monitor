// 本機用 Playwright 腳本：開登入頁、幫你填 email、發 OTP，等你手動在頁面輸入 OTP，
// 然後開狀態頁讀取「工寮 Open Sensor」右邊按鈕文字並正規化成 OPEN/CLOSED。

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
  'li.MuiListItem-root:has-text("工寮 Open Sensor") >> button.MuiIconButton-root';
const STATUS_OPEN_REGEX_DEFAULT = "(Open)";
const STATUS_CLOSED_REGEX_DEFAULT = "(Closed)";

// 本機僅從環境讀取真正需要保密或可能因環境不同而改的值
const { LOGIN_EMAIL, SESSION_IMPORT_URL } = process.env;

// login 頁面的 selector 採內建預設，若未來介面改版再來調整即可
const EMAIL_INPUT_SELECTOR_DEFAULT = "input[type='email']";
const SEND_CODE_BUTTON_SELECTOR_DEFAULT = "button:has-text('Send code')";
const OTP_INPUT_SELECTOR_DEFAULT = "input[name='otp']";

function assertEnv() {
  const missing = [];
  if (!LOGIN_EMAIL) missing.push("LOGIN_EMAIL");
  if (missing.length > 0) {
    throw new Error(`缺少必要環境變數: ${missing.join(", ")}`);
  }
}

function normalizeStatus(raw) {
  const text = raw.trim().toLowerCase();
  const closedRegex = new RegExp(STATUS_CLOSED_REGEX_DEFAULT, "i");
  const openRegex = new RegExp(STATUS_OPEN_REGEX_DEFAULT, "i");
  if (openRegex.test(text)) return "OPEN";
  if (closedRegex.test(text)) return "CLOSED";
  return `UNKNOWN(${raw.trim()})`;
}

async function main() {
  assertEnv();

  const loginUrl = LOGIN_URL_DEFAULT;
  const statusUrl = STATUS_URL_DEFAULT;
  const emailSelector = EMAIL_INPUT_SELECTOR_DEFAULT;
  const sendCodeSelector = SEND_CODE_BUTTON_SELECTOR_DEFAULT;
  const otpInputSelector = OTP_INPUT_SELECTOR_DEFAULT;
  const lockStatusSelector = LOCK_STATUS_SELECTOR_DEFAULT;

  console.log("使用設定：");
  console.log(`LOGIN_URL = ${loginUrl}`);
  console.log(`STATUS_URL = ${statusUrl}`);
  console.log(`EMAIL_INPUT_SELECTOR = ${emailSelector}`);
  console.log(`SEND_CODE_BUTTON_SELECTOR = ${sendCodeSelector}`);
  console.log(`OTP_INPUT_SELECTOR = ${otpInputSelector}`);
  console.log(`LOCK_STATUS_SELECTOR = ${lockStatusSelector}`);
  console.log("");

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    // 1. 開登入頁，填 email，按「發送驗證碼」
    console.log("打開登入頁...");
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

    console.log("填入 email...");
    await page.fill(emailSelector, LOGIN_EMAIL);

    console.log("按下發送驗證碼按鈕...");
    await page.click(sendCodeSelector);

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
    await page.fill(otpInputSelector, code.trim());

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

