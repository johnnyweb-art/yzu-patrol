# 交接文件（handoff）

更新日期：2026-10-29

## 1. 專案名稱與進度階段

- 專案：元智大學校園巡邏系統（網頁版 App）
- 階段：**示範版已上線，等待補充資料以建置正式環境**
- 試用網址：https://johnnyweb-art.github.io/yzu-patrol/ （管理後台加 `admin.html`）
- 程式庫：https://github.com/johnnyweb-art/yzu-patrol

## 2. 已確認的關鍵決策

| 決策 | 推理依據 |
|------|----------|
| 第一版做網頁版 App，不上架 App Store | 省去上架審核與開發者帳號；相機、定位、生物辨識網頁皆可使用 |
| 防代巡採五層驗證，不只靠 QR Code | QR 可被翻拍；需搭配 GPS 圍欄、伺服器時間、即時拍照、身分確認 |
| 到點確認維持 QR Code | 成本最低、維護簡單；替代方案留待第二階段 |
| 巡邏員自行註冊，只有管理者可核准（註冊與換機） | 免除逐一建帳號；由管理者把關防止外人或代巡（2026-11 確認） |
| 日常以掃臉一次完成登入、報到、開始巡邏 | 降低操作負擔；臉部辨識結果由伺服器驗證 |
| 巡查紀錄不可修改或刪除 | 作為稽核證據；錯誤由主管覆核註明 |
| 日報表每天 23:59 寄出當天紀錄 | 使用者指定；跨午夜巡邏的紀錄只計入發生當天 |
| 不需排班；依「大門／側門」崗位自動帶入巡邏範圍 | 總務處意見（10/28） |
| 巡邏點掃 QR 即自動記錄 GPS 與時間，不需拍照、勾選 | 巡邏員年長、不熟手機，操作越少越好 |
| 有未巡點時無法送出，去不了的點一鍵標記「無法巡邏」 | 使用者指定；兼顧完整性與現場例外 |
| 交接事項只做提醒，不需勾選 | 總務處意見 |

## 2-1. 正式環境建置進度（2026-11-11）

- Supabase 組織「元智校園智慧巡邏」、專案 `yzu-partol`（專案代碼 `bpvrvbybmulgjkvqtsqr`，區域 Singapore，免費方案）已由 Johnny 建立。
- 已確認只有一個專案，無重複。
- 2026-11-11 已完成（由 Claude 以 Management API 執行）：`schema.sql`、`seed.sql`（6 個示意據點）、Storage bucket `patrol-photos`（不公開）與存取規則、部署 admin（驗證 JWT）／passkey、daily-report（`--no-verify-jwt`）、設定 WEBAUTHN_RP_ID、WEBAUTHN_ORIGINS、LOGIN_EMAIL_DOMAIN、關閉公開註冊、`js/config.js` 填入專案 URL 與 anon key（網站已切換正式模式）。
- 尚未完成：建立第一位管理者（待 Johnny 提供工號與姓名）；日報表寄信需 RESEND_API_KEY、REPORT_FROM、REPORT_CRON_SECRET，並執行 `supabase/cron.sql`。

## 3. 未完成事項與下一步

| 優先序 | 事項 | 負責 |
|--------|------|------|
| 1 | iPhone 實機測試：註冊、核准、掃臉報到、拍照、定位 | Johnny |
| 2 | 總務處提供大門、側門的巡邏範圍與據點位置 | 總務處 |
| 3 | 確認 Supabase 帳號由誰申請、寄件信箱網域 | 資訊處 |
| 4 | 建置正式環境：資料庫、三個伺服器功能、排程（見 README） | Claude 協助 |
| 5 | 現場標定據點座標、列印張貼 QR 標籤 | 總務處 |
| 6 | 個資告知範本送法務審閱 | 總務處 |
| 7 | 選 1 條路線試行 1–2 週，調整 GPS 範圍半徑 | 保全 |

## 4. 需延續的工作假設

1. 巡邏員以步行巡邏（兩點最快速度每秒 2.5 公尺）。
2. 「隊長」對應系統中的「班長」角色；班長可審核註冊申請。
3. 一天以 00:00 起算，日報表 23:59 寄出。
4. 掃臉報到沿用上次的路線與天候。
5. 示範據點名稱與座標為示意資料，正式上線前需替換。
6. 寄信服務預設 Resend；學校若有自有郵件伺服器可替換。

## 5. 已使用檔案清單

| 類別 | 檔案 |
|------|------|
| 巡邏員手機端 | `index.html`、`js/guard.js`、`js/camera.js`、`js/webauthn.js`、`js/biometric.js` |
| 管理後台 | `admin.html`、`js/admin.js` |
| 共用程式 | `js/config.js`（部署設定）、`js/api.js`、`js/backend-demo.js`、`js/backend-supabase.js`、`js/rules.js`、`js/report.js`、`js/util.js`、`js/idb.js` |
| 資料庫 | `supabase/schema.sql`、`supabase/seed.sql`、`supabase/cron.sql` |
| 伺服器功能 | `supabase/functions/admin`、`supabase/functions/passkey`、`supabase/functions/daily-report`、`supabase/functions/_shared` |
| 文件 | `README.md`、`docs/對話紀錄.md`、`docs/handoff.md`、`docs/初版設計規格書.html`、`docs/需補充資料清單.md`、`docs/資料填寫範本.xlsx`、`docs/已知限制.md`、`docs/個資告知範本.md` |
| 外部元件 | `vendor/`（QR 掃描、QR 產生、地圖、Excel、臉部辨識） |
