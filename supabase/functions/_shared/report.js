// 巡查日報表：管理後台下載與每日自動寄送共用。不依賴瀏覽器或伺服器環境。
import { flagLabel, REVIEW_LABELS, INCIDENT_STATUS } from './labels.js';

const TZ_MS = 8 * 3600 * 1000; // 臺北時間 UTC+8，不受執行環境時區影響
const p2 = n => String(n).padStart(2, '0');
const tp = iso => new Date(new Date(iso).getTime() + TZ_MS);
export const fmtDate = iso => { if (!iso) return ''; const d = tp(iso); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`; };
export const fmtTime = iso => { if (!iso) return ''; const d = tp(iso); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
export const fmtDT = iso => iso ? `${fmtDate(iso)} ${fmtTime(iso)}` : '';

// 勤務日：例如 dayStartHour = 6，則「10/21 勤務日」為 10/21 06:00 至 10/22 06:00（臺北時間）
export function dutyWindow(day, dayStartHour = 6) {
  const [y, m, d] = day.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, d, dayStartHour) - TZ_MS);
  return { from, to: new Date(from.getTime() + 86400000) };
}
// 指定時間點所屬的勤務日
export function dutyDayOf(date = new Date(), dayStartHour = 6) {
  return fmtDate(new Date(new Date(date).getTime() - dayStartHour * 3600000).toISOString());
}
// 最近一個「已結束」的勤務日
export function lastCompletedDutyDay(now = new Date(), dayStartHour = 6) {
  return dutyDayOf(new Date(new Date(now).getTime() - 86400000), dayStartHour);
}
export const taipeiHour = (now = new Date()) => tp(now).getUTCHours();
export const taipeiMinutes = (now = new Date()) => { const d = tp(now); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

// 預設：每天 23:59 寄出當天（00:00–23:59）的報表
export const DEFAULT_REPORT_SETTINGS = { enabled: false, recipients: [], send_hour: 23, send_minute: 59, day_start_hour: 0, report_scope: 'today' };
const withDefaults = st => ({ ...DEFAULT_REPORT_SETTINGS, ...Object.fromEntries(Object.entries(st || {}).filter(([, v]) => v != null)) });
// 報表涵蓋哪一天：today＝寄送當天；previous＝前一個已結束的勤務日
export function targetReportDay(settings, now = new Date()) {
  const st = withDefaults(settings);
  return st.report_scope === 'previous' ? lastCompletedDutyDay(now, st.day_start_hour) : dutyDayOf(now, st.day_start_hour);
}
export function isSendDue(settings, now = new Date()) {
  const st = withDefaults(settings);
  return taipeiMinutes(now) >= st.send_hour * 60 + st.send_minute;
}
export const sendTimeLabel = settings => { const st = withDefaults(settings); return `${p2(st.send_hour)}:${p2(st.send_minute)}`; };

// 跨日巡邏：場次與報表期間重疊即列入，定點紀錄只計入期間內的筆數，每筆紀錄只會出現在一份日報表
export const patrolOverlaps = (p, from, to) => new Date(p.started_at) < to && (!p.ended_at || new Date(p.ended_at) >= from);
export function applyWindow(patrols, scans, from, to) {
  const inW = scans.filter(x => { const t = new Date(x.server_at); return t >= from && t < to; });
  return {
    scans: inW,
    patrols: patrols.map(p => {
      const sc = inW.filter(x => x.patrol_id === p.id);
      return { ...p, scan_count: sc.length, abnormal_count: sc.filter(x => x.status === 'abnormal').length, flagged_count: sc.filter(x => x.flags?.length).length,
        cross_day: new Date(p.started_at) < from || (p.ended_at ? new Date(p.ended_at) >= to : false),
        // 未巡據點在結束巡邏時才填寫，只計入結束當天的報表
        ended_in_window: !!p.ended_at && new Date(p.ended_at) >= from && new Date(p.ended_at) < to };
    }),
  };
}

const pct = (a, b) => b ? `${(a / b * 100).toFixed(1)}%` : '—';

// data: { day, dayStartHour, patrols, scans, incidents, sos, checkpointNames }
export function summarize(data) {
  const { patrols, scans, incidents, sos } = data;
  const ended = patrols.filter(p => p.status === 'ended');
  const done = patrols.reduce((a, p) => a + p.scan_count, 0), total = patrols.reduce((a, p) => a + p.point_count, 0);
  const missed = patrols.filter(p => p.ended_in_window !== false).reduce((a, p) => a + (p.missed?.length || 0), 0);
  return {
    patrols: patrols.length, ended: ended.length, active: patrols.length - ended.length,
    completion: pct(done, total), done, total, missed,
    abnormal: scans.filter(s => s.status === 'abnormal').length,
    flagged: scans.filter(s => s.flags?.length).length,
    pendingReview: scans.filter(s => s.review_status === 'pending').length,
    rejected: scans.filter(s => s.review_status === 'rejected').length,
    incidents: incidents.length, openIncidents: incidents.filter(i => i.status !== 'closed').length,
    sos: sos.length,
    guards: [...new Set(patrols.map(p => p.profile?.staff_no))].length,
  };
}

export function reportTables(data) {
  const { patrols, scans, incidents, sos, checkpointNames = {} } = data;
  const s = summarize(data);
  const w = dutyWindow(data.day, data.dayStartHour);
  const summary = [
    ['勤務日', `${data.day}（${fmtDT(w.from.toISOString())} 至 ${fmtDT(w.to.toISOString())}）`],
    ['報表產生時間', fmtDT(new Date().toISOString())],
    ['巡邏場次', `${s.patrols} 場（已結束 ${s.ended}、進行中 ${s.active}）`],
    ['出勤巡邏人數', `${s.guards} 人`],
    ['據點完成率', `${s.completion}（${s.done}/${s.total}）`],
    ['未巡據點', `${s.missed} 處`],
    ['異常件數', `${s.abnormal} 件`],
    ['防代巡註記', `${s.flagged} 筆（待覆核 ${s.pendingReview}、退回 ${s.rejected}）`],
    ['事件回報', `${s.incidents} 件（未結案 ${s.openIncidents}）`],
    ['SOS 求援', `${s.sos} 次`],
  ];
  const patrolT = {
    head: ['日期', '工號', '姓名', '班別', '路線', '開始', '結束', '完成據點', '應巡據點', '異常', '未巡據點與原因', '註記', '天候', '交接事項'],
    rows: patrols.map(p => {
      const tm = iso => p.cross_day ? fmtDT(iso) : fmtTime(iso);
      return [fmtDate(p.started_at), p.profile?.staff_no, p.profile?.name, p.shift, p.route_name, tm(p.started_at), p.ended_at ? tm(p.ended_at) : '進行中',
        p.scan_count, p.point_count, p.abnormal_count, p.ended_in_window === false ? '' : (p.missed || []).map(m => `${checkpointNames[m.checkpoint_id] || ''}：${m.reason}`).join('；'),
        [...(p.cross_day ? ['跨日巡邏（完成據點只計本日）'] : []), ...(p.flags || []).map(flagLabel)].join('、'), p.weather, p.handover_note];
    }),
  };
  const scanT = {
    head: ['時間', '工號', '姓名', '據點代碼', '據點名稱', '結果', '異常類別', '嚴重度', '說明', '距離(公尺)', '註記', '覆核', '覆核意見', '照片數'],
    rows: scans.map(x => [fmtDT(x.server_at), x.profile?.staff_no, x.profile?.name, x.checkpoint?.code, x.checkpoint?.name, x.status === 'abnormal' ? '異常' : '正常',
      x.category, x.severity, x.note, x.distance_m, (x.flags || []).map(flagLabel).join('、'), REVIEW_LABELS[x.review_status] || '', x.review_note, (x.photo_paths || []).length]),
  };
  const issueT = {
    head: ['時間', '來源', '地點／類型', '嚴重度', '說明', '回報人', '處理狀態'],
    rows: [
      ...scans.filter(x => x.status === 'abnormal').map(x => [x.server_at, '定點巡查', `${x.checkpoint?.code} ${x.checkpoint?.name}・${x.category}`, x.severity, x.note, x.profile?.name, '']),
      ...incidents.map(i => [i.created_at, '事件回報', i.type, i.severity, i.description, i.profile?.name, INCIDENT_STATUS[i.status] || i.status]),
      ...sos.map(x => [x.created_at, 'SOS', x.lat != null ? `${x.lat.toFixed(5)}, ${x.lng.toFixed(5)}` : '無定位', '緊急', '', x.profile?.name, x.acknowledged_at ? '已處理' : '未處理']),
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(r => [fmtDT(r[0]), ...r.slice(1)]),
  };
  return { summary, stats: s, patrolT, scanT, issueT };
}

// 產生 Excel：表頭粗體、細框線、無底色
export async function buildWorkbook(ExcelJS, data, orgName = '') {
  const t = reportTables(data);
  const wb = new ExcelJS.Workbook();
  wb.creator = '校園巡邏系統';
  const thin = { style: 'thin', color: { argb: 'FF999999' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const sheet = (name, head, rows, widths) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(head);
    rows.forEach(r => ws.addRow(r.map(v => v ?? '')));
    ws.getRow(1).font = { bold: true };
    ws.eachRow(row => row.eachCell({ includeEmpty: true }, c => { c.border = border; c.alignment = { vertical: 'top', wrapText: true }; }));
    ws.columns.forEach((c, i) => { c.width = widths?.[i] ?? 14; });
    return ws;
  };
  const ws = sheet('摘要', ['項目', '內容'], t.summary, [18, 70]);
  ws.insertRow(1, [`${orgName}校園巡查日報表　${data.day}`]);
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.getRow(1).getCell(1).border = {};
  ws.views = [{}];
  sheet('巡邏場次', t.patrolT.head, t.patrolT.rows, [11, 9, 12, 16, 18, 7, 7, 9, 9, 6, 30, 20, 7, 24]);
  sheet('異常與事件', t.issueT.head, t.issueT.rows, [17, 10, 28, 8, 36, 12, 10]);
  sheet('定點紀錄明細', t.scanT.head, t.scanT.rows, [17, 9, 12, 9, 16, 7, 12, 8, 30, 10, 20, 9, 24, 7]);
  return wb;
}

// 檔名使用英數字，避免部分瀏覽器與郵件軟體把中文檔名改成「download」
export const reportFileName = (day) => `patrol-daily-report_${day}.xlsx`;

// 電子郵件內文（摘要＋異常清單）
export function emailHtml(data, orgName = '') {
  const t = reportTables(data);
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const td = 'style="border:1px solid #999;padding:6px 10px;vertical-align:top"';
  const th = 'style="border:1px solid #999;padding:6px 10px;text-align:left;font-weight:bold"';
  const table = (head, rows) => `<table style="border-collapse:collapse;font-size:14px">${head ? `<tr>${head.map(h => `<th ${th}>${esc(h)}</th>`).join('')}</tr>` : ''}${rows.map(r => `<tr>${r.map(v => `<td ${td}>${esc(v)}</td>`).join('')}</tr>`).join('')}</table>`;
  const missed = t.patrolT.rows.filter(r => r[10]).map(r => [r[2], r[3], r[10]]);
  return `<div style="font-family:'Microsoft JhengHei','PingFang TC',sans-serif;color:#16222b">
    <h2 style="margin:0 0 12px">${esc(orgName)}校園巡查日報表　${esc(data.day)}</h2>
    ${table(null, t.summary)}
    <h3>異常與事件（${t.issueT.rows.length} 件）</h3>
    ${t.issueT.rows.length ? table(t.issueT.head, t.issueT.rows) : '<p>本勤務日無異常與事件。</p>'}
    ${missed.length ? `<h3>未巡據點</h3>${table(['姓名', '班別', '據點與原因'], missed)}` : ''}
    <p style="color:#5b6b70;font-size:13px">完整明細請見附件 Excel。待覆核紀錄請登入管理後台處理。本信由系統自動寄出。</p></div>`;
}
