-- 每日日報表排程：每 5 分鐘（第 4、9、14…59 分）呼叫一次 daily-report，
-- 函式會比對管理後台設定的寄送時間（預設 23:59），時間到才寄出，同一天只寄一次。
-- 使用前請替換：
--   <PROJECT_REF>         Supabase 專案代碼（Project Settings → General）
--   <REPORT_CRON_SECRET>  自訂的一串亂碼，需與 Edge Function Secrets 的 REPORT_CRON_SECRET 相同
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('patrol-daily-report') where exists (select 1 from cron.job where jobname = 'patrol-daily-report');
select cron.schedule('patrol-daily-report', '4-59/5 * * * *', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/daily-report',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<REPORT_CRON_SECRET>'),
    body := '{}'::jsonb
  );
$$);
