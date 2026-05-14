import { launch } from "@cloudflare/playwright";

const STATUS_URL_DEFAULT = "https://biz.candyhouse.co";
const LOGIN_URL_DEFAULT = "https://biz.candyhouse.co/login";
const LOCK_STATUS_SELECTOR_DEFAULT = 'li:has-text("工寮 Open Sensor")';
const DEFAULT_CLOSED_REGEX = "(Closed)";
const DEFAULT_OPEN_REGEX = "(Open)";
const RELOGIN_REQUIRED_TELEGRAM_MESSAGE = "門鎖監控需要重新登入，請重新匯入 session";
const RELOGIN_REQUIRED_ERROR_MESSAGE = "需要重新登入：目前網址為 /login";
const OPEN_ANNOUNCEMENT_CHANNEL_OPEN_TITLE = "Moz://TW（工寮開放中）";
const OPEN_ANNOUNCEMENT_CHANNEL_CLOSED_TITLE = "Moz://TW";
/** 公告頻道（開關門公告 + 頻道標題更新目標） */
const TELEGRAM_OPEN_ANNOUNCEMENT_CHAT_ID = "@moztw_general";
/** Bot 使用者名稱（不含 @），供群組內 /manual_open@…、/manual_close@… 比對後綴 */
const TELEGRAM_BOT_USERNAME = "moztw_space_new_event_bot";
/** 自動感測觸發之公告頻道訊息結尾（非手動指令） */
const SENSOR_ANNOUNCEMENT_BYLINE = "（by 大門感應器）";

const SENSORS_KV_KEY = "sensors_cache";
const SENSORS_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;
const SENSORS_FETCH_TIMEOUT_MS = 3000;
const SENSORS_API_URL = "https://moztw-co2.yuaner.tw/sensors";

const MONITORING_MODE_NORMAL = "normal";
const MONITORING_MODE_MANUAL_OPEN_MUTED = "manual_open_muted";
const BROWSER_INIT_RETRY_DEFAULT = 3;
const BROWSER_INIT_RETRY_DELAY_MS_DEFAULT = 5000;

/** 與門鎖狀態無關的第三方網域，擋請求以縮短載入與 browser 時數 */
const BROWSER_BLOCKED_REQUEST_HOSTS = [
  "js.stripe.com",
  "fonts.googleapis.com"
];

function shouldBlockRequestHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  return BROWSER_BLOCKED_REQUEST_HOSTS.some(
    (root) => h === root,
  );
}

/**
 * 在 goto 前註冊；以 hostname 比對，避免誤擋 URL 路徑內含字串。
 * @param {import("@cloudflare/playwright").Page} page
 */
async function installThirdPartyRequestBlocking(page) {
  await page.route("**/*", (route) => {
    let url;
    try {
      url = route.request().url();
    } catch {
      route.continue().catch(() => {});
      return;
    }
    try {
      const hostname = new URL(url).hostname;
      if (shouldBlockRequestHostname(hostname)) {
        route.abort().catch(() => {});
        return;
      }
    } catch {
      // 非標準 URL，放行
    }
    route.continue().catch(() => {});
  });
}

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
    .banner { margin-bottom:16px; padding:10px 12px; border-radius:10px; border:1px solid #ca8a04; background:#422006; color:#fde68a; font-size:13px; line-height:1.45; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Door Lock Monitor</h1>
    ${
      status.monitoring_mode === MONITORING_MODE_MANUAL_OPEN_MUTED
        ? `<div class="banner">感測隔離中（手動開門）：Cron 與 /run 不會讀取網頁感測，請以 Telegram /manual_close 恢復。</div>`
        : ""
    }
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

async function getMonitoringMode(env) {
  const v = await env.LOCK_STATE.get("monitoring_mode");
  return v === MONITORING_MODE_MANUAL_OPEN_MUTED
    ? MONITORING_MODE_MANUAL_OPEN_MUTED
    : MONITORING_MODE_NORMAL;
}

/**
 * 解析群組內 `/manual_open@Bot` 或 `/manual_close@Bot`（Bot 使用者名稱不含 @）。
 * @returns {{ kind: "manual_open" | "manual_close" | null; wrongBot?: boolean }}
 */
function parseManualTelegramCommand(text, expectedBotUsername) {
  const first = String(text || "").trim().split(/\n/)[0]?.trim() || "";
  const lower = first.toLowerCase();
  const openCmd = "/manual_open";
  const closeCmd = "/manual_close";
  let kind = null;
  let rest = "";
  if (lower.startsWith(openCmd.toLowerCase())) {
    kind = "manual_open";
    rest = first.slice(openCmd.length);
  } else if (lower.startsWith(closeCmd.toLowerCase())) {
    kind = "manual_close";
    rest = first.slice(closeCmd.length);
  } else {
    return { kind: null };
  }
  if (rest === "") {
    return { kind };
  }
  if (!rest.startsWith("@")) {
    return { kind: null };
  }
  const suffix = rest.slice(1);
  if (!/^[a-zA-Z0-9_]{5,32}$/.test(suffix)) {
    return { kind: null };
  }
  const expected = String(expectedBotUsername || "").trim();
  if (expected && suffix.toLowerCase() !== expected.toLowerCase()) {
    return { kind: null, wrongBot: true };
  }
  return { kind };
}

async function handleTelegramWebhook(request, env, ctx) {
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return json({ ok: false, message: "TELEGRAM_WEBHOOK_SECRET 未設定" }, 503);
  }
  const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (header !== secret) {
    return new Response("Forbidden", { status: 403 });
  }

  const update = await request.json().catch(() => null);
  if (!update || typeof update !== "object") {
    return json({ ok: false, message: "invalid json" }, 400);
  }

  const message = update.message || update.edited_message;
  if (!message || typeof message.text !== "string") {
    return json({ ok: true });
  }

  const chatId = message.chat?.id;
  const allowedChat = String(env.TELEGRAM_CHAT_ID || "").trim();
  if (!allowedChat || String(chatId) !== allowedChat) {
    return json({ ok: true });
  }

  const botUser = TELEGRAM_BOT_USERNAME;
  const parsed = parseManualTelegramCommand(message.text, botUser);
  if (parsed.wrongBot) {
    await sendTelegramToChat(
      env,
      allowedChat,
      `請使用正確的 bot 後綴，例如 /manual_open@${botUser}`,
      { reply_to_message_id: message.message_id },
    );
    return json({ ok: true });
  }
  if (!parsed.kind) {
    return json({ ok: true });
  }

  const replyOpts = { reply_to_message_id: message.message_id };

  try {
    if (parsed.kind === "manual_open") {
      const mode = await getMonitoringMode(env);
      if (mode === MONITORING_MODE_MANUAL_OPEN_MUTED) {
        await sendTelegramToChat(
          env,
          allowedChat,
          "目前已在手動開門（感測隔離）狀態。",
          replyOpts,
        );
        return json({ ok: true });
      }

      await env.LOCK_STATE.put("monitoring_mode", MONITORING_MODE_MANUAL_OPEN_MUTED);
      await env.LOCK_STATE.put("manual_mode_changed_at", new Date().toISOString());

      try {
        const channel = await getAnnouncementChannelOrNotify();
        if (channel) {
          await sendManualDoorAnnouncement(
            env,
            "OPEN",
            new Date(),
            channel,
            message.from,
          );
          await updateStatusAnnouncementChannelTitle(env, "OPEN", channel);
        }
      } catch (announcementError) {
        const msg =
          announcementError instanceof Error
            ? announcementError.message
            : String(announcementError);
        await sendTelegram(env, `手動開門公告發送失敗：${msg}`);
      }

      // 手動開門已對外為「開」：寫入 last_status，避免恢復感測或並發 run 讀到仍為 OPEN 時再發一次感測公告／主群通知（與 manual_close 對稱）
      await env.LOCK_STATE.put("last_status", "OPEN");

      const dt = formatTaipeiDateTime(new Date());
      const closeHint = `/manual_close@${botUser}`;
      const bodyText =
        `#工寮開門 已於 ${dt} 送出開門資訊。\n\n` +
        `關門時請記得點擊手動關門以恢復自動偵測\n` +
        closeHint;

      await sendTelegramToChat(env, allowedChat, bodyText, replyOpts);
      if (ctx) {
        ctx.waitUntil(invalidateStatusHtmlCache());
      }
      return json({ ok: true });
    }

    if (parsed.kind === "manual_close") {
      const mode = await getMonitoringMode(env);
      if (mode !== MONITORING_MODE_MANUAL_OPEN_MUTED) {
        await sendTelegramToChat(
          env,
          allowedChat,
          "目前並非手動開門隔離狀態。",
          replyOpts,
        );
        return json({ ok: true });
      }

      await env.LOCK_STATE.put("monitoring_mode", MONITORING_MODE_NORMAL);
      await env.LOCK_STATE.put("manual_mode_changed_at", new Date().toISOString());

      try {
        const channel = await getAnnouncementChannelOrNotify();
        if (channel) {
          await sendManualDoorAnnouncement(
            env,
            "CLOSED",
            new Date(),
            channel,
            message.from,
          );
          await updateStatusAnnouncementChannelTitle(env, "CLOSED", channel);
        }
      } catch (announcementError) {
        const msg =
          announcementError instanceof Error
            ? announcementError.message
            : String(announcementError);
        await sendTelegram(env, `手動關門公告發送失敗：${msg}`);
      }

      // 手動關門已對外為「關」：先寫入 last_status，避免緊接著 runMonitor 讀到仍為 CLOSED 時再發一次感測公告／主群通知
      await env.LOCK_STATE.put("last_status", "CLOSED");

      if (ctx) {
        ctx.waitUntil(
          runMonitor(env, ctx).catch(() => {
            // 錯誤已由 runMonitor 內 Telegram 通知；webhook 仍回 200
          }),
        );
        ctx.waitUntil(invalidateStatusHtmlCache());
      }

      await sendTelegramToChat(
        env,
        allowedChat,
        "已恢復自動偵測，將依感測同步門鎖狀態。",
        replyOpts,
      );
      return json({ ok: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendTelegramToChat(env, allowedChat, `指令處理失敗：${msg}`, replyOpts).catch(
      () => {},
    );
    return json({ ok: false, error: msg }, 500);
  }

  return json({ ok: true });
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
        await runMonitor(env, ctx);
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
      const accept = request.headers.get("Accept") || "";
      const wantsHtml = accept.includes("text/html");

      if (wantsHtml) {
        const cache = caches.default;
        const cached = await cache.match(request);
        if (cached) {
          return cached;
        }
      }

      const status = await readStatus(env);

      if (wantsHtml) {
        const html = renderStatusHtml(status);
        const resp = new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
        resp.headers.set("Cache-Control", "public, max-age=900");
        if (ctx) {
          ctx.waitUntil(caches.default.put(request, resp.clone()));
        }
        return resp;
      }

      return json(status);
    }

    if (url.pathname === "/api" && request.method === "GET") {
      const cache = caches.default;
      const cached = await cache.match(request);
      if (cached) {
        return cached;
      }

      const status = await readStatus(env);

      const open =
        status.last_status === "OPEN"
          ? true
          : status.last_status === "CLOSED"
          ? false
          : undefined;
      const lastchangeMs = Number(status.last_run_finished_at || 0);
      const lastchange =
        Number.isFinite(lastchangeMs) && lastchangeMs > 0
          ? Math.floor(lastchangeMs / 1000)
          : undefined;

      const sensorMuted = status.sensor_muted === true;

      const cachedSensors = await readSensorsFromKV(env);
      const isStale =
        !cachedSensors ||
        Date.now() - cachedSensors.fetched_at > SENSORS_REFRESH_THRESHOLD_MS;
      if (isStale && ctx) {
        ctx.waitUntil(refreshSensorsToKV(env));
      }
      const sensors = cachedSensors?.data ?? null;

      const payload = {
        api_compatibility: ["15", "16"],
        space: "MozTW Space / Mozilla Community Space Taipei",
        logo: "https://moztw.org/space/images/logo.png",
        url: "https://moztw.space",
        location: {
          address: "Rm. 1105, 11F, 99 Chongqing S. Rd. Sec I, Zhongzheng Dist., Taipei City 100, Taiwan",
          lat: 25.0429807,
          lon: 121.5129848,
          timezone: "Asia/Taipei",
          country_code: "TW",
          hint: "Visit whenever we are open. Also check Telegram (https://t.me/moztw_general) to see if space is currently open (channel name postfix with （工寮開放中）). Weekly meetup Fri 1930-2200. Calendar at cal.moztw.space"
        },
        state: {
          ...(typeof open === "boolean" ? { open } : {}),
          ...(lastchange ? { lastchange } : {}),
          ...(sensorMuted ? { sensor_muted: true } : {}),
          icon: {
            open: "https://moztw.org/space/images/open.png",
            closed: "https://moztw.org/space/images/closed.png",
          },
        },
        contact: {
          email: "space@moztw.org",
          facebook: "https://www.facebook.com/moztw.space",
          foursquare: "5370b8a1498e8c14504d0007",
          telegram: "https://t.me/moztw_general",
        },
        issue_report_channels: ["email"],
        feeds: {
          blog: {
            type: "rss",
            url: "https://medium.com/feed/mozilla-related",
          },
          calendar: {
            type: "ical",
            url: "https://calendar.google.com/calendar/ical/3fs8qeakm6ij88hibpb5bsg3mc%40group.calendar.google.com/public/basic.ics",
          },
          flickr: {
            type: "atom",
            url: "https://www.flickr.com/services/feeds/groups_pool.gne?id=2664848@N20&lang=en-us&format=atom",
          }
        },
        ...(sensors ? { sensors } : {}),
      };

      const resp = new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
        },
      });
      resp.headers.set("Cache-Control", "public, max-age=300, s-maxage=300");
      if (ctx) {
        ctx.waitUntil(cache.put(request, resp.clone()));
      }
      return resp;
    }

    if (url.pathname === "/telegram-webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env, ctx);
    }

    return json({ ok: false, message: "Not Found" }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runMonitor(env, ctx));
  },
};

async function runMonitor(env, ctx) {
  const now = Date.now();
  const runId = crypto.randomUUID();
  await markRunStart(env, runId);
  await Promise.all([
    env.LOCK_STATE.put("active_run_id", runId),
    env.LOCK_STATE.put("active_run_started_at", String(now)),
  ]);

  try {
    const monitoringMode = await getMonitoringMode(env);
    if (monitoringMode === MONITORING_MODE_MANUAL_OPEN_MUTED) {
      await saveRunStage(env, "skipped_sensor_muted");
      await env.LOCK_STATE.put("last_status", "OPEN");
      await markRunFinish(env);
      if (ctx) {
        ctx.waitUntil(invalidateStatusHtmlCache());
      }
      return;
    }

    const status = await fetchLockStatusWithSessionOnly(env);
    const prevStatus = await env.LOCK_STATE.get("last_status");
    const hadErrorNotified = await env.LOCK_STATE.get("last_error_notified");

    // 若前一輪曾有錯誤並發出通知，先發恢復正常訊息，再處理本輪的開關門狀態
    if (hadErrorNotified) {
      await sendTelegram(env, "門鎖監控已恢復正常");
      await env.LOCK_STATE.delete("last_error_notified");
    }

    if (!prevStatus) {
      await env.LOCK_STATE.put("last_status", status);
      await sendTelegram(env, status === "OPEN" ? "工寮大門：已開啟" : "工寮大門：已關閉");
      if (ctx) {
        ctx.waitUntil(invalidateStatusHtmlCache());
      }
    } else if (prevStatus !== status) {
      await env.LOCK_STATE.put("last_status", status);
      await sendTelegram(env, status === "OPEN" ? "工寮大門：已開啟" : "工寮大門：已關閉");
      if (status === "OPEN" || status === "CLOSED") {
        try {
          const channel = await getAnnouncementChannelOrNotify();
          if (channel) {
            await sendStatusAnnouncement(env, status, new Date(), channel);
            await updateStatusAnnouncementChannelTitle(env, status, channel);
          }
        } catch (announcementError) {
          const msg =
            announcementError instanceof Error
              ? announcementError.message
              : String(announcementError);
          await sendTelegram(env, `開關門公告發送失敗：${msg}`);
        }
      }
      if (ctx) {
        ctx.waitUntil(invalidateStatusHtmlCache());
      }
    }

    await markRunFinish(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markRunFail(env, msg);
    const telegramErrorText = isReloginRequiredError(msg)
      ? RELOGIN_REQUIRED_TELEGRAM_MESSAGE
      : `門鎖監控錯誤：${msg}`;
    // 只在錯誤訊息與上次通知不同時才發送 Telegram，避免 cron 重複洗版
    if (await shouldNotifyError(env, telegramErrorText)) {
      await sendTelegram(env, telegramErrorText);
    }
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
  const maxRetries = getBrowserInitMaxRetries(env);
  const maxAttempts = maxRetries + 1;
  const initTimeoutMs = Math.max(5000, Number(env.BROWSER_INIT_TIMEOUT_MS || 30000));
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let browser;
    try {
      await saveRunStage(env, `browser_launch_attempt_${attempt}`);
      browser = await withTimeout(
        launch(env.MYBROWSER),
        initTimeoutMs,
        `browser launch timeout (${initTimeoutMs}ms)`,
      );
      const context = await withTimeout(
        browser.newContext(),
        initTimeoutMs,
        `browser newContext timeout (${initTimeoutMs}ms)`,
      );
      await restoreSessionCookies(context, env);
      const page = await withTimeout(
        context.newPage(),
        initTimeoutMs,
        `browser newPage timeout (${initTimeoutMs}ms)`,
      );

      await installThirdPartyRequestBlocking(page);

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

      await saveRunStage(env, "open_status_page");
      await page.goto(STATUS_URL_DEFAULT, { waitUntil: "domcontentloaded" });
      await ensureNotOnLoginPage(page);
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
      const lockSelector = env.LOCK_STATUS_SELECTOR || LOCK_STATUS_SELECTOR_DEFAULT;
      if (lockSelector) {
        await saveRunStage(env, "wait_lock_status_selector");
        await waitForAnySelector(
          page,
          [lockSelector],
          "lock status 元素",
          Number(env.STATUS_READY_TIMEOUT_MS || 15000)
        );
      }
      await ensureNotOnLoginPage(page);
      await saveRunStage(env, "read_status_text");
      const rawStatus = await readRawStatus(page);
      await env.LOCK_STATE.put("last_raw_status", rawStatus ?? "");
      const status = normalizeStatus(rawStatus);
      await persistSessionCookies(context, env);
      await saveRunStage(env, `status=${status}`);
      return status;
    } catch (err) {
      lastError = err;
      const retryable = isRetryableBrowserInitError(err);
      if (!retryable || attempt >= maxAttempts) {
        throw err;
      }
      const delayMs = getBrowserInitRetryDelayMs(env, attempt);
      await saveRunStage(env, `browser_init_retry_${attempt}_of_${maxRetries}_wait_${delayMs}ms`);
      await sleep(delayMs);
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  throw lastError || new Error("browser initialization failed");
}

function normalizeStatus(rawStatus) {
  const raw = rawStatus.trim();
  const text = raw.toLowerCase();

  // 先依照字串中最後一次出現的位置決定，避免同時含有 "open" 與 "closed" 時誤判
  const idxOpen = text.lastIndexOf("open");
  const idxClosed = text.lastIndexOf("closed");
  if (idxOpen !== -1 || idxClosed !== -1) {
    if (idxClosed > idxOpen) return "CLOSED";
    if (idxOpen > idxClosed) return "OPEN";
  }

  // 回退到舊的正則判斷（保留原行為以防未來文字有變形）
  const closedRegex = new RegExp(DEFAULT_CLOSED_REGEX, "i");
  const openRegex = new RegExp(DEFAULT_OPEN_REGEX, "i");

  if (openRegex.test(text)) return "OPEN";
  if (closedRegex.test(text)) return "CLOSED";
  return `UNKNOWN(${raw})`;
}

async function sendTelegram(env, text) {
  return sendTelegramToChat(env, env.TELEGRAM_CHAT_ID, text);
}

async function sendStatusAnnouncement(env, status, date, channel) {
  const tag = status === "OPEN" ? "#工寮開門" : "#工寮關門";
  const text = `${tag} ${formatTaipeiDateTime(date)}${SENSOR_ANNOUNCEMENT_BYLINE}`;
  return sendTelegramToChat(env, channel, text);
}

/** Telegram `from`：有 username 時為 `（by @username）`，否則退而求其次用顯示名稱。 */
function formatTelegramActorByline(from) {
  if (!from || typeof from !== "object") {
    return "（by {?}）";
  }
  const username = from.username;
  if (username && String(username).trim()) {
    return `（by @${String(username).trim()}）`;
  }
  const name = String(from.first_name || "").trim();
  if (name) return `（by ${name}）`;
  if (from.id != null) return `（by user_${from.id}）`;
  return "（by {?}）";
}

function buildManualDoorAnnouncementText(status, date, from) {
  const tag = status === "OPEN" ? "#工寮開門" : "#工寮關門";
  return `${tag} ${formatTaipeiDateTime(date)}${formatTelegramActorByline(from)}`;
}

async function sendManualDoorAnnouncement(env, status, date, channel, from) {
  const text = buildManualDoorAnnouncementText(status, date, from);
  return sendTelegramToChat(env, channel, text);
}

async function updateStatusAnnouncementChannelTitle(env, status, channel) {
  const title =
    status === "OPEN"
      ? OPEN_ANNOUNCEMENT_CHANNEL_OPEN_TITLE
      : OPEN_ANNOUNCEMENT_CHANNEL_CLOSED_TITLE;
  return setTelegramChatTitle(env, channel, title);
}

async function getAnnouncementChannelOrNotify() {
  return TELEGRAM_OPEN_ANNOUNCEMENT_CHAT_ID;
}

async function sendTelegramToChat(env, chatId, text, options = {}) {
  if (String(env.TELEGRAM_ENABLED || "true").toLowerCase() !== "true") {
    return;
  }
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) {
    return;
  }

  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...options,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram 發送失敗: ${resp.status} ${body}`);
  }
}

async function setTelegramChatTitle(env, chatId, title) {
  if (String(env.TELEGRAM_ENABLED || "true").toLowerCase() !== "true") {
    return;
  }
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) {
    return;
  }

  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setChatTitle`;
  const resp = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      title,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram 頻道標題更新失敗: ${resp.status} ${body}`);
  }
}

function formatTaipeiDateTime(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}/${value.month}/${value.day} ${value.hour}:${value.minute}:${value.second}`;
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
  const currentUrl = page.url();
  if (isBizLoginPath(currentUrl)) {
    throw new Error(RELOGIN_REQUIRED_ERROR_MESSAGE);
  }
}

function isReloginRequiredError(message) {
  return String(message || "").includes(RELOGIN_REQUIRED_ERROR_MESSAGE);
}

/** biz.candyhouse.co 且 path 為 /login（與 LOGIN_URL_DEFAULT 對齊） */
function isBizLoginPath(currentUrl) {
  try {
    const u = new URL(currentUrl);
    const expected = new URL(LOGIN_URL_DEFAULT);
    if (u.hostname !== expected.hostname) return false;
    return u.pathname === "/login" || u.pathname === expected.pathname;
  } catch {
    return false;
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
    "monitoring_mode",
    "manual_mode_changed_at",
  ];
  const entries = await Promise.all(
    keys.map(async (k) => [k, await env.LOCK_STATE.get(k)])
  );
  const base = Object.fromEntries(entries);

  const started = Number(base.last_run_started_at || 0);
  const finished = Number(base.last_run_finished_at || 0);

  const monitoring_mode =
    base.monitoring_mode === MONITORING_MODE_MANUAL_OPEN_MUTED
      ? MONITORING_MODE_MANUAL_OPEN_MUTED
      : MONITORING_MODE_NORMAL;

  return {
    ...base,
    monitoring_mode,
    sensor_muted: monitoring_mode === MONITORING_MODE_MANUAL_OPEN_MUTED,
    last_run_started_at_iso:
      started > 0 ? new Date(started).toISOString() : null,
    last_run_finished_at_iso:
      finished > 0 ? new Date(finished).toISOString() : null,
  };
}

async function readSensorsFromKV(env) {
  try {
    const raw = await env.LOCK_STATE.get(SENSORS_KV_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.fetched_at !== "number" || !parsed.data) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function refreshSensorsToKV(env) {
  try {
    const resp = await withTimeout(
      fetch(SENSORS_API_URL),
      SENSORS_FETCH_TIMEOUT_MS,
      "sensors fetch timeout",
    );
    if (!resp.ok) return;
    const text = await resp.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") return;
    await env.LOCK_STATE.put(
      SENSORS_KV_KEY,
      JSON.stringify({ fetched_at: Date.now(), data }),
    );
  } catch {
    // 上游壞掉就不寫 KV，舊值保留；下次 request 仍會嘗試補
  }
}

async function invalidateStatusHtmlCache() {
  const cache = caches.default;
  const urls = [
    "https://door-lock-monitor.irvinfly.workers.dev/status",
    "https://moztw.space/status",
    "https://door-lock-monitor.irvinfly.workers.dev/api",
    "https://moztw.space/api",
  ];
  await Promise.all(
    urls.map((u) =>
      cache.delete(new Request(u, {
        method: "GET",
      })),
    ),
  );
}

async function shouldNotifyError(env, msg) {
  const prev = await env.LOCK_STATE.get("last_error_notified");
  if (prev && prev === msg) {
    return false;
  }
  await env.LOCK_STATE.put("last_error_notified", msg || "");
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(label));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function isRetryableBrowserInitError(err) {
  const msg = err instanceof Error ? err.message : String(err || "");
  const text = msg.toLowerCase();
  return (
    text.includes("unable to create new browser") ||
    text.includes("no browser available") ||
    text.includes("code: 503") ||
    text.includes("service temporarily unavailable") ||
    text.includes("target page, context or browser has been closed") ||
    text.includes("browser has been closed") ||
    text.includes("browser has disconnected") ||
    text.includes("browser launch timeout") ||
    text.includes("browser newcontext timeout") ||
    text.includes("browser newpage timeout")
  );
}

function getBrowserInitRetryDelayMs(env, attempt) {
  const configuredDelayMs = Number(env.BROWSER_INIT_RETRY_DELAY_MS);
  const baseDelayMs = Number.isFinite(configuredDelayMs)
    ? Math.max(0, configuredDelayMs)
    : BROWSER_INIT_RETRY_DELAY_MS_DEFAULT;
  return baseDelayMs * Math.max(1, attempt);
}

function getBrowserInitMaxRetries(env) {
  const configuredRetries = Number(env.BROWSER_INIT_RETRY);
  return Number.isFinite(configuredRetries)
    ? Math.max(0, Math.floor(configuredRetries))
    : BROWSER_INIT_RETRY_DEFAULT;
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
