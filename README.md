# Door Lock Cloudflare Monitor

用 Cloudflare Worker 監控「只能網頁查看」的門鎖狀態，**以既有登入 session（長效 cookie）** 讀取門鎖狀態文字，狀態變更時送 Telegram 群組通知。

## 架構與流程

- `scheduled` (Cron): 每 5 分鐘執行一次監控（`wrangler.toml` 中的 `*/5 * * * *`）。
- `Browser Rendering + Playwright`: 使用「已登入的 session」（cookies + localStorage）開啟狀態頁，讀取門鎖狀態文字。
- `KV (LOCK_STATE)`: 保存
  - `session_cookies`：登入後的 cookies
  - `session_local_storage`：登入後的 localStorage key/value
  - `last_status`：上一次成功讀到的狀態（`OPEN` / `CLOSED`）
  - `last_run_*`：最近一次執行的時間與結果
- `Telegram Bot API`: 當狀態變化時發訊息到群組：
  - `OPEN` → `工寮現在開門中`
  - `CLOSED` → `工寮現在已關門`

## 先決條件

1. Cloudflare 帳號（已可用 Workers）。
2. 啟用 Browser Rendering。
3. 建立 KV Namespace。
4. Telegram Bot 與群組 chat id。

### 一次性前置步驟：建立「已登入的 session」

整個系統的「登入」只透過本機瀏覽器完成一次，然後由腳本自動把 session 上傳到 Cloudflare：

1. 編輯 `.dev.vars`：
   - `LOGIN_URL`：登入頁（例如 `https://biz.candyhouse.co/login`）
   - `STATUS_URL`：登入後顯示狀態的頁面（例如 `https://biz.candyhouse.co`）
   - `LOGIN_EMAIL`：登入用 email
   - `EMAIL_INPUT_SELECTOR` / `SEND_CODE_BUTTON_SELECTOR` / `OTP_INPUT_SELECTOR` / `LOCK_STATUS_SELECTOR`：
     - 已依這個專案調整為 SESAME Biz 的實際 selector，可依你環境再調整。
2. 在本機執行：
   ```bash
   npm run local:test
   ```
   - 這會開一個本機瀏覽器，流程：
     - 自動開 `LOGIN_URL`、填入 `LOGIN_EMAIL`、按「發送驗證碼」。
     - 等你在終端機輸入 Email 收到的 4 碼 OTP。
     - 自動填入 OTP、等待跳轉到狀態頁。
     - 等到「工寮 Open Sensor」那一行出現後，讀出當下狀態（`OPEN` / `CLOSED`）。
     - 讀取登入後的 cookies + localStorage，呼叫 `/import-session` 將這份 session 傳給 Worker。
3. 若 `SESSION_IMPORT_URL` 未設定，`local-test.js` 會預設把 session 傳到本機 dev：
   - `http://localhost:8787/import-session`（搭配 `npm run dev` 使用）。
4. 若你想直接把 session 上傳到正式 Worker，可使用：
   ```bash
   npm run local:test:prod
   ```
   - 這個 script 會把 session 傳到：
     - `https://door-lock-monitor.irvinfly.workers.dev/import-session`
   - 也就是「本機登入 → 把 cookies + localStorage 上傳到正式 Cloudflare Worker」。
5. 之後 Worker 每次執行時會：
   - 從 KV 拿出 `session_cookies` + `session_local_storage`，還原到 Browser Rendering 環境。
   - 直接開 `STATUS_URL` 讀取狀態，不再自動走 OTP 流程。

## 本地開發與測試

```bash
npm install
cp .dev.vars.example .dev.vars
# 編輯 `.dev.vars`（登入 URL、selector、Telegram 設定等）

# 啟動本機開發（使用 Cloudflare 的 Browser Rendering + 遠端 KV）
npm run dev

# 在本機實際登入一次並同步 session（預設打到 http://localhost:8787/import-session）
npm run local:test

# 再用本機 Worker 端點測試一次完整流程
curl -X POST http://localhost:8787/run-sync
curl http://localhost:8787/status
```

## Cloudflare 設定與部署

1. 在 `wrangler.toml` 填入 KV namespace id 與 `triggers.crons`（預設為每 5 分鐘一次）。
2. 在 `wrangler.toml` 的 `[vars]` 區塊設定必要變數，例如：
   ```toml
   [vars]
   STATUS_URL = "https://biz.candyhouse.co"
   LOCK_STATUS_SELECTOR = 'li.MuiListItem-root:has-text("工寮 Open Sensor") >> button.MuiIconButton-root'
   STATUS_OPEN_REGEX = "(Open)"
   STATUS_CLOSED_REGEX = "(Closed)"
   TELEGRAM_ENABLED = "true"
   ```
3. 使用 `wrangler secret put` 設定敏感資訊，例如：
   ```bash
   wrangler secret put TELEGRAM_BOT_TOKEN
   wrangler secret put TELEGRAM_CHAT_ID
   ```
4. 部署：
```bash
npm run deploy
```

> 備註：如果未來 session 失效，Worker 會在讀取狀態頁時失敗，你只要重新登入一次、再匯入新的 cookies 即可。

## Telegram 設定

1. 用 `@BotFather` 建立 bot，拿到 token。
2. 把 bot 加入你的群組。
3. 先在群組發一則訊息給 bot。
4. 呼叫：
```bash
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
```
從回傳中的 `chat.id` 取得群組 id（通常是 `-100...`）。

## 狀態查詢與通知行為

- **查詢最新狀態（本機 / 正式皆可）**
  - 手動觸發一次同步監控：
    ```bash
    # 本機
    curl -X POST http://localhost:8787/run-sync
    curl http://localhost:8787/status

    # 正式
    curl -X POST "https://door-lock-monitor.irvinfly.workers.dev/run-sync"
    curl "https://door-lock-monitor.irvinfly.workers.dev/status"
    ```
  - `/status` 回傳重點欄位：
    - `last_status`: `"OPEN"` / `"CLOSED"`
    - `last_run_started_at_iso`: 上次啟動時間（ISO）
    - `last_run_finished_at_iso`: 上次結束時間（ISO）
    - `last_run_ok`: `"1"` 表示成功，`"0"` 表示失敗
- **排程行為**
  - 每 5 分鐘由 Cloudflare cron 自動呼叫 `scheduled`，執行與 `run-sync` 相同的監控流程。
- **Telegram 通知規則**
  - 第一次成功讀到狀態時：
    - `OPEN` → 發送 `工寮現在開門中`
    - `CLOSED` → 發送 `工寮現在已關門`
  - 之後每次執行只要 `last_status` 與前一次不同時，才會再發送一次對應訊息（不重複刷同一個狀態）。

## 重要注意

- 你必須把 selector 換成你的實際頁面（`EMAIL_INPUT_SELECTOR` / `LOCK_STATUS_SELECTOR` 等）。
- 如果你看到的 HTML 只有 `<div id="root"></div>`，代表是 SPA；請用瀏覽器開頁後用 DevTools 檢查「渲染後」DOM 再填 selector。
- 如果頁面有防 bot / CAPTCHA，這個方案可能需要人工介入。
- 若登入後 session 可以維持，可透過 `npm run local:test:prod` 不定期更新 session，減少手動處理登入的頻率。

## 主要檔案

- `src/index.js`: Worker 主程式（排程、監控、收信、通知）
- `wrangler.toml`: Worker 綁定與 cron
- `.dev.vars.example`: 環境變數範本
