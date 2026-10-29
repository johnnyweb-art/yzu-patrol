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
| 巡邏員自行註冊，班長核准 | 免除管理者逐一建帳號；核准機制防止外人註冊 |
| 日常以掃臉一次完成登入、報到、開始巡邏 | 降低操作負擔；臉部辨識結果由伺服器驗證 |
| 巡查紀錄不可修改或刪除 | 作為稽核證據；錯誤由主管覆核註明 |
| 日報表每天 23:59 寄出當天紀錄 | 使用者指定；跨午夜巡邏的紀錄只計入發生當天 |

## 3. 未完成事項與下一步

| 優先序 | 事項 | 負責 |
|--------|------|------|
| 1 | iPhone 實機測試：註冊、核准、掃臉報到、拍照、定位 | Johnny |
| 2 | 填寫 `docs/資料填寫範本.xlsx`：據點、路線、人員 | 總務處、保全 |
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
