// 示範模式：所有資料存於本機瀏覽器（localStorage＋IndexedDB），供試用與教育訓練。
// 同一台電腦、同一個瀏覽器開啟巡邏端與管理後台，即可看到彼此的資料。
import { CONFIG } from './config.js';
import { kv } from './idb.js';
import { evaluateScan, RuleError } from './rules.js';
import { uid } from './util.js';
import * as wa from './webauthn.js';
import { dutyWindow, applyWindow, patrolOverlaps, DEFAULT_REPORT_SETTINGS } from './report.js';

// v2：加入大門／側門崗位，舊的示範資料會自動重建
const KEY = 'yzup-demo-v2';
// 巡邏員畫面與管理後台各自登入，在同一個瀏覽器測試兩種角色時不會互相覆蓋
const SESSION = 'yzup-demo-session-' + (/admin\.html$/.test(location.pathname) ? 'admin' : 'guard');
const listeners = new Set();

// 據點座標為元智大學附近的示意位置，正式使用時需於管理後台以地圖重新標定
const BASE = { lat: 24.9702, lng: 121.2660 };
const off = (dy, dx) => ({ lat: +(BASE.lat + dy / 111320).toFixed(6), lng: +(BASE.lng + dx / 101000).toFixed(6) });
const CHECK = {
  門禁: ['門窗已上鎖', '門禁設備正常', '無破壞痕跡'],
  戶外: ['照明正常', '無積水或倒木', '無可疑人員'],
  宿舍: ['出入口管制正常', '逃生通道淨空', '無可疑人員'],
  停車場: ['照明正常', '無違規停車', '緊急求救鈴正常'],
  機電: ['無異味或異音', '無漏水', '滅火器壓力正常'],
};

function seed() {
  const users = [
    { id: 'u-g1024', staff_no: 'G1024', name: '林巡員（示範）', role: 'guard', post: '大門', active: true, password: 'demo1234' },
    { id: 'u-g1025', staff_no: 'G1025', name: '陳巡員（示範）', role: 'guard', post: '側門', active: true, password: 'demo1234' },
    { id: 'u-s001', staff_no: 'S001', name: '王班長（示範）', role: 'supervisor', active: true, password: 'demo1234' },
    { id: 'u-a001', staff_no: 'A001', name: '總務處管理者（示範）', role: 'admin', active: true, password: 'demo1234' },
  ];
  const cps = [
    ['P01', '行政大樓正門', '門禁', off(0, 0), true, '大門'],
    ['P02', '圖書館側門', '門禁', off(120, 90), true, '側門'],
    ['P03', '體育館周邊', '戶外', off(260, -80), true, '大門'],
    ['P04', '學生宿舍區', '宿舍', off(380, 160), true, '側門'],
    ['P05', '地下停車場 B1', '停車場', off(-90, 200), false, '大門'],
    ['P06', '配電室', '機電', off(-150, -60), false, '側門'],
  ].map(([code, name, type, pos, fence, post]) => ({
    id: 'cp-' + code, code, name, type, post, lat: pos.lat, lng: pos.lng, radius_m: 30, enforce_fence: fence,
    checklist: CHECK[type], min_photos: 0, active: true, note: fence ? '' : '室內點，GPS 訊號弱，不強制圍欄',
    qr_token: Math.random().toString(16).slice(2, 14),
  }));
  const routes = [
    { id: 'rt-gate', name: '大門巡邏路線', mode: 'free', active: true, post: '大門', point_ids: cps.filter(c => c.post === '大門').map(c => c.id) },
    { id: 'rt-side', name: '側門巡邏路線', mode: 'free', active: true, post: '側門', point_ids: cps.filter(c => c.post === '側門').map(c => c.id) },
  ];
  const d = { users, devices: [], checkpoints: cps, routes, patrols: [], scans: [], incidents: [], sos: [], track: [], selfies: [] };
  // 兩筆過去的示例巡邏，讓後台一開始就有資料可看
  const day = 86400000, now = Date.now();
  [[2, 'u-g1024', 0, 'rt-gate', '大門'], [1, 'u-g1025', 1, 'rt-side', '側門']].forEach(([ago, user, variant, routeId, post]) => {
    const start = new Date(now - ago * day - 3 * 3600000);
    const p = { id: uid(), user_id: user, device_id: 'sample', route_id: routeId, post, shift: null, weather: null, started_at: start.toISOString(),
      ended_at: new Date(+start + 55 * 60000).toISOString(), status: 'ended', uv_ok: true, flags: [], missed: [], handover_items: {}, handover_note: '示例資料',
      selfie_status: 'ok', start_lat: BASE.lat, start_lng: BASE.lng, is_sample: true };
    d.patrols.push(p);
    cps.filter(cp => cp.post === post).forEach((cp, i) => {
      if (variant === 1 && i === 2) { p.missed.push({ checkpoint_id: cp.id, reason: '施工封閉' }); return; }
      const t = new Date(+start + (i + 1) * 8 * 60000).toISOString();
      const abn = variant === 0 && i === 1;
      d.scans.push({ id: uid(), patrol_id: p.id, user_id: user, checkpoint_id: cp.id, server_at: t, device_at: t, lat: cp.lat, lng: cp.lng, accuracy: 8, distance_m: 4,
        status: abn ? 'abnormal' : 'normal', checklist: Object.fromEntries(cp.checklist.map((c, k) => [c, !(abn && k === 0)])),
        category: abn ? '門窗沒鎖' : '', severity: abn ? '中' : '', note: abn ? '示例：側門未上鎖，已關閉' : '', photo_paths: [], photo_hashes: [],
        flags: [], review_status: 'none', is_sample: true });
    });
  });
  d.incidents.push({ id: uid(), patrol_id: null, user_id: 'u-g1025', created_at: new Date(now - day).toISOString(), type: '設施損壞', severity: '中', handling: '已通報總務處報修',
    description: '示例：體育館東側路燈不亮', lat: cps[2].lat, lng: cps[2].lng, photo_paths: [], status: 'open', resolution: '', is_sample: true });
  return d;
}

function load() {
  try { const s = localStorage.getItem(KEY); if (s) return JSON.parse(s); } catch { /* 損毀時重建 */ }
  const d = seed(); save(d); return d;
}
function save(d) { localStorage.setItem(KEY, JSON.stringify(d)); listeners.forEach(f => f()); }
window.addEventListener('storage', e => { if (e.key === KEY) listeners.forEach(f => f()); });

function me() {
  const id = localStorage.getItem(SESSION);
  const u = id && load().users.find(x => x.id === id && x.active);
  if (!u) throw new Error('請重新登入');
  return u;
}
const pub = u => u && ({ id: u.id, staff_no: u.staff_no, name: u.name, role: u.role, active: u.active, post: u.post || null });
const isStaff = u => ['supervisor', 'admin'].includes(u.role);
function needStaff() { const u = me(); if (!isStaff(u)) throw new Error('權限不足'); return u; }
function needAdmin() { const u = me(); if (u.role !== 'admin') throw new Error('僅限管理者'); return u; }
const nowIso = () => new Date().toISOString();
const delay = (ms = 120) => new Promise(r => setTimeout(r, ms));
const stripToken = ({ qr_token, ...c }) => c;

function routeWithPoints(d, r, withToken = false) {
  const pts = r.point_ids.map(id => d.checkpoints.find(c => c.id === id)).filter(Boolean)
    .map(c => withToken ? { ...c } : { ...stripToken(c), _demoToken: c.qr_token });
  return { ...r, points: pts };
}

function patrolSummary(d, p) {
  const r = d.routes.find(x => x.id === p.route_id);
  const sc = d.scans.filter(s => s.patrol_id === p.id);
  return { ...p, route_name: r?.name || '', point_count: r?.point_ids.length || 0, scan_count: sc.length,
    abnormal_count: sc.filter(s => s.status === 'abnormal').length + d.incidents.filter(i => i.patrol_id === p.id).length, flagged_count: sc.filter(s => s.flags.length).length,
    last_scan_at: sc.map(s => s.server_at).sort().pop() || null, profile: pub(d.users.find(u => u.id === p.user_id)) };
}

function inRange(iso, from, to) {
  const t = new Date(iso);
  if (from && t < new Date(from + 'T00:00:00')) return false;
  if (to && t > new Date(to + 'T23:59:59')) return false;
  return true;
}

export const api = {
  demo: true,

  async login(staffNo, password) {
    await delay();
    const d = load();
    const u = d.users.find(x => x.staff_no.toLowerCase() === String(staffNo).trim().toLowerCase());
    if (!u || u.password !== password) throw new Error('工號或密碼錯誤');
    if (!u.active) throw new Error('此帳號已停用，請洽管理者');
    localStorage.setItem(SESSION, u.id);
    return pub(u);
  },
  async logout() { localStorage.removeItem(SESSION); },
  async currentProfile() { try { return pub(me()); } catch { return null; } },

  async registerDevice(deviceId, label) {
    const u = me(), d = load();
    const ex = d.devices.find(x => x.user_id === u.id && x.device_id === deviceId);
    if (ex) return ex.status;
    const hasActive = d.devices.some(x => x.user_id === u.id && x.status === 'active');
    const status = hasActive ? 'pending' : 'active';
    d.devices.push({ id: uid(), user_id: u.id, device_id: deviceId, label, status, created_at: nowIso() });
    save(d);
    return status;
  },

  async getRoutes() {
    const u = me(), d = load();
    // 巡邏員只看到自己崗位的路線；未標記崗位的路線兩邊共用
    return d.routes.filter(r => r.active && (isStaff(u) || !r.post || !u.post || r.post === u.post)).map(r => routeWithPoints(d, r));
  },

  async getActivePatrol() {
    const u = me(), d = load();
    const p = d.patrols.find(x => x.user_id === u.id && x.status === 'active');
    if (!p) return null;
    return { patrol: p, scans: d.scans.filter(s => s.patrol_id === p.id) };
  },

  async startPatrol({ routeId, shift, weather, deviceId, lat, lng, uvOk }) {
    await delay();
    const u = me(), d = load();
    if (!d.devices.some(x => x.user_id === u.id && x.device_id === deviceId && x.status === 'active')) throw new Error('此裝置未獲授權，請洽主管');
    const ex = d.patrols.find(x => x.user_id === u.id && x.status === 'active');
    if (ex) return ex;
    const post = d.routes.find(r => r.id === routeId)?.post || u.post || null;
    const p = { id: uid(), user_id: u.id, device_id: deviceId, route_id: routeId, post, shift: shift || null, weather: weather || null, started_at: nowIso(), ended_at: null, status: 'active',
      uv_ok: !!uvOk, flags: uvOk ? [] : ['UV_SKIPPED'], missed: [], handover_items: {}, handover_note: '', selfie_status: 'none', start_lat: lat, start_lng: lng };
    d.patrols.push(p); save(d);
    return p;
  },

  async uploadPhoto(blob, kind) {
    const u = me();
    const path = `${u.id}/${kind}/${uid()}.jpg`;
    await kv.set('photo:' + path, blob);
    return path;
  },
  async photoUrl(path) {
    const b = await kv.get('photo:' + path);
    return b ? URL.createObjectURL(b) : null;
  },

  async submitScan(x) {
    await delay();
    const u = me(), d = load();
    const p = d.patrols.find(q => q.id === x.patrolId && q.user_id === u.id);
    if (!p) throw new Error('找不到此巡邏場次');
    if (p.status !== 'active') throw new Error('此巡邏已結束');
    if (!d.devices.some(q => q.user_id === u.id && q.device_id === x.deviceId && q.status === 'active')) throw new Error('此裝置未獲授權');
    const cp = d.checkpoints.find(c => c.code === x.code && c.active);
    if (!cp || cp.qr_token !== x.token) throw new Error('QR Code 無效或已更換，請通報管理者');
    const route = d.routes.find(r => r.id === p.route_id);
    if (route && !route.point_ids.includes(cp.id)) throw new Error('此據點不在本次巡邏路線');
    const mine = d.scans.filter(s => s.patrol_id === p.id);
    if (mine.some(s => s.checkpoint_id === cp.id)) throw new Error('此據點本場次已完成');
    if (!['normal', 'abnormal'].includes(x.status)) throw new Error('狀態不正確');
    if (x.status === 'abnormal' && !String(x.note || '').trim() && !String(x.category || '').trim()) throw new Error('異常需選擇類別或填寫說明');
    if ((x.photoPaths || []).length < cp.min_photos) throw new Error('照片數量不足');
    const prev = [...mine].sort((a, b) => new Date(a.device_at || a.server_at) - new Date(b.device_at || b.server_at)).pop();
    let res;
    try {
      res = evaluateScan({ cp, lat: x.lat, lng: x.lng, acc: x.acc, deviceAt: x.deviceAt ? new Date(x.deviceAt) : null, serverAt: new Date(),
        prev, prevCp: prev && d.checkpoints.find(c => c.id === prev.checkpoint_id),
        route: route && routeWithPoints(d, route, true), scannedIds: mine.map(s => s.checkpoint_id), clientFlags: x.clientFlags });
    } catch (e) { throw e instanceof RuleError ? new Error(e.message) : e; }
    const s = { id: uid(), patrol_id: p.id, user_id: u.id, checkpoint_id: cp.id, server_at: nowIso(), device_at: x.deviceAt, lat: x.lat, lng: x.lng, accuracy: x.acc,
      distance_m: res.distance == null ? null : Math.round(res.distance), status: x.status, checklist: x.checklist, category: x.category || '', severity: x.severity || '',
      note: x.note || '', photo_paths: x.photoPaths, photo_hashes: x.photoHashes, flags: res.flags, review_status: res.flags.length ? 'pending' : 'none' };
    d.scans.push(s); save(d);
    return s;
  },

  async reportIncident(x) {
    const u = me(), d = load();
    const i = { id: uid(), patrol_id: x.patrolId || null, user_id: u.id, created_at: x.deviceAt || nowIso(), type: x.type, severity: x.severity, handling: x.handling,
      description: x.description, lat: x.lat, lng: x.lng, photo_paths: x.photoPaths || [], status: 'open', resolution: '' };
    d.incidents.push(i); save(d);
    return i;
  },

  async sendSOS(x) {
    const u = me(), d = load();
    const s = { id: uid(), user_id: u.id, patrol_id: x.patrolId || null, created_at: nowIso(), lat: x.lat, lng: x.lng, accuracy: x.acc, acknowledged_by: null, acknowledged_at: null };
    d.sos.push(s); save(d);
    return s;
  },

  async addTrack(x) {
    const u = me(), d = load();
    d.track.push({ patrol_id: x.patrolId, user_id: u.id, at: x.at, lat: x.lat, lng: x.lng, accuracy: x.acc });
    save(d);
  },

  async submitSelfie(x) {
    const u = me(), d = load();
    d.selfies.push({ id: uid(), patrol_id: x.patrolId, user_id: u.id, requested_at: x.requestedAt, taken_at: x.takenAt, photo_path: x.photoPath, result: 'pending' });
    save(d);
  },

  async endPatrol({ patrolId, missed, handoverItems, handoverNote, selfieStatus }) {
    await delay();
    const u = me(), d = load();
    const p = d.patrols.find(q => q.id === patrolId && q.user_id === u.id);
    if (!p || p.status !== 'active') throw new Error('此巡邏已結束或不存在');
    const route = d.routes.find(r => r.id === p.route_id);
    const done = d.scans.filter(s => s.patrol_id === p.id).map(s => s.checkpoint_id);
    Object.assign(p, { status: 'ended', ended_at: nowIso(), missed, handover_items: handoverItems, handover_note: handoverNote, selfie_status: selfieStatus });
    if (selfieStatus === 'missed' && !p.flags.includes('SELFIE_MISSED')) p.flags.push('SELFIE_MISSED');
    save(d);
    return p;
  },

  async myPatrols(limit = 30) {
    const u = me(), d = load();
    return d.patrols.filter(p => p.user_id === u.id).sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit).map(p => patrolSummary(d, p));
  },

  async patrolDetail(id) {
    const u = me(), d = load();
    const p = d.patrols.find(x => x.id === id);
    if (!p || (p.user_id !== u.id && !isStaff(u))) throw new Error('無權限檢視此紀錄');
    const route = d.routes.find(r => r.id === p.route_id);
    return {
      patrol: patrolSummary(d, p),
      route: route && routeWithPoints(d, route, true),
      scans: d.scans.filter(s => s.patrol_id === id).map(s => ({ ...s, checkpoint: d.checkpoints.find(c => c.id === s.checkpoint_id) })),
      incidents: d.incidents.filter(i => i.patrol_id === id),
      track: d.track.filter(t => t.patrol_id === id),
      selfies: d.selfies.filter(s => s.patrol_id === id),
    };
  },

  // ===== 管理端 =====
  async dashboard() {
    needStaff(); const d = load();
    const today = new Date().toDateString();
    const isToday = iso => new Date(iso).toDateString() === today;
    const scansToday = d.scans.filter(s => isToday(s.server_at));
    return {
      active: d.patrols.filter(p => p.status === 'active').map(p => patrolSummary(d, p)),
      sos: d.sos.filter(s => !s.acknowledged_at).map(s => ({ ...s, profile: pub(d.users.find(u => u.id === s.user_id)) })),
      openIncidents: d.incidents.filter(i => i.status !== 'closed').map(i => ({ ...i, profile: pub(d.users.find(u => u.id === i.user_id)) })),
      pendingReview: d.scans.filter(s => s.review_status === 'pending').length,
      pendingDevices: d.devices.filter(x => x.status === 'pending').length,
      pendingSelfies: d.selfies.filter(x => x.result === 'pending').length,
      pendingRegistrations: (d.registrations || []).filter(x => x.status === 'pending').length,
      today: { patrols: d.patrols.filter(p => isToday(p.started_at)).length, scans: scansToday.length,
        abnormal: scansToday.filter(s => s.status === 'abnormal').length + d.incidents.filter(i => isToday(i.created_at)).length, flagged: scansToday.filter(s => s.flags.length).length },
    };
  },

  async listProfiles() { needStaff(); return load().users.map(pub); },
  async updateProfile(id, patch) {
    needAdmin(); const d = load();
    const u = d.users.find(x => x.id === id);
    Object.assign(u, (({ name, role, active, post }) => Object.fromEntries(Object.entries({ name, role, active, post }).filter(([, v]) => v !== undefined)))(patch));
    save(d);
  },
  async createUser({ staff_no, name, role, password }) {
    needAdmin(); const d = load();
    if (d.users.some(u => u.staff_no.toLowerCase() === staff_no.toLowerCase())) throw new Error('工號已存在');
    d.users.push({ id: 'u-' + uid(), staff_no, name, role, active: true, password });
    save(d);
  },
  async resetPassword(id, password) { needAdmin(); const d = load(); d.users.find(u => u.id === id).password = password; save(d); },

  async listDevices() {
    needStaff(); const d = load();
    return d.devices.map(x => ({ ...x, profile: pub(d.users.find(u => u.id === x.user_id)) })).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  async setDeviceStatus(id, status) {
    const s = needStaff(), d = load();
    const dev = d.devices.find(x => x.id === id);
    if (status === 'active') d.devices.filter(x => x.user_id === dev.user_id && x.status === 'active').forEach(x => (x.status = 'revoked'));
    Object.assign(dev, { status, decided_by: s.id, decided_at: nowIso() });
    save(d);
  },

  async adminCheckpoints() { needStaff(); return load().checkpoints.map(c => ({ ...c })); },
  async saveCheckpoint(cp) {
    needAdmin(); const d = load();
    if (d.checkpoints.some(c => c.code === cp.code && c.id !== cp.id)) throw new Error('據點代碼重複');
    if (cp.id) Object.assign(d.checkpoints.find(c => c.id === cp.id), cp);
    else d.checkpoints.push({ ...cp, id: 'cp-' + uid(), qr_token: Math.random().toString(16).slice(2, 14) });
    save(d);
  },
  async rotateToken(id) { needAdmin(); const d = load(); d.checkpoints.find(c => c.id === id).qr_token = Math.random().toString(16).slice(2, 14); save(d); },

  async adminRoutes() { needStaff(); const d = load(); return d.routes.map(r => routeWithPoints(d, r, true)); },
  async saveRoute({ id, name, mode, active, pointIds, post }) {
    needAdmin(); const d = load();
    const r = { name, mode, active, post: post || null, point_ids: pointIds };
    if (id) Object.assign(d.routes.find(x => x.id === id), r); else d.routes.push({ id: 'rt-' + uid(), ...r });
    save(d);
  },

  async listPatrols({ from, to, userId } = {}) {
    needStaff(); const d = load();
    return d.patrols.filter(p => inRange(p.started_at, from, to) && (!userId || p.user_id === userId))
      .sort((a, b) => b.started_at.localeCompare(a.started_at)).map(p => patrolSummary(d, p));
  },

  async queryScans({ from, to, userId, checkpointId, status, flaggedOnly, review } = {}) {
    needStaff(); const d = load();
    return d.scans.filter(s => inRange(s.server_at, from, to) && (!userId || s.user_id === userId) && (!checkpointId || s.checkpoint_id === checkpointId)
      && (!status || s.status === status) && (!flaggedOnly || s.flags.length) && (!review || s.review_status === review))
      .sort((a, b) => b.server_at.localeCompare(a.server_at))
      .map(s => ({ ...s, checkpoint: d.checkpoints.find(c => c.id === s.checkpoint_id), profile: pub(d.users.find(u => u.id === s.user_id)) }));
  },
  async reviewScan(id, { review_status, review_note }) {
    const u = needStaff(), d = load();
    Object.assign(d.scans.find(s => s.id === id), { review_status, review_note, reviewed_by: u.id, reviewed_at: nowIso() });
    save(d);
  },

  async listIncidents({ status, from, to } = {}) {
    needStaff(); const d = load();
    return d.incidents.filter(i => (!status || i.status === status) && inRange(i.created_at, from, to))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).map(i => ({ ...i, profile: pub(d.users.find(u => u.id === i.user_id)) }));
  },
  async updateIncident(id, { status, resolution }) {
    const u = needStaff(), d = load();
    const i = d.incidents.find(x => x.id === id);
    Object.assign(i, { status, resolution }, status === 'closed' ? { closed_by: u.id, closed_at: nowIso() } : {});
    save(d);
  },
  async ackSOS(id) { const u = needStaff(), d = load(); Object.assign(d.sos.find(s => s.id === id), { acknowledged_by: u.id, acknowledged_at: nowIso() }); save(d); },

  async listSelfies({ pendingOnly } = {}) {
    needStaff(); const d = load();
    return d.selfies.filter(s => !pendingOnly || s.result === 'pending').sort((a, b) => b.taken_at.localeCompare(a.taken_at))
      .map(s => ({ ...s, profile: pub(d.users.find(u => u.id === s.user_id)) }));
  },
  async reviewSelfie(id, result) { const u = needStaff(), d = load(); Object.assign(d.selfies.find(s => s.id === id), { result, reviewed_by: u.id }); save(d); },

  async purgePhotos(days) {
    needAdmin(); const d = load();
    const cut = Date.now() - days * 86400000;
    let n = 0;
    for (const s of d.scans) if (new Date(s.server_at) < cut && s.photo_paths.length) {
      for (const p of s.photo_paths) { await kv.del('photo:' + p); n++; }
      s.photo_paths = []; s.photos_purged_at = nowIso();
    }
    save(d);
    return n;
  },

  // ===== 自行註冊與臉部辨識登入（示範模式：簽章只在手機端確認） =====
  async passkeyRegister({ staff_no, name, phone, org, post, deviceId, deviceLabel, simulate }) {
    staff_no = String(staff_no).trim().toUpperCase(); name = String(name).trim();
    if (!/^[A-Z0-9_-]{2,20}$/.test(staff_no)) throw new Error('工號格式不正確（英文字母或數字，2–20 碼）');
    if (!name) throw new Error('請填寫姓名');
    let credentialId;
    if (simulate) credentialId = 'sim-' + uid();
    else {
      try { credentialId = (await wa.startRegistration(wa.localRegOptions({ staff_no, name }))).id; }
      catch (e) { throw new Error(wa.friendlyError(e)); }
    }
    const d = load();
    d.registrations ||= [];
    const ex = d.users.find(u => u.staff_no === staff_no);
    if (ex && !ex.active) throw new Error('此工號已停用，請洽總務處');
    d.registrations = d.registrations.filter(r => !(r.staff_no === staff_no && r.status === 'pending'));
    const r = { id: uid(), kind: ex ? 'rebind' : 'new', staff_no, name, phone: phone || '', org: org || '', post: post || null, device_id: deviceId, device_label: deviceLabel,
      credential_id: credentialId, consent_at: nowIso(), status: 'pending', created_at: nowIso() };
    d.registrations.push(r); save(d);
    return { requestId: r.id, credentialId };
  },
  async registrationStatus(requestId, deviceId) {
    const r = (load().registrations || []).find(x => x.id === requestId && x.device_id === deviceId);
    return r ? { status: r.status, reason: r.reject_reason } : { status: 'missing' };
  },
  async passkeyLogin({ credentialId, deviceId, simulate }) {
    const d = load();
    const pk = (d.passkeys || []).find(x => x.credential_id === credentialId && x.active);
    if (!pk) throw new Error('此手機的臉部登入已失效，請重新申請註冊');
    if (!simulate) {
      try { await wa.startAuthentication(wa.localAuthOptions(credentialId)); } catch (e) { throw new Error(wa.friendlyError(e)); }
    }
    const u = d.users.find(x => x.id === pk.user_id);
    if (!u?.active) throw new Error('此帳號已停用，請洽總務處');
    if (pk.device_id !== deviceId) throw new Error('臉部登入只能在註冊時的手機使用');
    const dev = d.devices.find(x => x.user_id === u.id && x.device_id === deviceId);
    if (dev?.status !== 'active') throw new Error('此手機未獲授權，請洽班長');
    dev.last_uv_at = pk.last_used_at = nowIso(); save(d);
    localStorage.setItem(SESSION, u.id);
    return pub(u);
  },
  async listRegistrations({ status } = {}) {
    needStaff();
    return (load().registrations || []).filter(r => !status || r.status === status).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  async approveRegistration(id) {
    const s = needStaff(), d = load();
    const r = (d.registrations || []).find(x => x.id === id);
    if (!r || r.status !== 'pending') throw new Error('此申請已處理或不存在');
    let u = d.users.find(x => x.staff_no === r.staff_no);
    if (!u) { u = { id: 'u-' + uid(), staff_no: r.staff_no, name: r.name, role: 'guard', post: r.post, active: true, password: null }; d.users.push(u); }
    else if (r.post) u.post = r.post;
    d.passkeys ||= [];
    d.passkeys.filter(x => x.user_id === u.id).forEach(x => (x.active = false));
    d.passkeys.push({ id: uid(), user_id: u.id, device_id: r.device_id, credential_id: r.credential_id, active: true, created_at: nowIso() });
    d.devices.filter(x => x.user_id === u.id && x.status === 'active').forEach(x => Object.assign(x, { status: 'revoked', decided_by: s.id, decided_at: nowIso() }));
    const dev = d.devices.find(x => x.user_id === u.id && x.device_id === r.device_id);
    if (dev) Object.assign(dev, { status: 'active', decided_by: s.id, decided_at: nowIso() });
    else d.devices.push({ id: uid(), user_id: u.id, device_id: r.device_id, label: r.device_label, status: 'active', created_at: nowIso(), decided_by: s.id, decided_at: nowIso() });
    Object.assign(r, { status: 'approved', user_id: u.id, decided_by: s.id, decided_at: nowIso() });
    save(d);
  },
  async rejectRegistration(id, reason) {
    const s = needStaff(), d = load();
    if (!String(reason || '').trim()) throw new Error('請填寫退回原因');
    const r = (d.registrations || []).find(x => x.id === id && x.status === 'pending');
    if (!r) throw new Error('此申請已處理或不存在');
    Object.assign(r, { status: 'rejected', reject_reason: reason.trim(), decided_by: s.id, decided_at: nowIso() });
    save(d);
  },

  async changePassword(oldPw, newPw) {
    const u = me(), d = load();
    const x = d.users.find(y => y.id === u.id);
    if (x.password !== oldPw) throw new Error('目前密碼不正確');
    if (String(newPw).length < 8) throw new Error('新密碼至少 8 碼');
    x.password = newPw; save(d);
  },

  // ===== 日報表 =====
  async getReportSettings() {
    needStaff(); const d = load();
    return { ...DEFAULT_REPORT_SETTINGS, ...(d.report_settings || {}) };
  },
  async saveReportSettings(patch) {
    const u = needAdmin(), d = load();
    d.report_settings = { ...DEFAULT_REPORT_SETTINGS, ...(d.report_settings || {}), ...patch, updated_at: nowIso(), updated_by: u.id };
    save(d);
  },
  async listReportRuns() { needStaff(); return (load().report_runs || []).slice().reverse(); },
  async sendReportNow() { needStaff(); throw new Error('示範模式沒有寄信伺服器。請改用「下載 Excel」；正式上線後即可自動寄送。'); },
  async reportData(day) {
    needStaff(); const d = load();
    const startHour = { ...DEFAULT_REPORT_SETTINGS, ...(d.report_settings || {}) }.day_start_hour;
    const { from, to } = dutyWindow(day, startHour);
    const inW = iso => { const t = new Date(iso); return t >= from && t < to; };
    const overl = d.patrols.filter(p => patrolOverlaps(p, from, to)).sort((a, b) => a.started_at.localeCompare(b.started_at)).map(p => patrolSummary(d, p));
    const ids = new Set(overl.map(p => p.id));
    const w = applyWindow(overl, d.scans.filter(x => ids.has(x.patrol_id)).sort((a, b) => a.server_at.localeCompare(b.server_at))
      .map(x => ({ ...x, checkpoint: d.checkpoints.find(c => c.id === x.checkpoint_id), profile: pub(d.users.find(u => u.id === x.user_id)) })), from, to);
    return {
      day, dayStartHour: startHour, patrols: w.patrols, scans: w.scans,
      incidents: d.incidents.filter(i => inW(i.created_at)).map(i => ({ ...i, profile: pub(d.users.find(u => u.id === i.user_id)) })),
      sos: d.sos.filter(x => inW(x.created_at)).map(x => ({ ...x, profile: pub(d.users.find(u => u.id === x.user_id)) })),
      checkpointNames: Object.fromEntries(d.checkpoints.map(c => [c.id, `${c.code} ${c.name}`])),
    };
  },

  subscribe(cb) { listeners.add(cb); const t = setInterval(cb, 15000); return () => { listeners.delete(cb); clearInterval(t); }; },

  async resetDemo() { localStorage.removeItem(KEY); localStorage.removeItem(SESSION); await kv.clear(); },
};
