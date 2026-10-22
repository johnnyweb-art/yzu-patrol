// 管理後台：班長（supervisor）與總務處管理者（admin）使用
import { CONFIG } from './config.js';
import { api, DEMO } from './api.js';
import { qrPayload } from './camera.js';
import { flagLabel, FLAG_LABELS } from './rules.js';
import { buildWorkbook, reportTables, reportFileName, targetReportDay, sendTimeLabel } from './report.js';
import { $, $$, esc, ymd, hm, hms, dt, toast, getPosition, mins, downloadText, downloadBlob, csvCell } from './util.js';

const P = {};
const S = { profile: null, page: 'dash', counts: {} };
let unsub = null;
const isAdmin = () => S.profile?.role === 'admin';
const today = () => ymd(new Date());
const daysAgo = n => ymd(new Date(Date.now() - n * 86400000));
const opts = (arr, sel) => arr.map(v => Array.isArray(v) ? `<option value="${esc(v[0])}"${v[0] === sel ? ' selected' : ''}>${esc(v[1])}</option>` : `<option${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');
const flagsHtml = f => (f || []).map(x => `<span class="chip warn">${esc(flagLabel(x))}</span>`).join(' ');
const statusChip = s => s === 'abnormal' ? '<span class="chip bad">異常</span>' : '<span class="chip ok">正常</span>';
const reviewChip = r => ({ pending: '<span class="chip warn">待覆核</span>', ok: '<span class="chip ok">已確認</span>', rejected: '<span class="chip bad">退回</span>' }[r] || '');
const incStatus = { open: '未處理', processing: '處理中', closed: '已結案' };
const roleName = { guard: '巡邏員', supervisor: '班長', admin: '管理者' };

// ---------- 對話框 ----------
const dlg = $('#dlg');
$('#dlg-x').onclick = () => dlg.close();
function openDialog(title, body) {
  $('#dlg-t').textContent = title;
  $('#dlg-b').innerHTML = body;
  $('#dlg-b').onclick = null;
  if (!dlg.open) dlg.showModal();
  return $('#dlg-b');
}

// ---------- 地圖 ----------
function makeMap(el, center) {
  const m = L.map(el).setView(center || [24.9702, 121.266], 17);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
  setTimeout(() => m.invalidateSize(), 150);
  return m;
}
const vest = getComputedStyle(document.documentElement).getPropertyValue('--vest').trim() || '#e8650c';

async function loadPhotos(root = document) {
  for (const el of $$('[data-photos]', root)) {
    const paths = JSON.parse(el.dataset.photos);
    el.removeAttribute('data-photos');
    for (const p of paths) {
      const url = await api.photoUrl(p);
      el.insertAdjacentHTML('beforeend', url ? `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="巡查照片"></a>` : '<span class="small">照片已刪除</span>');
    }
  }
}

// ---------- 版面 ----------
const NAV = [
  ['dash', '即時看板'], ['report', '每日巡查日報表'], ['patrols', '巡邏場次'], ['scans', '定點紀錄查詢'], ['incidents', '事件管理'], ['selfies', '身分確認'],
  ['stats', '統計分析'], ['checkpoints', '據點管理', true], ['routes', '路線管理', true], ['labels', 'QR 標籤列印', true], ['people', '人員與裝置'],
];
function shell() {
  $('#root').innerHTML = `<div class="admin">
    <nav class="side" aria-label="功能選單">
      <div class="brand">巡邏管理後台<div class="small">${esc(CONFIG.ORG_NAME)}${DEMO ? '・示範模式' : ''}</div></div>
      ${NAV.filter(n => !n[2] || isAdmin()).map(([k, t]) => `<button data-p="${k}" id="nav-${k}">${t}<span class="badge" hidden></span></button>`).join('')}
      <div class="foot">${esc(S.profile.name)}（${roleName[S.profile.role]}）<br>
        <a href="index.html">巡邏員畫面</a>・<a href="#" id="logout">登出</a></div>
    </nav>
    <main class="main" id="main"></main></div>`;
  $$('.side [data-p]').forEach(b => b.addEventListener('click', () => show(b.dataset.p)));
  $('#logout').onclick = async e => { e.preventDefault(); unsub?.(); await api.logout(); location.reload(); };
}
function badge(page, n) {
  const b = $(`#nav-${page} .badge`); if (!b) return;
  b.hidden = !n; b.textContent = n;
}
async function show(page) {
  S.page = page;
  $$('.side [data-p]').forEach(b => b.classList.toggle('on', b.dataset.p === page));
  const main = $('#main');
  main.innerHTML = '<p class="empty">載入中…</p>';
  try { await P[page](main); } catch (e) { main.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; }
}
async function refreshBadges() {
  try {
    const d = await api.dashboard();
    badge('dash', d.sos.length);
    badge('scans', d.pendingReview);
    badge('incidents', d.openIncidents.length);
    badge('people', d.pendingDevices + (d.pendingRegistrations || 0));
    badge('selfies', d.pendingSelfies);
    if (d.sos.length > S.counts.sos) { toast(`SOS 緊急求援：${d.sos[0].profile?.name || ''}`, 'bad'); navigator.vibrate?.(300); }
    S.counts.sos = d.sos.length;
    return d;
  } catch { return null; }
}

// ---------- 即時看板 ----------
P.dash = async main => {
  const d = await refreshBadges() || await api.dashboard();
  main.innerHTML = `<h1>即時看板</h1>
    ${d.sos.map(s => `<div class="sosbar"><div><b>SOS 緊急求援</b>：${esc(s.profile?.staff_no)} ${esc(s.profile?.name)}・${hms(s.created_at)}
      ${s.lat != null ? `・<a style="color:#fff" href="https://www.google.com/maps?q=${s.lat},${s.lng}" target="_blank" rel="noopener">位置 ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</a>` : '・無定位'}</div>
      <button class="btn sm" data-ack="${s.id}">已處理</button></div>`).join('')}
    <div class="kpis">
      <div class="kpi"><b>${d.active.length}</b><span>進行中巡邏</span></div>
      <div class="kpi"><b>${d.today.patrols}</b><span>今日巡邏場次</span></div>
      <div class="kpi"><b>${d.today.scans}</b><span>今日定點紀錄</span></div>
      <div class="kpi ${d.today.abnormal ? 'alert' : ''}"><b>${d.today.abnormal}</b><span>今日異常</span></div>
      <div class="kpi ${d.pendingReview ? 'alert' : ''}"><b>${d.pendingReview}</b><span>待覆核紀錄</span></div>
      <div class="kpi ${d.openIncidents.length ? 'alert' : ''}"><b>${d.openIncidents.length}</b><span>未結案事件</span></div>
    </div>
    <div class="grid2">
      <section class="stack"><h3>進行中巡邏</h3>
        ${d.active.length ? `<div class="tbl"><table><tr><th>人員</th><th>路線</th><th>進度</th><th>最後掃描</th></tr>
          ${d.active.map(p => `<tr class="click" data-patrol="${p.id}"><td>${esc(p.profile?.name)}<div class="small mono">${esc(p.profile?.staff_no)}</div></td>
            <td>${esc(p.route_name)}<div class="small">開始 ${hm(p.started_at)}・${mins(p.started_at, new Date())} 分鐘</div></td>
            <td class="mono">${p.scan_count}/${p.point_count}${p.abnormal_count ? ` <span class="chip bad">異常 ${p.abnormal_count}</span>` : ''}</td>
            <td class="mono">${p.last_scan_at ? hm(p.last_scan_at) + `<div class="small">${mins(p.last_scan_at, new Date())} 分鐘前</div>` : '—'}</td></tr>`).join('')}</table></div>`
          : '<p class="empty card">目前沒有進行中的巡邏。</p>'}
      </section>
      <section class="stack"><h3>未結案事件</h3>
        ${d.openIncidents.length ? `<div class="tbl"><table><tr><th>時間</th><th>類型</th><th>回報人</th><th>狀態</th></tr>
          ${d.openIncidents.slice(0, 8).map(i => `<tr class="click" data-inc="${i.id}"><td class="mono">${dt(i.created_at)}</td><td>${esc(i.type)}<div class="small">${esc(i.severity || '')}</div></td>
            <td>${esc(i.profile?.name)}</td><td>${incStatus[i.status]}</td></tr>`).join('')}</table></div>`
          : '<p class="empty card">沒有未結案事件。</p>'}
      </section>
    </div>
    ${d.pendingRegistrations ? `<div class="banner warn"><span>有 ${d.pendingRegistrations} 位巡邏員申請註冊，等待審核</span><button class="btn sm" id="go-reg">前往審核</button></div>` : ''}
    ${d.pendingDevices ? `<div class="banner warn"><span>有 ${d.pendingDevices} 支新手機等待核准</span><button class="btn sm" id="go-dev">前往處理</button></div>` : ''}`;
  $$('[data-ack]').forEach(b => b.onclick = async () => { await api.ackSOS(b.dataset.ack); S.counts.sos--; show('dash'); });
  $$('[data-patrol]').forEach(r => r.onclick = () => patrolDialog(r.dataset.patrol));
  $$('[data-inc]').forEach(r => r.onclick = () => show('incidents'));
  $('#go-dev')?.addEventListener('click', () => show('people'));
  $('#go-reg')?.addEventListener('click', () => show('people'));
};

// ---------- 每日巡查日報表 ----------
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  return new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'vendor/exceljs.min.js';
    sc.onload = () => res(window.ExcelJS);
    sc.onerror = () => rej(new Error('Excel 元件載入失敗，請檢查網路'));
    document.head.append(sc);
  });
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
P.report = async main => {
  const st = await api.getReportSettings();
  const hours = Array.from({ length: 24 }, (_, h) => [String(h), `${String(h).padStart(2, '0')}:00`]);
  const def = targetReportDay(st);
  const sh = String(st.day_start_hour).padStart(2, '0');
  const dis = isAdmin() ? '' : 'disabled';
  main.innerHTML = `<h1>每日巡查日報表</h1>
    <div class="small">${st.day_start_hour === 0 ? '報表以日曆日計算（00:00 至 23:59）。跨過午夜的巡邏會出現在兩天的報表中，每筆定點紀錄只計入發生當天。'
      : `報表以每日 ${sh}:00 為分界，例如「10/21」涵蓋 10/21 ${sh}:00 至 10/22 ${sh}:00。`}</div>
    <form class="filters" id="f"><label class="f">勤務日<input type="date" id="day" value="${def}" max="${today()}"></label>
      <button class="btn">預覽</button><button type="button" class="btn vest" id="xlsx">下載 Excel</button>
      <button type="button" class="btn ghost" id="send">立即寄送給收件人</button></form>
    <div id="out"></div>
    <section class="card stack"><h3>自動寄送設定</h3>
      ${DEMO ? '<div class="banner demo">示範模式沒有寄信伺服器，此處設定可儲存但不會實際寄出。正式上線後，系統每天依設定時間自動寄出 Excel 日報表。</div>' : ''}
      <form id="sf" class="stack">
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="s-en" ${st.enabled ? 'checked' : ''} ${dis}> 每天自動寄送日報表</label>
        <label class="f">收件人 Email（一行一位，例如隊長、總務處承辦人）<textarea id="s-to" rows="3" ${dis} placeholder="captain@example.com">${esc((st.recipients || []).join('\n'))}</textarea></label>
        <div class="row"><label class="f">每天寄送時間<input type="time" id="s-time" step="60" value="${sendTimeLabel(st)}" ${dis}></label>
          <label class="f">報表內容<select id="s-scope" ${dis}>${opts([['today', '寄送當天的紀錄'], ['previous', '前一天的紀錄']], st.report_scope)}</select></label>
          <label class="f">一天從幾點開始算<select id="s-start" ${dis}>${opts(hours, String(st.day_start_hour))}</select></label></div>
        <div class="small">建議組合：① 23:59 寄出當天（00:00 起算），當晚即可收到；② 07:00 寄出前一天（06:00 起算），夜班完整收在同一份報表。</div>
        ${isAdmin() ? '<button class="btn vest" style="align-self:flex-start">儲存設定</button>' : '<div class="small">僅管理者可修改設定。</div>'}
      </form></section>
    <section class="stack"><h3>寄送紀錄</h3><div id="runs"></div></section>`;
  let data = null;
  const preview = async () => {
    data = await api.reportData($('#day').value);
    const t = reportTables(data), s = t.stats;
    $('#out').innerHTML = `
      <div class="kpis"><div class="kpi"><b>${s.patrols}</b><span>巡邏場次</span></div><div class="kpi"><b>${s.completion}</b><span>據點完成率</span></div>
        <div class="kpi ${s.missed ? 'alert' : ''}"><b>${s.missed}</b><span>未巡據點</span></div><div class="kpi ${s.abnormal ? 'alert' : ''}"><b>${s.abnormal}</b><span>異常件數</span></div>
        <div class="kpi ${s.pendingReview ? 'alert' : ''}"><b>${s.pendingReview}</b><span>待覆核</span></div><div class="kpi ${s.sos ? 'alert' : ''}"><b>${s.sos}</b><span>SOS</span></div></div>
      <section class="stack"><h3>異常與事件</h3>${t.issueT.rows.length ? tbl(t.issueT.head, t.issueT.rows) : '<p class="empty card">本勤務日無異常與事件。</p>'}</section>
      <section class="stack"><h3>巡邏場次</h3>${t.patrolT.rows.length ? tbl(t.patrolT.head.slice(1, 12), t.patrolT.rows.map(r => r.slice(1, 12))) : '<p class="empty card">本勤務日沒有巡邏紀錄。</p>'}</section>
      <div class="small">Excel 另含「定點紀錄明細」工作表，共 ${t.scanT.rows.length} 筆。</div>`;
  };
  const tbl = (head, rows) => `<div class="tbl"><table><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</table></div>`;
  const runs = async () => {
    const rs = await api.listReportRuns();
    $('#runs').innerHTML = rs.length ? tbl(['寄送時間', '勤務日', '方式', '收件人', '結果'], rs.map(r => [dt(r.run_at), r.report_day, r.trigger === 'cron' ? '自動' : '手動',
      (r.recipients || []).join('、'), r.status === 'sent' ? '已寄出' : `失敗：${r.error || ''}`])) : '<p class="empty card">尚無寄送紀錄。</p>';
  };
  $('#f').onsubmit = e => { e.preventDefault(); preview().catch(err => toast(err.message, 'bad')); };
  $('#xlsx').onclick = async e => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = '產生中…';
    try {
      if (!data || data.day !== $('#day').value) await preview();
      const wb = await buildWorkbook(await loadExcelJS(), data, CONFIG.ORG_NAME);
      const blob = new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      downloadBlob(reportFileName(data.day), blob);
    } catch (err) { toast(err.message, 'bad'); }
    btn.disabled = false; btn.textContent = '下載 Excel';
  };
  $('#send').onclick = async e => {
    const btn = e.currentTarget; btn.disabled = true;
    try { const r = await api.sendReportNow($('#day').value); toast(`已寄出 ${r.day} 日報表給 ${r.recipients.join('、')}`); runs(); }
    catch (err) { toast(err.message, 'bad'); }
    btn.disabled = false;
  };
  $('#sf').onsubmit = async e => {
    e.preventDefault();
    if (!isAdmin()) return;
    const to = $('#s-to').value.split(/[\n,，;；\s]+/).map(x => x.trim()).filter(Boolean);
    const bad = to.filter(x => !EMAIL_RE.test(x));
    if (bad.length) return toast(`Email 格式不正確：${bad.join('、')}`, 'bad');
    if ($('#s-en').checked && !to.length) return toast('啟用自動寄送前，請至少填寫一位收件人', 'bad');
    try {
      const [hh, mm] = ($('#s-time').value || '23:59').split(':').map(Number);
      const scope = $('#s-scope').value, start = +$('#s-start').value;
      if (scope === 'previous' && hh * 60 + mm < start * 60) return toast('寄送「前一天」報表時，寄送時間需晚於一天的起算時間', 'bad');
      await api.saveReportSettings({ enabled: $('#s-en').checked, recipients: to, send_hour: hh, send_minute: mm, report_scope: scope, day_start_hour: start });
      toast('設定已儲存'); show('report');
    } catch (err) { toast(err.message, 'bad'); }
  };
  await Promise.all([preview(), runs()]);
};

// ---------- 巡邏場次 ----------
let people = [];
async function peopleOpts(sel) {
  if (!people.length) people = await api.listProfiles();
  return `<option value="">全部人員</option>${people.map(u => `<option value="${u.id}"${u.id === sel ? ' selected' : ''}>${esc(u.staff_no)} ${esc(u.name)}</option>`).join('')}`;
}
P.patrols = async main => {
  main.innerHTML = `<h1>巡邏場次</h1>
    <form class="filters" id="f"><label class="f">起日<input type="date" id="from" value="${daysAgo(7)}"></label>
      <label class="f">迄日<input type="date" id="to" value="${today()}"></label>
      <label class="f">人員<select id="user">${await peopleOpts()}</select></label>
      <button class="btn">查詢</button><button type="button" class="btn ghost" id="csv">匯出 CSV</button></form>
    <div id="out"></div>`;
  let rows = [];
  const run = async () => {
    rows = await api.listPatrols({ from: $('#from').value, to: $('#to').value, userId: $('#user').value });
    $('#out').innerHTML = rows.length ? `<div class="tbl"><table><tr><th>日期</th><th>人員</th><th>班別／路線</th><th>時間</th><th>完成</th><th>異常</th><th>未巡</th><th>註記</th></tr>
      ${rows.map(p => `<tr class="click" data-id="${p.id}"><td class="mono">${ymd(p.started_at)}</td><td>${esc(p.profile?.name)}<div class="small mono">${esc(p.profile?.staff_no)}</div></td>
        <td>${esc(p.shift || '')}<div class="small">${esc(p.route_name)}</div></td>
        <td class="mono">${hm(p.started_at)}–${p.ended_at ? hm(p.ended_at) : '<span class="chip vest">進行中</span>'}</td>
        <td class="mono">${p.scan_count}/${p.point_count}</td><td>${p.abnormal_count || ''}</td><td>${p.missed?.length || ''}</td>
        <td>${flagsHtml(p.flags)}${p.flagged_count ? ` <span class="chip warn">紀錄待覆核 ${p.flagged_count}</span>` : ''}${p.is_sample ? ' <span class="chip">示例</span>' : ''}</td></tr>`).join('')}</table></div>`
      : '<p class="empty card">查無資料。</p>';
    $$('#out [data-id]').forEach(r => r.onclick = () => patrolDialog(r.dataset.id));
  };
  $('#f').onsubmit = e => { e.preventDefault(); run().catch(err => toast(err.message, 'bad')); };
  $('#csv').onclick = () => {
    const head = ['日期', '工號', '姓名', '班別', '路線', '開始', '結束', '完成據點', '應巡據點', '異常數', '未巡據點與原因', '註記', '天候', '交接事項'];
    const body = rows.map(p => [ymd(p.started_at), p.profile?.staff_no, p.profile?.name, p.shift, p.route_name, dt(p.started_at), dt(p.ended_at), p.scan_count, p.point_count,
      p.abnormal_count, (p.missed || []).map(m => m.reason).join('；'), (p.flags || []).map(flagLabel).join('；'), p.weather, p.handover_note]);
    downloadText(`patrols_${$('#from').value}_${$('#to').value}.csv`, [head, ...body].map(r => r.map(csvCell).join(',')).join('\n'));
  };
  await run();
};

async function patrolDialog(id) {
  const body = openDialog('巡邏場次明細', '<p class="empty">載入中…</p>');
  const d = await api.patrolDetail(id);
  const p = d.patrol;
  const cpById = Object.fromEntries((d.route?.points || []).map(c => [c.id, c]));
  body.innerHTML = `
    <dl class="kv"><dt>人員</dt><dd>${esc(p.profile?.staff_no)} ${esc(p.profile?.name)}</dd><dt>路線</dt><dd>${esc(p.route_name)}・${esc(p.shift || '')}・${esc(p.weather || '')}</dd>
      <dt>時間</dt><dd class="mono">${dt(p.started_at)} – ${p.ended_at ? hm(p.ended_at) : '進行中'}</dd><dt>完成</dt><dd>${p.scan_count}/${p.point_count}</dd>
      <dt>生物辨識</dt><dd>${p.uv_ok ? '通過' : '<span class="chip warn">未通過</span>'}</dd>
      <dt>自拍確認</dt><dd>${{ ok: '已完成', missed: '<span class="chip warn">未完成</span>', none: '未要求' }[p.selfie_status] || esc(p.selfie_status)}</dd>
      ${p.handover_note || Object.keys(p.handover_items || {}).length ? `<dt>交接</dt><dd>${Object.entries(p.handover_items || {}).map(([k, v]) => `${esc(k)}${v ? '✓' : '✗'}`).join('　')}<br>${esc(p.handover_note || '')}</dd>` : ''}</dl>
    <div class="map" id="pmap"></div>
    <div class="small">橘色圓圈為據點範圍；綠點為正常、紅點為異常；虛線為巡邏軌跡（${d.track.length} 個定位點）。</div>
    <div class="tbl"><table><tr><th>時間</th><th>據點</th><th>結果</th><th>距離</th><th>註記</th><th>照片</th></tr>
      ${d.scans.map(s => `<tr><td class="mono">${hms(s.server_at)}</td><td>${esc(s.checkpoint?.code)} ${esc(s.checkpoint?.name)}</td>
        <td>${statusChip(s.status)}${s.status === 'abnormal' ? `<div class="small">${esc(s.category)}・${esc(s.severity)}</div>` : ''}${s.note ? `<div class="small">${esc(s.note)}</div>` : ''}</td>
        <td class="mono">${s.distance_m ?? '—'}${s.accuracy != null ? `<div class="small">±${Math.round(s.accuracy)}</div>` : ''}</td>
        <td>${flagsHtml(s.flags)} ${reviewChip(s.review_status)}</td><td><div class="photo-grid" data-photos="${esc(JSON.stringify(s.photo_paths || []))}"></div></td></tr>`).join('')}</table></div>
    ${p.missed?.length ? `<div class="card"><b>未巡據點</b>${p.missed.map(m => `<div>${esc(cpById[m.checkpoint_id]?.name || m.checkpoint_id)}：${esc(m.reason)}</div>`).join('')}</div>` : ''}
    ${d.selfies.length ? `<div class="card stack"><b>身分確認自拍</b><div class="photo-grid" data-photos="${esc(JSON.stringify(d.selfies.map(s => s.photo_path).filter(Boolean)))}"></div></div>` : ''}
    ${d.incidents.length ? `<div class="card"><b>本場事件</b>${d.incidents.map(i => `<div>${hm(i.created_at)} ${esc(i.type)}：${esc(i.description)}</div>`).join('')}</div>` : ''}`;
  const pts = d.route?.points || [];
  const first = pts.find(c => c.lat != null);
  const m = makeMap($('#pmap'), first ? [first.lat, first.lng] : null);
  const bounds = [];
  pts.forEach(c => { if (c.lat == null) return; L.circle([c.lat, c.lng], { radius: c.radius_m, color: vest, weight: 2, fillOpacity: .08 }).addTo(m).bindTooltip(`${c.code} ${c.name}`); bounds.push([c.lat, c.lng]); });
  if (d.track.length) L.polyline(d.track.map(t => [t.lat, t.lng]), { color: '#2b6cb0', weight: 3, dashArray: '6 6' }).addTo(m);
  d.scans.forEach(s => { if (s.lat == null) return; L.circleMarker([s.lat, s.lng], { radius: 7, color: '#fff', weight: 2, fillColor: s.status === 'abnormal' ? '#c0392b' : '#1f7a4d', fillOpacity: 1 }).addTo(m).bindTooltip(`${hm(s.server_at)} ${s.checkpoint?.name || ''}`); bounds.push([s.lat, s.lng]); });
  if (bounds.length > 1) setTimeout(() => m.fitBounds(bounds, { padding: [30, 30] }), 200);
  loadPhotos(body);
}

// ---------- 定點紀錄查詢與覆核 ----------
P.scans = async main => {
  const cps = await api.adminCheckpoints();
  main.innerHTML = `<h1>定點紀錄查詢</h1>
    <form class="filters" id="f">
      <label class="f">起日<input type="date" id="from" value="${daysAgo(7)}"></label><label class="f">迄日<input type="date" id="to" value="${today()}"></label>
      <label class="f">人員<select id="user">${await peopleOpts()}</select></label>
      <label class="f">據點<select id="cp"><option value="">全部據點</option>${cps.map(c => `<option value="${c.id}">${esc(c.code)} ${esc(c.name)}</option>`).join('')}</select></label>
      <label class="f">結果<select id="st">${opts([['', '全部'], ['normal', '正常'], ['abnormal', '異常']])}</select></label>
      <label class="f">覆核<select id="rv">${opts([['', '全部'], ['pending', '待覆核'], ['ok', '已確認'], ['rejected', '退回']])}</select></label>
      <button class="btn">查詢</button><button type="button" class="btn ghost" id="csv">匯出 CSV</button></form>
    <div class="small">註記說明：${Object.values(FLAG_LABELS).slice(0, 8).join('、')}。有註記的紀錄需由主管覆核。</div>
    <div id="out"></div>`;
  let rows = [];
  const run = async () => {
    rows = await api.queryScans({ from: $('#from').value, to: $('#to').value, userId: $('#user').value, checkpointId: $('#cp').value, status: $('#st').value, review: $('#rv').value });
    $('#out').innerHTML = rows.length ? `<div class="small">共 ${rows.length} 筆</div><div class="tbl"><table><tr><th>時間</th><th>人員</th><th>據點</th><th>結果</th><th>距離</th><th>註記／覆核</th></tr>
      ${rows.map(s => `<tr class="click" data-id="${s.id}"><td class="mono">${dt(s.server_at)}</td><td>${esc(s.profile?.name)}</td><td>${esc(s.checkpoint?.code)} ${esc(s.checkpoint?.name)}</td>
        <td>${statusChip(s.status)}${s.category ? `<div class="small">${esc(s.category)}</div>` : ''}</td><td class="mono">${s.distance_m ?? '—'}</td>
        <td>${flagsHtml(s.flags)} ${reviewChip(s.review_status)}</td></tr>`).join('')}</table></div>` : '<p class="empty card">查無資料。</p>';
    $$('#out [data-id]').forEach(r => r.onclick = () => scanDialog(rows.find(s => s.id === r.dataset.id), run));
  };
  $('#f').onsubmit = e => { e.preventDefault(); run().catch(err => toast(err.message, 'bad')); };
  $('#csv').onclick = () => {
    const head = ['伺服器時間', '手機時間', '工號', '姓名', '據點代碼', '據點名稱', '結果', '異常類別', '嚴重度', '說明', '距離(公尺)', '定位誤差(公尺)', '註記', '覆核', '覆核意見', '照片數', '照片雜湊值'];
    const body = rows.map(s => [dt(s.server_at) + ':' + String(new Date(s.server_at).getSeconds()).padStart(2, '0'), s.device_at ? hms(s.device_at) : '', s.profile?.staff_no, s.profile?.name,
      s.checkpoint?.code, s.checkpoint?.name, s.status === 'abnormal' ? '異常' : '正常', s.category, s.severity, s.note, s.distance_m, s.accuracy != null ? Math.round(s.accuracy) : '',
      (s.flags || []).map(flagLabel).join('；'), { pending: '待覆核', ok: '已確認', rejected: '退回' }[s.review_status] || '', s.review_note, (s.photo_paths || []).length, (s.photo_hashes || []).join(' ')]);
    downloadText(`checkpoint-records_${$('#from').value}_${$('#to').value}.csv`, [head, ...body].map(r => r.map(csvCell).join(',')).join('\n'));
  };
  await run();
};

function scanDialog(s, after) {
  const body = openDialog(`${s.checkpoint?.code} ${s.checkpoint?.name}`, `
    <dl class="kv"><dt>人員</dt><dd>${esc(s.profile?.staff_no)} ${esc(s.profile?.name)}</dd>
      <dt>伺服器時間</dt><dd class="mono">${ymd(s.server_at)} ${hms(s.server_at)}</dd><dt>手機時間</dt><dd class="mono">${s.device_at ? hms(s.device_at) : '—'}</dd>
      <dt>位置</dt><dd>${s.lat != null ? `${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}・距離 ${s.distance_m ?? '—'} 公尺・誤差 ±${Math.round(s.accuracy ?? 0)} 公尺` : '無定位'}</dd>
      <dt>結果</dt><dd>${statusChip(s.status)} ${esc(s.category || '')} ${esc(s.severity || '')}</dd>
      <dt>說明</dt><dd>${esc(s.note || '—')}</dd>
      <dt>檢查項目</dt><dd>${Object.entries(s.checklist || {}).map(([k, v]) => `${esc(k)} ${v ? '✓' : '<b style="color:var(--bad)">✗</b>'}`).join('　') || '—'}</dd>
      <dt>註記</dt><dd>${flagsHtml(s.flags) || '無'}</dd>
      <dt>照片雜湊</dt><dd class="mono small">${(s.photo_hashes || []).map(h => esc(h.slice(0, 16)) + '…').join('<br>') || '—'}</dd></dl>
    <div class="photo-grid" data-photos="${esc(JSON.stringify(s.photo_paths || []))}"></div>
    ${s.photos_purged_at ? `<div class="small">照片已於 ${dt(s.photos_purged_at)} 依保存期限刪除。</div>` : ''}
    <section class="card stack"><b>主管覆核</b> ${reviewChip(s.review_status)}
      <label class="f">覆核意見<textarea id="rnote" rows="2">${esc(s.review_note || '')}</textarea></label>
      <div class="row"><button class="btn" id="ok">確認無誤</button><button class="btn bad" id="rej">退回／疑似代巡</button></div></section>`);
  const save = async st => { await api.reviewScan(s.id, { review_status: st, review_note: $('#rnote').value.trim() }); toast('已儲存覆核結果'); dlg.close(); after?.(); refreshBadges(); };
  $('#ok').onclick = () => save('ok').catch(e => toast(e.message, 'bad'));
  $('#rej').onclick = () => { if (!$('#rnote').value.trim()) return toast('退回時請填寫覆核意見', 'bad'); save('rejected').catch(e => toast(e.message, 'bad')); };
  loadPhotos(body);
}

// ---------- 事件管理 ----------
P.incidents = async main => {
  main.innerHTML = `<h1>事件管理</h1>
    <form class="filters" id="f"><label class="f">狀態<select id="st">${opts([['', '全部'], ['open', '未處理'], ['processing', '處理中'], ['closed', '已結案']], 'open')}</select></label>
      <label class="f">起日<input type="date" id="from" value="${daysAgo(30)}"></label><label class="f">迄日<input type="date" id="to" value="${today()}"></label>
      <button class="btn">查詢</button></form><div id="out"></div>`;
  const run = async () => {
    const rows = await api.listIncidents({ status: $('#st').value, from: $('#from').value, to: $('#to').value });
    $('#out').innerHTML = rows.length ? `<div class="tbl"><table><tr><th>時間</th><th>類型</th><th>描述</th><th>回報人</th><th>狀態</th></tr>
      ${rows.map(i => `<tr class="click" data-id="${i.id}"><td class="mono">${dt(i.created_at)}</td><td>${esc(i.type)}<div class="small">${esc(i.severity || '')}・${esc(i.handling || '')}</div></td>
        <td>${esc(i.description)}</td><td>${esc(i.profile?.name)}</td><td>${incStatus[i.status]}${i.is_sample ? ' <span class="chip">示例</span>' : ''}</td></tr>`).join('')}</table></div>`
      : '<p class="empty card">查無事件。</p>';
    $$('#out [data-id]').forEach(r => r.onclick = () => {
      const i = rows.find(x => x.id === r.dataset.id);
      const body = openDialog(`事件：${i.type}`, `
        <dl class="kv"><dt>時間</dt><dd class="mono">${dt(i.created_at)}</dd><dt>回報人</dt><dd>${esc(i.profile?.staff_no)} ${esc(i.profile?.name)}</dd>
          <dt>嚴重度</dt><dd>${esc(i.severity || '')}</dd><dt>處置</dt><dd>${esc(i.handling || '')}</dd><dt>描述</dt><dd>${esc(i.description)}</dd>
          <dt>位置</dt><dd>${i.lat != null ? `<a href="https://www.google.com/maps?q=${i.lat},${i.lng}" target="_blank" rel="noopener">${i.lat.toFixed(5)}, ${i.lng.toFixed(5)}</a>` : '—'}</dd></dl>
        <div class="photo-grid" data-photos="${esc(JSON.stringify(i.photo_paths || []))}"></div>
        <label class="f">處理狀態<select id="ist">${opts([['open', '未處理'], ['processing', '處理中'], ['closed', '已結案']], i.status)}</select></label>
        <label class="f">處理說明<textarea id="ires" rows="3">${esc(i.resolution || '')}</textarea></label>
        <button class="btn vest" id="isave">儲存</button>`);
      loadPhotos(body);
      $('#isave').onclick = async () => {
        if ($('#ist').value === 'closed' && !$('#ires').value.trim()) return toast('結案前請填寫處理說明', 'bad');
        await api.updateIncident(i.id, { status: $('#ist').value, resolution: $('#ires').value.trim() });
        toast('已更新'); dlg.close(); run(); refreshBadges();
      };
    });
  };
  $('#f').onsubmit = e => { e.preventDefault(); run(); };
  await run();
};

// ---------- 身分確認 ----------
P.selfies = async main => {
  const rows = await api.listSelfies({});
  main.innerHTML = `<h1>身分確認自拍</h1>
    <div class="small">巡邏中系統隨機要求巡邏員自拍。請比對是否為登入者本人；不符者請標記「不符」，並查閱該場次紀錄。</div>
    ${rows.length ? `<div class="grid2">${rows.map(s => `<div class="card stack">
      <div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(s.profile?.staff_no)} ${esc(s.profile?.name)}</b>
        ${{ pending: '<span class="chip warn">待確認</span>', ok: '<span class="chip ok">本人</span>', fail: '<span class="chip bad">不符</span>' }[s.result]}</div>
      <div class="small mono">${dt(s.taken_at)}（要求於 ${hm(s.requested_at)}）</div>
      <div class="photo-grid" data-photos="${esc(JSON.stringify(s.photo_path ? [s.photo_path] : []))}"></div>
      <div class="row"><button class="btn sm" data-ok="${s.id}">本人</button><button class="btn sm bad" data-fail="${s.id}">不符</button>
        <button class="btn sm ghost" data-pt="${s.patrol_id}">查看場次</button></div></div>`).join('')}</div>`
      : '<p class="empty card">尚無自拍紀錄。巡邏員完成巡邏中的身分確認後會出現在這裡。</p>'}`;
  loadPhotos(main);
  $$('[data-ok]').forEach(b => b.onclick = async () => { await api.reviewSelfie(b.dataset.ok, 'ok'); show('selfies'); refreshBadges(); });
  $$('[data-fail]').forEach(b => b.onclick = async () => { await api.reviewSelfie(b.dataset.fail, 'fail'); show('selfies'); refreshBadges(); });
  $$('[data-pt]').forEach(b => b.onclick = () => patrolDialog(b.dataset.pt));
};

// ---------- 統計 ----------
P.stats = async main => {
  main.innerHTML = `<h1>統計分析</h1>
    <form class="filters" id="f"><label class="f">起日<input type="date" id="from" value="${daysAgo(30)}"></label>
      <label class="f">迄日<input type="date" id="to" value="${today()}"></label><button class="btn">更新</button></form><div id="out"></div>`;
  const bars = (pairs, unit = '') => {
    const max = Math.max(1, ...pairs.map(p => p[1]));
    return pairs.length ? pairs.map(([k, v]) => `<div class="bar"><span title="${esc(k)}">${esc(k)}</span><i style="width:${v / max * 70}%"></i><b class="mono">${v}${unit}</b></div>`).join('') : '<p class="empty">無資料</p>';
  };
  const run = async () => {
    const [scans, patrols] = await Promise.all([api.queryScans({ from: $('#from').value, to: $('#to').value }), api.listPatrols({ from: $('#from').value, to: $('#to').value })]);
    const count = (arr, key) => Object.entries(arr.reduce((m, x) => { const k = key(x); if (k) m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
    const abn = scans.filter(s => s.status === 'abnormal');
    const ended = patrols.filter(p => p.status === 'ended');
    const rate = ended.length ? (ended.reduce((a, p) => a + (p.point_count ? p.scan_count / p.point_count : 0), 0) / ended.length * 100).toFixed(1) : '—';
    const byGuard = Object.values(patrols.reduce((m, p) => {
      const k = p.profile?.staff_no || '?';
      m[k] ??= { name: `${k} ${p.profile?.name || ''}`, n: 0, done: 0, total: 0, flagged: 0 };
      m[k].n++; m[k].done += p.scan_count; m[k].total += p.point_count; m[k].flagged += p.flagged_count + (p.flags?.length ? 1 : 0);
      return m;
    }, {}));
    const hours = Array.from({ length: 24 }, (_, h) => [`${String(h).padStart(2, '0')} 時`, abn.filter(s => new Date(s.server_at).getHours() === h).length]).filter(x => x[1]);
    $('#out').innerHTML = `
      <div class="kpis"><div class="kpi"><b>${patrols.length}</b><span>巡邏場次</span></div><div class="kpi"><b>${scans.length}</b><span>定點紀錄</span></div>
        <div class="kpi"><b>${abn.length}</b><span>異常件數</span></div><div class="kpi"><b>${rate}${rate === '—' ? '' : '%'}</b><span>平均據點完成率</span></div>
        <div class="kpi"><b>${scans.filter(s => s.flags?.length).length}</b><span>有註記紀錄</span></div></div>
      <div class="grid2">
        <section class="card stack"><b>異常熱點（依據點）</b>${bars(count(abn, s => `${s.checkpoint?.code} ${s.checkpoint?.name}`))}</section>
        <section class="card stack"><b>異常類別</b>${bars(count(abn, s => s.category))}</section>
        <section class="card stack"><b>異常發生時段</b>${bars(hours)}</section>
        <section class="card stack"><b>防代巡註記分布</b>${bars(count(scans.flatMap(s => s.flags || []), f => flagLabel(f)))}</section>
      </div>
      <section class="stack"><h3>人員巡邏概況</h3><div class="tbl"><table><tr><th>人員</th><th>場次</th><th>據點完成率</th><th>註記數</th></tr>
        ${byGuard.map(g => `<tr><td>${esc(g.name)}</td><td class="mono">${g.n}</td><td class="mono">${g.total ? (g.done / g.total * 100).toFixed(1) + '%' : '—'}</td><td class="mono">${g.flagged}</td></tr>`).join('')}</table></div></section>`;
  };
  $('#f').onsubmit = e => { e.preventDefault(); run(); };
  await run();
};

// ---------- 據點管理 ----------
P.checkpoints = async main => {
  const cps = await api.adminCheckpoints();
  main.innerHTML = `<h1>據點管理</h1>
    <div class="row" style="flex:none"><button class="btn vest" id="add" style="flex:none">新增據點</button></div>
    <div class="map" id="cmap"></div>
    <div class="tbl"><table><tr><th>代碼</th><th>名稱</th><th>類型</th><th>範圍</th><th>圍欄</th><th>檢查項目</th><th>狀態</th></tr>
      ${cps.map(c => `<tr class="click" data-id="${c.id}"><td class="mono">${esc(c.code)}</td><td>${esc(c.name)}</td><td>${esc(c.type)}</td>
        <td class="mono">${c.radius_m} 公尺</td><td>${c.enforce_fence ? '強制' : '僅註記'}</td><td>${(c.checklist || []).length} 項</td>
        <td>${c.active ? '<span class="chip ok">啟用</span>' : '<span class="chip">停用</span>'}</td></tr>`).join('')}</table></div>
    <div class="small">「強制」：位置不在範圍內時無法完成掃描。「僅註記」：適用於地下室、機房等 GPS 訊號差的室內點，位置不符時只標記，由主管覆核。</div>`;
  const m = makeMap($('#cmap'));
  const b = [];
  cps.filter(c => c.lat != null).forEach(c => { L.circle([c.lat, c.lng], { radius: c.radius_m, color: vest, weight: 2, fillOpacity: .1 }).addTo(m).bindTooltip(`${c.code} ${c.name}`, { permanent: true, direction: 'top' }); b.push([c.lat, c.lng]); });
  if (b.length > 1) setTimeout(() => m.fitBounds(b, { padding: [40, 40] }), 200);
  $('#add').onclick = () => cpDialog({ code: '', name: '', type: '門禁', lat: null, lng: null, radius_m: 30, enforce_fence: true, checklist: [], min_photos: 1, active: true, note: '' });
  $$('[data-id]', main).forEach(r => r.onclick = () => cpDialog(cps.find(c => c.id === r.dataset.id)));
};

function cpDialog(c) {
  openDialog(c.id ? `編輯據點 ${c.code}` : '新增據點', `
    <form id="cf" class="stack">
      <div class="row"><label class="f">據點代碼<input id="c-code" value="${esc(c.code)}" required placeholder="例：P07"></label>
        <label class="f">名稱<input id="c-name" value="${esc(c.name)}" required></label>
        <label class="f">類型<input id="c-type" value="${esc(c.type)}" list="types"></label></div>
      <datalist id="types"><option>門禁</option><option>戶外</option><option>宿舍</option><option>停車場</option><option>機電</option><option>實驗室</option></datalist>
      <div class="row"><label class="f">緯度<input id="c-lat" type="number" step="0.000001" value="${c.lat ?? ''}"></label>
        <label class="f">經度<input id="c-lng" type="number" step="0.000001" value="${c.lng ?? ''}"></label>
        <label class="f">範圍半徑（公尺）<input id="c-rad" type="number" min="5" max="500" value="${c.radius_m}"></label></div>
      <div class="small">在地圖上點選位置即可設定座標；也可帶手機到現場按「使用我目前的位置」。</div>
      <div class="map" id="emap" style="height:300px"></div>
      <button type="button" class="btn ghost" id="here">使用我目前的位置</button>
      <div class="row"><label class="f">位置驗證<select id="c-fence">${opts([['1', '強制（不在範圍內不得完成）'], ['0', '僅註記（室內點）']], c.enforce_fence ? '1' : '0')}</select></label>
        <label class="f">最少照片數<select id="c-ph">${opts([['0', '0'], ['1', '1'], ['2', '2'], ['3', '3']], String(c.min_photos))}</select></label>
        <label class="f">狀態<select id="c-act">${opts([['1', '啟用'], ['0', '停用']], c.active ? '1' : '0')}</select></label></div>
      <label class="f">檢查項目（一行一項）<textarea id="c-chk" rows="4">${esc((c.checklist || []).join('\n'))}</textarea></label>
      <label class="f">備註<input id="c-note" value="${esc(c.note || '')}"></label>
      <div class="row"><button class="btn vest">儲存</button>${c.id ? '<button type="button" class="btn ghost" id="rot">更換 QR 金鑰</button>' : ''}</div>
      ${c.id ? '<div class="small">更換 QR 金鑰後，舊的 QR 標籤立即失效，需重新列印並張貼。建議每學期更換一次，或發現標籤被翻拍時立即更換。</div>' : ''}
    </form>`);
  const m = makeMap($('#emap'), c.lat != null ? [c.lat, c.lng] : null);
  let mk = null, circ = null;
  const place = () => {
    const lat = parseFloat($('#c-lat').value), lng = parseFloat($('#c-lng').value), r = parseInt($('#c-rad').value) || 30;
    if (isNaN(lat) || isNaN(lng)) return;
    mk ? mk.setLatLng([lat, lng]) : (mk = L.marker([lat, lng]).addTo(m));
    circ ? circ.setLatLng([lat, lng]).setRadius(r) : (circ = L.circle([lat, lng], { radius: r, color: vest }).addTo(m));
  };
  place();
  m.on('click', e => { $('#c-lat').value = e.latlng.lat.toFixed(6); $('#c-lng').value = e.latlng.lng.toFixed(6); place(); });
  ['#c-lat', '#c-lng', '#c-rad'].forEach(s => $(s).addEventListener('input', place));
  $('#here').onclick = async () => {
    const p = await getPosition({ timeout: 15000 });
    if (!p) return toast('無法取得定位，請允許瀏覽器使用位置', 'bad');
    $('#c-lat').value = p.lat.toFixed(6); $('#c-lng').value = p.lng.toFixed(6); place(); m.setView([p.lat, p.lng], 18);
    toast(`已取得目前位置（誤差 ±${p.acc} 公尺）`);
  };
  $('#rot')?.addEventListener('click', async e => {
    if (e.currentTarget.dataset.armed !== '1') { e.currentTarget.dataset.armed = '1'; e.currentTarget.textContent = '再按一次確認更換'; return; }
    await api.rotateToken(c.id); toast('已更換金鑰，請重新列印此據點的 QR 標籤'); dlg.close(); show('checkpoints');
  });
  $('#cf').onsubmit = async e => {
    e.preventDefault();
    const num = s => { const v = parseFloat($(s).value); return isNaN(v) ? null : v; };
    const cp = { id: c.id, code: $('#c-code').value.trim().toUpperCase(), name: $('#c-name').value.trim(), type: $('#c-type').value.trim() || '一般',
      lat: num('#c-lat'), lng: num('#c-lng'), radius_m: parseInt($('#c-rad').value) || 30, enforce_fence: $('#c-fence').value === '1',
      min_photos: +$('#c-ph').value, active: $('#c-act').value === '1', note: $('#c-note').value.trim(),
      checklist: $('#c-chk').value.split('\n').map(x => x.trim()).filter(Boolean) };
    if (!cp.code || !cp.name) return toast('請填寫代碼與名稱', 'bad');
    if (cp.enforce_fence && cp.lat == null) return toast('強制位置驗證的據點必須設定座標', 'bad');
    try { await api.saveCheckpoint(cp); toast('已儲存'); dlg.close(); show('checkpoints'); } catch (err) { toast(err.message, 'bad'); }
  };
}

// ---------- 路線管理 ----------
P.routes = async main => {
  const [routes, cps] = await Promise.all([api.adminRoutes(), api.adminCheckpoints()]);
  main.innerHTML = `<h1>路線管理</h1>
    <div class="row" style="flex:none"><button class="btn vest" id="add" style="flex:none">新增路線</button></div>
    <div class="tbl"><table><tr><th>路線</th><th>方式</th><th>據點</th><th>狀態</th></tr>
      ${routes.map(r => `<tr class="click" data-id="${r.id}"><td>${esc(r.name)}</td><td>${r.mode === 'ordered' ? '依序' : '不限順序'}</td>
        <td>${r.points.map(p => esc(p.code)).join(' → ')}</td><td>${r.active ? '<span class="chip ok">啟用</span>' : '<span class="chip">停用</span>'}</td></tr>`).join('')}</table></div>`;
  const edit = r => {
    let ids = [...(r.point_ids || r.points.map(p => p.id))];
    openDialog(r.id ? '編輯路線' : '新增路線', `<form id="rf" class="stack">
      <div class="row"><label class="f">路線名稱<input id="r-name" value="${esc(r.name)}" required></label>
        <label class="f">巡邏方式<select id="r-mode">${opts([['free', '不限順序'], ['ordered', '依序巡邏（未依序會註記）']], r.mode)}</select></label>
        <label class="f">狀態<select id="r-act">${opts([['1', '啟用'], ['0', '停用']], r.active ? '1' : '0')}</select></label></div>
      <div class="grid2"><section class="stack"><b>路線據點（依巡邏順序）</b><div id="r-list" class="pts"></div></section>
        <section class="stack"><b>可加入的據點</b><div id="r-pool" class="pts"></div></section></div>
      <button class="btn vest">儲存</button></form>`);
    const draw = () => {
      $('#r-list').innerHTML = ids.map((id, i) => { const c = cps.find(x => x.id === id); return `<div class="pt"><span><b class="mono">${i + 1}.</b> ${esc(c?.code)} ${esc(c?.name)}</span>
        <span class="row" style="flex:none;gap:4px"><button type="button" class="btn ghost sm" data-up="${i}" aria-label="上移">↑</button><button type="button" class="btn ghost sm" data-dn="${i}" aria-label="下移">↓</button>
        <button type="button" class="btn ghost sm" data-rm="${i}">移除</button></span></div>`; }).join('') || '<p class="empty">尚未加入據點</p>';
      $('#r-pool').innerHTML = cps.filter(c => c.active && !ids.includes(c.id)).map(c => `<div class="pt"><span>${esc(c.code)} ${esc(c.name)}</span><button type="button" class="btn sm" data-add="${c.id}">加入</button></div>`).join('') || '<p class="empty">全部據點已加入</p>';
    };
    $('#dlg-b').onclick = e => {
      const d = e.target.dataset;
      if (d.add) ids.push(d.add);
      else if (d.rm != null) ids.splice(+d.rm, 1);
      else if (d.up != null && +d.up > 0) [ids[+d.up - 1], ids[+d.up]] = [ids[+d.up], ids[+d.up - 1]];
      else if (d.dn != null && +d.dn < ids.length - 1) [ids[+d.dn + 1], ids[+d.dn]] = [ids[+d.dn], ids[+d.dn + 1]];
      else return;
      draw();
    };
    draw();
    $('#rf').onsubmit = async e => {
      e.preventDefault();
      if (!ids.length) return toast('請至少加入一個據點', 'bad');
      try { await api.saveRoute({ id: r.id, name: $('#r-name').value.trim(), mode: $('#r-mode').value, active: $('#r-act').value === '1', pointIds: ids }); toast('已儲存'); dlg.close(); $('#dlg-b').onclick = null; show('routes'); }
      catch (err) { toast(err.message, 'bad'); }
    };
  };
  $('#add').onclick = () => edit({ name: '', mode: 'free', active: true, points: [] });
  $$('[data-id]', main).forEach(tr => tr.onclick = () => edit(routes.find(r => r.id === tr.dataset.id)));
};

// ---------- QR 標籤列印 ----------
P.labels = async main => {
  const cps = (await api.adminCheckpoints()).filter(c => c.active);
  main.innerHTML = `<h1>QR 標籤列印</h1>
    <div class="small">勾選要列印的據點後按「列印」。建議使用防水貼紙或護貝，張貼於據點固定位置。標籤內含金鑰，請勿外流；若懷疑被翻拍，請到「據點管理」更換金鑰後重印。</div>
    <div class="row" style="flex:none;gap:12px"><label style="display:flex;gap:6px;align-items:center;flex:none"><input type="checkbox" id="all" checked> 全選</label>
      <button class="btn vest" id="print" style="flex:none">列印</button></div>
    <div id="print-area"><div class="labels">${cps.map(c => {
      const qr = qrcode(0, 'M'); qr.addData(qrPayload(c.code, c.qr_token)); qr.make();
      return `<label class="label" data-c="${c.id}"><input type="checkbox" checked class="pick" style="float:left" aria-label="選取 ${esc(c.code)}">
        <div class="lo">${esc(CONFIG.ORG_NAME)}・校園巡邏點</div>${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}
        <div class="lc">${esc(c.code)}</div><div class="ln">${esc(c.name)}</div><div class="lo">請勿撕除・損壞請通報總務處</div></label>`;
    }).join('')}</div></div>`;
  const sync = () => $$('.label').forEach(l => { l.style.display = $('.pick', l).checked ? '' : 'none'; });
  $('#all').onchange = e => { $$('.pick').forEach(p => (p.checked = e.target.checked)); };
  $('#print').onclick = () => {
    sync(); $$('.pick').forEach(p => (p.style.display = 'none'));
    window.print();
    setTimeout(() => { $$('.label').forEach(l => (l.style.display = '')); $$('.pick').forEach(p => (p.style.display = '')); }, 500);
  };
};

// ---------- 人員與裝置 ----------
P.people = async main => {
  const [users, devs, regs] = await Promise.all([api.listProfiles(), api.listDevices(), api.listRegistrations({ status: 'pending' })]);
  people = users;
  const pend = devs.filter(d => d.status === 'pending');
  main.innerHTML = `<h1>人員與裝置</h1>
    ${regs.length ? `<section class="stack"><h3>待審核註冊申請</h3><div class="tbl"><table><tr><th>工號</th><th>姓名</th><th>類型</th><th>所屬／手機號碼</th><th>裝置</th><th>申請時間</th><th></th></tr>
      ${regs.map(r => `<tr><td class="mono">${esc(r.staff_no)}</td><td>${esc(r.name)}</td>
        <td>${r.kind === 'rebind' ? '<span class="chip warn">既有人員重新綁定</span>' : '<span class="chip vest">新人員</span>'}</td>
        <td>${esc(r.org || '—')}<div class="small mono">${esc(r.phone || '')}</div></td><td>${esc(r.device_label || '')}<div class="small mono">${esc(String(r.device_id).slice(0, 8))}</div></td>
        <td class="mono">${dt(r.created_at)}</td><td><div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-reg="${r.id}">核准</button>
        <button class="btn sm ghost" data-rej="${r.id}">退回</button></div></td></tr>`).join('')}</table></div>
      <div class="small">請確認工號、姓名與本人相符後再核准。核准後，該人員只能用這支手機掃臉登入；「重新綁定」會讓他原本的手機失效。</div></section>` : ''}
    ${pend.length ? `<section class="stack"><h3>待核准手機</h3><div class="tbl"><table><tr><th>人員</th><th>裝置</th><th>申請時間</th><th></th></tr>
      ${pend.map(d => `<tr><td>${esc(d.profile?.staff_no)} ${esc(d.profile?.name)}</td><td>${esc(d.label)}<div class="small mono">${esc(d.device_id.slice(0, 8))}</div></td>
        <td class="mono">${dt(d.created_at)}</td><td><div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-dev="${d.id}" data-s="active">核准（停用舊機）</button>
        <button class="btn sm ghost" data-dev="${d.id}" data-s="revoked">拒絕</button></div></td></tr>`).join('')}</table></div>
      <div class="small">核准前請確認是本人換機。核准後，該人員原本綁定的手機會自動停用。</div></section>` : ''}
    <section class="stack"><h3>人員</h3><div class="tbl"><table><tr><th>工號</th><th>姓名</th><th>角色</th><th>狀態</th><th>使用中手機</th>${isAdmin() ? '<th></th>' : ''}</tr>
      ${users.map(u => { const d = devs.find(x => x.user_id === u.id && x.status === 'active');
        return `<tr><td class="mono">${esc(u.staff_no)}</td><td>${esc(u.name)}</td>
        <td>${isAdmin() ? `<select data-role="${u.id}" aria-label="角色">${opts([['guard', '巡邏員'], ['supervisor', '班長'], ['admin', '管理者']], u.role)}</select>` : roleName[u.role]}</td>
        <td>${isAdmin() ? `<select data-act="${u.id}" aria-label="狀態">${opts([['1', '在職'], ['0', '停用']], u.active ? '1' : '0')}</select>` : (u.active ? '在職' : '停用')}</td>
        <td>${d ? `${esc(d.label)} <button class="btn sm ghost" data-dev="${d.id}" data-s="revoked">停用此手機</button>` : '<span class="small">尚未綁定</span>'}</td>
        ${isAdmin() ? `<td><button class="btn sm ghost" data-pw="${u.id}">重設密碼</button></td>` : ''}</tr>`; }).join('')}</table></div></section>
    ${isAdmin() ? `<section class="card stack"><h3>新增人員</h3>
      <form id="uf" class="row"><label class="f">工號<input id="u-no" required placeholder="例：G1030"></label><label class="f">姓名<input id="u-name" required></label>
        <label class="f">角色<select id="u-role">${opts([['guard', '巡邏員'], ['supervisor', '班長'], ['admin', '管理者']])}</select></label>
        <label class="f">初始密碼<input id="u-pw" type="text" minlength="8" required placeholder="至少 8 碼"></label>
        <button class="btn vest" style="align-self:end;flex:none">新增</button></form>
      <div class="small">登入帳號為工號。人員離職時請將狀態改為「停用」，保留歷史紀錄。</div></section>
    <section class="card stack"><h3>照片保存期限</h3>
      <div class="small">依個資告知，巡查照片保存 ${CONFIG.PHOTO_RETENTION_DAYS} 天。按下按鈕刪除超過期限的照片（文字紀錄保留）。建議每月執行一次。</div>
      <button class="btn ghost" id="purge" style="align-self:flex-start">刪除 ${CONFIG.PHOTO_RETENTION_DAYS} 天前的照片</button></section>` : ''}`;
  $$('[data-reg]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { await api.approveRegistration(b.dataset.reg); toast('已核准，巡邏員可以掃臉登入了'); people = []; show('people'); refreshBadges(); }
    catch (err) { toast(err.message, 'bad'); b.disabled = false; }
  });
  $$('[data-rej]').forEach(b => b.onclick = () => {
    const r = regs.find(x => x.id === b.dataset.rej);
    openDialog(`退回 ${r.staff_no} ${r.name} 的申請`, `<form id="rjf" class="stack"><label class="f">退回原因（巡邏員會在手機上看到）
      <textarea id="rj-why" rows="3" required placeholder="例：工號有誤，請確認後重新申請"></textarea></label><button class="btn bad">確認退回</button></form>`);
    $('#rjf').onsubmit = async e => {
      e.preventDefault();
      try { await api.rejectRegistration(r.id, $('#rj-why').value.trim()); toast('已退回'); dlg.close(); show('people'); refreshBadges(); } catch (err) { toast(err.message, 'bad'); }
    };
  });
  $$('[data-dev]').forEach(b => b.onclick = async () => { await api.setDeviceStatus(b.dataset.dev, b.dataset.s); toast('已更新'); show('people'); refreshBadges(); });
  $$('[data-role]').forEach(s => s.onchange = async () => { await api.updateProfile(s.dataset.role, { role: s.value }); toast('角色已更新'); });
  $$('[data-act]').forEach(s => s.onchange = async () => { await api.updateProfile(s.dataset.act, { active: s.value === '1' }); toast('狀態已更新'); });
  $$('[data-pw]').forEach(b => b.onclick = () => {
    openDialog('重設密碼', `<form id="pf" class="stack"><label class="f">新密碼（至少 8 碼）<input id="npw" minlength="8" required></label><button class="btn vest">確認重設</button></form>`);
    $('#pf').onsubmit = async e => { e.preventDefault(); try { await api.resetPassword(b.dataset.pw, $('#npw').value); toast('密碼已重設'); dlg.close(); } catch (err) { toast(err.message, 'bad'); } };
  });
  $('#uf')?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.createUser({ staff_no: $('#u-no').value.trim().toUpperCase(), name: $('#u-name').value.trim(), role: $('#u-role').value, password: $('#u-pw').value });
      toast('已新增人員'); people = []; show('people');
    } catch (err) { toast(err.message, 'bad'); }
  });
  $('#purge')?.addEventListener('click', async e => {
    if (e.currentTarget.dataset.armed !== '1') { e.currentTarget.dataset.armed = '1'; e.currentTarget.textContent = '再按一次確認刪除（無法復原）'; return; }
    try { const n = await api.purgePhotos(CONFIG.PHOTO_RETENTION_DAYS); toast(`已刪除 ${n} 張過期照片`); show('people'); } catch (err) { toast(err.message, 'bad'); }
  });
};

// ---------- 登入 ----------
function loginView(msg = '') {
  $('#root').innerHTML = `<div style="max-width:420px;margin:10vh auto;padding:0 max(16px, env(safe-area-inset-left, 0px))" class="stack">
    <div><div class="eyebrow">${esc(CONFIG.ORG_NAME)}</div><h1 style="font-size:26px">巡邏管理後台</h1></div>
    ${DEMO ? '<div class="banner demo"><div><b>示範模式</b>：班長 <span class="mono">S001</span>、管理者 <span class="mono">A001</span>，密碼 <span class="mono">demo1234</span></div></div>' : ''}
    ${msg ? `<div class="banner warn">${esc(msg)}</div>` : ''}
    <form id="lf" class="stack card"><label class="f">工號<input id="l-no" autocomplete="username" required></label>
      <label class="f">密碼<input id="l-pw" type="password" autocomplete="current-password" required></label><button class="btn vest">登入</button></form>
    <a href="index.html" class="small">前往巡邏員畫面</a></div>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    try { S.profile = await api.login($('#l-no').value, $('#l-pw').value); start(); } catch (err) { toast(err.message, 'bad'); }
  };
}
function start() {
  if (!['supervisor', 'admin'].includes(S.profile.role)) return loginView('此帳號為巡邏員，沒有管理後台權限。');
  shell();
  const hash = location.hash.slice(1);
  show(NAV.some(n => n[0] === hash && (!n[2] || isAdmin())) ? hash : 'dash');
  unsub = api.subscribe(async () => { await refreshBadges(); if (S.page === 'dash' && !dlg.open) show('dash'); });
}

(async () => {
  try { S.profile = await api.currentProfile(); } catch { S.profile = null; }
  S.profile ? start() : loginView();
})();
