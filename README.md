# Door Lock Cloudflare Monitor

用 Cloudflare Worker 監控工寮大門開關狀態，整合 **Candy House Open Sensor**（WebSocket）與 **SwitchBot 開門感測**（經由 yuaner 感測 API 的 `door_open`），合併判斷後更新 Space API、狀態頁與 Telegram 通知。

Candy House 以既有登入 session（cookies + localStorage）開啟狀態頁、旁聽 WebSocket；SwitchBot 資料由上游 `https://moztw-co2.yuaner.tw/sensors` 提供，Worker 定期快取至 KV。

## 架構概覽

```
┌─────────────────┐          Cron             ┌──────────────────────┐
│  Candy House    │ ◄── Browser Rendering ──│                      │
│  (WebSocket)    │                         │  Cloudflare Worker   │
└─────────────────┘                         │  (src/index.js)      │
                                            │                      │
┌─────────────────┐     fetch /sensors      │  ┌────────────────┐  │
│  yuaner API     │ ◄───────────────────────│  │ 合併開關門邏輯 │  │
│  (SwitchBot 等) │                         │  └────────┬───────┘  │
└─────────────────┘                         │           │          │
                                            │     KV + Telegram    │
                                            └──────────┬───────────┘
                                                       │
                              ┌────────────────────────┼────────────────────────┐
                              ▼                        ▼                        ▼
                        GET /api              GET /status            POST /telegram-webhook
                   (moztw.space/api)         (狀態頁 HTML/JSON)         (手動指令)
```

- **排程**：`scheduled`（Cron）每 10 分鐘執行一次（`wrangler.toml`：`*/10 * * * *`）。
- **Candy House**：Playwright 還原 session → 開啟 `https://biz.candyhouse.co` → 旁聽 WebSocket `PubedCompanyDevice` → 解析工寮 Open Sensor 的 `CHSesame2Status`（`Open` / `Closed`）。
- **SwitchBot**：自 yuaner API 讀取 `door_open[0].value`（`true` = 開、`false` = 關）；API 回傳可能包在 `{ "sensors": { ... } }` 外層，Worker 會自動解包。
- **環境感測**：溫度、濕度、CO₂、`illuminance` 等一併附在 `/api` 的 `sensors` 欄位（原樣轉貼，不影響開關門判斷）。

## 開關門狀態：合併規則

對外顯示的「工寮是否開放」（`effective_status` / `state.open`）由 `resolveEffectiveDoorState()` 決定，採 **邊緣偵測 + 位準一致** 混合規則。輸入為 **Candy House（CH）** 與 **SwitchBot（SB）**；每次成功解析後會把各邊讀數存入 KV，供下一輪比對邊緣。

> CH 逾時／讀取失敗時，合併計算會使用 KV 中上次成功的 `last_status` 作為 CH 輸入（若與上一輪 CH 快照相同，則 **不會** 產生假邊緣）。

### 讀數正規化

| 來源 | 有效值 | 無效 |
|------|--------|------|
| Candy House | `OPEN` / `CLOSED` | 其它／無資料 → 不參與該邊判斷 |
| SwitchBot | `door_open[0].value` 為 `true`（開）／`false`（關） | 非 boolean → 不參與 |

### 邊緣偵測（edge）

- 每個感測器各自與上一輪快照比對。
- **只有** `OPEN ↔ CLOSED`（或 SB 的開 ↔ 關）算邊緣；`無資料 ↔ 有資料` **不算**邊緣。
- 任一感測器出現邊緣 → 有效狀態改為**該次變化後的狀態**（開或關）。
- 同一輪兩邊邊緣方向相同 → 採用該狀態。

### 位準一致（level）

- 兩邊**都有**有效讀數且相同 → 有效狀態改為該一致狀態（用來校正漏採樣、重啟後卡住等）。
- 僅一邊有資料 → 位準規則不成立（只可能靠該邊的邊緣更新）。

### 套用優先順序（單次解析）

1. **同一輪兩邊往相反方向變**（例如 CH 轉開、SB 轉關）→ **不更新** `last_effective_status`；視為感測器異常，**立刻**通知主群組。
2. 否則若有邊緣（單邊或雙邊同向）→ 有效狀態跟邊緣結果。
3. 否則若兩邊位準一致 → 有效狀態跟一致結果。
4. 否則（含穩定不一致、資料不足）→ **不更新**，沿用 `last_effective_status`。

### 感測器不一致（兩邊皆有讀數且矛盾）

| 情況 | 行為 |
|------|------|
| 穩定不一致（無邊緣，或未觸發「同輪反向」） | 不更新有效狀態；**不立即通知** |
| 連續 **3** 次 Cron 輪詢皆不一致 | 視為長期不一致：通知主群組一次；`last_sensor_conflict_active`；API `sensor_conflict: true` |
| 同輪反向邊緣 | 不更新有效狀態；**立即**通知主群組（與長期計次分開） |
| 恢復一致（或不再 mismatch） | 清零不一致計次；若曾進入長期衝突，主群組再通知 `感測器狀態已恢復一致` |

Cron **照常執行**，不因不一致進入隔離模式。短期不一致期間對外 `state.open` 仍沿用 `last_effective_status`。

## 監控模式與手動指令

### `monitoring_mode`

| 值 | 說明 |
|----|------|
| `normal` | 預設；Cron 讀取 Candy House + SwitchBot，依合併規則更新 `last_effective_status` 並通知 |
| `manual_open_muted` | 手動開門隔離；Cron **略過** Candy House 讀取，強制對外 `OPEN` |

### 輔助旗標

| 鍵 / 欄位 | 說明 |
|-----------|------|
| `manual_closed_override` | `normal` 模式下因 `/manual_close` 設定的手動關門覆寫（`"1"`） |
| `sensor_muted` | 等同 `monitoring_mode === manual_open_muted`（`/api` 的 `state.sensor_muted`） |

### `/manual_open@Bot`（進入隔離）

- 將 `monitoring_mode` 設為 `manual_open_muted`
- 對外強制 **開門**；清除 `manual_closed_override`
- 發送開門公告、更新頻道標題
- **不再**自動讀取 Candy House（SwitchBot 仍會在 `/api` 的 `sensors` 更新，但不參與隔離期的開門顯示）
- 群組回覆會提示關門時使用 `/manual_close@Bot`

### `/manual_close@Bot`（依目前模式分支）

**情況 A：`normal`（一般自動偵測）— 手動關門覆寫**

適用於自動判斷為開、但需人工改為關門時。

- **不**進入隔離；Cron **照常**讀感測器
- 設 `manual_closed_override = "1"`，`last_effective_status = CLOSED`
- 發送關門公告、更新頻道標題
- 感測仍判開時，對外維持 **關**；感測一致為 **關** 後自動解除覆寫
- 群組回覆：`已手動切換為關門（自動偵測仍運行；感測一致為關後解除覆寫）。`

**情況 B：`manual_open_muted`（手動開門隔離）— 結束隔離**

- 將 `monitoring_mode` 改回 `normal`；清除 `manual_closed_override`
- 對外切換為 **關門**；發送關門公告
- 背景觸發一輪 `runMonitor` 恢復自動偵測
- 群組回覆：`已結束手動開門隔離，並切換為關門；自動偵測已恢復。`

## Telegram 設定與通知

### Bot 與 Webhook

1. 用 `@BotFather` 建立 bot，取得 token。
2. 將 bot 加入 `TELEGRAM_CHAT_ID` 群組，並在群組內發一則訊息。
3. 取得群組 `chat.id`（`getUpdates` 或已知 id）。
4. 設定 secrets 與 webhook（見下方「部署」）。
5. Bot 須已加入公告頻道 `@moztw_general`，並具發訊息、修改頻道標題權限。

在 `TELEGRAM_CHAT_ID` 群組使用（`TELEGRAM_BOT_USERNAME` 預設 `moztw_space_new_event_bot`，不含 `@`）：

| 指令 | 說明 |
|------|------|
| `/manual_open@Bot` | 手動開門（進入隔離） |
| `/manual_close@Bot` | 一般模式：手動關門覆寫；隔離模式：結束隔離並關門 |

### 通知目標

| 目標 | 用途 |
|------|------|
| `TELEGRAM_CHAT_ID`（secret） | 主群組：開關門狀態、監控錯誤（含感測器衝突）、指令回覆 |
| `TELEGRAM_OPEN_ANNOUNCEMENT_CHAT_ID`（程式常數 `@moztw_general`） | 公告頻道：開關門公告、頻道標題 |

### 自動通知規則

- **開關門變更**（合併後 `last_effective_status` 改變時；非 `last_status`）：
  - 主群組：`工寮大門：已開啟` / `工寮大門：已關閉`
  - 公告頻道：`#工寮開門 …（by 大門感應器）` 或 `#工寮關門 …`；開門時頻道標題 `Moz://TW（工寮開放中）`，關門 `Moz://TW`
- **手動 `/manual_open` / `/manual_close`**：公告頻道改為 `（by @username）`；主群組在狀態實際變更時亦會收到開關門訊息
- **感測器同輪反向邊緣**：主群組立即警告；不更新 `last_effective_status`；Cron 不停止
- **感測器長期不一致**（連續 3 次 Cron 皆 mismatch）：主群組通知一次；不因字串不同而重複；API `sensor_conflict`；Cron 不停止
- **感測器恢復一致**（曾進入長期衝突後）：主群組 `感測器狀態已恢復一致`
- **Candy House 讀取失敗**：主群組 `門鎖監控錯誤：…`（整段故障期間只通知一次，恢復成功後才重置）；SwitchBot 仍可參與合併；Cron 不停止
- **Session 失效**（`/login`）：`門鎖監控需要重新登入，請重新匯入 session`
- **Candy House 恢復成功**：先發 `門鎖監控已恢復正常`，再依合併狀態處理開關門

## KV（`LOCK_STATE`）儲存欄位

| 鍵 | 說明 |
|----|------|
| `session_cookies` / `session_local_storage` | Candy House 登入 session；每次成功讀取狀態後同步更新並續期 |
| `last_status` | 上次**成功**讀到的 Candy House 狀態（`OPEN` / `CLOSED`） |
| `last_ch_sensor_status` | 上一輪參與合併的 CH 快照（供邊緣偵測） |
| `last_sb_sensor_status` | 上一輪參與合併的 SB 快照（`OPEN` / `CLOSED`） |
| `last_effective_status` | 上次對外有效的合併開關門狀態 |
| `last_run_*` | 最近執行 id、時間、階段、成敗、錯誤 |
| `last_error_notified_key` | 本次故障最先通知的監控錯誤類型（`relogin` / `ws_timeout` / `browser_init` / `other`）；恢復前不再重複通知 |
| `sensor_mismatch_streak` | 連續 mismatch 的 Cron 次數（字串數字） |
| `last_conflict_notified` | 長期不一致是否已通知（固定值 `sensor_conflict`） |
| `last_sensor_conflict_active` | 長期感測器不一致進行中 |
| `monitoring_mode` | `normal` 或 `manual_open_muted` |
| `manual_mode_changed_at` | 最近一次切換監控模式（ISO） |
| `manual_closed_override` | 手動關門覆寫（`"1"`） |
| `sensors_cache` | yuaner API 快取（含溫濕度、door_open 等） |

## HTTP 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/status` | JSON 或（`Accept: text/html` 時）HTML 狀態，Workers Cache 5 分鐘（`Vary: Accept`） |
| GET | `/api` | 對外 Space API（Workers Cache 5 分鐘；感測資料 stale 時不快取） |
| POST | `/telegram-webhook` | Telegram Webhook（需 `X-Telegram-Bot-Api-Secret-Token`） |

自訂網域（`wrangler.toml`）：`https://moztw.space/status`、`/api`、`/telegram-webhook`。

### `/status` 重點欄位

| 欄位 | 說明 |
|------|------|
| `last_status` | Candy House 上次成功讀數 |
| `door_open` | SwitchBot `door_open`（`true` / `false` / `null`） |
| `effective_status` | 合併後對外狀態（`OPEN` / `CLOSED` / `UNKNOWN`；短期不一致時沿用上次有效值） |
| `effective_open` | 合併後布林 |
| `sensor_conflict` | 長期不一致或同輪反向邊緣 |
| `manual_closed_override` | 是否為手動關門覆寫 |
| `monitoring_mode` / `sensor_muted` | 監控模式 |
| `last_run_ok` / `last_run_error` | 最近 Candy House 讀取成敗 |

### `/api` 的 `state` 欄位

| 欄位 | 說明 |
|------|------|
| `open` | 合併後是否開放；無新結論時沿用 `last_effective_status`；`manual_closed_override` 時為 `false` |
| `lastchange` | CH 與 SB `door_open[].lastchange` 較新者（Unix 秒） |
| `sensor_muted` | 手動開門隔離中 |
| `sensor_conflict` | 長期不一致（連續 3 次）或同輪反向邊緣 |
| `manual_closed_override` | 手動關門覆寫中（`normal` 模式） |

`sensors` 含溫度、濕度、CO₂、`door_open`、`illuminance` 等（來自 yuaner API，單層結構）。

## 先決條件

1. Cloudflare 帳號（Workers、Browser Rendering、KV）
2. Telegram Bot 與群組 `chat.id`
3. Candy House 帳號（本機手動登入匯入 session）
4. yuaner 感測 API 已部署且含 `door_open`

### 建立／更新 Candy House session

先決條件：本機已 `npx wrangler login`（與 deploy 相同帳號）。

```bash
npm install
npx playwright install chromium   # 首次在本機執行時

npm run session:update            # 登入後直接寫入 LOCK_STATE KV（不經 HTTP）
```

**流程**

1. 腳本開啟瀏覽器至 Candy House 登入頁，請**手動登入**。
2. 登入成功後會**自動偵測**（URL 離開 `/login`），接著擷取 WebSocket 狀態。
3. 以 `wrangler kv key put` 寫入 Worker 讀取的 `session_cookies` / `session_local_storage` 鍵，並設定 TTL。
4. 終端機輸出 `SESSION_IMPORT_RESULT:` JSON；`ok: true` 表示 KV 寫入成功。

> `session:update` 透過 Wrangler 直接寫入遠端 KV，不依賴 workers.dev 或任何 HTTP 匯入端點。

**Agent 協助更新 session**：背景執行 `npm run session:update`，使用者於瀏覽器完成登入即可；腳本會自動繼續並以 `SESSION_IMPORT_RESULT` 回報結果。

## 本地檢查與測試

```bash
npm install
cp .dev.vars.example .dev.vars

npm run session:update         # 登入並寫入正式 LOCK_STATE KV（wrangler）

node --check src/index.js
node --check src/open-sensor-ws.js
node --check update-session.js
npx wrangler deploy --dry-run
```

## 部署

```bash
# 首次設定 secrets
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put TELEGRAM_WEBHOOK_SECRET

# 部署
npm run deploy
```

### Telegram Webhook

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://moztw.space/telegram-webhook","secret_token":"<與 TELEGRAM_WEBHOOK_SECRET 相同>"}'
```

### 設定摘要

| 項目 | 位置 |
|------|------|
| `TELEGRAM_ENABLED` | `wrangler.toml` `[vars]` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_WEBHOOK_SECRET` | `wrangler secret` |
| 公告頻道、Bot 使用者名稱 | `src/index.js`（`TELEGRAM_OPEN_ANNOUNCEMENT_CHAT_ID`、`TELEGRAM_BOT_USERNAME`） |
| Cron 週期 | `wrangler.toml` `triggers.crons` |

`TELEGRAM_BOT_USERNAME` 供群組內 `/manual_open@…`、`/manual_close@…` 比對後綴；若更換 bot 請一併修改原始碼與 webhook。

## 環境變數（選用）

| 變數 | 預設 | 說明 |
|------|------|------|
| `OPEN_SENSOR_DEVICE_UUID` | `11200423-…` | 工寮 Candy House Open Sensor UUID |
| `WS_STATUS_TIMEOUT_MS` | `30000` | 等待 WebSocket 裝置列表逾時 |
| `SESSION_COOKIE_TTL_SEC` | 7 天 | `session_cookies` 與 `session_local_storage` KV TTL |
| `BROWSER_INIT_RETRY` | `3` | Browser 啟動重試次數 |
| `BROWSER_INIT_TIMEOUT_MS` | `30000` | Browser 啟動逾時 |
| `BROWSER_INIT_RETRY_DELAY_MS` | `5000` | 重試間隔基數 |

## 除錯與維運

- **Candy House WebSocket 逾時**：session 可能仍有效；確認 DevTools → Network → WS 是否有 `PubedCompanyDevice` 且工寮 UUID 帶 `CHSesame2Status`。定期執行 `npm run session:update` 更新 session。
- **SwitchBot 無資料**：確認 `https://moztw-co2.yuaner.tw/sensors` 含 `door_open`。
- **感測器不一致**：短期矛盾不通知、沿用上次有效狀態；連續 3 次才告警。同輪兩邊反向變化會立即警告。請至現場或 Candy House / SwitchBot 確認。
- **Browser 503**：同一輪內會重試；重試完仍失敗才通知，下一輪 Cron 仍會執行。
- **Session 更新除錯**：`update-session.js` 與 Worker 共用 `src/open-sensor-ws.js`。

## 主要檔案

| 檔案 | 說明 |
|------|------|
| `src/index.js` | Worker 主程式（合併邏輯、排程、API、Telegram） |
| `src/open-sensor-ws.js` | Candy House WebSocket 解析與 Playwright 旁聽 |
| `update-session.js` | 本機登入與 session 匯入 |
| `wrangler.toml` | Worker 綁定、cron、路由 |
| `.dev.vars.example` | 本機環境變數範本 |
