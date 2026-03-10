import { launch } from "@cloudflare/playwright";

const STATUS_URL_DEFAULT = "https://biz.candyhouse.co";
const LOCK_STATUS_SELECTOR_DEFAULT =
  'li.MuiListItem-root:has-text("工寮 Open Sensor") >> button.MuiIconButton-root';
const DEFAULT_CLOSED_REGEX = "(Closed)";
const DEFAULT_OPEN_REGEX = "(Open)";

function renderStatusHtml(status) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <title>工寮門鎖狀態</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0f172a; color:#e5e7eb; margin:0; padding:24px; }
    .card { max-width:480px; margin:0 auto; background:#020617; border-radius:16px; padding:24px 20px 20px; box-shadow:0 20px 40px rgba(15,23,42,.7); border:1px solid #1e293b; }
    h1 { margin:0 0 12px; font-size:22px; letter-spacing:0.04em; text-transform:uppercase; color:#94a3b8; }
    .status { font-size:40px; font-weight:700; margin:4px 0 8px; }
    .status-open { color:#4ade80; }
    .status-closed { color:#f97373; }
    .status-unknown { color:#eab308; font-size:26px; }
    .label { font-size:12px; text-transform:uppercase; letter-spacing:0.12em; color:#64748b; margin-top:12px; }
    .value { font-size:14px; color:#e5e7eb; margin-top:4px; word-break:break-word; }
    .meta { margin-top:12px; font-size:12px; color:#9ca3af; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size:11px; background:#020617; padding:2px 4px; border-radius:4px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Door Lock Monitor</h1>
    <div class="label">目前狀態</div>
    <div class="status ${
      status.last_status === "OPEN"
        ? "status-open"
        : status.last_status === "CLOSED"
        ? "status-closed"
        : "status-unknown"
    }">${status.last_status || "UNKNOWN"}</div>

    <div class="label">最近檢查完成時間</div>
    <div class="value" id="last-finished" data-utc="${status.last_run_finished_at_iso || ""}">
      ${status.last_run_finished_at_iso || "尚無紀錄"}
    </div>

    <div class="label">最近執行結果</div>
    <div class="value">
      ${status.last_run_ok === "1" ? "成功" : status.last_run_ok === "0" ? "失敗" : "未知"}
      ${status.last_run_error ? ` - ${status.last_run_error}` : ""}
    </div>

    <div class="meta">
      Run ID: <code>${status.last_run_id || "-"}</code>
      <br/>
      上次開始時間: <code id="last-started" data-utc="${status.last_run_started_at_iso || ""}">${status.last_run_started_at_iso || "尚無紀錄"}</code>
      <br/>
      原始狀態文字: <code>${(status.last_raw_status || "").slice(0, 120) || "-"}</code>
    </div>
  </div>
  <script>
    (function () {
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
        const finishedEl = document.getElementById("last-finished");
        const startedEl = document.getElementById("last-started");
        if (!finishedEl || !startedEl) return;

        const fmt = new Intl.DateTimeFormat("zh-TW", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        const apply = (el) => {
          const v = el.getAttribute("data-utc");
          if (!v) return;
          const d = new Date(v);
          if (Number.isNaN(d.getTime())) return;
          el.textContent = fmt.format(d) + " (" + tz + ")";
        };

        apply(finishedEl);
        apply(startedEl);
      } catch {
        // ignore client-side time formatting errors
      }
    })();
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    if (url.pathname === "/" && request.method === "GET") {
      const status = await readStatus(env);
      const html = renderStatusHtml(status);
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/run" && request.method === "POST") {
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
      const status = await readStatus(env);
      const accept = request.headers.get("Accept") || "";
      if (accept.includes("text/html")) {
        const html = renderStatusHtml(status);
        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return json(status);
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
    await page.goto(STATUS_URL_DEFAULT, { waitUntil: "domcontentloaded" });
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
    const rawStatus = await readRawStatus(page);
    await env.LOCK_STATE.put("last_raw_status", rawStatus ?? "");
    const status = normalizeStatus(rawStatus);
    await persistSessionCookies(context, env);
    await saveRunStage(env, `status=${status}`);
    return status;
  } catch (err) {
    throw err;
  } finally {
    await browser.close();
  }
}

function normalizeStatus(rawStatus) {
  const text = rawStatus.trim().toLowerCase();
  const closedRegex = new RegExp(DEFAULT_CLOSED_REGEX, "i");
  const openRegex = new RegExp(DEFAULT_OPEN_REGEX, "i");

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

async function readRawStatus(page) {
  const selectors = buildCandidates(LOCK_STATUS_SELECTOR_DEFAULT, []);
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

async function ensureNotOnLoginPage(page) {
  if (isLoginUrl(page.url(), STATUS_URL_DEFAULT)) {
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

async function readStatus(env) {
  const keys = [
    "last_run_id",
    "last_run_started_at",
    "last_run_finished_at",
    "last_run_stage",
    "last_run_ok",
    "last_run_error",
    "last_status",
    "last_raw_status",
  ];
  const entries = await Promise.all(
    keys.map(async (k) => [k, await env.LOCK_STATE.get(k)])
  );
  const base = Object.fromEntries(entries);

  const started = Number(base.last_run_started_at || 0);
  const finished = Number(base.last_run_finished_at || 0);

  return {
    ...base,
    last_run_started_at_iso:
      started > 0 ? new Date(started).toISOString() : null,
    last_run_finished_at_iso:
      finished > 0 ? new Date(finished).toISOString() : null,
  };
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
