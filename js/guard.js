// 巡邏員手機端
import { CONFIG } from './config.js';
import { api, DEMO, isNetworkError } from './api.js';
import * as cam from './camera.js';
import * as bio from './biometric.js';
import * as wa from './webauthn.js';
import { queueStore } from './idb.js';
import { flagLabel, distanceM } from './rules.js';
import { $, $$, esc, ymd, hm, hms, dt, uid, toast, getPosition, mins } from './util.js';

const V = {};
const S = { profile: null, deviceId: null, routes: [], route: null, patrol: null, scans: [], cur: null, lastPos: null, queue: [], screen: '', uvAt: 0 };
const PRE_LOGIN = ['login', 'device', 'welcome', 'register', 'pending', 'unlock'];

// 本機的臉部登入資料：{ credentialId, requestId, staffNo, name, status, simulated }
const store = key => ({
  get() { try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; } },
  set(v) { try { v ? localStorage.setItem(key, JSON.stringify(v)) : localStorage.removeItem(key); } catch { /* 無法保存時略過 */ } },
});
const PK = store('yzup-passkey');
const LAST = store('yzup-last');   // 上次使用的路線與天候，供一鍵報到
const faceReady = () => PK.get()?.status === 'approved';
const shiftNow = () => { const h = new Date().getHours(); return CONFIG.SHIFTS[h >= 22 || h < 6 ? 0 : h < 14 ? 1 : 2]; };
let cleanup = null;

// ---------- 裝置識別 ----------
function getDeviceId() {
  try {
    let id = localStorage.getItem('yzup-device-id');
    if (!id) { id = uid(); localStorage.setItem('yzup-device-id', id); }
    return id;
  } catch { return 'nostore-' + uid(); }
}
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : '其他';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '瀏覽器';
  return `${os} · ${br}`;
}

// ---------- 畫面切換 ----------
function go(name, arg) {
  try { cleanup?.(); } catch { /* 忽略清理錯誤 */ }
  cleanup = null;
  cam.stopCamera();
  S.screen = name;
  window.scrollTo(0, 0);
  const tabs = $('#tabs');
  tabs.hidden = !S.profile || PRE_LOGIN.includes(name);
  const tab = ['home', 'patrol', 'scan', 'record', 'incident', 'end', 'selfie'].includes(name) ? 'patrol' : ['history', 'detail'].includes(name) ? 'history' : name;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  Promise.resolve(V[name](arg)).catch(showError);
  renderStatus();
}
function showError(e) {
  if (String(e?.message).includes('請重新登入')) { S.profile = null; return go(faceReady() ? 'unlock' : 'welcome'); }
  toast(e?.message || String(e), 'bad');
}
$('#tabs').addEventListener('click', e => {
  const t = e.target.closest('button')?.dataset.tab;
  if (t === 'patrol') go(S.patrol ? 'patrol' : 'home');
  else if (t) go(t);
});
const view = () => $('#view');
const html = s => { view().innerHTML = s; };

async function renderStatus() {
  const n = S.queue.length;
  $('#status').innerHTML = [
    DEMO ? '<span class="chip vest">示範模式</span>' : '',
    navigator.onLine ? '<span class="chip"><span class="dot"></span>連線</span>' : '<span class="chip bad"><span class="dot off"></span>離線</span>',
    n ? `<span class="chip warn">待上傳 ${n}</span>` : '',
  ].join('');
}

// ---------- 離線佇列 ----------
async function refreshQueue() {
  try { S.queue = await queueStore.all(); } catch { S.queue = []; }
  renderStatus();
}
async function runOp(it) {
  if (it.blobs?.length) {
    const paths = [];
    for (const b of it.blobs) paths.push(await api.uploadPhoto(b, it.kind));
    it.payload.photoPaths = [...(it.payload.photoPaths || []), ...paths];
    it.blobs = [];
    if (it.stored) await queueStore.put(it);
  }
  const p = it.payload;
  switch (it.type) {
    case 'scan': return api.submitScan(p);
    case 'incident': return api.reportIncident(p);
    case 'sos': return api.sendSOS(p);
    case 'track': return api.addTrack(p);
    case 'selfie': return api.submitSelfie({ ...p, photoPath: p.photoPaths?.[0] || null });
  }
}
// 有網路時直接送出；網路中斷時放入佇列，恢復後自動上傳
async function submitOrQueue(type, payload, blobs = [], kind = type) {
  const it = { id: uid(), type, kind, payload, blobs, createdAt: Date.now(), stored: false };
  if (navigator.onLine) {
    try { return { ok: true, result: await runOp(it) }; }
    catch (e) { if (!isNetworkError(e)) throw e; }
  }
  it.stored = true;
  await queueStore.put(it);
  await refreshQueue();
  return { queued: true };
}
let syncing = false;
async function sync() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  let changed = 0;
  try {
    const items = (await queueStore.all()).sort((a, b) => a.createdAt - b.createdAt);
    for (const it of items) {
      try {
        const r = await runOp(it);
        await queueStore.del(it.id);
        changed++;
        if (it.type === 'scan' && S.patrol && r?.patrol_id === S.patrol.id) S.scans.push(r);
      } catch (e) {
        if (isNetworkError(e)) break;
        await queueStore.del(it.id);
        changed++;
        toast(`暫存資料上傳被拒：${e.message}`, 'bad');
      }
    }
  } finally {
    syncing = false;
    await refreshQueue();
    if (changed && S.screen === 'patrol') go('patrol');
  }
}
window.addEventListener('online', () => { renderStatus(); sync(); });
window.addEventListener('offline', renderStatus);
setInterval(sync, 30000);

// ---------- 定位與軌跡 ----------
function simOn() { try { return DEMO && localStorage.getItem('yzup-sim-gps') !== 'off'; } catch { return DEMO; } }
const SIM_BASE = { lat: 24.9702, lng: 121.2660 };
function jitter(p, m = 6) {
  const a = Math.random() * Math.PI * 2, r = Math.random() * m;
  return { lat: p.lat + (r * Math.sin(a)) / 111320, lng: p.lng + (r * Math.cos(a)) / 101000, acc: Math.round(5 + Math.random() * 7) };
}
async function locate(cp, { far = false } = {}) {
  if (simOn()) {
    const base = cp?.lat != null ? cp : (S.lastPos || SIM_BASE);
    const p = jitter(base);
    if (far) p.lat += 380 / 111320;
    S.lastPos = { ...p, at: Date.now() };
    return p;
  }
  const p = await getPosition({ timeout: 12000 });
  if (p) S.lastPos = { ...p, at: Date.now() };
  return p;
}
let watchId = null, trackTimer = null;
function startTracking() {
  stopTracking();
  if (!simOn() && navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(
      p => { S.lastPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), at: Date.now() }; },
      () => {}, { enableHighAccuracy: true, maximumAge: 15000 });
  }
  trackTimer = setInterval(() => {
    if (!S.patrol || document.visibilityState !== 'visible') return;
    const p = simOn() ? jitter(S.lastPos || SIM_BASE, 15) : S.lastPos;
    if (!p || (!simOn() && Date.now() - p.at > 120000)) return;
    submitOrQueue('track', { patrolId: S.patrol.id, at: new Date().toISOString(), lat: p.lat, lng: p.lng, acc: p.acc }).catch(() => {});
  }, CONFIG.TRACK_INTERVAL_SEC * 1000);
}
function stopTracking() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  clearInterval(trackTimer);
  watchId = null; trackTimer = null;
}
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => (wakeLock = null)); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* 不支援時略過 */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.patrol) keepAwake(true); });

// ---------- 自拍確認排程 ----------
const selfieKey = () => 'yzup-selfie-' + S.patrol?.id;
function selfiePlan() { try { return JSON.parse(localStorage.getItem(selfieKey())) || null; } catch { return null; } }
function saveSelfiePlan(p) { try { localStorage.setItem(selfieKey(), JSON.stringify(p)); } catch { /* 略過 */ } }
function planSelfies() {
  const n = S.route?.points.length || 0, k = Math.min(CONFIG.SELFIE_CHECKS_PER_PATROL, Math.max(0, n - 1));
  const pool = Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
  saveSelfiePlan({ at: pool.slice(0, k), done: [], pending: null });
}
function selfieDue() {
  const p = selfiePlan(); if (!p) return null;
  if (p.pending) return p.pending;
  const doneCount = doneCheckpointIds().size;
  const hit = p.at.find(k => k <= doneCount && !p.done.includes(k));
  if (hit) { p.pending = { k: hit, requestedAt: new Date().toISOString() }; saveSelfiePlan(p); return p.pending; }
  return null;
}
function selfieStatus() {
  const p = selfiePlan();
  if (!p || !p.at.length) return 'none';
  return p.at.every(k => p.done.includes(k)) ? 'ok' : 'missed';
}

// ---------- 共用元件 ----------
function doneCheckpointIds() {
  const ids = new Set(S.scans.map(s => s.checkpoint_id));
  for (const q of S.queue) if (q.type === 'scan' && q.payload.patrolId === S.patrol?.id) {
    const cp = S.route?.points.find(p => p.code === q.payload.code);
    if (cp) ids.add(cp.id);
  }
  return ids;
}
function pendingIds() {
  const ids = new Set();
  for (const q of S.queue) if (q.type === 'scan' && q.payload.patrolId === S.patrol?.id) {
    const cp = S.route?.points.find(p => p.code === q.payload.code);
    if (cp) ids.add(cp.id);
  }
  return ids;
}

const sosHtml = () => `<button class="btn bad block sos" id="sos" aria-describedby="sos-hint"><span class="fill"></span><span id="sos-t">長按 3 秒・SOS 緊急求援</span></button>
  <div class="small" id="sos-hint">按住不放 3 秒送出位置給值班主管與校安中心。</div>`;
function bindSOS() {
  const b = $('#sos'); if (!b) return;
  let t = null;
  const start = e => {
    if (e.repeat) return;
    e.preventDefault();
    b.classList.add('holding'); $('#sos-t').textContent = '持續按住…';
    t = setTimeout(fireSOS, 3000);
  };
  const end = () => {
    clearTimeout(t); t = null; b.classList.remove('holding');
    if ($('#sos-t')?.textContent === '持續按住…') $('#sos-t').textContent = '長按 3 秒・SOS 緊急求援';
  };
  b.addEventListener('pointerdown', start);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, end));
  b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') start(e); });
  b.addEventListener('keyup', end);
  b.addEventListener('contextmenu', e => e.preventDefault());
}
async function fireSOS() {
  navigator.vibrate?.([200, 100, 200]);
  $('#sos-t').textContent = '送出中…';
  const fresh = S.lastPos && Date.now() - S.lastPos.at < 60000 ? S.lastPos : await locate(null);
  const phones = CONFIG.SOS_PHONES.map(p => `${esc(p.label)}：<b class="mono">${esc(p.number)}</b>`).join('<br>');
  let r;
  try { r = await submitOrQueue('sos', { patrolId: S.patrol?.id || null, lat: fresh?.lat ?? null, lng: fresh?.lng ?? null, acc: fresh?.acc ?? null }); }
  catch (e) { r = { error: e.message }; }
  const box = document.createElement('div');
  box.className = 'banner bad';
  box.innerHTML = r.ok
    ? `<div><b>求援已送出</b>，位置已傳送給值班主管。情況危急請同時撥打：<br>${phones}</div>`
    : `<div><b>求援尚未送出</b>（${r.queued ? '目前離線' : esc(r.error)}）。請立即以電話或無線電聯絡：<br>${phones}</div>`;
  $('#sos').replaceWith(box);
}

// 照片元件：App 內相機即時拍攝；相機無法使用時才提供備援方式
function photoWidget(root, { max = 3, facing = 'environment', lines }) {
  const st = { photos: [], nonLive: false };
  root.innerHTML = `
    <div class="cam ${facing === 'user' ? 'selfie' : ''}" style="aspect-ratio:4/3"><video playsinline muted></video><div class="hint">對準後按下方「拍照」</div></div>
    <div class="banner warn" data-err hidden></div>
    <button type="button" class="btn block" data-shoot>拍照</button>
    <div data-fb hidden class="stack">
      <label class="btn ghost block">改用手機相機拍攝<input type="file" accept="image/*" capture="${facing}" hidden data-file></label>
      <div class="small">此方式拍攝的照片會標記為「非即時拍攝」，由主管覆核。</div>
    </div>
    ${DEMO ? '<button type="button" class="btn ghost block" data-sample>產生示範照片（電腦沒有相機時使用）</button>' : ''}
    <div class="thumbs" data-thumbs></div>`;
  const video = $('video', root), shoot = $('[data-shoot]', root);
  const draw = () => {
    $('[data-thumbs]', root).innerHTML = st.photos.map((p, i) => `<figure><img src="${p.url}" alt="照片 ${i + 1}"><button type="button" data-del="${i}" aria-label="刪除照片 ${i + 1}">×</button></figure>`).join('');
    shoot.disabled = st.photos.length >= max || !video.srcObject;
    shoot.textContent = st.photos.length >= max ? `已達 ${max} 張上限` : `拍照（${st.photos.length}/${max}）`;
  };
  const fallback = msg => {
    $('.cam', root).hidden = true; shoot.hidden = true;
    const err = $('[data-err]', root); err.hidden = false; err.textContent = msg;
    if (CONFIG.ALLOW_FILE_PHOTO_FALLBACK) $('[data-fb]', root).hidden = false;
  };
  cam.startCamera(video, facing).then(draw).catch(e => fallback(e.message));
  shoot.addEventListener('click', async () => {
    if (st.photos.length >= max) return;
    st.photos.push(await cam.captureFrame(video, lines(), { mirror: facing === 'user' }));
    draw();
  });
  $('[data-file]', root)?.addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f || st.photos.length >= max) return;
    st.photos.push(await cam.photoFromFile(f, lines())); st.nonLive = true; e.target.value = ''; draw();
  });
  $('[data-sample]', root)?.addEventListener('click', async () => {
    if (st.photos.length >= max) return;
    st.photos.push(await cam.samplePhoto(lines())); draw();
  });
  $('[data-thumbs]', root).addEventListener('click', e => {
    const i = e.target.dataset.del; if (i == null) return;
    URL.revokeObjectURL(st.photos[i].url); st.photos.splice(+i, 1); draw();
  });
  draw();
  return st;
}
const stampLines = (title) => {
  const p = S.lastPos;
  return () => [`${S.profile.name}  ${S.profile.staff_no}`, title, `${ymd(new Date())} ${hms(new Date())}  ${p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} ±${p.acc}m` : '無定位'}`];
};
const opts = (arr, sel) => arr.map(v => `<option${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');

// ---------- 畫面：歡迎（尚未註冊的手機） ----------
V.welcome = () => {
  html(`
    <div><div class="eyebrow">${esc(CONFIG.ORG_NAME)}・總務處</div><h2>校園巡邏</h2></div>
    <p style="margin:0">巡邏員第一次使用請先申請註冊。班長核准後，每次只要掃臉就能報到並開始巡邏。</p>
    <button class="btn vest block" id="w-reg">第一次使用：申請註冊</button>
    <button class="btn ghost block" id="w-pw">用工號密碼登入（班長、管理者）</button>
    ${DEMO ? `<div class="banner demo"><div><b>示範模式</b>：可直接申請註冊，再用電腦開啟管理後台，以班長 <span class="mono">S001</span>／密碼 <span class="mono">demo1234</span> 核准，體驗完整流程。</div></div>` : ''}`);
  $('#w-reg').onclick = () => go('register');
  $('#w-pw').onclick = () => go('login');
};

const privacyText = () => `${esc(CONFIG.ORG_NAME)}為執行校園安全巡查，蒐集您的姓名、工號、手機號碼與手機裝置代碼，並於「開始巡邏」至「結束巡邏」期間蒐集定位、巡查照片與身分確認自拍照。
  臉部辨識由您的手機執行，學校只收到「驗證通過」的結果，不取得、不儲存您的臉部特徵。
  資料僅供巡邏管理、安全事件處理與稽核使用，照片保存 ${CONFIG.PHOTO_RETENTION_DAYS} 天後刪除；非巡邏時間不蒐集定位。您可向總務處申請查閱、更正或停止使用。`;

// ---------- 畫面：申請註冊 ----------
V.register = async () => {
  const ok = await wa.supported();
  html(`<button class="btn ghost sm" id="back" style="align-self:flex-start">← 返回</button>
    <div><h2>申請註冊</h2><div class="small">送出後由班長核准。核准後，這支手機每次只要掃臉即可報到。</div></div>
    ${!ok ? `<div class="banner warn">這支手機或瀏覽器無法使用臉部辨識。iPhone 請用 Safari、Android 請用 Chrome 開啟，並確認手機已設定 Face ID 或指紋。</div>` : ''}
    <form id="rf" class="stack" novalidate>
      <label class="f">工號<input id="r-no" autocapitalize="characters" autocomplete="off" required placeholder="例：G1030"></label>
      <label class="f">姓名<input id="r-name" autocomplete="name" required></label>
      <label class="f">手機號碼（選填，緊急聯絡用）<input id="r-phone" type="tel" autocomplete="tel" inputmode="tel"></label>
      <label class="f">所屬單位<input id="r-org" placeholder="例：總務處、○○保全公司"></label>
      <details class="card small" open><summary>個人資料蒐集告知</summary><p style="margin:8px 0 0">${privacyText()}</p></details>
      <label style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="r-ok" style="width:20px;height:20px;accent-color:var(--vest)"> 我已閱讀並同意上述告知事項</label>
      <button class="btn vest block" id="r-go" ${ok ? '' : 'disabled'}>下一步：設定臉部辨識並送出</button>
    </form>
    ${DEMO ? '<button class="btn ghost block" id="r-sim">用模擬臉部辨識送出（電腦測試用）</button>' : ''}`);
  $('#back').onclick = () => go('welcome');
  const submit = async simulate => {
    const info = { staff_no: $('#r-no').value.trim().toUpperCase(), name: $('#r-name').value.trim(), phone: $('#r-phone').value.trim(), org: $('#r-org').value.trim() };
    if (!/^[A-Z0-9_-]{2,20}$/.test(info.staff_no)) return toast('請填寫正確的工號（英文字母或數字）', 'bad');
    if (!info.name) return toast('請填寫姓名', 'bad');
    if (!$('#r-ok').checked) return toast('請先閱讀並勾選同意個人資料蒐集告知', 'bad');
    const btn = $('#r-go'); btn.disabled = true; btn.textContent = '請依手機提示掃臉…';
    try {
      const r = await api.passkeyRegister({ ...info, deviceId: S.deviceId, deviceLabel: deviceLabel(), simulate });
      PK.set({ credentialId: r.credentialId, requestId: r.requestId, staffNo: info.staff_no, name: info.name, status: 'pending', simulated: !!simulate, at: new Date().toISOString() });
      go('pending');
    } catch (e) { toast(e.message, 'bad'); btn.disabled = !ok; btn.textContent = '下一步：設定臉部辨識並送出'; }
  };
  $('#rf').addEventListener('submit', e => { e.preventDefault(); submit(false); });
  $('#r-sim')?.addEventListener('click', () => submit(true));
};

// ---------- 畫面：等待核准 ----------
V.pending = () => {
  const pk = PK.get(); if (!pk) return go('welcome');
  html(`<h2>申請已送出</h2>
    <div class="card"><dl class="kv"><dt>工號</dt><dd class="mono">${esc(pk.staffNo)}</dd><dt>姓名</dt><dd>${esc(pk.name)}</dd><dt>送出時間</dt><dd class="mono">${dt(pk.at)}</dd></dl></div>
    <div id="st"><p style="margin:0">請通知班長到管理後台「人員與裝置」核准。核准後，這個畫面會自動進入。</p></div>
    <button class="btn vest block" id="chk">重新檢查</button>
    <button class="btn ghost block" id="redo">取消申請，重新填寫</button>`);
  const check = async manual => {
    const r = await api.registrationStatus(pk.requestId, S.deviceId);
    if (r.status === 'approved') { PK.set({ ...pk, status: 'approved' }); toast('申請已核准，請掃臉報到'); return go('unlock'); }
    if (r.status === 'rejected') {
      $('#st').innerHTML = `<div class="banner bad"><div><b>申請未通過</b>：${esc(r.reason || '')}<br>請修正後重新申請，或洽班長。</div></div>`;
      $('#chk').hidden = true; $('#redo').textContent = '重新申請';
      return;
    }
    if (r.status === 'missing') { PK.set(null); toast('找不到申請資料，請重新申請', 'bad'); return go('register'); }
    if (manual) toast('尚未核准，請稍候');
  };
  $('#chk').onclick = () => check(true).catch(showError);
  $('#redo').onclick = () => { PK.set(null); go('register'); };
  const t = setInterval(() => check(false).catch(() => {}), 15000);
  cleanup = () => clearInterval(t);
  check(false).catch(() => {});
};

// ---------- 畫面：掃臉報到（日常使用） ----------
async function faceLogin() {
  const pk = PK.get();
  S.profile = await api.passkeyLogin({ credentialId: pk.credentialId, deviceId: S.deviceId, simulate: pk.simulated });
  S.uvAt = Date.now();
  sync();
}
V.unlock = () => {
  const pk = PK.get(); if (!pk) return go('welcome');
  const last = LAST.get();
  html(`
    <div style="text-align:center" class="stack">
      <svg width="88" height="88" viewBox="0 0 88 88" aria-hidden="true" style="margin:8px auto 0;display:block">
        <g fill="none" stroke="var(--vest)" stroke-width="5" stroke-linecap="round">
          <path d="M8 26V14a6 6 0 0 1 6-6h12M62 8h12a6 6 0 0 1 6 6v12M80 62v12a6 6 0 0 1-6 6H62M26 80H14a6 6 0 0 1-6-6V62"/>
          <path d="M30 32v6M58 32v6M44 34v14h-4M32 60c7 6 17 6 24 0"/></g></svg>
      <div><h2>${esc(pk.name)}，您好</h2><div class="small mono">${esc(pk.staffNo)}</div></div>
    </div>
    <div class="card"><dl class="kv"><dt>日期</dt><dd class="mono">${ymd(new Date())}</dd><dt>時間</dt><dd class="mono" id="clock">${hms(new Date())}</dd>
      <dt>班別</dt><dd>${esc(shiftNow())}</dd><dt>路線</dt><dd>${last?.routeName ? esc(last.routeName) : '登入後選擇'}</dd>
      <dt>天候</dt><dd>${esc(last?.weather || CONFIG.WEATHER[0])}</dd></dl>
      <div class="small" style="margin-top:6px">掃臉後立即以伺服器時間報到。要更換路線或天候，請選「掃臉進入」。</div></div>
    <button class="btn vest block" id="u-start" style="min-height:58px;font-size:17px">掃臉報到並開始巡邏</button>
    <button class="btn ghost block" id="u-in">掃臉進入（暫不開始巡邏）</button>
    <details class="card small"><summary>無法使用臉部辨識？</summary>
      <p>請先確認手機的 Face ID 或指紋可以正常解鎖。換手機、重設 Face ID 或刪除網站資料後，需重新申請註冊並由班長核准。</p>
      <div class="stack"><button class="btn ghost block" id="u-re">重新申請註冊此手機</button>
      <button class="btn ghost block" id="u-pw">改用工號密碼登入</button></div></details>
    ${sosHtml()}`);
  bindSOS();
  const clk = setInterval(() => { const c = $('#clock'); if (c) c.textContent = hms(new Date()); }, 1000);
  cleanup = () => clearInterval(clk);
  const busy = (btn, on, text) => { $$('#u-start, #u-in').forEach(b => (b.disabled = on)); btn.textContent = text; };
  $('#u-start').onclick = async e => {
    const btn = e.currentTarget; busy(btn, true, '請依手機提示掃臉…');
    try {
      await faceLogin();
      const st = await api.registerDevice(S.deviceId, deviceLabel());
      if (st !== 'active') return go('device', st);
      S.routes = await api.getRoutes();
      const ap = await api.getActivePatrol();
      if (ap) { toast('繼續進行中的巡邏'); return afterLogin(); }
      const route = S.routes.find(r => r.id === last?.routeId) || (S.routes.length === 1 ? S.routes[0] : null);
      if (!route) { toast('請選擇今天的巡邏路線'); return go('home'); }
      await startPatrolWith({ routeId: route.id, shift: shiftNow(), weather: last?.weather || CONFIG.WEATHER[0] }, true);
    } catch (err) { toast(err.message, 'bad'); busy(btn, false, '掃臉報到並開始巡邏'); }
  };
  $('#u-in').onclick = async e => {
    const btn = e.currentTarget; busy(btn, true, '請依手機提示掃臉…');
    try { await faceLogin(); await afterLogin(); } catch (err) { toast(err.message, 'bad'); busy(btn, false, '掃臉進入（暫不開始巡邏）'); }
  };
  $('#u-re').onclick = e => {
    if (e.currentTarget.dataset.armed !== '1') { e.currentTarget.dataset.armed = '1'; e.currentTarget.textContent = '再按一次確認：本機臉部登入將失效，需重新核准'; return; }
    PK.set(null); go('register');
  };
  $('#u-pw').onclick = () => go('login');
};

// 開始巡邏（首頁與掃臉報到共用）
async function startPatrolWith({ routeId, shift, weather }, uvOk) {
  const pos = await locate(null);
  S.patrol = await api.startPatrol({ routeId, shift, weather, deviceId: S.deviceId, lat: pos?.lat ?? null, lng: pos?.lng ?? null, uvOk });
  S.scans = []; S.route = S.routes.find(r => r.id === routeId);
  LAST.set({ routeId, routeName: S.route?.name, weather });
  planSelfies(); startTracking(); keepAwake(true);
  toast('已報到並開始巡邏，定位記錄啟用');
  go('patrol');
}
// 開始巡邏前確認本人：已註冊臉部登入者 15 分鐘內免重掃；密碼登入者沿用手機端生物辨識
async function verifyIdentity() {
  if (faceReady()) {
    if (Date.now() - S.uvAt < 14 * 60000) return true;
    await faceLogin();
    return true;
  }
  if (bio.storedCredential(S.profile.id)) return bio.verify(S.profile.id);
  return false;
}

// ---------- 畫面：登入 ----------
V.login = () => {
  html(`<button class="btn ghost sm" id="back" style="align-self:flex-start">← 返回</button>
    <div><div class="eyebrow">${esc(CONFIG.ORG_NAME)}・總務處</div><h2>工號密碼登入</h2></div>
    ${DEMO ? `<div class="banner demo"><div><b>示範模式</b>：資料只存在這台裝置。<br>
      示範帳號：<span class="mono">G1024</span>、<span class="mono">G1025</span>（巡邏員），密碼 <span class="mono">demo1234</span></div></div>` : ''}
    <form id="f" class="stack" novalidate>
      <label class="f">工號<input id="staff" autocomplete="username" autocapitalize="characters" required></label>
      <label class="f">密碼<input id="pw" type="password" autocomplete="current-password" required></label>
      <button class="btn vest block" id="login-btn">登入</button>
    </form>
    <details class="card small"><summary>個人資料蒐集告知</summary>
      <p>${esc(CONFIG.ORG_NAME)}為執行校園安全巡查，於您按下「開始巡邏」至「結束巡邏」期間，蒐集您的定位、巡查照片與身分確認自拍照。
      資料僅供巡邏管理、安全事件處理與稽核使用，照片保存 ${CONFIG.PHOTO_RETENTION_DAYS} 天後刪除；非巡邏時間不會蒐集定位。
      您可向總務處申請查閱或更正本人資料。</p></details>`);
  $('#back').onclick = () => go(faceReady() ? 'unlock' : 'welcome');
  $('#f').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#login-btn'); btn.disabled = true; btn.textContent = '登入中…';
    try {
      S.profile = await api.login($('#staff').value, $('#pw').value);
      await afterLogin();
    } catch (err) { toast(err.message, 'bad'); btn.disabled = false; btn.textContent = '登入'; }
  });
};

async function afterLogin() {
  const st = await api.registerDevice(S.deviceId, deviceLabel());
  if (st !== 'active') return go('device', st);
  S.routes = await api.getRoutes();
  const ap = await api.getActivePatrol();
  if (ap) {
    S.patrol = ap.patrol; S.scans = ap.scans;
    S.route = S.routes.find(r => r.id === S.patrol.route_id) || null;
    startTracking(); keepAwake(true);
    return go('patrol');
  }
  go('home');
}

V.device = st => {
  html(`<h2>此手機尚未獲授權</h2>
    <div class="card stack">
      <p style="margin:0">${st === 'revoked' ? '此手機已被主管停用。' : '您的帳號已綁定另一支手機。為避免代巡，每個帳號只能在一支手機上使用。'}</p>
      <p style="margin:0">若您更換了手機，請通知班長或總務處，於管理後台「人員與裝置」核准此手機。</p>
      <dl class="kv"><dt>裝置代碼</dt><dd class="mono">${esc(S.deviceId.slice(0, 8))}</dd><dt>裝置類型</dt><dd>${esc(deviceLabel())}</dd></dl>
    </div>
    <button class="btn vest block" id="retry">已核准，重新檢查</button>
    <button class="btn ghost block" id="out">登出</button>`);
  $('#retry').onclick = () => afterLogin().catch(showError);
  $('#out').onclick = async () => { await api.logout(); S.profile = null; go(faceReady() ? 'unlock' : 'welcome'); };
};

// ---------- 畫面：首頁 ----------
V.home = async () => {
  if (S.patrol) return go('patrol');
  const shift = shiftNow();
  const face = faceReady();
  const hasBio = face || !!bio.storedCredential(S.profile.id);
  const last = LAST.get();
  html(`
    <div><div class="small">${esc(S.profile.staff_no)}・${esc(S.profile.name)}</div><h2>開始巡邏</h2></div>
    <div class="card"><dl class="kv"><dt>日期</dt><dd class="mono">${ymd(new Date())}</dd><dt>時間</dt><dd class="mono" id="clock">${hms(new Date())}</dd>
      <dt>身分驗證</dt><dd>${face ? '<span class="chip ok">臉部辨識登入</span>' : hasBio ? '<span class="chip ok">指紋／臉部辨識已啟用</span>' : '<span class="chip warn">尚未啟用生物辨識</span>'}</dd></dl>
      <div class="small" style="margin-top:6px">開始時間以伺服器時間記錄，無法手動修改。</div></div>
    ${S.routes.length ? `
    <label class="f">班別<select id="shift">${opts(CONFIG.SHIFTS, shift)}</select></label>
    <label class="f">巡邏路線<select id="route">${S.routes.map(r => `<option value="${r.id}"${r.id === last?.routeId ? ' selected' : ''}>${esc(r.name)}（${r.points.length} 點${r.mode === 'ordered' ? '・依序' : ''}）</option>`).join('')}</select></label>
    <label class="f">天候<select id="wx">${opts(CONFIG.WEATHER, last?.weather)}</select></label>
    <button class="btn vest block" id="start">開始巡邏</button>` : '<div class="banner warn">目前沒有可用的巡邏路線，請洽管理者設定。</div>'}
    ${!hasBio ? '<button class="btn ghost block" id="go-bio">設定指紋／臉部辨識</button>' : ''}
    ${sosHtml()}`);
  bindSOS();
  const clk = setInterval(() => { const c = $('#clock'); if (c) c.textContent = hms(new Date()); }, 1000);
  cleanup = () => clearInterval(clk);
  $('#go-bio')?.addEventListener('click', () => go('settings'));
  $('#start')?.addEventListener('click', async e => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = '驗證身分中…';
    try {
      let uvOk = false;
      try { uvOk = await verifyIdentity(); } catch (err) { if (face) throw err; }
      if (!uvOk && CONFIG.REQUIRE_BIOMETRIC) throw new Error(hasBio ? '生物辨識未通過，無法開始巡邏' : '請先到「設定」啟用指紋或臉部辨識');
      if (!uvOk) toast('未通過生物辨識，本場巡邏將標記供主管覆核');
      btn.textContent = '定位中…';
      await startPatrolWith({ routeId: $('#route').value, shift: $('#shift').value, weather: $('#wx').value }, uvOk);
    } catch (err) { toast(err.message, 'bad'); btn.disabled = false; btn.textContent = '開始巡邏'; }
  });
};

// ---------- 畫面：巡邏中 ----------
V.patrol = () => {
  if (!S.patrol) return go('home');
  const pts = S.route?.points || [];
  const done = doneCheckpointIds(), pend = pendingIds();
  const byCp = Object.fromEntries(S.scans.map(s => [s.checkpoint_id, s]));
  const next = S.route?.mode === 'ordered' ? pts.find(p => !done.has(p.id)) : null;
  const due = selfieDue();
  html(`
    <div><div class="small mono">${esc(S.route?.name || '')}・${esc(S.patrol.shift || '')}・開始 ${hm(S.patrol.started_at)}</div>
      <h2>巡邏中 ${done.size}/${pts.length}</h2></div>
    <div class="prog" role="progressbar" aria-valuenow="${done.size}" aria-valuemax="${pts.length}"><b style="width:${pts.length ? done.size / pts.length * 100 : 0}%"></b></div>
    <div class="small" id="elapsed">已進行 ${mins(S.patrol.started_at, new Date())} 分鐘</div>
    ${due ? '<div class="banner warn"><span>請完成一次身分確認自拍</span><button class="btn sm vest" id="do-selfie">自拍</button></div>' : ''}
    <div class="pts">${pts.map((p, i) => {
      const s = byCp[p.id];
      const [cls, txt] = s ? (s.status === 'abnormal' ? ['abn', '異常 ' + hm(s.server_at)] : ['done', '完成 ' + hm(s.server_at)])
        : pend.has(p.id) ? ['sync', '待上傳'] : p === next ? ['todo', '下一站'] : ['todo', '待巡'];
      return `<div class="pt"><span>${S.route.mode === 'ordered' ? `<b class="mono">${i + 1}.</b> ` : ''}<span class="mono small">${esc(p.code)}</span> ${esc(p.name)}</span><span class="st ${cls}">${txt}</span></div>`;
    }).join('')}</div>
    <button class="btn vest block" id="scan">掃描據點 QR Code</button>
    <div class="row"><button class="btn ghost" id="inc">回報事件</button><button class="btn ghost" id="end">結束巡邏</button></div>
    ${sosHtml()}`);
  bindSOS();
  $('#scan').onclick = () => go('scan');
  $('#inc').onclick = () => go('incident');
  $('#end').onclick = () => go('end');
  $('#do-selfie')?.addEventListener('click', () => go('selfie'));
  const t = setInterval(() => { const el = $('#elapsed'); if (el) el.textContent = `已進行 ${mins(S.patrol.started_at, new Date())} 分鐘`; }, 30000);
  cleanup = () => clearInterval(t);
};

// ---------- 畫面：掃描 ----------
V.scan = () => {
  const pts = S.route?.points || [];
  html(`<h2>掃描據點</h2>
    <div class="cam"><video id="vid" playsinline muted></video><div class="frame"></div><div class="hint" id="hint">將據點 QR Code 置於框內</div></div>
    <div class="banner warn" id="camErr" hidden></div>
    ${DEMO ? `<div class="card stack"><div class="small"><b>示範模式</b>：沒有實體 QR 標籤時，點選下方據點即代表掃描成功。最後一個按鈕模擬「在值班室掃描翻拍的 QR」，用來測試位置驗證。</div>
      <div class="row">${pts.map(p => `<button class="btn ghost sm" data-demo="${esc(p.code)}">${esc(p.code)} ${esc(p.name)}</button>`).join('')}</div>
      ${pts[0] ? `<button class="btn ghost sm" data-demo="${esc(pts.find(p => p.enforce_fence)?.code || pts[0].code)}" data-far="1">在值班室掃描翻拍 QR（位置不符）</button>` : ''}</div>` : ''}
    <button class="btn ghost block" id="back">返回</button>`);
  $('#back').onclick = () => go('patrol');
  let stopLoop = () => {};
  const video = $('#vid');
  const listen = () => { stopLoop = cam.scanLoop(video, handle); };
  cam.startCamera(video, 'environment').then(listen).catch(e => { $('#camErr').hidden = false; $('#camErr').textContent = e.message; $('.cam').hidden = true; });
  cleanup = () => stopLoop();

  async function handle(text, far = false) {
    const q = cam.parseQR(text);
    const retry = msg => { toast(msg, 'bad'); setTimeout(listen, 1500); };
    if (!q) return retry('這不是巡邏據點的 QR Code');
    const cp = pts.find(p => p.code === q.code);
    if (!cp) return retry(`${q.code} 不在本次巡邏路線`);
    if (doneCheckpointIds().has(cp.id)) return retry(`${cp.code} ${cp.name} 本場次已完成`);
    navigator.vibrate?.(60);
    $('#hint').textContent = '掃描成功，定位中…';
    const pos = await locate(cp, { far });
    if (pos && cp.lat != null && cp.enforce_fence && pos.acc <= CONFIG.RULES.BLOCK_MAX_ACC_M) {
      const d = distanceM(pos.lat, pos.lng, cp.lat, cp.lng), tol = cp.radius_m + Math.min(pos.acc, CONFIG.RULES.FENCE_TOLERANCE_MAX_M);
      if (d > tol) { $('#hint').textContent = '將據點 QR Code 置於框內'; return retry(`位置驗證失敗：距離 ${cp.name} ${Math.round(d)} 公尺，請到據點現場掃描`); }
    }
    if (!pos && cp.enforce_fence) { $('#hint').textContent = '將據點 QR Code 置於框內'; return retry('無法取得定位，請開啟 GPS 並允許網站使用位置'); }
    S.cur = { cp, code: q.code, token: q.token, pos, deviceAt: new Date().toISOString() };
    go('record');
  }
  $$('[data-demo]').forEach(b => b.addEventListener('click', () => {
    const cp = pts.find(p => p.code === b.dataset.demo);
    stopLoop();
    handle(cam.qrPayload(cp.code, cp._demoToken), !!b.dataset.far);
  }));
};

// ---------- 畫面：定點紀錄 ----------
V.record = () => {
  const c = S.cur; if (!c) return go('patrol');
  const { cp, pos } = c;
  const dist = pos && cp.lat != null ? Math.round(distanceM(pos.lat, pos.lng, cp.lat, cp.lng)) : null;
  html(`
    <div><div class="small mono">${esc(cp.code)}・${esc(cp.type)}</div><h2>${esc(cp.name)}</h2></div>
    <div class="card"><dl class="kv"><dt>掃描時間</dt><dd class="mono">${hms(c.deviceAt)}</dd>
      <dt>位置</dt><dd>${pos ? `距離據點 ${dist ?? '—'} 公尺・誤差 ±${pos.acc} 公尺` : '無定位（室內點）'}</dd></dl></div>
    <section class="stack"><b>現場照片（至少 ${cp.min_photos} 張）</b><div class="stack" id="pw"></div></section>
    ${cp.checklist?.length ? `<section><b>檢查項目</b><div class="checks">${cp.checklist.map((x, i) => `<label><input type="checkbox" id="ck${i}"> ${esc(x)}</label>`).join('')}</div></section>` : ''}
    <div class="seg" role="radiogroup" aria-label="巡查結果">
      <label><input type="radio" name="st" value="normal" checked>正常</label>
      <label><input type="radio" name="st" value="abnormal">異常</label></div>
    <div id="abn" class="stack" hidden>
      <label class="f">異常類別<select id="cat">${opts(CONFIG.ABNORMAL_CATEGORIES)}</select></label>
      <label class="f">嚴重度<select id="sev">${opts(CONFIG.SEVERITIES)}</select></label>
    </div>
    <label class="f"><span id="note-l">備註（選填）</span><textarea id="note" rows="3" placeholder="例：3 樓東側窗戶未關，已關閉並上鎖"></textarea></label>
    <button class="btn vest block" id="save">完成定點巡查</button>
    <button class="btn ghost block" id="cancel">取消</button>`);
  const pw = photoWidget($('#pw'), { lines: stampLines(`${cp.code} ${cp.name}`) });
  $$('input[name=st]').forEach(r => r.addEventListener('change', () => {
    const abn = $('input[name=st]:checked').value === 'abnormal';
    $('#abn').hidden = !abn; $('#note-l').textContent = abn ? '異常說明（必填）' : '備註（選填）';
  }));
  $('#cancel').onclick = () => { S.cur = null; go('patrol'); };
  $('#save').onclick = async e => {
    const btn = e.currentTarget;
    const status = $('input[name=st]:checked').value;
    const checklist = Object.fromEntries((cp.checklist || []).map((x, i) => [x, $('#ck' + i).checked]));
    const note = $('#note').value.trim();
    if (pw.photos.length < cp.min_photos) return toast(`請至少拍攝 ${cp.min_photos} 張現場照片`, 'bad');
    if (status === 'normal' && Object.values(checklist).some(v => !v)) return toast('尚有檢查項目未勾選。若現場有異常，請切換為「異常」並說明', 'bad');
    if (status === 'abnormal' && !note) return toast('異常狀態需填寫說明', 'bad');
    btn.disabled = true; btn.textContent = '上傳中…';
    const payload = {
      patrolId: S.patrol.id, code: c.code, token: c.token, deviceId: S.deviceId,
      lat: pos?.lat ?? null, lng: pos?.lng ?? null, acc: pos?.acc ?? null, deviceAt: c.deviceAt,
      status, checklist, category: status === 'abnormal' ? $('#cat').value : '', severity: status === 'abnormal' ? $('#sev').value : '', note,
      photoHashes: pw.photos.map(p => p.hash), clientFlags: pw.nonLive ? ['NON_LIVE_PHOTO'] : [],
    };
    try {
      const r = await submitOrQueue('scan', payload, pw.photos.map(p => p.blob), 'scan');
      if (r.ok) {
        S.scans.push(r.result);
        const f = r.result.flags || [];
        toast(f.length ? `已完成，將由主管覆核：${f.map(flagLabel).join('、')}` : `${cp.name} 巡查完成`);
      } else toast('目前離線，紀錄已暫存，恢復連線後自動上傳');
      if (status === 'abnormal' && payload.severity === '緊急') toast('緊急異常已送出。請同時以電話或無線電通報值班主管', 'bad');
      S.cur = null;
      go(selfieDue() ? 'selfie' : 'patrol');
    } catch (err) {
      toast(err.message, 'bad');
      btn.disabled = false; btn.textContent = '完成定點巡查';
      if (/位置|QR|路線|已完成|已結束|裝置/.test(err.message)) { S.cur = null; setTimeout(() => go('patrol'), 1500); }
    }
  };
};

// ---------- 畫面：自拍確認 ----------
V.selfie = () => {
  const due = selfieDue(); if (!due) return go('patrol');
  html(`<h2>身分確認</h2>
    <p style="margin:0">請拍攝一張清楚的正面自拍，供主管確認為本人巡邏。</p>
    <div class="stack" id="pw"></div>
    <button class="btn vest block" id="send">送出</button>
    <button class="btn ghost block" id="later">稍後再拍</button>`);
  const pw = photoWidget($('#pw'), { max: 1, facing: 'user', lines: stampLines('身分確認自拍') });
  $('#later').onclick = () => go('patrol');
  $('#send').onclick = async e => {
    if (!pw.photos.length) return toast('請先拍攝自拍照', 'bad');
    e.currentTarget.disabled = true;
    try {
      const r = await submitOrQueue('selfie', { patrolId: S.patrol.id, requestedAt: due.requestedAt, takenAt: new Date().toISOString() }, [pw.photos[0].blob], 'selfie');
      const p = selfiePlan(); p.done.push(due.k); p.pending = null; saveSelfiePlan(p);
      toast(r.ok ? '身分確認已送出' : '目前離線，已暫存');
      go('patrol');
    } catch (err) { toast(err.message, 'bad'); e.currentTarget.disabled = false; }
  };
};

// ---------- 畫面：事件回報 ----------
V.incident = () => {
  html(`<h2>回報事件</h2>
    <div class="small">用於據點以外的突發狀況。系統自動附上目前位置與時間，送出後即時通知主管。</div>
    <label class="f">事件類型<select id="type">${opts(CONFIG.INCIDENT_TYPES)}</select></label>
    <label class="f">嚴重度<select id="sev">${opts(CONFIG.SEVERITIES, '中')}</select></label>
    <label class="f">處置方式<select id="hd">${opts(CONFIG.INCIDENT_HANDLING)}</select></label>
    <label class="f">描述（必填）<textarea id="desc" rows="4" placeholder="時間、地點、人員特徵、處置經過"></textarea></label>
    <details class="card"><summary>附加照片（選填）</summary><div class="stack" id="pw" style="margin-top:10px"></div></details>
    <button class="btn vest block" id="send">送出事件單</button>
    <button class="btn ghost block" id="back">返回</button>`);
  let pw = null;
  $('details').addEventListener('toggle', e => { if (e.target.open && !pw) pw = photoWidget($('#pw'), { lines: stampLines('事件回報') }); });
  $('#back').onclick = () => go(S.patrol ? 'patrol' : 'home');
  $('#send').onclick = async e => {
    const desc = $('#desc').value.trim();
    if (!desc) return toast('請填寫事件描述', 'bad');
    e.currentTarget.disabled = true;
    const pos = await locate(null);
    try {
      const r = await submitOrQueue('incident', { patrolId: S.patrol?.id || null, type: $('#type').value, severity: $('#sev').value, handling: $('#hd').value,
        description: desc, lat: pos?.lat ?? null, lng: pos?.lng ?? null, deviceAt: new Date().toISOString() }, (pw?.photos || []).map(p => p.blob), 'incident');
      toast(r.ok ? '事件單已送出，主管已收到通知' : '目前離線，事件單已暫存');
      go(S.patrol ? 'patrol' : 'home');
    } catch (err) { toast(err.message, 'bad'); e.currentTarget.disabled = false; }
  };
};

// ---------- 畫面：結束巡邏 ----------
V.end = () => {
  const pts = S.route?.points || [];
  const done = doneCheckpointIds();
  const miss = pts.filter(p => !done.has(p.id));
  const abn = S.scans.filter(s => s.status === 'abnormal').length;
  html(`<h2>結束巡邏</h2>
    <div class="card"><dl class="kv">
      <dt>開始</dt><dd class="mono">${dt(S.patrol.started_at)}</dd><dt>目前</dt><dd class="mono">${dt(new Date())}</dd>
      <dt>完成據點</dt><dd>${done.size}/${pts.length}</dd><dt>異常</dt><dd>${abn} 件</dd>
      <dt>待上傳</dt><dd>${S.queue.length} 筆</dd></dl></div>
    ${miss.length ? `<section class="stack"><b>未巡據點須說明原因</b>${miss.map(p => `<label class="f">${esc(p.code)} ${esc(p.name)}
      <select data-miss="${p.id}"><option value="">請選擇原因</option>${opts(CONFIG.MISSED_REASONS)}</select></label>`).join('')}</section>`
      : '<span class="chip ok"><span class="dot"></span>全部據點已完成</span>'}
    <section><b>交接清點</b><div class="checks">${CONFIG.HANDOVER_ITEMS.map((x, i) => `<label><input type="checkbox" id="ho${i}"> ${esc(x)} 已交接</label>`).join('')}</div></section>
    <label class="f">交接事項<textarea id="note" rows="3" placeholder="未結案事件、需下一班注意的狀況"></textarea></label>
    <button class="btn vest block" id="fin">確認結束並送出</button>
    <button class="btn ghost block" id="back">繼續巡邏</button>`);
  $('#back').onclick = () => go('patrol');
  $('#fin').onclick = async e => {
    const btn = e.currentTarget;
    const missed = $$('[data-miss]').map(s => ({ checkpoint_id: s.dataset.miss, reason: s.value }));
    if (missed.some(m => !m.reason)) return toast('請為每個未巡據點選擇原因', 'bad');
    if (!navigator.onLine) return toast('結束巡邏需要網路連線，請移至有訊號處再送出', 'bad');
    btn.disabled = true; btn.textContent = '上傳暫存資料…';
    await sync();
    if (S.queue.some(q => q.payload?.patrolId === S.patrol.id && q.type !== 'track')) {
      btn.disabled = false; btn.textContent = '確認結束並送出';
      return toast('尚有巡查紀錄未上傳完成，請稍後再試', 'bad');
    }
    try {
      const handoverItems = Object.fromEntries(CONFIG.HANDOVER_ITEMS.map((x, i) => [x, $('#ho' + i).checked]));
      const status = selfieStatus();
      await api.endPatrol({ patrolId: S.patrol.id, missed, handoverItems, handoverNote: $('#note').value.trim(), selfieStatus: status });
      try { localStorage.removeItem(selfieKey()); } catch { /* 略過 */ }
      stopTracking(); keepAwake(false);
      const id = S.patrol.id;
      S.patrol = null; S.scans = []; S.route = null;
      toast('巡邏已結束，定位記錄停止');
      go('detail', id);
    } catch (err) { toast(err.message, 'bad'); btn.disabled = false; btn.textContent = '確認結束並送出'; }
  };
};

// ---------- 畫面：我的紀錄 ----------
V.history = async () => {
  html('<h2>我的巡查紀錄</h2><p class="empty">載入中…</p>');
  const rows = await api.myPatrols();
  html(`<h2>我的巡查紀錄</h2><div class="small">只顯示本人的巡邏紀錄。</div>
    ${rows.length ? rows.map(r => `<button class="card" data-id="${r.id}" style="text-align:left;font:inherit;color:inherit;cursor:pointer">
      <div style="display:flex;justify-content:space-between;gap:8px"><b>${ymd(r.started_at)} ${esc(r.shift || '')}</b>${r.status === 'active' ? '<span class="chip vest">進行中</span>' : r.is_sample ? '<span class="chip">示例</span>' : ''}</div>
      <div class="small">${esc(r.route_name)}・${hm(r.started_at)}–${r.ended_at ? hm(r.ended_at) : '—'}</div>
      <div class="flags" style="margin-top:6px"><span class="chip">完成 ${r.scan_count}/${r.point_count}</span>
        ${r.abnormal_count ? `<span class="chip bad">異常 ${r.abnormal_count}</span>` : ''}
        ${r.missed?.length ? `<span class="chip warn">未巡 ${r.missed.length}</span>` : ''}
        ${r.flagged_count ? `<span class="chip warn">待覆核 ${r.flagged_count}</span>` : ''}</div></button>`).join('')
      : '<p class="empty">尚無巡邏紀錄。</p>'}`);
  $$('[data-id]').forEach(b => b.addEventListener('click', () => go('detail', b.dataset.id)));
};

V.detail = async id => {
  html('<p class="empty">載入中…</p>');
  const d = await api.patrolDetail(id);
  const p = d.patrol;
  const cpName = cid => d.route?.points.find(x => x.id === cid)?.name || '';
  html(`<button class="btn ghost sm" id="back" style="align-self:flex-start">← 返回</button>
    <div><div class="small mono">${esc(p.route_name)}</div><h2>${ymd(p.started_at)} ${esc(p.shift || '')}</h2></div>
    <div class="card"><dl class="kv"><dt>時間</dt><dd class="mono">${hm(p.started_at)}–${p.ended_at ? hm(p.ended_at) : '進行中'}</dd>
      <dt>完成</dt><dd>${p.scan_count}/${p.point_count}</dd><dt>天候</dt><dd>${esc(p.weather || '—')}</dd>
      ${p.flags?.length ? `<dt>註記</dt><dd>${p.flags.map(f => `<span class="chip warn">${esc(flagLabel(f))}</span>`).join(' ')}</dd>` : ''}
      ${p.handover_note ? `<dt>交接</dt><dd>${esc(p.handover_note)}</dd>` : ''}</dl></div>
    ${d.scans.map(s => `<div class="card stack" style="gap:6px">
      <div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(s.checkpoint?.code)} ${esc(s.checkpoint?.name)}</b>
        <span class="chip ${s.status === 'abnormal' ? 'bad' : 'ok'}">${s.status === 'abnormal' ? '異常' : '正常'}</span></div>
      <div class="small mono">${hms(s.server_at)}${s.distance_m != null ? `・距離 ${s.distance_m} 公尺` : ''}</div>
      ${s.status === 'abnormal' ? `<div>${esc(s.category)}・${esc(s.severity)}</div>` : ''}${s.note ? `<div>${esc(s.note)}</div>` : ''}
      ${s.flags?.length ? `<div class="flags">${s.flags.map(f => `<span class="chip warn">${esc(flagLabel(f))}</span>`).join('')}</div>` : ''}
      ${s.photo_paths?.length ? `<div class="photo-grid" data-photos="${esc(JSON.stringify(s.photo_paths))}"></div>` : s.is_sample ? '<div class="small">示例資料沒有照片</div>' : ''}
    </div>`).join('')}
    ${p.missed?.length ? `<div class="card"><b>未巡據點</b>${p.missed.map(m => `<div>${esc(cpName(m.checkpoint_id))}：${esc(m.reason)}</div>`).join('')}</div>` : ''}`);
  $('#back').onclick = () => go('history');
  for (const el of $$('[data-photos]')) {
    for (const path of JSON.parse(el.dataset.photos)) {
      const url = await api.photoUrl(path);
      if (url) el.insertAdjacentHTML('beforeend', `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="巡查照片"></a>`);
    }
  }
};

// ---------- 畫面：設定 ----------
V.settings = async () => {
  const canBio = await bio.available();
  const hasBio = !!bio.storedCredential(S.profile.id);
  const face = faceReady();
  const staff = ['supervisor', 'admin'].includes(S.profile.role);
  html(`<h2>設定</h2>
    <div class="card"><dl class="kv"><dt>姓名</dt><dd>${esc(S.profile.name)}</dd><dt>工號</dt><dd class="mono">${esc(S.profile.staff_no)}</dd>
      <dt>本機代碼</dt><dd class="mono">${esc(S.deviceId.slice(0, 8))}</dd><dt>裝置</dt><dd>${esc(deviceLabel())}</dd></dl></div>
    ${face ? `<section class="card stack"><b>登入方式</b>
      <div class="small">這支手機已註冊臉部辨識登入，每次開啟只要掃臉即可報到。換手機或重設 Face ID 後，需重新申請。</div></section>` : `
    <section class="card stack"><b>指紋／臉部辨識</b>
      <div class="small">${!canBio ? '此手機或瀏覽器不支援。iPhone 請用 Safari 並將本網站「加入主畫面」；Android 請用 Chrome。'
        : hasBio ? '已啟用。開始巡邏時需通過驗證。' : '啟用後，每次開始巡邏都需以本人指紋或臉部解鎖。'}</div>
      ${canBio ? `<button class="btn ${hasBio ? 'ghost' : 'vest'} block" id="bio">${hasBio ? '重新設定' : '啟用'}</button>` : ''}</section>
    <section class="card stack"><b>變更密碼</b>
      <form id="pwf" class="stack" novalidate>
        <label class="f">目前密碼<input id="pw-old" type="password" autocomplete="current-password" required></label>
        <label class="f">新密碼（至少 8 碼）<input id="pw-new" type="password" autocomplete="new-password" minlength="8" required></label>
        <label class="f">再輸入一次新密碼<input id="pw-new2" type="password" autocomplete="new-password" required></label>
        <button class="btn ghost block">變更密碼</button></form>
      <div class="small">忘記密碼請洽班長或總務處重設。</div></section>`}
    <section class="card stack"><b>離線暫存</b>
      <div class="small">尚未上傳 ${S.queue.length} 筆。恢復連線後會自動上傳。</div>
      <button class="btn ghost block" id="sync" ${S.queue.length ? '' : 'disabled'}>立即上傳</button></section>
    ${DEMO ? `<section class="card stack"><b>示範模式工具</b>
      <label style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="sim" ${simOn() ? 'checked' : ''}> 模擬定位在據點現場（不在校園時使用）</label>
      <button class="btn ghost block" id="reset">清除所有示範資料</button></section>` : ''}
    ${staff ? '<a class="btn ghost block" href="admin.html">開啟管理後台</a>' : ''}
    <button class="btn ghost block" id="logout">登出</button>
    <div class="small">緊急聯絡：${CONFIG.SOS_PHONES.map(p => `${esc(p.label)} <span class="mono">${esc(p.number)}</span>`).join('；')}</div>`);
  $('#bio')?.addEventListener('click', async () => {
    try { await bio.enroll(S.profile); toast('生物辨識已啟用'); go('settings'); } catch (e) { toast('設定未完成：' + e.message, 'bad'); }
  });
  $('#pwf')?.addEventListener('submit', async e => {
    e.preventDefault();
    const o = $('#pw-old').value, n = $('#pw-new').value;
    if (n.length < 8) return toast('新密碼至少 8 碼', 'bad');
    if (n !== $('#pw-new2').value) return toast('兩次輸入的新密碼不一致', 'bad');
    if (n === o) return toast('新密碼不可與目前密碼相同', 'bad');
    try { await api.changePassword(o, n); toast('密碼已變更，下次登入請使用新密碼'); e.target.reset(); } catch (err) { toast(err.message, 'bad'); }
  });
  $('#sync').onclick = () => sync().then(() => go('settings'));
  $('#sim')?.addEventListener('change', e => { try { localStorage.setItem('yzup-sim-gps', e.target.checked ? 'on' : 'off'); } catch { /* 略過 */ } if (S.patrol) startTracking(); });
  $('#reset')?.addEventListener('click', async e => {
    if (e.currentTarget.dataset.armed !== '1') { e.currentTarget.dataset.armed = '1'; e.currentTarget.textContent = '再按一次確認清除'; return; }
    await api.resetDemo(); await queueStore.clear(); localStorage.clear(); location.reload();
  });
  $('#logout').onclick = async e => {
    if (S.patrol && e.currentTarget.dataset.armed !== '1') { e.currentTarget.dataset.armed = '1'; e.currentTarget.textContent = '巡邏尚未結束，再按一次仍要登出'; return; }
    stopTracking(); keepAwake(false); await api.logout(); Object.assign(S, { profile: null, patrol: null, scans: [], route: null, uvAt: 0 }); go(faceReady() ? 'unlock' : 'welcome');
  };
};

// ---------- 啟動 ----------
(async function boot() {
  S.deviceId = getDeviceId();
  await refreshQueue();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  const pk = PK.get();
  if (pk?.status === 'pending') return go('pending');
  // 已註冊臉部登入的手機：每次開啟都要掃臉，避免手機交給他人使用
  if (pk?.status === 'approved') return go('unlock');
  try {
    S.profile = await api.currentProfile();
    if (S.profile) { await afterLogin(); sync(); return; }
  } catch (e) {
    if (isNetworkError(e)) toast('無法連線伺服器，請確認網路', 'bad');
  }
  go('welcome');
})();
