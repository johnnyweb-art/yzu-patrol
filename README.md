# 元智大學 校園巡邏系統（網頁版 App）

巡邏員用手機瀏覽器開啟，加入主畫面後操作方式與一般 App 相同，不需上架 App Store 或 Google Play。

| 畫面 | 網址 | 使用者 |
|------|------|--------|
| 巡邏員手機端 | `index.html` | 巡邏員（也可由班長、管理者使用） |
| 管理後台 | `admin.html` | 班長、總務處管理者 |

## 一、兩種運作模式

| 模式 | 啟用方式 | 資料存放 | 用途 |
|------|----------|----------|------|
| 示範模式 | `js/config.js` 的 `SUPABASE_URL` 留空（目前狀態） | 只存在該台裝置的瀏覽器 | 試用、教育訓練、確認流程 |
| 正式模式 | 填入 Supabase 專案網址與金鑰 | 雲端資料庫，所有人共用 | 實際上線 |

示範帳號（密碼皆為 `demo1234`）：

| 工號 | 角色 |
|------|------|
| G1024、G1025 | 巡邏員 |
| S001 | 班長 |
| A001 | 總務處管理者 |

示範模式下，同一台電腦、同一個瀏覽器開啟兩個分頁（巡邏員畫面與管理後台），即可看到巡邏資料即時出現在後台。

## 二、功能總覽

**巡邏員手機端**
1. 工號登入，帳號綁定第一支使用的手機；換機需主管核准。
2. 指紋／臉部辨識後開始巡邏，日期時間由伺服器記錄。
3. 掃描據點 QR Code，系統同時驗證位置是否在據點範圍內。
4. App 內相機現場拍照（停用相簿），照片自動壓上姓名、據點、時間、座標浮水印，並計算雜湊值防竄改。
5. 依據點類型勾選檢查項目，填寫正常或異常（類別、嚴重度、說明）。
6. 回報非據點事件（可疑人員、設施損壞等）。
7. 長按 3 秒 SOS，位置即時傳送給主管。
8. 巡邏中隨機要求自拍，供主管確認為本人。
9. 結束巡邏時，未巡據點必須填寫原因，並完成交接清點。
10. 無訊號處可繼續作業，資料暫存於手機，恢復連線後自動上傳。
11. 只能查看本人的巡邏紀錄；可自行變更密碼，但不能修改或刪除已送出的紀錄。

**管理後台**
1. 即時看板：進行中巡邏、SOS 警示、今日異常、待覆核數量。
1. 每日巡查日報表：預覽、下載 Excel，並可設定每天自動寄送給隊長。
2. 巡邏場次：地圖顯示據點、掃描位置與巡邏軌跡。
3. 定點紀錄查詢：多條件篩選、照片檢視、主管覆核、匯出 CSV（可用 Excel 開啟）。
4. 事件管理：未處理、處理中、已結案三階段追蹤。
5. 身分確認：比對巡邏中自拍照。
6. 統計分析：異常熱點、異常類別、發生時段、人員完成率。
7. 據點管理：地圖點選座標、設定範圍半徑、檢查項目、更換 QR 金鑰。
8. 路線管理：設定據點順序，可要求依序巡邏。
9. QR 標籤列印。
10. 人員與裝置：新增人員、停用離職人員、核准換機、刪除過期照片。

## 三、防代巡機制

| 層次 | 機制 | 判定位置 |
|------|------|----------|
| 身分 | 帳號綁定單一手機；開始巡邏需生物辨識；巡邏中隨機自拍 | 資料庫＋手機 |
| 位置 | 掃描時 GPS 必須在據點範圍內，否則無法完成 | 資料庫 |
| 時間 | 伺服器時間戳記；兩點間隔短於合理移動時間即註記 | 資料庫 |
| 證據 | App 內即時拍照；浮水印；SHA-256 雜湊值；照片上傳後無法修改或刪除 | 手機＋儲存空間權限 |
| 權限 | 巡邏員無法讀取 QR 金鑰、無法直接寫入或修改紀錄、無法查看他人資料 | 資料庫權限規則 |

有註記的紀錄會進入「待覆核」，由班長在後台確認或退回。

## 四、正式上線步驟

需要的帳號：Supabase（免費方案可試行）、一個能放靜態網頁的 https 網址。

### 步驟 1：建立資料庫
1. 到 https://supabase.com 註冊並建立專案，區域建議選 Northeast Asia (Tokyo)。
2. 左側選單 **SQL Editor** → 貼上 `supabase/schema.sql` 全文 → **Run**。
3. （選用）再執行 `supabase/seed.sql` 建立範例據點與路線。
4. **Authentication → Providers → Email**：關閉「Allow new users to sign up」，避免外人自行註冊。
5. **Project Settings → API**：複製 `Project URL` 與 `anon public` 金鑰。

### 步驟 2：部署管理者專用功能
在電腦安裝 Supabase CLI 後執行：
```
supabase login
supabase link --project-ref 你的專案代碼
supabase functions deploy admin
```
此功能用於後台「新增人員」「重設密碼」「刪除過期照片」。

### 步驟 3：建立第一位管理者
1. **Authentication → Users → Add user**，Email 填 `a001@patrol.yzu.local`（工號小寫＋`@patrol.yzu.local`），設定密碼，勾選 Auto Confirm。
2. 在 SQL Editor 執行：
```sql
update public.profiles set role = 'admin', name = '管理者姓名' where staff_no = 'A001';
```
之後的人員都可以由管理後台新增。

### 步驟 4：設定並部署網頁
1. 編輯 `js/config.js`：填入 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SOS_PHONES` 緊急電話。
2. 把整個資料夾放到任何支援 https 的靜態網站空間，例如學校網頁伺服器、Netlify、GitHub Pages。
   **必須是 https**，否則手機瀏覽器不允許使用相機與定位。

### 步驟 5：設定每日自動寄送日報表（選用）
1. 到 https://resend.com 註冊寄信服務，驗證學校的寄件網域，取得 API 金鑰。
2. Supabase → **Edge Functions → Secrets** 新增：`RESEND_API_KEY`、`REPORT_FROM`（例如 `校園巡邏系統 <patrol@你的網域>`）、`REPORT_CRON_SECRET`（自訂一串亂碼）。
3. 部署：`supabase functions deploy daily-report --no-verify-jwt`
4. 編輯 `supabase/cron.sql`，填入專案代碼與 `REPORT_CRON_SECRET`，在 SQL Editor 執行。
5. 管理後台「每日巡查日報表」→ 填寫收件人、寄送時間（預設每天 23:59 寄出當天紀錄），勾選「每天自動寄送」後儲存。可先按「立即寄送給收件人」測試。

### 步驟 6：現場建置
1. 管理者帶手機到每個據點，在「據點管理」按「使用我目前的位置」標定座標。
2. 「QR 標籤列印」印出標籤，護貝後張貼。
3. 「路線管理」建立路線。
4. 巡邏員用手機開啟網址：iPhone 用 Safari →「分享」→「加入主畫面」；Android 用 Chrome →「加到主畫面」。
5. 巡邏員第一次登入後，到「設定」啟用指紋／臉部辨識。

## 五、檔案結構

```
index.html              巡邏員手機端
admin.html              管理後台
js/config.js            系統設定（部署時只需改這個檔）
js/guard.js             巡邏員畫面邏輯
js/admin.js             管理後台邏輯
js/rules.js             防代巡判定規則（示範模式用；正式模式由資料庫執行同樣規則）
js/backend-demo.js      示範模式資料存取
js/backend-supabase.js  正式模式資料存取
js/camera.js            QR 掃描、拍照、浮水印、雜湊
js/biometric.js         指紋／臉部辨識
supabase/schema.sql     資料庫結構與權限
supabase/seed.sql       範例據點
supabase/cron.sql       每日日報表排程
supabase/functions/     伺服器功能：admin（管理者）、daily-report（日報表寄送）、_shared（日報表共用程式）
docs/                   需補充資料清單、已知限制、個資告知範本
```

## 六、本機試用

```
npx http-server . -p 8080
```
瀏覽器開啟 http://localhost:8080 。電腦沒有相機時，示範模式提供「產生示範照片」按鈕。
