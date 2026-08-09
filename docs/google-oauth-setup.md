# Google OAuth Client ID Setup

> 一次性設定。設定一次後可以在 Cloud Console 看到 client ID 跟 secret，貼到 app 即可。

## 概覽

你要拿到的東西：

- **Google Cloud project**（免費，沙盒環境）
- **OAuth 2.0 Client ID**（Web application 類型）
- **已啟用的 googleapis API**（這個專案只需要 Drive API）

完成時間約 10 分鐘。**不需要綁信用卡，不會產生任何費用**。

---

## ⚠️ 重要：origin 設定

OAuth flow 跑在瀏覽器（或 WebView）裡，需要在 Cloud Console 設定「你的 app 從哪裡執行」白名單（**Authorized JavaScript origins**），沒列在白名單的 origin 會被 Google 擋下，console 顯示 `redirect_uri_mismatch`。

對這個專案來說，**origin 跟你怎麼「打開」`portfolio.html` 有關**：

| 開啟方式 | origin | 白名單要加 |
|----------|--------|----------|
| 直接雙擊（檔案總管） | `null` 或 `file://` | ❌ Google 不接受，要走下面兩種 |
| 本機 server (`python -m http.server`) | `http://localhost:8000` | `http://localhost:8000` |
| GitHub Pages / Netlify 等 | `https://你的帳號.github.io` | `https://你的帳號.github.io` |
| 自訂網域 | `https://example.com` | `https://example.com` |

**建議**：本機開發用 `python -m http.server`，正式用 GitHub Pages（這個 repo 已經在 GitHub 上，零成本）。

---

## Step 1：建 Google Cloud project

1. 開 https://console.cloud.google.com/
2. 右上角下拉選單 → **New Project**
3. Project name 隨意（例如 `property-tracker`）
4. Location 選 **No organization**（個人用途）
5. 建立後，確定右上角選到新 project

---

## Step 2：開 Drive API

1. 左側選單 → **APIs & Services** → **Library**
2. 搜尋 `Google Drive API`
3. 點進去 → **Enable**

`drive.file` 是 OAuth scope，開 API 跟授權 scope 是兩件事。API 要先開，授權是 Cloud Console 自動處理。

---

## Step 3：設定 OAuth consent screen

第一次建 client ID 之前，Google 會要求先設 consent screen。

1. 左側選單 → **APIs & Services** → **OAuth consent screen**
2. User type 選 **External**（個人 Gmail 也要選 External）
3. 按 **Create**

填基本資料：

| 欄位 | 填什麼 |
|------|--------|
| App name | `Property Tracker` |
| User support email | 你的 Gmail |
| Developer contact email | 你的 Gmail |

4. **Scopes** 步驟：
   - 按 **Add or remove scopes**
   - 搜尋 `drive.file`，勾 `https://www.googleapis.com/auth/drive.file`
   - **不要勾** `drive`（全權限）— 用 `drive.file` 只授權 app 建立的檔案
5. **Test users** 步驟：加你自己的 Gmail（External app 在「In testing」狀態最多 100 個測試者，只有他們能登入）
6. **Summary** → 回 Dashboard

**⚠️ 個人用、不上架，不需要做「App verification」**。留在 Testing 狀態就好，「Sensitive scopes」verification 是上 Play Store 或想公開用的時候才需要。

---

## Step 4：建 OAuth 2.0 Client ID

1. 左側選單 → **APIs & Services** → **Credentials**
2. 上方 **+ Create Credentials** → **OAuth client ID**
3. Application type 選 **Web application**
4. Name 隨意（例如 `property-tracker-web`）
5. **Authorized JavaScript origins**：
   - 本機開發：按 **+ Add URI** → 加 `http://localhost:8000`
   - GitHub Pages：再加 `https://你的github帳號.github.io`
6. **Authorized redirect URIs**：**不用填**（我們用 token model 不用 redirect code）
7. 按 **Create**

跳出來一個視窗顯示：

```
Your Client ID
xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com
```

（例如 `1234567890-abc123def456.apps.googleusercontent.com`）

**Client secret 在 Web application 類型下可以忽略**（GIS token model 不用 secret，跟 OAuth code flow 不一樣）。

---

## Step 5：把 Client ID 貼到 app

開 `portfolio.html`，點右上角 **☁️ Sync** 按鈕 → 在 modal 裡貼上 Client ID → **Save**。

存到 `localStorage['property_tracker_sync_client_id']`，之後 reload 不用重打。

然後按 **Connect to Google Drive** → 跳 Google 授權頁 → 同意 → 回來應該顯示「☁️ 已連線」。

---

## 驗證設定

最簡單的測試：編輯一個 holding → 等 5 秒（auto-sync 預設 ON）→ 開 https://drive.google.com → 找根目錄的 `property_tracker_portfolio_v1.json` → 應該看到 `modifiedTime` 剛剛更新。

第二次開檔案（重新整理網頁）會看到「☁️ 未連線」狀態 → 點 Connect → 重新同意 → 連線 → 點 **Sync now** → 應該把剛剛在 Drive 端編輯的內容拉回來。

---

## 疑難排解

| 問題 | 原因 | 解法 |
|------|------|------|
| `redirect_uri_mismatch` | 你的 origin 沒在 JS origins 白名單 | 回 Step 4 加 URI |
| `idpiframe_initialization_failed` | GIS script 沒載入完 | 檢查網路，確認 `<script src="https://accounts.google.com/gsi/client">` 沒被擋 |
| `Access blocked: This app's request is invalid` | Consent screen 沒建或 scope 沒加 | 回 Step 3 |
| `Error 403: access_denied` | 你不是 Test user | 回 Step 3 Test users 加你的 Gmail |
| `popup_closed_by_user` | 你按了 Cancel 或擋了 popup | 允許 popup 再試 |
| 連線成功但 push 失敗 | 沒開 Drive API | 回 Step 2 |

---

## 參考

- ADR 0008（v1 OAuth 決策）：`docs/adr/0008-google-oauth-gis-token-model.md`
- ADR 0002（Drive sync 決策）：`docs/adr/0002-google-drive-sync.md`
- Google 官方：[OAuth 2.0 for Web Server-Side Flows](https://developers.google.com/identity/protocols/oauth2/web-server)（注意：我們用 implicit token model 不是這個，但 scope 設定一致）
- Google 官方：[Google Identity Services token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
