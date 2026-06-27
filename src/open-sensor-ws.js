/** Candy House biz WebSocket API（裝置列表含 Open Sensor 狀態） */
export const WS_API_HOST_FRAGMENT = "execute-api.ap-northeast-1.amazonaws.com";

/** 工寮 Open Sensor（open_sensor_1） */
export const OPEN_SENSOR_DEVICE_UUID_DEFAULT =
  "11200423-0300-0214-F000-4E00FFFFFFFF";

/** 同帳號下另一顆「Open Sensor」，勿與工寮混淆 */
export const OTHER_OPEN_SENSOR_DEVICE_UUID =
  "11200504-0303-0221-DD00-F600FFFFFFFF";

export const WS_STATUS_TIMEOUT_MS_DEFAULT = 30000;

/**
 * @param {import("@cloudflare/playwright").WebSocket} ws
 */
export function isCandyHouseDeviceWebSocket(ws) {
  try {
    return ws.url().includes(WS_API_HOST_FRAGMENT);
  } catch {
    return false;
  }
}

/**
 * @param {import("@cloudflare/playwright").WebSocketFrame} frame
 * @returns {string|null}
 */
export function framePayloadToText(frame) {
  const payload = frame.payload;
  if (typeof payload === "string") return payload;
  if (payload instanceof Buffer) return payload.toString("utf8");
  if (payload instanceof Uint8Array) {
    return new TextDecoder().decode(payload);
  }
  if (payload != null && typeof payload.toString === "function") {
    return payload.toString();
  }
  return null;
}

/**
 * @param {string} text
 * @param {string} deviceUuid
 * @returns {{ status: string; raw: string }|null}
 */
export function parseOpenSensorFromWsPayload(text, deviceUuid) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    msg.action !== "biz3ManageDevice" ||
    msg.op !== "PubedCompanyDevice" ||
    msg.code !== 200
  ) {
    return null;
  }
  const list = msg.data?.data?.list;
  if (!Array.isArray(list)) return null;

  const device = findOpenSensorDevice(list, deviceUuid);
  if (!device?.stateInfo) return null;

  const mapped = mapCHSesame2Status(device.stateInfo.CHSesame2Status);
  if (!mapped) return null;

  return {
    status: mapped,
    raw: JSON.stringify(device.stateInfo),
  };
}

/**
 * @param {Array<Record<string, unknown>>} list
 * @param {string} deviceUuid
 */
export function findOpenSensorDevice(list, deviceUuid) {
  const target = String(deviceUuid || OPEN_SENSOR_DEVICE_UUID_DEFAULT);
  const byUuid = list.find((d) => d.deviceUUID === target);
  if (byUuid) return byUuid;

  return list.find(
    (d) =>
      d.deviceModel === "open_sensor_1" &&
      d.deviceUUID !== OTHER_OPEN_SENSOR_DEVICE_UUID &&
      String(d.deviceName || "").toLowerCase().includes("open sensor"),
  );
}

/**
 * @param {unknown} chStatus
 * @returns {"OPEN"|"CLOSED"|null}
 */
export function mapCHSesame2Status(chStatus) {
  if (chStatus === "Open") return "OPEN";
  if (chStatus === "Closed") return "CLOSED";
  return null;
}

/**
 * 在 page.goto 之前呼叫；收到第一筆符合的 PubedCompanyDevice 即停止解析。
 * @param {import("@cloudflare/playwright").Page} page
 * @param {string} [deviceUuid]
 */
export function attachOpenSensorWebSocketListener(page, deviceUuid) {
  const uuid = deviceUuid || OPEN_SENSOR_DEVICE_UUID_DEFAULT;
  /** @type {{ status: string; raw: string }|null} */
  let captured = null;
  /** @type {Array<{ ws: import("@cloudflare/playwright").WebSocket; onFrame: (frame: import("@cloudflare/playwright").WebSocketFrame) => void }>} */
  const bindings = [];

  const onWebSocket = (ws) => {
    if (!isCandyHouseDeviceWebSocket(ws)) return;
    const onFrame = (frame) => {
      if (captured) return;
      const text = framePayloadToText(frame);
      if (!text) return;
      const parsed = parseOpenSensorFromWsPayload(text, uuid);
      if (parsed) captured = parsed;
    };
    ws.on("framereceived", onFrame);
    bindings.push({ ws, onFrame });
  };

  page.on("websocket", onWebSocket);

  return {
    getCaptured: () => captured,
    detach() {
      page.off("websocket", onWebSocket);
      for (const { ws, onFrame } of bindings) {
        ws.off("framereceived", onFrame);
      }
    },
  };
}

/**
 * @param {() => { status: string; raw: string }|null} getCaptured
 * @param {number} timeoutMs
 * @param {string} [label]
 */
export async function waitForFirstWsCapture(getCaptured, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = getCaptured();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `等待 ${label || "WebSocket PubedCompanyDevice"} 逾時（${timeoutMs}ms）`,
  );
}

/**
 * 與 page.goto 並行等待 WebSocket；收到目標 frame 後儘早返回。
 * @param {import("@cloudflare/playwright").Page} page
 * @param {() => { status: string; raw: string }|null} getCaptured
 * @param {number} timeoutMs
 * @param {{ gotoUrl: string; isLoginPath: (url: string) => boolean; reloginMessage?: string }} options
 */
export async function waitForOpenSensorWithNavigationRace(
  page,
  getCaptured,
  timeoutMs,
  { gotoUrl, isLoginPath, reloginMessage = "需要重新登入：目前網址為 /login" },
) {
  const label = "WebSocket PubedCompanyDevice（工寮 Open Sensor）";
  const deadline = Date.now() + timeoutMs;
  /** @type {Error|null} */
  let gotoError = null;
  let gotoSettled = false;

  const assertNotOnLogin = (url) => {
    if (isLoginPath(url)) {
      throw new Error(reloginMessage);
    }
  };

  page
    .goto(gotoUrl, { waitUntil: "domcontentloaded" })
    .then(() => {
      gotoSettled = true;
    })
    .catch((err) => {
      gotoError = err instanceof Error ? err : new Error(String(err));
      gotoSettled = true;
    });

  while (Date.now() < deadline) {
    assertNotOnLogin(page.url());

    const captured = getCaptured();
    if (captured) {
      if (gotoSettled && gotoError) throw gotoError;
      assertNotOnLogin(page.url());
      return captured;
    }

    if (gotoSettled) {
      if (gotoError) throw gotoError;
      assertNotOnLogin(page.url());
      break;
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`等待 ${label} 逾時（${timeoutMs}ms）`);
  }
  return waitForFirstWsCapture(getCaptured, remaining, label);
}
