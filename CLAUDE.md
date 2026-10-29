# 專案說明（給 Claude）

元智大學校園巡邏系統，網頁版 App（PWA）。需求方：Johnny 教授。

## 開工前先讀
1. `docs/handoff.md`：目前進度、關鍵決策、下一步、工作假設
2. `docs/對話紀錄.md`：需求演變與每次決策的原因
3. `docs/已知限制.md`：限制與第二階段建議

## 架構
- 巡邏員端 `index.html` + `js/guard.js`；管理後台 `admin.html` + `js/admin.js`
- 資料存取有兩種實作，介面相同：`js/backend-demo.js`（示範模式，資料存瀏覽器）、`js/backend-supabase.js`（正式模式）
- `js/config.js` 的 `SUPABASE_URL` 留空即為示範模式
- 資料庫與權限：`supabase/schema.sql`；伺服器功能：`supabase/functions/`（admin、passkey、daily-report、_shared）
- 防代巡判定規則在 `js/rules.js`（示範）與 `supabase/schema.sql` 的 `submit_scan`（正式），兩邊需一致
- 日報表程式 `supabase/functions/_shared/report.js` 前後端共用

## 慣例
- 介面與文件一律繁體中文（臺灣用語）
- 不需建置工具，純 HTML／JS 模組；外部套件放在 `vendor/`
- 已送出的巡查紀錄不可修改或刪除（稽核證據）
- 修改後推送到 GitHub `main`，GitHub Pages 約 1 分鐘自動更新：https://johnnyweb-art.github.io/yzu-patrol/

## 本機試用
在專案資料夾執行 `npx http-server . -p 8080`（需 Node.js）或 `python -m http.server 8080`，瀏覽器開 http://localhost:8080 。
手機測試需 https，請推送到 GitHub 後用上方網址。
