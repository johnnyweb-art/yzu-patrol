// 每日巡查日報表：自動寄送 Excel 給隊長（班長）。
// 部署：supabase functions deploy daily-report --no-verify-jwt
// 觸發方式：
//   1. 排程（supabase/cron.sql）每小時呼叫一次，到了設定的寄送時間才寄出，同一勤務日只寄一次
//   2. 管理後台「立即寄送」：由班長或管理者登入後手動觸發
// 需要的環境變數（Supabase → Edge Functions → Secrets）：
//   RESEND_API_KEY      寄信服務 Resend 的金鑰
//   REPORT_FROM         寄件人，例如「校園巡邏系統 <patrol@你的網域>」
//   REPORT_CRON_SECRET  排程呼叫用的密語，需與 cron.sql 相同
//   ORG_NAME            （選填）報表標題的單位名稱，預設「元智大學」
import ExcelJS from 'npm:exceljs@4.4.0';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { buildWorkbook, dutyWindow, emailHtml, lastCompletedDutyDay, reportFileName, summarize, taipeiHour } from '../_shared/report.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const PROFILE = 'profiles!{t}_user_id_fkey(staff_no,name)';
const prof = (t: string) => PROFILE.replace('{t}', t);

// deno-lint-ignore no-explicit-any
export async function loadReportData(db: any, day: string, dayStartHour: number) {
  const { from, to } = dutyWindow(day, dayStartHour);
  const F = from.toISOString(), T = to.toISOString();
  const chk = (r: { data: unknown; error: { message: string } | null }) => { if (r.error) throw new Error(r.error.message); return r.data as any[]; };
  const [patrols, incidents, sos, routes, cps] = await Promise.all([
    db.from('patrols').select(`*, ${prof('patrols')}`).gte('started_at', F).lt('started_at', T).order('started_at').then(chk),
    db.from('incidents').select(`*, ${prof('incidents')}`).gte('created_at', F).lt('created_at', T).order('created_at').then(chk),
    db.from('sos_alerts').select(`*, ${prof('sos_alerts')}`).gte('created_at', F).lt('created_at', T).order('created_at').then(chk),
    db.from('routes').select('id,name,route_points(checkpoint_id)').then(chk),
    db.from('checkpoints').select('id,code,name').then(chk),
  ]);
  const ids = patrols.map((p: any) => p.id);
  const scans = ids.length
    ? chk(await db.from('scans').select(`*, checkpoint:checkpoints(code,name), ${prof('scans')}`).in('patrol_id', ids).order('server_at'))
    : [];
  const rById = Object.fromEntries(routes.map((r: any) => [r.id, r]));
  return {
    day, dayStartHour,
    patrols: patrols.map((p: any) => {
      const sc = scans.filter((s: any) => s.patrol_id === p.id);
      return { ...p, profile: p.profiles, route_name: rById[p.route_id]?.name || '', point_count: rById[p.route_id]?.route_points.length || 0,
        scan_count: sc.length, abnormal_count: sc.filter((s: any) => s.status === 'abnormal').length };
    }),
    scans: scans.map((s: any) => ({ ...s, profile: s.profiles })),
    incidents: incidents.map((i: any) => ({ ...i, profile: i.profiles })),
    sos: sos.map((s: any) => ({ ...s, profile: s.profiles })),
    checkpointNames: Object.fromEntries(cps.map((c: any) => [c.id, `${c.code} ${c.name}`])),
  };
}

function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function sendMail(to: string[], subject: string, html: string, filename: string, content: ArrayBuffer) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('尚未設定 RESEND_API_KEY');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: Deno.env.get('REPORT_FROM') || '校園巡邏系統 <onboarding@resend.dev>', to, subject, html,
      attachments: [{ filename, content: toBase64(content) }] }),
  });
  if (!res.ok) throw new Error(`寄信失敗：${res.status} ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = Deno.env.get('SUPABASE_URL')!;
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const org = Deno.env.get('ORG_NAME') ?? '元智大學';
  let trigger = 'cron', day = '';
  try {
    const body = await req.json().catch(() => ({}));
    const { data: settings } = await db.from('report_settings').select('*').eq('id', 1).single();
    const startHour = settings?.day_start_hour ?? 6;

    const secret = Deno.env.get('REPORT_CRON_SECRET');
    if (secret && req.headers.get('x-cron-secret') === secret) {
      if (!settings?.enabled) return json({ skipped: '自動寄送未啟用' });
      if (taipeiHour() !== settings.send_hour) return json({ skipped: '尚未到寄送時間' });
      day = lastCompletedDutyDay(new Date(), startHour);
      const { data: done } = await db.from('report_runs').select('id').eq('report_day', day).eq('status', 'sent').limit(1);
      if (done?.length) return json({ skipped: '此勤務日已寄送' });
    } else {
      // 手動觸發：需為登入中的班長或管理者
      const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
      const { data: { user } } = await asUser.auth.getUser();
      if (!user) return json({ error: '請重新登入' }, 401);
      const { data: me } = await db.from('profiles').select('role,active').eq('id', user.id).single();
      if (!me?.active || !['supervisor', 'admin'].includes(me.role)) return json({ error: '權限不足' }, 403);
      trigger = 'manual';
      day = /^\d{4}-\d{2}-\d{2}$/.test(body.day ?? '') ? body.day : lastCompletedDutyDay(new Date(), startHour);
    }

    const recipients: string[] = (body.to?.length && trigger === 'manual') ? body.to : (settings?.recipients ?? []);
    if (!recipients.length) throw new Error('尚未設定收件人');

    const data = await loadReportData(db, day, startHour);
    const s = summarize(data);
    const wb = await buildWorkbook(ExcelJS, data, org);
    const buf = await wb.xlsx.writeBuffer();
    const subject = `【巡查日報】${day}｜${s.patrols} 場、完成率 ${s.completion}、異常 ${s.abnormal} 件${s.sos ? `、SOS ${s.sos} 次` : ''}`;
    await sendMail(recipients, subject, emailHtml(data, org), reportFileName(day), buf);
    await db.from('report_runs').insert({ report_day: day, trigger, recipients, status: 'sent' });
    return json({ sent: true, day, recipients });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (day) await db.from('report_runs').insert({ report_day: day, trigger, status: 'failed', error: msg });
    return json({ error: msg }, 500);
  }
});
