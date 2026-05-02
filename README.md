# Door Lock Cloudflare Monitor

用 Cloudflare Worker 監控「只能網頁查看」的門鎖狀態，**以既有登入 session（長效 cookie）** 讀取門鎖狀態文字，狀態變更時送 Telegram 群組通知。

## 架構與流程

- `scheduled` (Cron): 每 10 分鐘執行一次監控（`wrangler.toml` 中的 `*/10 * * * *`）。
- `Browser Rendering + Playwright`: 使用「已登入的 session」（cookies + localStorage）開啟狀態頁，讀取門鎖狀態文字。
- `KV (LOCK_STATE)`: 保存
  - `session_cookies`：登入後的 cookies
  - `session_local_storage`：登入後的 localStorage key/value
  - `last_status`：上一次成功讀到的狀態（`OPEN` / `CLOSED`）
  - `last_run_*`：最近一次執行的時間與結果
  - `monitoring_mode`：一般為 `normal`；手動開門隔離感測時為 `manual_open_muted`
  - `manual_mode_changed_at`：最近一次切換監控模式的時間（ISO 字串）
- `Telegram Bot API`: 發訊息到群組，包含：
  - 狀態變化：`OPEN` → `工寮大門：已開啟`，`CLOSED` → `工寮大門：已關閉`（僅在 `last_status` 變更時發送，避免重複洗版）
  - 監控曾失敗後恢復成功：先發 `門鎖監控已恢復正常`，再依上列規則處理開關門訊息
  - 一般錯誤：`門鎖監控錯誤：…`（同一錯誤訊息只通知一次，直到下次成功執行）
  - Session 失效且瀏覽器落在 `https://biz.candyhouse.co/login`：`門鎖監控需要重新登入，請重新匯入 session`

## 先決條件

1. Cloudflare 帳號（已可用 Workers）。
2. 啟用 Browser Rendering。
3. 建立 KV Namespace。
4. Telegram Bot 與群組 chat id。

### 一次性前置步驟：建立「已登入的 session」

整個系統的「登入」只透過本機瀏覽器完成一次，然後由 `local-test.js` 把 session 上傳到 Cloudflare：

1. 編輯 `.dev.vars`（可參考 `.dev.vars.example`）：
   - `SESSION_IMPORT_URL`（選用）：登入完成後要把 session POST 到哪個 `/import-session`。未設定時預設為本機 `http://localhost:8787/import-session`（須先 `npm run dev`）。
2. 在本機執行（本機 dev 匯入）：
   ```bash
   npm run local:test
   ```
   - 會開啟本機瀏覽器到 Candy House 登入頁，**請你在瀏覽器內手動完成登入**（含收驗證碼等），直到畫面上出現「工寮 Open Sensor」那一列。
   - 回到終端機按 Enter 後，腳本會讀取該列狀態文字、匯出 cookies + `localStorage`，並 `POST` 到 `SESSION_IMPORT_URL`（或上述預設本機位址）。
3. 若 `SESSION_IMPORT_URL` 未設定，`local-test.js` 會預設把 session 傳到本機 dev：
   - `http://localhost:8787/import-session`（搭配 `npm run dev` 使用）。
4. 若你想直接把 session 上傳到正式 Worker，請使用：
   ```bash
   npm run local:test:prod
   ```
   - 此指令會把 `SESSION_IMPORT_URL` 設為：
     - `https://door-lock-monitor.irvinfly.workers.dev/import-session`
   - 流程同上：本機瀏覽器手動登入 → 按 Enter → 上傳 cookies + `localStorage` 到正式 Worker。
5. 之後 Worker 每次執行時會：
   - 從 KV 拿出 `session_cookies` + `session_local_storage`，還原到 Browser Rendering 環境。
   - 直接開狀態頁讀取門鎖文字，**不再**於 Worker 內自動走 OTP 登入流程。

## 本地開發與測試

```bash
npm install
cp .dev.vars.example .dev.vars
# 編輯 `.dev.vars`（選用：自訂 SESSION_IMPORT_URL；未設定則匯入本機；`npm run local:test:prod` 會固定指向正式 import）

# 啟動本機開發（使用 Cloudflare 的 Browser Rendering + 遠端 KV）
npm run dev

# 在本機實際登入一次並同步 session（打到 SESSION_IMPORT_URL）
npm run local:test

# 再用本機 Worker 端點測試一次完整流程
curl -X POST http://localhost:8787/run
curl http://localhost:8787/status
```

## Cloudflare 設定與部署

1. 專案中的 `wrangler.toml` 已預先填好 KV namespace 與 `triggers.crons`（目前為每 10 分鐘一次），通常不需更改。
2. 若要開啟或關閉 Telegram 通知，可依需要修改 `wrangler.toml` 裡的：
   ```toml
   [vars]
   TELEGRAM_ENABLED = "true"
   ```
   若要啟用「開關門公告 + 頻道標題更新」，需設定 `TELEGRAM_OPEN_ANNOUNCEMENT_CHAT_ID`（未設定時會略過該功能，並通知 `TELEGRAM_CHAT_ID`）。
3. 第一次部署前，需使用 `wrangler secret put` 設定敏感資訊，例如：
   ```bash
   wrangler secret put TELEGRAM_BOT_TOKEN
   wrangler secret put TELEGRAM_CHAT_ID
   ```
4. 部署：

   ```bash
   npm run deploy
   ```

> 備註：若 session 失效，Worker 可能讀不到狀態或導向登入頁（網址為 `/login` 時會透過 Telegram 提示需重新匯入 session）。請再執行一次 `npm run local:test` 或 `npm run local:test:prod` 完成手動登入並上傳新的 cookies。

## Telegram 設定

1. 用 `@BotFather` 建立 bot，拿到 token。
2. 把 bot 加入你的群組。
3. 先在群組發一則訊息給 bot。
4. 取得群組 `chat.id`（先讓 bot 在群組收到至少一則訊息後再呼叫）：

   ```bash
   curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
   ```

   從回傳中的 `chat.id` 取得群組 id（通常是 `-100...`）。
5. 若有設定 `TELEGRAM_OPEN_ANNOUNCEMENT_CHAT_ID`，bot 需已加入該目標頻道/群組，且具有發訊息與修改頻道資訊（`setChatTitle`）的管理員權限。

## 狀態查詢與通知行為

- **查詢最新狀態（本機 / 正式皆可）**
  - 手動觸發一次同步監控：
    ```bash
    # 本機
    curl -X POST http://localhost:8787/run
    curl http://localhost:8787/status

    # 正式
    curl -X POST "https://door-lock-monitor.irvinfly.workers.dev/run"
    curl "https://door-lock-monitor.irvinfly.workers.dev/status"
    ```
  - `/status` 回傳重點欄位：
    - `last_status`: `"OPEN"` / `"CLOSED"`
    - `monitoring_mode`: `"normal"` 或 `"manual_open_muted"`
    - `sensor_muted`: 是否為感測隔離（布林，與 `monitoring_mode` 一致）
    - `manual_mode_changed_at`: 最近一次切換監控模式時間（若有）
    - `last_run_started_at_iso`: 上次啟動時間（ISO）
    - `last_run_finished_at_iso`: 上次結束時間（ISO）
    - `last_run_ok`: `"1"` 表示成功，`"0"` 表示失敗
    - 隔離期間最近一次執行的 `last_run_stage` 可能為 `skipped_sensor_muted`（略過瀏覽器）
- **排程行為**
  - 每 10 分鐘由 Cloudflare cron 自動呼叫 `scheduled`，執行與 `run` 相同的監控流程。
- **Telegram 通知規則**
  - 第一次成功讀到狀態時：
    - `OPEN` → 發送 `工寮大門：已開啟`
    - `CLOSED` → 發送 `工寮大門：已關閉`
  - 之後每次執行只要 `last_status` 與前一次不同時，才會再發送一次對應訊息（不重複刷同一個狀態）。
  - 當狀態在 `OPEN` 與 `CLOSED` 之間變化時，若有設定 `TELEGRAM_OPEN_ANNOUNCEMENT_CHAT_ID`，會另外發送公告到該頻道/群組；**自動感測**格式為 `#工寮開門 YYYY/MM/DD HH:mm:ss（by 大門感應器）` 或 `#工寮關門 …（by 大門感應器）`（台北時間）。
  - 若以 Telegram 指令**手動開門**或**手動關門**（Webhook），同一公告頻道會改為 `#工寮開門 YYYY/MM/DD HH:mm:ss（by {@username}）` 或 `#工寮關門 YYYY/MM/DD HH:mm:ss（by {@username}）`；`username` 為下指令者的 Telegram 使用者名稱（若未設定則改為顯示名稱或 `user_<id>`）。
  - 若有設定 `TELEGRAM_OPEN_ANNOUNCEMENT_CHAT_ID`，開門時會把該頻道標題改成 `Moz://TW（工寮開放中）`；關門時會改回 `Moz://TW`。
  - 若未設定 `TELEGRAM_OPEN_ANNOUNCEMENT_CHAT_ID`，會略過上述公告/改標題，並通知 `TELEGRAM_CHAT_ID` 缺少此變數。
  - 若前一輪曾發送過錯誤通知，下一輪成功時會先發 `門鎖監控已恢復正常`，再依狀態變更規則處理開關門訊息。

## 重要注意

- Worker 預設以 `li:has-text("工寮 Open Sensor")` 鎖定狀態列；若 Candy House 介面改版，可在 Worker 環境變數設定 `LOCK_STATUS_SELECTOR` 覆寫。
- `local-test.js` 使用與 Worker 對齊的 selector；本機除錯時請用 DevTools 確認「渲染後」DOM 再調整。
- 若頁面有防 bot / CAPTCHA，本機手動登入仍適用；Worker 端無法自動完成互動式驗證。
- 建議不定期執行 `npm run local:test:prod` 更新 session，減少遠端讀取失敗。

## 主要檔案

- `src/index.js`: Worker 主程式（排程、監控、Telegram Webhook、通知）
- `wrangler.toml`: Worker 綁定與 cron
- `.dev.vars.example`: 環境變數範本
