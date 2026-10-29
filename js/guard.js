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
const S = { profile: null, deviceId: null, routes: [], route: null, patrol: null, scans: [], reported: new Set(), cur: null, lastPos: null, queue: [], screen: '', uvAt: 0 };
const PRE_LOGIN = ['login', 'device', 'welcome', 'register', 'pending', 'unlock'];

// 本機的臉部登入資料：{ credentialId, requestId, staffNo, name, status, simulated }
const store = key => ({
  get() { try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; } },
  set(v) { try { v ? localStorage.setItem(key, JSON.stringify(v)) : localStorage.removeItem(key); } catch { /* 無法保存時略過 */ } },
});
const PK = store('yzup-passkey');
const LAST = store('yzup-last');   // 上次使用的路線，供一鍵開始巡邏
const faceReady = () => PK.get()?.status === 'approved';
const postLabel = id => CONFIG.POSTS.find(p => p.id === id)?.label || id || '';
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
  const tab = ['home', 'patrol', 'scan', 'record', 'incident', 'abnormal', 'done', 'end', 'finished', 'selfie'].includes(name) ? 'patrol' : ['history', 'detail'].includes(name) ? 'history' : name;
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
    <div><h2>申請註冊</h2><div class="small">填好後按最下面的按鈕，再看著手機掃臉。班長核准後就能使用。</div></div>
    ${!ok ? `<div class="banner warn">這支手機無法使用臉部辨識。iPhone 請用 Safari、Android 請用 Chrome 開啟，並確認手機已設定 Face ID 或指紋。</div>` : ''}
    <form id="rf" class="stack" novalidate>
      <div class="stack" style="gap:6px"><b>我的崗位</b>
        <div class="choices" role="radiogroup" aria-label="崗位">${CONFIG.POSTS.map((p, i) => `<label class="choice"><input type="radio" name="post" value="${esc(p.id)}"${i === 0 ? '' : ''}><span>${esc(p.label)}</span></label>`).join('')}</div></div>
      <label class="f">工號<input id="r-no" autocapitalize="characters" autocomplete="off" required placeholder="例：G1030"></label>
      <label class="f">姓名<input id="r-name" autocomplete="name" required></label>
      <label class="f">手機號碼（可不填）<input id="r-phone" type="tel" autocomplete="tel" inputmode="tel"></label>
      <details class="card small"><summary>個人資料蒐集告知（請點開閱讀）</summary><p style="margin:8px 0 0">${privacyText()}</p></details>
      <label class="agree"><input type="checkbox" id="r-ok"> 我已閱讀並同意</label>
      <button class="btn vest block big" id="r-go" ${ok ? '' : 'disabled'}>送出申請（接著掃臉）</button>
    </form>
    ${DEMO ? '<button class="btn ghost block" id="r-sim">用模擬臉部辨識送出（電腦測試用）</button>' : ''}`);
  $('#back').onclick = () => go('welcome');
  const submit = async simulate => {
    const info = { staff_no: $('#r-no').value.trim().toUpperCase(), name: $('#r-name').value.trim(), phone: $('#r-phone').value.trim(),
      post: $('input[name=post]:checked')?.value || '' };
    if (!info.post) return toast('請選擇崗位：大門或側門', 'bad');
    if (!/^[A-Z0-9_-]{2,20}$/.test(info.staff_no)) return toast('請填寫正確的工號（英文字母或數字）', 'bad');
    if (!info.name) return toast('請填寫姓名', 'bad');
    if (!$('#r-ok').checked) return toast('請勾選「我已閱讀並同意」', 'bad');
    const btn = $('#r-go'); btn.disabled = true; btn.textContent = '請看著手機掃臉…';
    try {
      const r = await api.passkeyRegister({ ...info, deviceId: S.deviceId, deviceLabel: deviceLabel(), simulate });
      PK.set({ credentialId: r.credentialId, requestId: r.requestId, staffNo: info.staff_no, name: info.name, post: info.post, status: 'pending', simulated: !!simulate, at: new Date().toISOString() });
      go('pending');
    } catch (e) { toast(e.message, 'bad'); btn.disabled = !ok; btn.textContent = '送出申請（接著掃臉）'; }
  };
  $('#rf').addEventListener('submit', e => { e.preventDefault(); submit(false); });
  $('#r-sim')?.addEventListener('click', () => submit(true));
};

// ---------- 畫面：等待核准 ----------
V.pending = () => {
  const pk = PK.get(); if (!pk) return go('welcome');
  html(`<h2>申請已送出</h2>
    <div class="card"><dl class="kv"><dt>崗位</dt><dd>${esc(postLabel(pk.post))}</dd><dt>工號</dt><dd class="mono">${esc(pk.staffNo)}</dd><dt>姓名</dt><dd>${esc(pk.name)}</dd><dt>送出時間</dt><dd class="mono">${dt(pk.at)}</dd></dl></div>
    <div id="st"><p style="margin:0">請告訴班長「我已經申請了」。班長核准後，這個畫面會自動換到下一步。</p></div>
    <button class="btn vest block big" id="chk">重新檢查</button>
    <button class="btn ghost block" id="redo">取消申請，重新填寫</button>`);
  const check = async manual => {
    const r = await api.registrationStatus(pk.requestId, S.deviceId);
    if (r.status === 'approved') { PK.set({ ...pk, status: 'approved' }); toast('申請已核准'); return go('unlock'); }
    if (r.status === 'rejected') {
      $('#st').innerHTML = `<div class="banner bad"><div><b>申請沒有通過</b>：${esc(r.reason || '')}<br>請重新申請，或洽班長。</div></div>`;
      $('#chk').hidden = true; $('#redo').textContent = '重新申請';
      return;
    }
    if (r.status === 'missing') { PK.set(null); toast('找不到申請資料，請重新申請', 'bad'); return go('register'); }
    if (manual) toast('還沒核准，請稍等');
  };
  $('#chk').onclick = () => check(true).catch(showError);
  $('#redo').onclick = () => { PK.set(null); go('register'); };
  const t = setInterval(() => check(false).catch(() => {}), 15000);
  cleanup = () => clearInterval(t);
  check(false).catch(() => {});
};

// ---------- 畫面：掃臉開始巡邏（日常使用） ----------
async function faceLogin() {
  const pk = PK.get();
  S.profile = await api.passkeyLogin({ credentialId: pk.credentialId, deviceId: S.deviceId, simulate: pk.simulated });
  S.uvAt = Date.now();
  sync();
}
// 選路線：上次用過的 → 崗位只有一條就直接用 → 否則讓巡邏員選
function pickRoute() {
  const last = LAST.get();
  return S.routes.find(r => r.id === last?.routeId) || (S.routes.length === 1 ? S.routes[0] : null);
}
V.unlock = () => {
  const pk = PK.get(); if (!pk) return go('welcome');
  html(`
    <div style="text-align:center" class="stack">
      <svg width="96" height="96" viewBox="0 0 88 88" aria-hidden="true" style="margin:8px auto 0;display:block">
        <g fill="none" stroke="var(--vest)" stroke-width="5" stroke-linecap="round">
          <path d="M8 26V14a6 6 0 0 1 6-6h12M62 8h12a6 6 0 0 1 6 6v12M80 62v12a6 6 0 0 1-6 6H62M26 80H14a6 6 0 0 1-6-6V62"/>
          <path d="M30 32v6M58 32v6M44 34v14h-4M32 60c7 6 17 6 24 0"/></g></svg>
      <div><h2 class="hello">${esc(pk.name)}，您好</h2><div class="post-tag">${esc(postLabel(pk.post))}</div></div>
      <div class="bigclock mono" id="clock">${hm(new Date())}</div><div class="small">${ymd(new Date())}</div>
    </div>
    <button class="btn vest block huge" id="u-start">掃臉，開始巡邏</button>
    <button class="btn ghost block" id="u-in">只進入，先不巡邏</button>
    <details class="card small"><summary>掃臉一直失敗？</summary>
      <p>請確認手機的 Face ID 或指紋可以正常解鎖手機。換了新手機或重設 Face ID，需要重新申請，並請班長核准。</p>
      <div class="stack"><button class="btn ghost block" id="u-re">重新申請這支手機</button>
      <button class="btn ghost block" id="u-pw">改用工號密碼登入</button></div></details>
    ${sosHtml()}`);
  bindSOS();
  const clk = setInterval(() => { const c = $('#clock'); if (c) c.textContent = hm(new Date()); }, 5000);
  cleanup = () => clearInterval(clk);
  const busy = (btn, on, text) => { $$('#u-start, #u-in').forEach(b => (b.disabled = on)); btn.textContent = text; };
  $('#u-start').onclick = async e => {
    const btn = e.currentTarget; busy(btn, true, '請看著手機…');
    try {
      await faceLogin();
      const st = await api.registerDevice(S.deviceId, deviceLabel());
      if (st !== 'active') return go('device', st);
      S.routes = await api.getRoutes();
      const ap = await api.getActivePatrol();
      if (ap) { toast('繼續剛才的巡邏'); return afterLogin(); }
      const route = pickRoute();
      if (!route) return go('home');
      await startPatrolWith(route.id, true);
    } catch (err) { toast(err.message, 'bad'); busy(btn, false, '掃臉，開始巡邏'); }
  };
  $('#u-in').onclick = async e => {
    const btn = e.currentTarget; busy(btn, true, '請看著手機…');
    try { await faceLogin(); await afterLogin(); } catch (err) { toast(err.message, 'bad'); busy(btn, false, '只進入，先不巡邏'); }
  };
  $('#u-re').onclick = e => {
    if (e.currentTarget.dataset.armed !== '1') { e.currentTarget.dataset.armed = '1'; e.currentTarget.textContent = '再按一次確認（需要班長重新核准）'; return; }
    PK.set(null); go('register');
  };
  $('#u-pw').onclick = () => go('login');
};

// 開始巡邏：日期時間由伺服器記錄，不需選班別或天候
async function startPatrolWith(routeId, uvOk) {
  const pos = await locate(null);
  S.patrol = await api.startPatrol({ routeId, shift: null, weather: null, deviceId: S.deviceId, lat: pos?.lat ?? null, lng: pos?.lng ?? null, uvOk });
  S.scans = []; S.reported = new Set(); S.route = S.routes.find(r => r.id === routeId);
  LAST.set({ routeId, routeName: S.route?.name });
  planSelfies(); startTracking(); keepAwake(true);
  toast('已開始巡邏');
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
      示範帳號：<span class="mono">G1024</span>（大門）、<span class="mono">G1025</span>（側門），密碼 <span class="mono">demo1234</span></div></div>` : ''}
    <form id="f" class="stack" novalidate>
      <label class="f">工號<input id="staff" autocomplete="username" autocapitalize="characters" required></label>
      <label class="f">密碼<input id="pw" type="password" autocomplete="current-password" required></label>
      <button class="btn vest block big" id="login-btn">登入</button>
    </form>
    <details class="card small"><summary>個人資料蒐集告知</summary><p style="margin:8px 0 0">${privacyText()}</p></details>`);
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
    S.patrol = ap.patrol; S.scans = ap.scans; S.reported = S.reported || new Set();
    S.route = S.routes.find(r => r.id === S.patrol.route_id) || null;
    startTracking(); keepAwake(true);
    return go('patrol');
  }
  go('home');
}

V.device = st => {
  html(`<h2>這支手機還不能使用</h2>
    <div class="card stack">
      <p style="margin:0">${st === 'revoked' ? '這支手機已被班長停用。' : '您的帳號已經綁定另一支手機。每個人只能用一支手機巡邏。'}</p>
      <p style="margin:0">如果換了手機，請告訴班長，到管理後台「人員與裝置」核准這支手機。</p>
      <dl class="kv"><dt>手機代碼</dt><dd class="mono">${esc(S.deviceId.slice(0, 8))}</dd><dt>手機類型</dt><dd>${esc(deviceLabel())}</dd></dl>
    </div>
    <button class="btn vest block big" id="retry">班長已核准，重新檢查</button>
    <button class="btn ghost block" id="out">登出</button>`);
  $('#retry').onclick = () => afterLogin().catch(showError);
  $('#out').onclick = async () => { await api.logout(); S.profile = null; go(faceReady() ? 'unlock' : 'welcome'); };
};

// ---------- 畫面：首頁（尚未開始巡邏） ----------
V.home = async () => {
  if (S.patrol) return go('patrol');
  const face = faceReady();
  const hasBio = face || !!bio.storedCredential(S.profile.id);
  const sel = pickRoute()?.id || S.routes[0]?.id;
  html(`
    <div><div class="post-tag">${esc(postLabel(S.profile.post) || '巡邏員')}</div><h2 class="hello">${esc(S.profile.name)}，您好</h2></div>
    <div class="bigclock mono" id="clock">${hm(new Date())}</div><div class="small">${ymd(new Date())}　開始時間由系統自動記錄</div>
    ${S.routes.length > 1 ? `<div class="stack" style="gap:6px"><b>今天巡哪一條路線？</b>
      <div class="choices col" role="radiogroup" aria-label="巡邏路線">${S.routes.map(r => `<label class="choice"><input type="radio" name="route" value="${r.id}"${r.id === sel ? ' checked' : ''}>
        <span>${esc(r.name)}（${r.points.length} 個點）</span></label>`).join('')}</div></div>` : ''}
    ${S.routes.length ? '<button class="btn vest block huge" id="start">開始巡邏</button>' : '<div class="banner warn">目前沒有可用的巡邏路線，請洽班長。</div>'}
    ${!hasBio ? '<button class="btn ghost block" id="go-bio">設定指紋／臉部辨識</button>' : ''}
    ${sosHtml()}`);
  bindSOS();
  const clk = setInterval(() => { const c = $('#clock'); if (c) c.textContent = hm(new Date()); }, 5000);
  cleanup = () => clearInterval(clk);
  $('#go-bio')?.addEventListener('click', () => go('settings'));
  $('#start')?.addEventListener('click', async e => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = '確認身分中…';
    try {
      let uvOk = false;
      try { uvOk = await verifyIdentity(); } catch (err) { if (face) throw err; }
      if (!uvOk && CONFIG.REQUIRE_BIOMETRIC) throw new Error(hasBio ? '身分確認沒有通過，無法開始巡邏' : '請先到「設定」啟用指紋或臉部辨識');
      btn.textContent = '開始中…';
      await startPatrolWith($('input[name=route]:checked')?.value || S.routes[0].id, uvOk);
    } catch (err) { toast(err.message, 'bad'); btn.disabled = false; btn.textContent = '開始巡邏'; }
  });
};

// ---------- 畫面：巡邏中 ----------
V.patrol = () => {
  if (!S.patrol) return go('home');
  S.reported = S.reported || new Set();
  const pts = S.route?.points || [];
  const done = doneCheckpointIds(), pend = pendingIds();
  const byCp = Object.fromEntries(S.scans.map(s => [s.checkpoint_id, s]));
  const next = S.route?.mode === 'ordered' ? pts.find(p => !done.has(p.id)) : null;
  const due = selfieDue();
  const all = pts.length && done.size >= pts.length;
  html(`
    <div><div class="post-tag">${esc(postLabel(S.patrol.post) || S.route?.name || '')}巡邏中</div>
      <div class="count"><b>${done.size}</b> / ${pts.length} 個點</div></div>
    <div class="prog big" role="progressbar" aria-valuenow="${done.size}" aria-valuemax="${pts.length}"><b style="width:${pts.length ? done.size / pts.length * 100 : 0}%"></b></div>
    ${due ? '<div class="banner warn"><span>請拍一張自拍確認身分</span><button class="btn sm vest" id="do-selfie">自拍</button></div>' : ''}
    ${all ? '<div class="banner ok-banner">全部的點都巡完了，請按下方「送出今日巡邏結果」。</div>'
      : '<button class="btn vest block huge" id="scan">掃描 QR Code</button>'}
    <div class="pts big">${pts.map((p, i) => {
      const s = byCp[p.id];
      const [cls, txt] = s ? ['done', '✓ ' + hm(s.server_at)] : pend.has(p.id) ? ['sync', '✓ 待上傳'] : p === next ? ['todo', '下一個'] : ['todo', '還沒巡'];
      return `<div class="pt"><span>${S.route.mode === 'ordered' ? `<b class="mono">${i + 1}.</b> ` : ''}${esc(p.name)}${S.reported.has(p.id) ? ' <span class="chip bad">已回報異常</span>' : ''}</span><span class="st ${cls}">${txt}</span></div>`;
    }).join('')}</div>
    <button class="btn ${all ? 'vest' : ''} block big" id="end">送出今日巡邏結果</button>
    <button class="btn ghost block" id="inc">回報異常（不在巡邏點上）</button>
    ${sosHtml()}`);
  bindSOS();
  $('#scan')?.addEventListener('click', () => go('scan'));
  $('#inc').onclick = () => go('abnormal', {});
  $('#end').onclick = () => go('end');
  $('#do-selfie')?.addEventListener('click', () => go('selfie'));
};

// ---------- 畫面：掃描 ----------
V.scan = () => {
  const pts = S.route?.points || [];
  html(`<h2>對準 QR Code</h2>
    <div class="cam"><video id="vid" playsinline muted></video><div class="frame"></div><div class="hint" id="hint">把巡邏點的 QR Code 放進框框裡</div></div>
    <div class="banner warn" id="camErr" hidden></div>
    ${DEMO ? `<div class="card stack"><div class="small"><b>示範模式</b>：沒有實體 QR 標籤時，點選下方據點即代表掃描成功。最後一個按鈕模擬「在值班室掃描翻拍的 QR」，用來測試位置驗證。</div>
      <div class="row">${pts.map(p => `<button class="btn ghost sm" data-demo="${esc(p.code)}">${esc(p.code)} ${esc(p.name)}</button>`).join('')}</div>
      ${pts[0] ? `<button class="btn ghost sm" data-demo="${esc(pts.find(p => p.enforce_fence)?.code || pts[0].code)}" data-far="1">在值班室掃描翻拍 QR（位置不符）</button>` : ''}</div>` : ''}
    <button class="btn ghost block big" id="back">返回</button>`);
  $('#back').onclick = () => go('patrol');
  let stopLoop = () => {};
  const video = $('#vid');
  const listen = () => { stopLoop = cam.scanLoop(video, handle); };
  cam.startCamera(video, 'environment').then(listen).catch(e => { $('#camErr').hidden = false; $('#camErr').textContent = e.message; $('.cam').hidden = true; });
  cleanup = () => stopLoop();

  async function handle(text, far = false) {
    const q = cam.parseQR(text);
    const retry = msg => { toast(msg, 'bad'); navigator.vibrate?.([80, 60, 80]); $('#hint') && ($('#hint').textContent = '把巡邏點的 QR Code 放進框框裡'); setTimeout(listen, 1800); };
    if (!q) return retry('這不是巡邏點的 QR Code');
    const cp = pts.find(p => p.code === q.code);
    if (!cp) return retry(`「${q.code}」不是您的巡邏點`);
    if (doneCheckpointIds().has(cp.id)) return retry(`${cp.name} 已經巡過了`);
    navigator.vibrate?.(60);
    $('#hint').textContent = '掃到了，正在記錄位置…';
    const pos = await locate(cp, { far });
    if (pos && cp.lat != null && cp.enforce_fence && pos.acc <= CONFIG.RULES.BLOCK_MAX_ACC_M) {
      const d = distanceM(pos.lat, pos.lng, cp.lat, cp.lng), tol = cp.radius_m + Math.min(pos.acc, CONFIG.RULES.FENCE_TOLERANCE_MAX_M);
      if (d > tol) return retry(`位置不對：離「${cp.name}」還有 ${Math.round(d)} 公尺，請走到巡邏點再掃`);
    }
    if (!pos && cp.enforce_fence) return retry('抓不到位置，請開啟手機定位（GPS）');
    S.cur = { cp, code: q.code, token: q.token, pos, deviceAt: new Date().toISOString() };
    // 一般據點：掃到就自動記錄；需要照片的據點才進入拍照
    if ((cp.min_photos || 0) > 0) return go('record');
    try { await saveScan([], false); }
    catch (err) { S.cur = null; retry(err.message); }
  }
  $$('[data-demo]').forEach(b => b.addEventListener('click', () => {
    const cp = pts.find(p => p.code === b.dataset.demo);
    stopLoop();
    handle(cam.qrPayload(cp.code, cp._demoToken), !!b.dataset.far);
  }));
};

// 儲存一筆定點紀錄（GPS 與時間自動帶入），成功後顯示大勾勾
async function saveScan(photos, nonLive) {
  const c = S.cur;
  const payload = {
    patrolId: S.patrol.id, code: c.code, token: c.token, deviceId: S.deviceId,
    lat: c.pos?.lat ?? null, lng: c.pos?.lng ?? null, acc: c.pos?.acc ?? null, deviceAt: c.deviceAt,
    status: 'normal', checklist: {}, category: '', severity: '', note: '',
    photoHashes: photos.map(p => p.hash), clientFlags: nonLive ? ['NON_LIVE_PHOTO'] : [],
  };
  const r = await submitOrQueue('scan', payload, photos.map(p => p.blob), 'scan');
  if (r.ok) S.scans.push(r.result);
  navigator.vibrate?.(150);
  S.cur = null;
  go('done', { cp: c.cp, at: c.deviceAt, queued: !r.ok, hasPos: !!c.pos });
}

// ---------- 畫面：需要拍照的據點 ----------
V.record = () => {
  const c = S.cur; if (!c) return go('patrol');
  const { cp } = c;
  html(`<div><div class="post-tag">${esc(cp.code)}</div><h2>${esc(cp.name)}</h2></div>
    <p style="margin:0">這個點需要拍 ${cp.min_photos} 張現場照片，拍好後按「完成」。</p>
    <div class="stack" id="pw"></div>
    <button class="btn vest block huge" id="save">完成</button>
    <button class="btn ghost block" id="cancel">取消</button>`);
  const pw = photoWidget($('#pw'), { lines: stampLines(`${cp.code} ${cp.name}`) });
  $('#cancel').onclick = () => { S.cur = null; go('patrol'); };
  $('#save').onclick = async e => {
    if (pw.photos.length < cp.min_photos) return toast(`請先拍 ${cp.min_photos} 張照片`, 'bad');
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = '送出中…';
    try { await saveScan(pw.photos, pw.nonLive); }
    catch (err) { toast(err.message, 'bad'); btn.disabled = false; btn.textContent = '完成'; if (/位置|QR|路線|已|裝置/.test(err.message)) { S.cur = null; setTimeout(() => go('patrol'), 1500); } }
  };
};

// ---------- 畫面：已記錄（大勾勾） ----------
V.done = ({ cp, at, queued, hasPos }) => {
  const t = $('#toast'); if (t) t.className = '';   // 清掉先前的錯誤訊息，避免和成功畫面同時出現
  const left = (S.route?.points.length || 0) - doneCheckpointIds().size;
  html(`<div class="donebox">
      <div class="tick" aria-hidden="true">✓</div>
      <h2>${esc(cp.name)}</h2>
      <div class="bigclock mono">${hm(at)}</div>
      <div>${queued ? '沒有網路，已先存在手機，有網路時會自動送出' : hasPos ? '已記錄時間與位置' : '已記錄時間（室內點）'}</div>
    </div>
    ${cp.checklist?.length ? `<div class="card small"><b>順便看看：</b>${cp.checklist.map(esc).join('、')}</div>` : ''}
    ${left > 0 ? `<button class="btn vest block huge" id="next">掃下一個點（還有 ${left} 個）</button>`
      : '<button class="btn vest block huge" id="fin">全部巡完了，送出今日巡邏結果</button>'}
    <button class="btn ghost block big danger-outline" id="abn">這裡有異常，要回報</button>
    <button class="btn ghost block" id="list">回到清單</button>`);
  $('#next')?.addEventListener('click', () => go('scan'));
  $('#fin')?.addEventListener('click', () => go('end'));
  $('#abn').onclick = () => go('abnormal', { cp });
  $('#list').onclick = () => go('patrol');
};

// ---------- 畫面：回報異常（大按鈕點選，說明與照片都可不填） ----------
V.abnormal = ({ cp } = {}) => {
  html(`<div><h2>回報異常</h2><div class="small">${cp ? `地點：${esc(cp.name)}` : '系統會自動附上您現在的位置'}</div></div>
    <b>發生什麼事？（點一下）</b>
    <div class="choices grid" role="radiogroup" aria-label="異常類別">${CONFIG.ABNORMAL_CATEGORIES.map(c => `<label class="choice"><input type="radio" name="cat" value="${esc(c)}"><span>${esc(c)}</span></label>`).join('')}</div>
    <button class="btn ghost block big" id="photo">拍照（可不拍）</button>
    <div class="stack" id="pw" hidden></div>
    <label class="f">補充說明（可不填）<textarea id="desc" rows="2" placeholder="可以用手機鍵盤的麥克風說話輸入"></textarea></label>
    <button class="btn vest block huge" id="send">送出</button>
    <button class="btn ghost block" id="back">取消</button>`);
  let pw = null;
  $('#photo').onclick = () => { $('#photo').hidden = true; $('#pw').hidden = false; pw = photoWidget($('#pw'), { lines: stampLines(cp ? `${cp.code} ${cp.name}` : '異常回報') }); };
  $('#back').onclick = () => go(S.patrol ? 'patrol' : 'home');
  $('#send').onclick = async e => {
    const cat = $('input[name=cat]:checked')?.value;
    if (!cat) return toast('請先點一下發生什麼事', 'bad');
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = '送出中…';
    const pos = await locate(cp || null);
    const note = $('#desc').value.trim();
    try {
      const r = await submitOrQueue('incident', { patrolId: S.patrol?.id || null, type: cat, severity: '中', handling: '已通報主管',
        description: `${cp ? `【${cp.code} ${cp.name}】` : ''}${note || cat}`, lat: pos?.lat ?? null, lng: pos?.lng ?? null, deviceAt: new Date().toISOString() },
        (pw?.photos || []).map(p => p.blob), 'incident');
      if (cp) (S.reported = S.reported || new Set()).add(cp.id);
      toast(r.ok ? '已送出，班長會收到通知' : '沒有網路，已先存在手機');
      go(S.patrol ? 'patrol' : 'home');
    } catch (err) { toast(err.message, 'bad'); btn.disabled = false; btn.textContent = '送出'; }
  };
};
V.incident = () => V.abnormal({});

// ---------- 畫面：自拍確認（預設停用，可於設定開啟） ----------
V.selfie = () => {
  const due = selfieDue(); if (!due) return go('patrol');
  html(`<h2>身分確認</h2>
    <p style="margin:0">請拍一張自己的正面照片。</p>
    <div class="stack" id="pw"></div>
    <button class="btn vest block big" id="send">送出</button>
    <button class="btn ghost block" id="later">等一下再拍</button>`);
  const pw = photoWidget($('#pw'), { max: 1, facing: 'user', lines: stampLines('身分確認自拍') });
  $('#later').onclick = () => go('patrol');
  $('#send').onclick = async e => {
    if (!pw.photos.length) return toast('請先拍照', 'bad');
    e.currentTarget.disabled = true;
    try {
      const r = await submitOrQueue('selfie', { patrolId: S.patrol.id, requestedAt: due.requestedAt, takenAt: new Date().toISOString() }, [pw.photos[0].blob], 'selfie');
      const p = selfiePlan(); p.done.push(due.k); p.pending = null; saveSelfiePlan(p);
      toast(r.ok ? '已送出' : '沒有網路，已先存在手機');
      go('patrol');
    } catch (err) { toast(err.message, 'bad'); e.currentTarget.disabled = false; }
  };
};

// ---------- 畫面：送出今日巡邏結果 ----------
// 還有沒巡的點時無法送出；去不了的點按一下「這個點無法巡邏」即可，不用選原因
V.end = () => {
  const pts = S.route?.points || [];
  const done = doneCheckpointIds();
  const miss = pts.filter(p => !done.has(p.id));
  const marked = new Set();
  html(`<h2>送出今日巡邏結果</h2>
    <div class="count center"><b>${done.size}</b> / ${pts.length} 個點已巡</div>
    ${miss.length ? `<section class="stack" style="gap:8px"><b>還沒巡的點</b>
      <div class="small">請回去巡完；如果真的去不了，按「這個點無法巡邏」。</div>
      ${miss.map(p => `<div class="card stack miss" style="gap:8px" data-row="${p.id}"><b>${esc(p.name)}</b>
        <button type="button" class="btn ghost block big danger-outline" data-miss="${p.id}">這個點無法巡邏</button></div>`).join('')}</section>`
      : '<div class="banner ok-banner">全部的點都巡完了</div>'}
    <div class="card"><b>交班提醒：</b>${CONFIG.HANDOVER_REMINDERS.map(esc).join('、')}，記得交給下一班。</div>
    <details class="card"><summary>有事要交代下一班？（可不填）</summary>
      <textarea id="note" rows="3" style="width:100%;margin-top:8px" placeholder="可以用手機鍵盤的麥克風說話輸入"></textarea></details>
    <button class="btn vest block huge" id="fin">確認送出</button>
    <button class="btn ghost block big" id="back">回去繼續巡邏</button>`);
  const refresh = () => {
    const left = miss.filter(p => !marked.has(p.id)).length;
    const btn = $('#fin');
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `還有 ${left} 個點沒巡，無法送出` : '確認送出';
  };
  $$('[data-miss]').forEach(b => b.onclick = () => {
    const id = b.dataset.miss;
    if (marked.has(id)) { marked.delete(id); b.textContent = '這個點無法巡邏'; b.classList.add('danger-outline'); b.closest('.miss').classList.remove('marked'); }
    else { marked.add(id); b.textContent = '✕ 已標記無法巡邏（再按一下取消）'; b.classList.remove('danger-outline'); b.closest('.miss').classList.add('marked'); }
    refresh();
  });
  refresh();
  $('#back').onclick = () => go('patrol');
  $('#fin').onclick = async e => {
    const btn = e.currentTarget;
    if (miss.some(p => !marked.has(p.id))) return;
    const missed = miss.map(p => ({ checkpoint_id: p.id, reason: '無法巡邏' }));
    if (!navigator.onLine) return toast('沒有網路，請走到有訊號的地方再按一次', 'bad');
    btn.disabled = true; btn.textContent = '送出中…';
    await sync();
    if (S.queue.some(q => q.payload?.patrolId === S.patrol.id && q.type !== 'track')) {
      btn.disabled = false; btn.textContent = '確認送出';
      return toast('還有紀錄沒傳完，請稍等再按一次', 'bad');
    }
    try {
      await api.endPatrol({ patrolId: S.patrol.id, missed, handoverItems: {}, handoverNote: $('#note').value.trim(), selfieStatus: selfieStatus() });
      try { localStorage.removeItem(selfieKey()); } catch { /* 略過 */ }
      stopTracking(); keepAwake(false);
      const summary = { done: done.size, total: pts.length, at: new Date().toISOString() };
      S.patrol = null; S.scans = []; S.route = null; S.reported = new Set();
      go('finished', summary);
    } catch (err) { toast(err.message, 'bad'); btn.disabled = false; btn.textContent = '確認送出'; }
  };
};

V.finished = ({ done, total, at }) => {
  const t = $('#toast'); if (t) t.className = '';
  html(`<div class="donebox">
      <div class="tick" aria-hidden="true">✓</div>
      <h2>今日巡邏已送出</h2>
      <div class="count center"><b>${done}</b> / ${total} 個點</div>
      <div class="small mono">${dt(at)}</div>
    </div>
    <button class="btn vest block huge" id="ok">好，完成</button>`);
  $('#ok').onclick = async () => {
    if (faceReady()) { await api.logout(); S.profile = null; return go('unlock'); }
    go('home');
  };
};

// ---------- 畫面：我的紀錄 ----------
V.history = async () => {
  html('<h2>我的巡查紀錄</h2><p class="empty">載入中…</p>');
  const rows = await api.myPatrols();
  html(`<h2>我的巡查紀錄</h2><div class="small">只顯示本人的巡邏紀錄。</div>
    ${rows.length ? rows.map(r => `<button class="card" data-id="${r.id}" style="text-align:left;font:inherit;color:inherit;cursor:pointer">
      <div style="display:flex;justify-content:space-between;gap:8px"><b>${ymd(r.started_at)} ${esc(postLabel(r.post))}</b>${r.status === 'active' ? '<span class="chip vest">進行中</span>' : r.is_sample ? '<span class="chip">示例</span>' : ''}</div>
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
    <div><div class="small mono">${esc(p.route_name)}</div><h2>${ymd(p.started_at)} ${esc(postLabel(p.post))}</h2></div>
    <div class="card"><dl class="kv"><dt>時間</dt><dd class="mono">${hm(p.started_at)}–${p.ended_at ? hm(p.ended_at) : '進行中'}</dd>
      <dt>完成</dt><dd>${p.scan_count}/${p.point_count}</dd>
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
