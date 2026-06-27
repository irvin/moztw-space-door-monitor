import { launch } from "@cloudflare/playwright";
import {
  OPEN_SENSOR_DEVICE_UUID_DEFAULT,
  WS_STATUS_TIMEOUT_MS_DEFAULT,
  attachOpenSensorWebSocketListener,
  waitForOpenSensorWithNavigationRace,
} from "./open-sensor-ws.js";

const STATUS_URL_DEFAULT = "https://biz.candyhouse.co";
const LOGIN_URL_DEFAULT = "https://biz.candyhouse.co/login";
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

/** yuaner API 可能為扁平物件，或包在 `{ sensors: { ... } }`（含舊 KV 雙層）。 */
function normalizeSensorsPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let payload = /** @type {Record<string, unknown>} */ (raw);
  for (let depth = 0; depth < 3; depth++) {
    if (
      "temperature" in payload ||
      "door_open" in payload ||
      "humidity" in payload ||
      "carbondioxide" in payload
    ) {
      return payload;
    }
    const wrapped = payload.sensors;
    if (!wrapped || typeof wrapped !== "object" || Array.isArray(wrapped)) {
      return payload;
    }
    payload = /** @type {Record<string, unknown>} */ (wrapped);
  }
  return payload;
}

/**
 * @param {unknown} sensors
 * @returns {boolean|null} true=開門、false=關門、null=無資料
 */
function readDoorOpenFromSensors(sensors) {
  const normalized = normalizeSensorsPayload(sensors);
  const value = normalized?.door_open?.[0]?.value;
  if (typeof value !== "boolean") return null;
  return value;
}

/**
 * @returns {{
 *   status: "OPEN"|"CLOSED"|null;
 *   conflict: boolean;
 *   conflictMessage?: string;
 * }}
 */
function resolveEffectiveDoorState(candyHouseStatus, sensors) {
  const ch =
    candyHouseStatus === "OPEN" || candyHouseStatus === "CLOSED"
      ? candyHouseStatus
      : null;
  const sb = readDoorOpenFromSensors(sensors);

  if (ch && sb !== null) {
    const chOpen = ch === "OPEN";
    if (chOpen !== sb) {
      return {
        status: null,
        conflict: true,
        conflictMessage: `感測器狀態不一致：Candy House ${ch === "OPEN" ? "開" : "關"}、SwitchBot ${sb ? "開" : "關"}`,
      };
    }
  }

  if (ch === "CLOSED" || sb === false) {
    return { status: "CLOSED", conflict: false };
  }
  if (ch === "OPEN") {
    return { status: "OPEN", conflict: false };
  }
  if (sb === true) {
    return { status: "OPEN", conflict: false };
  }
  return { status: null, conflict: false };
}

/**
 * 手動 /manual_close 覆寫（normal 模式）：感測仍判開時維持關，直到感測一致為關。
 * @param {{ status: "OPEN"|"CLOSED"|null; conflict: boolean; conflictMessage?: string }} resolution
 * @param {boolean} overrideActive
 */
function applyManualClosedOverride(resolution, overrideActive) {
  if (!overrideActive) return resolution;
  if (resolution.status === "CLOSED" && !resolution.conflict) {
    return resolution;
  }
  return { status: "CLOSED", conflict: false };
}

/**
 * @param {number} candyFinishedMs
 * @param {unknown} sensors
 * @returns {number|undefined} Unix 秒
 */
function computeCombinedLastchangeSec(candyFinishedMs, sensors) {
  const normalized = normalizeSensorsPayload(sensors);
  const doorSec = Number(normalized?.door_open?.[0]?.lastchange || 0);
  const candySec =
    Number.isFinite(candyFinishedMs) && candyFinishedMs > 0
      ? Math.floor(candyFinishedMs / 1000)
      : 0;
  const maxSec = Math.max(candySec, doorSec);
  return maxSec > 0 ? maxSec : undefined;
}

/**
 * @param {Record<string, unknown>} status
 * @param {unknown|null} sensors
 */
function enrichStatusWithDoorState(status, sensors) {
  const overrideActive = status.manual_closed_override === "1";
  let resolution = resolveEffectiveDoorState(status.last_status, sensors);
  resolution = applyManualClosedOverride(resolution, overrideActive);
  const doorOpen = readDoorOpenFromSensors(sensors);
  const effective_status = resolution.conflict
    ? status.last_effective_status || "CONFLICT"
    : resolution.status ||
      status.last_effective_status ||
      status.last_status ||
      "UNKNOWN";
  return {
    ...status,
    door_open: doorOpen,
    manual_closed_override: overrideActive,
    sensor_conflict: resolution.conflict,
    effective_open: resolution.conflict
      ? undefined
      : resolution.status === "OPEN"
        ? true
        : resolution.status === "CLOSED"
          ? false
          : undefined,
    effective_status,
  };
}

const MONITORING_MODE_NORMAL = "normal";
const MONITORING_MODE_MANUAL_OPEN_MUTED = "manual_open_muted";
const MANUAL_CLOSED_OVERRIDE_KV_KEY = "manual_closed_override";
const BROWSER_INIT_RETRY_DEFAULT = 3;
const BROWSER_INIT_RETRY_DELAY_MS_DEFAULT = 5000;

/** 與門鎖狀態無關的第三方網域，擋請求以縮短載入與 browser 時數 */
const BROWSER_BLOCKED_REQUEST_HOSTS = [
  "js.stripe.com",
  "fonts.googleapis.com"
];

/** 以 Playwright resourceType 擋掉的非必要資源（不影響 WebSocket 擷取） */
const BROWSER_BLOCKED_RESOURCE_TYPES = new Set(["image"]);

function shouldBlockRequestResourceType(resourceType) {
  return BROWSER_BLOCKED_RESOURCE_TYPES.has(String(resourceType || "").toLowerCase());
}

function shouldBlockRequestHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  return BROWSER_BLOCKED_REQUEST_HOSTS.some(
    (root) => h === root,
  );
}

/**
 * 在 goto 前註冊；以 resourceType 與 hostname 比對，避免載入非必要資源。
 * @param {import("@cloudflare/playwright").Page} page
 */
async function installThirdPartyRequestBlocking(page) {
  await page.route("**/*", (route) => {
    let request;
    try {
      request = route.request();
    } catch {
      route.continue().catch(() => {});
      return;
    }

    try {
      if (shouldBlockRequestResourceType(request.resourceType())) {
        route.abort().catch(() => {});
        return;
      }
    } catch {
      // resourceType 不可用時改走 hostname 檢查
    }

    let url;
    try {
      url = request.url();
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
    ${
      status.manual_closed_override
        ? `<div class="banner">手動關門覆寫中：對外顯示關門，自動偵測仍運行；感測一致為關後自動解除（/manual_close）。</div>`
        : ""
    }
    ${
      status.sensor_conflict
        ? `<div class="banner">感測器狀態不一致（Candy House 與 SwitchBot 相左）：暫不更新開關門判斷，已通知公告頻道。</div>`
        : ""
    }
    <div class="label">目前狀態（CH+SB 合併）</div>
    <div class="status ${
      status.effective_status === "OPEN"
        ? "status-open"
        : status.effective_status === "CLOSED"
        ? "status-closed"
        : "status-unknown"
    }">${status.effective_status || "UNKNOWN"}</div>

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
      Candy House: <code>${status.last_status || "-"}</code>
      · door_open: <code>${status.door_open === true ? "true（開）" : status.door_open === false ? "false（關）" : "-"}</code>
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
 * 解析群組內 `/manual_open@Bot` 或 `/manual_close@Bot`。
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
      await env.LOCK_STATE.delete(MANUAL_CLOSED_OVERRIDE_KV_KEY);

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
      await env.LOCK_STATE.put("last_effective_status", "OPEN");

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
      const wasMuted = mode === MONITORING_MODE_MANUAL_OPEN_MUTED;
      const prevEffective = await env.LOCK_STATE.get("last_effective_status");

      if (wasMuted) {
        await env.LOCK_STATE.put("monitoring_mode", MONITORING_MODE_NORMAL);
        await env.LOCK_STATE.put("manual_mode_changed_at", new Date().toISOString());
        await env.LOCK_STATE.delete(MANUAL_CLOSED_OVERRIDE_KV_KEY);
      } else {
        await env.LOCK_STATE.put(MANUAL_CLOSED_OVERRIDE_KV_KEY, "1");
      }

      await env.LOCK_STATE.put("last_status", "CLOSED");
      await env.LOCK_STATE.put("last_effective_status", "CLOSED");

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

      if (prevEffective !== "CLOSED") {
        await sendTelegram(env, "工寮大門：已關閉");
      }

      if (wasMuted) {
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
          "已結束手動開門隔離，並切換為關門；自動偵測已恢復。",
          replyOpts,
        );
      } else {
        await sendTelegramToChat(
          env,
          allowedChat,
          "已手動切換為關門（自動偵測仍運行；感測一致為關後解除覆寫）。",
          replyOpts,
        );
        if (ctx) {
          ctx.waitUntil(invalidateStatusHtmlCache());
        }
      }
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
      const status = enrichStatusWithDoorState(
        await readStatus(env),
        await getSensorsData(env),
      );
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

      const sensors = await getSensorsData(env);
      const status = enrichStatusWithDoorState(await readStatus(env), sensors);

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
      const sensors = await getSensorsData(env);
      const overrideActive = status.manual_closed_override === "1";
      let resolution = resolveEffectiveDoorState(status.last_status, sensors);
      resolution = applyManualClosedOverride(resolution, overrideActive);
      let open;
      if (resolution.conflict) {
        open =
          status.last_effective_status === "OPEN"
            ? true
            : status.last_effective_status === "CLOSED"
              ? false
              : undefined;
      } else if (resolution.status) {
        open = resolution.status === "OPEN";
      }
      const lastchange = computeCombinedLastchangeSec(
        Number(status.last_run_finished_at || 0),
        sensors,
      );

      const sensorMuted = status.sensor_muted === true;

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
          ...(resolution.conflict ? { sensor_conflict: true } : {}),
          ...(overrideActive ? { manual_closed_override: true } : {}),
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

const SENSOR_CONFLICT_RECOVERY_MESSAGE = "感測器狀態已恢復一致";

async function notifySensorConflict(env, conflictMessage) {
  const channel = await getAnnouncementChannelOrNotify();
  if (!channel || !conflictMessage) return;
  if (await shouldNotifyConflict(env, conflictMessage)) {
    await sendTelegramToChat(env, channel, conflictMessage);
  }
}

async function publishEffectiveStatusChange(env, ctx, status) {
  await sendTelegram(
    env,
    status === "OPEN" ? "工寮大門：已開啟" : "工寮大門：已關閉",
  );
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

/**
 * @returns {Promise<{ conflict: boolean; conflictMessage?: string }>}
 */
async function processEffectiveStatusAndNotify(env, ctx, input) {
  const sensors = input.sensors ?? (await getSensorsData(env));
  const lastStatus = await env.LOCK_STATE.get("last_status");
  const candyForCombine = input.freshCandyStatus ?? lastStatus;
  const overrideActive =
    (await env.LOCK_STATE.get(MANUAL_CLOSED_OVERRIDE_KV_KEY)) === "1";
  let resolution = resolveEffectiveDoorState(candyForCombine, sensors);
  const rawResolution = resolution;
  resolution = applyManualClosedOverride(resolution, overrideActive);

  if (
    overrideActive &&
    rawResolution.status === "CLOSED" &&
    !rawResolution.conflict
  ) {
    await env.LOCK_STATE.delete(MANUAL_CLOSED_OVERRIDE_KV_KEY);
  }

  const prevEffective = await env.LOCK_STATE.get("last_effective_status");
  const hadErrorNotified = await env.LOCK_STATE.get("last_error_notified");
  const hadConflictActive = await env.LOCK_STATE.get("last_sensor_conflict_active");

  if (!input.candyFetchFailed && hadErrorNotified) {
    await sendTelegram(env, "門鎖監控已恢復正常");
    await env.LOCK_STATE.delete("last_error_notified");
  }

  if (resolution.conflict) {
    await env.LOCK_STATE.put("last_sensor_conflict_active", "1");
    await notifySensorConflict(env, resolution.conflictMessage);
    if (ctx) {
      ctx.waitUntil(invalidateStatusHtmlCache());
    }
    return { conflict: true, conflictMessage: resolution.conflictMessage };
  }

  if (hadConflictActive === "1") {
    await env.LOCK_STATE.delete("last_sensor_conflict_active");
    await env.LOCK_STATE.delete("last_conflict_notified");
    const channel = await getAnnouncementChannelOrNotify();
    if (channel) {
      await sendTelegramToChat(env, channel, SENSOR_CONFLICT_RECOVERY_MESSAGE);
    }
  }

  if (resolution.status && resolution.status !== prevEffective) {
    await env.LOCK_STATE.put("last_effective_status", resolution.status);
    await publishEffectiveStatusChange(env, ctx, resolution.status);
  }

  return { conflict: false };
}

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
      await env.LOCK_STATE.put("last_effective_status", "OPEN");
      await markRunFinish(env);
      if (ctx) {
        ctx.waitUntil(invalidateStatusHtmlCache());
      }
      return;
    }

    let freshCandyStatus = null;
    let candyFetchFailed = false;
    const sensorsPromise = getSensorsData(env);
    try {
      freshCandyStatus = await fetchLockStatusWithSessionOnly(env);
      await env.LOCK_STATE.put("last_status", freshCandyStatus);
    } catch (err) {
      candyFetchFailed = true;
      const sensors = await sensorsPromise;
      const result = await processEffectiveStatusAndNotify(env, ctx, {
        freshCandyStatus: null,
        candyFetchFailed: true,
        sensors,
      });
      const msg = err instanceof Error ? err.message : String(err);
      await markRunFail(
        env,
        result.conflict ? result.conflictMessage || "感測器狀態不一致" : msg,
      );
      if (!result.conflict) {
        const telegramErrorText = isReloginRequiredError(msg)
          ? RELOGIN_REQUIRED_TELEGRAM_MESSAGE
          : `門鎖監控錯誤：${msg}`;
        if (await shouldNotifyError(env, telegramErrorText)) {
          await sendTelegram(env, telegramErrorText);
        }
      }
      return;
    }

    const sensors = await sensorsPromise;
    const result = await processEffectiveStatusAndNotify(env, ctx, {
      freshCandyStatus,
      candyFetchFailed: false,
      sensors,
    });
    if (result.conflict) {
      await markRunFail(
        env,
        result.conflictMessage || "感測器狀態不一致",
      );
      return;
    }

    await markRunFinish(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markRunFail(env, msg);
    const telegramErrorText = isReloginRequiredError(msg)
      ? RELOGIN_REQUIRED_TELEGRAM_MESSAGE
      : `門鎖監控錯誤：${msg}`;
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

      const deviceUuid =
        env.OPEN_SENSOR_DEVICE_UUID || OPEN_SENSOR_DEVICE_UUID_DEFAULT;
      const wsTimeoutMs = Math.max(
        5000,
        Number(env.WS_STATUS_TIMEOUT_MS || WS_STATUS_TIMEOUT_MS_DEFAULT),
      );
      const wsListener = attachOpenSensorWebSocketListener(page, deviceUuid);

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
        const { status, raw } = await waitForOpenSensorWithNavigationRace(
          page,
          wsListener.getCaptured,
          wsTimeoutMs,
          {
            gotoUrl: STATUS_URL_DEFAULT,
            isLoginPath: isBizLoginPath,
            reloginMessage: RELOGIN_REQUIRED_ERROR_MESSAGE,
          },
        );
        await env.LOCK_STATE.put("last_raw_status", raw);
        await persistSessionCookies(context, env);
        await saveRunStage(env, `status=${status}`);
        return status;
      } finally {
        wsListener.detach();
      }
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
    "last_effective_status",
    "manual_closed_override",
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

async function getSensorsData(env) {
  let cached = await readSensorsFromKV(env);
  const isStale =
    !cached ||
    Date.now() - cached.fetched_at > SENSORS_REFRESH_THRESHOLD_MS;
  if (isStale) {
    await refreshSensorsToKV(env);
    cached = await readSensorsFromKV(env);
  }
  return normalizeSensorsPayload(cached?.data ?? null);
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
    const parsed = JSON.parse(text);
    const data = normalizeSensorsPayload(parsed);
    if (!data) return;
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

async function shouldNotifyConflict(env, msg) {
  const prev = await env.LOCK_STATE.get("last_conflict_notified");
  if (prev && prev === msg) {
    return false;
  }
  await env.LOCK_STATE.put("last_conflict_notified", msg || "");
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
