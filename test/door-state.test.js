import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SENSOR_MISMATCH_STREAK_NOTIFY_THRESHOLD,
  applyManualClosedOverride,
  detectDoorStatusEdge,
  isLongTermMismatch,
  normalizeSensorsPayload,
  readDoorOpenFromSensors,
  resolveEffectiveDoorState,
} from "../src/door-state.js";

/** @param {boolean|null} open */
function sensorsWithDoor(open) {
  if (open === null) return {};
  return { door_open: [{ value: open }] };
}

describe("normalizeSensorsPayload / readDoorOpenFromSensors", () => {
  it("讀取扁平 door_open", () => {
    assert.equal(readDoorOpenFromSensors(sensorsWithDoor(true)), true);
    assert.equal(readDoorOpenFromSensors(sensorsWithDoor(false)), false);
  });

  it("解包 { sensors: { door_open } }", () => {
    assert.equal(
      readDoorOpenFromSensors({ sensors: sensorsWithDoor(true) }),
      true,
    );
  });

  it("非 boolean 視為無資料", () => {
    assert.equal(readDoorOpenFromSensors({ door_open: [{ value: "open" }] }), null);
    assert.equal(readDoorOpenFromSensors(null), null);
    assert.equal(readDoorOpenFromSensors({}), null);
  });

  it("normalize 會剝多層 sensors 包裝", () => {
    const inner = { door_open: [{ value: false }], temperature: [] };
    assert.deepEqual(
      normalizeSensorsPayload({ sensors: { sensors: inner } }),
      inner,
    );
  });
});

describe("detectDoorStatusEdge", () => {
  it("OPEN↔CLOSED 才算邊緣", () => {
    assert.equal(detectDoorStatusEdge("CLOSED", "OPEN"), "OPEN");
    assert.equal(detectDoorStatusEdge("OPEN", "CLOSED"), "CLOSED");
  });

  it("相同或 null 進出不算邊緣", () => {
    assert.equal(detectDoorStatusEdge("OPEN", "OPEN"), null);
    assert.equal(detectDoorStatusEdge(null, "OPEN"), null);
    assert.equal(detectDoorStatusEdge("OPEN", null), null);
    assert.equal(detectDoorStatusEdge(undefined, "CLOSED"), null);
  });
});

describe("resolveEffectiveDoorState", () => {
  it("單邊邊緣：CH 轉開 → OPEN", () => {
    const r = resolveEffectiveDoorState("OPEN", sensorsWithDoor(false), {
      prevCh: "CLOSED",
      prevSb: "CLOSED",
    });
    assert.equal(r.status, "OPEN");
    assert.equal(r.oppositeEdges, false);
    assert.equal(r.mismatch, true);
  });

  it("單邊邊緣：SB 轉關 → CLOSED", () => {
    const r = resolveEffectiveDoorState("OPEN", sensorsWithDoor(false), {
      prevCh: "OPEN",
      prevSb: "OPEN",
    });
    assert.equal(r.status, "CLOSED");
    assert.equal(r.mismatch, true);
  });

  it("雙邊同向邊緣 → 該狀態", () => {
    const r = resolveEffectiveDoorState("OPEN", sensorsWithDoor(true), {
      prevCh: "CLOSED",
      prevSb: "CLOSED",
    });
    assert.equal(r.status, "OPEN");
    assert.equal(r.mismatch, false);
    assert.equal(r.oppositeEdges, false);
  });

  it("同輪反向邊緣 → 不更新且 oppositeEdges", () => {
    const r = resolveEffectiveDoorState("OPEN", sensorsWithDoor(false), {
      prevCh: "CLOSED",
      prevSb: "OPEN",
    });
    assert.equal(r.status, null);
    assert.equal(r.oppositeEdges, true);
    assert.equal(r.conflict, true);
    assert.equal(r.mismatch, true);
    assert.match(r.conflictMessage, /同一輪反向變化/);
  });

  it("兩邊位準一致（無邊緣）→ 校正為一致狀態", () => {
    const r = resolveEffectiveDoorState("OPEN", sensorsWithDoor(true), {
      prevCh: "OPEN",
      prevSb: "OPEN",
    });
    assert.equal(r.status, "OPEN");
    assert.equal(r.mismatch, false);
  });

  it("兩邊位準一致為關（無邊緣）→ CLOSED", () => {
    const r = resolveEffectiveDoorState("CLOSED", sensorsWithDoor(false), {
      prevCh: "CLOSED",
      prevSb: "CLOSED",
    });
    assert.equal(r.status, "CLOSED");
  });

  it("穩定不一致（無邊緣）→ 不更新", () => {
    const r = resolveEffectiveDoorState("OPEN", sensorsWithDoor(false), {
      prevCh: "OPEN",
      prevSb: "CLOSED",
    });
    assert.equal(r.status, null);
    assert.equal(r.mismatch, true);
    assert.equal(r.oppositeEdges, false);
    assert.equal(r.conflict, false);
    assert.match(r.conflictMessage, /不一致/);
  });

  it("讀數不變時不因「有效狀態」反覆翻轉", () => {
    const prev = { prevCh: "OPEN", prevSb: "CLOSED" };
    const a = resolveEffectiveDoorState("OPEN", sensorsWithDoor(false), prev);
    const b = resolveEffectiveDoorState("OPEN", sensorsWithDoor(false), prev);
    assert.equal(a.status, null);
    assert.equal(b.status, null);
    assert.equal(a.mismatch, true);
    assert.equal(b.mismatch, true);
  });

  it("null↔有資料不算邊緣；僅一邊有效也不靠位準更新", () => {
    const r = resolveEffectiveDoorState("OPEN", sensorsWithDoor(null), {
      prevCh: null,
      prevSb: null,
    });
    assert.equal(r.status, null);
    assert.equal(r.currentCh, "OPEN");
    assert.equal(r.currentSb, null);
    assert.equal(r.mismatch, false);
  });

  it("僅 SB 有邊緣且 CH 無資料 → 跟 SB", () => {
    const r = resolveEffectiveDoorState(null, sensorsWithDoor(true), {
      prevCh: null,
      prevSb: "CLOSED",
    });
    assert.equal(r.status, "OPEN");
    assert.equal(r.currentCh, null);
    assert.equal(r.currentSb, "OPEN");
  });

  it("CH 失敗沿用相同 last_status 不造假邊緣", () => {
    const r = resolveEffectiveDoorState("CLOSED", sensorsWithDoor(false), {
      prevCh: "CLOSED",
      prevSb: "CLOSED",
    });
    assert.equal(r.status, "CLOSED");
    assert.equal(r.oppositeEdges, false);
  });

  it("邊緣優先於位準：一邊轉開、另一邊仍關 → OPEN（mismatch）", () => {
    const r = resolveEffectiveDoorState("OPEN", sensorsWithDoor(false), {
      prevCh: "CLOSED",
      prevSb: "CLOSED",
    });
    assert.equal(r.status, "OPEN");
    assert.equal(r.mismatch, true);
  });
});

describe("applyManualClosedOverride", () => {
  it("未啟用時原樣回傳", () => {
    const base = {
      status: "OPEN",
      conflict: false,
      currentCh: "OPEN",
      currentSb: "OPEN",
    };
    assert.equal(applyManualClosedOverride(base, false), base);
  });

  it("啟用時強制 CLOSED", () => {
    const r = applyManualClosedOverride(
      {
        status: "OPEN",
        conflict: false,
        currentCh: "OPEN",
        currentSb: "OPEN",
      },
      true,
    );
    assert.equal(r.status, "CLOSED");
    assert.equal(r.conflict, false);
  });

  it("兩邊皆關且非反向邊緣時維持 CLOSED（可供解除覆寫判斷）", () => {
    const r = applyManualClosedOverride(
      {
        status: "CLOSED",
        conflict: false,
        oppositeEdges: false,
        currentCh: "CLOSED",
        currentSb: "CLOSED",
      },
      true,
    );
    assert.equal(r.status, "CLOSED");
    assert.equal(r.currentCh, "CLOSED");
    assert.equal(r.currentSb, "CLOSED");
  });
});

describe("isLongTermMismatch", () => {
  it(`門檻為連續 ${SENSOR_MISMATCH_STREAK_NOTIFY_THRESHOLD} 次`, () => {
    assert.equal(isLongTermMismatch(2), false);
    assert.equal(isLongTermMismatch(3), true);
    assert.equal(isLongTermMismatch(4), true);
    assert.equal(isLongTermMismatch(NaN), false);
  });
});
