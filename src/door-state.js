/** 連續多少次 Cron mismatch 才視為長期不一致並通知 */
export const SENSOR_MISMATCH_STREAK_NOTIFY_THRESHOLD = 3;

/** yuaner API 可能為扁平物件，或包在 `{ sensors: { ... } }`（含舊 KV 雙層）。 */
export function normalizeSensorsPayload(raw) {
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
export function readDoorOpenFromSensors(sensors) {
  const normalized = normalizeSensorsPayload(sensors);
  const value = normalized?.door_open?.[0]?.value;
  if (typeof value !== "boolean") return null;
  return value;
}

/**
 * @param {boolean|null} sb
 * @returns {"OPEN"|"CLOSED"|null}
 */
export function switchBotToDoorStatus(sb) {
  if (sb === true) return "OPEN";
  if (sb === false) return "CLOSED";
  return null;
}

/**
 * 僅 OPEN↔CLOSED 算邊緣；null 進出不算。
 * @param {"OPEN"|"CLOSED"|null|undefined} prev
 * @param {"OPEN"|"CLOSED"|null} curr
 * @returns {"OPEN"|"CLOSED"|null}
 */
export function detectDoorStatusEdge(prev, curr) {
  const prevOk = prev === "OPEN" || prev === "CLOSED";
  const currOk = curr === "OPEN" || curr === "CLOSED";
  if (!prevOk || !currOk || prev === curr) return null;
  return curr;
}

export function formatDoorStatusZh(status) {
  return status === "OPEN" ? "開" : status === "CLOSED" ? "關" : "未知";
}

/**
 * 邊緣偵測 + 位準一致。
 * @param {unknown} candyHouseStatus
 * @param {unknown} sensors
 * @param {{ prevCh?: string|null; prevSb?: string|null }} [prev]
 * @returns {{
 *   status: "OPEN"|"CLOSED"|null;
 *   conflict: boolean;
 *   mismatch: boolean;
 *   oppositeEdges: boolean;
 *   conflictMessage?: string;
 *   currentCh: "OPEN"|"CLOSED"|null;
 *   currentSb: "OPEN"|"CLOSED"|null;
 * }}
 */
export function resolveEffectiveDoorState(candyHouseStatus, sensors, prev = {}) {
  const ch =
    candyHouseStatus === "OPEN" || candyHouseStatus === "CLOSED"
      ? candyHouseStatus
      : null;
  const sb = switchBotToDoorStatus(readDoorOpenFromSensors(sensors));
  const prevCh =
    prev.prevCh === "OPEN" || prev.prevCh === "CLOSED" ? prev.prevCh : null;
  const prevSb =
    prev.prevSb === "OPEN" || prev.prevSb === "CLOSED" ? prev.prevSb : null;

  const chEdge = detectDoorStatusEdge(prevCh, ch);
  const sbEdge = detectDoorStatusEdge(prevSb, sb);
  const bothValid = ch !== null && sb !== null;
  const mismatch = bothValid && ch !== sb;
  const agree = bothValid && ch === sb;

  if (chEdge && sbEdge && chEdge !== sbEdge) {
    return {
      status: null,
      conflict: true,
      mismatch: true,
      oppositeEdges: true,
      conflictMessage: `感測器同一輪反向變化：Candy House 轉為${formatDoorStatusZh(chEdge)}、SwitchBot 轉為${formatDoorStatusZh(sbEdge)}`,
      currentCh: ch,
      currentSb: sb,
    };
  }

  let status = null;
  if (chEdge && sbEdge) {
    status = chEdge;
  } else if (chEdge) {
    status = chEdge;
  } else if (sbEdge) {
    status = sbEdge;
  } else if (agree) {
    status = ch;
  }

  return {
    status,
    conflict: false,
    mismatch,
    oppositeEdges: false,
    conflictMessage: mismatch
      ? `感測器狀態不一致：Candy House ${formatDoorStatusZh(ch)}、SwitchBot ${formatDoorStatusZh(sb)}`
      : undefined,
    currentCh: ch,
    currentSb: sb,
  };
}

/**
 * 手動 /manual_close 覆寫（normal 模式）：感測仍判開時維持關，直到兩邊一致為關。
 * @param {{
 *   status: "OPEN"|"CLOSED"|null;
 *   conflict: boolean;
 *   mismatch?: boolean;
 *   oppositeEdges?: boolean;
 *   conflictMessage?: string;
 *   currentCh?: "OPEN"|"CLOSED"|null;
 *   currentSb?: "OPEN"|"CLOSED"|null;
 * }} resolution
 * @param {boolean} overrideActive
 */
export function applyManualClosedOverride(resolution, overrideActive) {
  if (!overrideActive) return resolution;
  if (
    resolution.currentCh === "CLOSED" &&
    resolution.currentSb === "CLOSED" &&
    !resolution.oppositeEdges
  ) {
    return { ...resolution, status: "CLOSED", conflict: false };
  }
  return {
    ...resolution,
    status: "CLOSED",
    conflict: false,
  };
}

/** 是否達長期不一致通知門檻（連續 streak 次）。 */
export function isLongTermMismatch(streak) {
  return (
    Number.isFinite(streak) &&
    streak >= SENSOR_MISMATCH_STREAK_NOTIFY_THRESHOLD
  );
}
