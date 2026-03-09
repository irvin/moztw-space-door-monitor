import { launch } from "@cloudflare/playwright";

const DEFAULT_CLOSED_REGEX = "(locked|closed|關門|上鎖)";
const DEFAULT_OPEN_REGEX = "(unlocked|open|開門|未上鎖)";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      ctx.waitUntil(runMonitor(env));
      return json({ queued: true });
    }

    if (url.pathname === "/run-sync" && request.method === "POST") {
      try {
        await runMonitor(env);
        const [stage, ok, err] = await Promise.all([
          env.LOCK_STATE.get("last_run_stage"),
          env.LOCK_STATE.get("last_run_ok"),
          env.LOCK_STATE.get("last_run_error"),
        ]);
        return json({ ok: true, stage, run_ok: ok, error: err || "" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ ok: false, error: message }, 500);
      }
    }

    if (url.pathname === "/import-session" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const cookies = body?.cookies;
      const localStorage = body?.localStorage;
      if (!Array.isArray(cookies) || cookies.length === 0) {
        return json({ ok: false, message: "cookies 必須是非空陣列" }, 400);
      }
      await env.LOCK_STATE.put("session_cookies", JSON.stringify(cookies), {
        expirationTtl: Number(env.SESSION_COOKIE_TTL_SEC || 7 * 24 * 3600),
      });
      if (Array.isArray(localStorage) && localStorage.length > 0) {
        await env.LOCK_STATE.put("session_local_storage", JSON.stringify(localStorage), {
          expirationTtl: Number(env.SESSION_COOKIE_TTL_SEC || 7 * 24 * 3600),
        });
      } else {
        await env.LOCK_STATE.delete("session_local_storage");
      }
      return json({
        ok: true,
        cookies_count: cookies.length,
        local_storage_count: Array.isArray(localStorage) ? localStorage.length : 0,
      });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const keys = [
        "last_run_id",
        "last_run_started_at",
        "last_run_finished_at",
        "last_run_stage",
        "last_run_ok",
        "last_run_error",
        "last_status",
      ];
      const entries = await Promise.all(
        keys.map(async (k) => [k, await env.LOCK_STATE.get(k)])
      );
      const base = Object.fromEntries(entries);

      const started = Number(base.last_run_started_at || 0);
      const finished = Number(base.last_run_finished_at || 0);

      return json({
        ...base,
        last_run_started_at_iso:
          started > 0 ? new Date(started).toISOString() : null,
        last_run_finished_at_iso:
          finished > 0 ? new Date(finished).toISOString() : null,
      });
    }

    return json({ ok: false, message: "Not Found" }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runMonitor(env));
  },
};

async function runMonitor(env) {
  const now = Date.now();
  const runId = crypto.randomUUID();
  await markRunStart(env, runId);
  await Promise.all([
    env.LOCK_STATE.put("active_run_id", runId),
    env.LOCK_STATE.put("active_run_started_at", String(now)),
  ]);

  try {
    const status = await fetchLockStatusWithSessionOnly(env);
    const prevStatus = await env.LOCK_STATE.get("last_status");

    if (!prevStatus) {
      await env.LOCK_STATE.put("last_status", status);
      await sendTelegram(env, status === "OPEN" ? "工寮現在開門中" : "工寮現在已關門");
    } else if (prevStatus !== status) {
      await env.LOCK_STATE.put("last_status", status);
      await sendTelegram(env, status === "OPEN" ? "工寮現在開門中" : "工寮現在已關門");
    }

    await markRunFinish(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markRunFail(env, msg);
    await sendTelegram(env, `門鎖監控錯誤：${msg}`);
    throw err;
  } finally {
    await Promise.all([
      env.LOCK_STATE.put("last_run_finished_at", String(Date.now())),
      env.LOCK_STATE.delete("active_run_id"),
      env.LOCK_STATE.delete("active_run_started_at"),
    ]);
  }
}

async function fetchLockStatusWithSessionOnly(env) {
  assertEnvForSessionOnly(env);
  await saveRunStage(env, "browser_launch");

  const browser = await launch(env.MYBROWSER);
  const context = await browser.newContext();
  await restoreSessionCookies(context, env);
  const page = await context.newPage();

   // 還原 localStorage（若有）
  const rawStorage = await env.LOCK_STATE.get("session_local_storage");
  if (rawStorage) {
    try {
      const items = JSON.parse(rawStorage);
      if (Array.isArray(items) && items.length > 0) {
        await page.addInitScript((entries) => {
          try {
            for (const { key, value } of entries) {
              if (typeof key === "string" && typeof value === "string") {
                localStorage.setItem(key, value);
              }
            }
          } catch {
            // 忽略 localStorage 還原錯誤，繼續後續流程
          }
        }, items);
      }
    } catch {
      // 忽略解析錯誤
    }
  }

  try {
    await saveRunStage(env, "open_status_page");
    await page.goto(env.STATUS_URL, { waitUntil: "domcontentloaded" });
    if (env.STATUS_READY_SELECTOR) {
      await saveRunStage(env, "wait_status_ready_selector");
      await waitForAnySelector(
        page,
        [env.STATUS_READY_SELECTOR],
        "狀態頁 ready selector",
        Number(env.STATUS_READY_TIMEOUT_MS || 15000)
      );
    }
    // 等待實際狀態元素出現（與 local-test.js 對齊）
    if (env.LOCK_STATUS_SELECTOR) {
      await saveRunStage(env, "wait_lock_status_selector");
      await waitForAnySelector(
        page,
        [env.LOCK_STATUS_SELECTOR],
        "lock status 元素",
        Number(env.STATUS_READY_TIMEOUT_MS || 15000)
      );
    }
    await ensureNotOnLoginPage(page, env);
    await saveRunStage(env, "read_status_text");
    const rawStatus = await readRawStatus(page, env);
    const status = normalizeStatus(rawStatus, env);
    await persistSessionCookies(context, env);
    await saveRunStage(env, `status=${status}`);
    return status;
  } catch (err) {
    throw err;
  } finally {
    await browser.close();
  }
}

function normalizeStatus(rawStatus, env) {
  const text = rawStatus.trim().toLowerCase();
  const closedRegex = new RegExp(env.STATUS_CLOSED_REGEX || DEFAULT_CLOSED_REGEX, "i");
  const openRegex = new RegExp(env.STATUS_OPEN_REGEX || DEFAULT_OPEN_REGEX, "i");

  if (openRegex.test(text)) return "OPEN";
  if (closedRegex.test(text)) return "CLOSED";
  return `UNKNOWN(${rawStatus.trim()})`;
}

async function sendTelegram(env, text) {
  if (String(env.TELEGRAM_ENABLED || "true").toLowerCase() !== "true") {
    return;
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return;
  }

  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram 發送失敗: ${resp.status} ${body}`);
  }
}

function assertEnv(env) {
  const required = [
    "STATUS_URL",
  ];

  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`缺少必要環境變數: ${missing.join(", ")}`);
  }
}

function assertEnvForSessionOnly(env) {
  const required = ["STATUS_URL"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`缺少必要環境變數: ${missing.join(", ")}`);
  }
}

async function fillByCandidates(page, selectors, value, fieldName) {
  for (const selector of selectors) {
    const loc = await findActionableLocator(page, selector);
    if (loc) {
      await loc.fill(value);
      return;
    }
  }
  throw new Error(`找不到 ${fieldName}，嘗試過: ${selectors.join(" | ")}`);
}

async function clickByCandidates(page, selectors, fieldName) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const loc = await findActionableLocator(page, selector);
      if (loc) {
        await loc.click();
        return;
      }
    }
    await sleep(400);
  }
  throw new Error(`找不到 ${fieldName}，嘗試過: ${selectors.join(" | ")}`);
}

async function readRawStatus(page, env) {
  const selectors = buildCandidates(env.LOCK_STATUS_SELECTOR, []);
  for (const selector of selectors) {
    const loc = await findActionableLocator(page, selector);
    if (loc) {
      const text = await loc.textContent();
      if (text && text.trim()) return text;
    }
  }
  return (await page.textContent("body")) || "";
}

async function restoreSessionCookies(context, env) {
  const raw = await env.LOCK_STATE.get("session_cookies");
  if (!raw) return;
  try {
    const cookies = JSON.parse(raw);
    if (Array.isArray(cookies) && cookies.length > 0) {
      await context.addCookies(cookies);
    }
  } catch {
    // Ignore broken session cache and proceed with normal login.
  }
}

async function persistSessionCookies(context, env) {
  const cookies = await context.cookies();
  if (!Array.isArray(cookies) || cookies.length === 0) return;
  await env.LOCK_STATE.put("session_cookies", JSON.stringify(cookies), {
    expirationTtl: Number(env.SESSION_COOKIE_TTL_SEC || 7 * 24 * 3600),
  });
}

async function waitForAnySelector(page, selectors, fieldName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const loc = await findActionableLocator(page, selector);
      if (loc) return loc;
    }
    await sleep(500);
  }
  throw new Error(`等待 ${fieldName} 超時，嘗試過: ${selectors.join(" | ")}`);
}

async function ensureNotOnLoginPage(page, env) {
  if (isLoginUrl(page.url(), env.LOGIN_URL)) {
    throw new Error("目前仍在登入頁，未成功進入狀態頁");
  }
}

function isLoginUrl(currentUrl, loginUrl) {
  try {
    const loginPath = new URL(loginUrl).pathname || "/login";
    const currentPath = new URL(currentUrl).pathname || "";
    if (!loginPath || loginPath === "/") return currentPath.includes("/login");
    return currentPath === loginPath || currentPath.includes("/login");
  } catch {
    return currentUrl.includes("/login");
  }
}

async function findActionableLocator(page, selector) {
  const loc = page.locator(selector).first();
  const count = await loc.count();
  if (count === 0) return null;
  const visible = await safeVisible(loc);
  if (!visible) return null;
  const enabled = await safeEnabled(loc);
  if (!enabled) return null;
  return loc;
}

async function safeVisible(locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function safeEnabled(locator) {
  try {
    return !(await locator.isDisabled());
  } catch {
    return false;
  }
}

function buildCandidates(primary, fallbacks) {
  const list = [];
  if (primary && primary.trim()) list.push(primary.trim());
  for (const item of fallbacks) {
    if (!list.includes(item)) list.push(item);
  }
  return list;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function saveRunState(env, stage, { ok, error }) {
  await Promise.all([
    env.LOCK_STATE.put("last_run_started_at", String(Date.now())),
    env.LOCK_STATE.put("last_run_stage", stage),
    env.LOCK_STATE.put("last_run_ok", ok),
    env.LOCK_STATE.put("last_run_error", error || ""),
  ]);
}

async function saveRunStage(env, stage) {
  await env.LOCK_STATE.put("last_run_stage", stage);
}

async function markRunStart(env, runId) {
  await Promise.all([
    env.LOCK_STATE.put("last_run_id", runId),
    env.LOCK_STATE.put("last_run_started_at", String(Date.now())),
    env.LOCK_STATE.put("last_run_stage", "starting"),
    env.LOCK_STATE.put("last_run_ok", "0"),
    env.LOCK_STATE.put("last_run_error", ""),
  ]);
}

async function markRunFinish(env) {
  await Promise.all([
    env.LOCK_STATE.put("last_run_stage", "finished"),
    env.LOCK_STATE.put("last_run_ok", "1"),
    env.LOCK_STATE.put("last_run_error", ""),
  ]);
}

async function markRunFail(env, msg) {
  await Promise.all([
    env.LOCK_STATE.put("last_run_stage", "failed"),
    env.LOCK_STATE.put("last_run_ok", "0"),
    env.LOCK_STATE.put("last_run_error", msg || ""),
  ]);
}
