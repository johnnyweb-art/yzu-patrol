// 正式模式：資料存於 Supabase（PostgreSQL＋檔案儲存），驗證規則由資料庫函式執行。
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { CONFIG } from './config.js';
import { uid } from './util.js';
import { dutyWindow, applyWindow, patrolOverlaps, DEFAULT_REPORT_SETTINGS } from './report.js';

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
const CP_COLS = 'id,code,name,type,lat,lng,radius_m,enforce_fence,checklist,min_photos,active,note';
const prof = t => `profiles!${t}_user_id_fkey(id,staff_no,name,role,active)`;

function chk({ data, error }) {
  if (error) {
    const e = new Error(error.message || '資料存取失敗');
    if (/fetch|network/i.test(error.message || '')) e.code = 'NETWORK';
    throw e;
  }
  return data;
}
async function myId() {
  const { data } = await sb.auth.getSession();
  if (!data.session) throw new Error('請重新登入');
  return data.session.user.id;
}
const dayStart = d => d ? new Date(d + 'T00:00:00').toISOString() : null;
const dayEnd = d => d ? new Date(d + 'T23:59:59.999').toISOString() : null;

async function routesWithPoints(onlyActive, withToken) {
  let q = sb.from('routes').select('id,name,mode,active,route_points(seq,checkpoint_id)').order('name');
  if (onlyActive) q = q.eq('active', true);
  const routes = chk(await q);
  const cps = withToken ? chk(await sb.rpc('admin_checkpoints')) : chk(await sb.from('checkpoints').select(CP_COLS));
  const byId = Object.fromEntries(cps.map(c => [c.id, c]));
  return routes.map(r => ({
    id: r.id, name: r.name, mode: r.mode, active: r.active,
    point_ids: r.route_points.sort((a, b) => a.seq - b.seq).map(p => p.checkpoint_id),
    points: r.route_points.sort((a, b) => a.seq - b.seq).map(p => byId[p.checkpoint_id]).filter(Boolean),
  }));
}

function summarize(p, routes) {
  const r = routes.find(x => x.id === p.route_id);
  const sc = p.scans || [];
  return { ...p, scans: undefined, route_name: r?.name || '', point_count: r?.point_ids.length || 0, scan_count: sc.length,
    abnormal_count: sc.filter(s => s.status === 'abnormal').length, flagged_count: sc.filter(s => s.flags?.length).length,
    last_scan_at: sc.map(s => s.server_at).sort().pop() || null, profile: p.profiles, profiles: undefined };
}

export const api = {
  demo: false,

  async login(staffNo, password) {
    const email = `${String(staffNo).trim().toLowerCase()}@${CONFIG.LOGIN_EMAIL_DOMAIN}`;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(/Invalid login/i.test(error.message) ? '工號或密碼錯誤' : error.message);
    const p = await api.currentProfile();
    if (!p) { await sb.auth.signOut(); throw new Error('找不到人員資料或帳號已停用，請洽管理者'); }
    return p;
  },
  async logout() { await sb.auth.signOut(); },
  async currentProfile() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return null;
    const { data: p } = await sb.from('profiles').select('id,staff_no,name,role,active').eq('id', data.session.user.id).maybeSingle();
    return p && p.active ? p : null;
  },

  async registerDevice(deviceId, label) { return chk(await sb.rpc('register_device', { p_device_id: deviceId, p_label: label })); },
  getRoutes: () => routesWithPoints(true, false),

  async getActivePatrol() {
    const id = await myId();
    const p = chk(await sb.from('patrols').select('*').eq('user_id', id).eq('status', 'active').maybeSingle());
    if (!p) return null;
    const scans = chk(await sb.from('scans').select('*').eq('patrol_id', p.id));
    return { patrol: p, scans };
  },

  async startPatrol({ routeId, shift, weather, deviceId, lat, lng, uvOk }) {
    return chk(await sb.rpc('start_patrol', { p_route_id: routeId, p_shift: shift, p_weather: weather, p_device_id: deviceId, p_lat: lat, p_lng: lng, p_uv_ok: uvOk }));
  },

  async uploadPhoto(blob, kind) {
    const path = `${await myId()}/${kind}/${new Date().toISOString().slice(0, 10)}/${uid()}.jpg`;
    chk(await sb.storage.from(CONFIG.PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false }));
    return path;
  },
  async photoUrl(path) {
    const { data } = await sb.storage.from(CONFIG.PHOTO_BUCKET).createSignedUrl(path, 3600);
    return data?.signedUrl || null;
  },

  async submitScan(x) {
    return chk(await sb.rpc('submit_scan', {
      p_patrol_id: x.patrolId, p_code: x.code, p_token: x.token, p_device_id: x.deviceId,
      p_lat: x.lat, p_lng: x.lng, p_acc: x.acc, p_device_at: x.deviceAt, p_status: x.status, p_checklist: x.checklist,
      p_category: x.category || '', p_severity: x.severity || '', p_note: x.note || '',
      p_photo_paths: x.photoPaths, p_photo_hashes: x.photoHashes, p_client_flags: x.clientFlags || [],
    }));
  },

  async reportIncident(x) {
    return chk(await sb.from('incidents').insert({ patrol_id: x.patrolId || null, type: x.type, severity: x.severity, handling: x.handling,
      description: x.description, lat: x.lat, lng: x.lng, photo_paths: x.photoPaths || [] }).select().single());
  },
  async sendSOS(x) {
    return chk(await sb.from('sos_alerts').insert({ patrol_id: x.patrolId || null, lat: x.lat, lng: x.lng, accuracy: x.acc }).select().single());
  },
  async addTrack(x) {
    chk(await sb.from('track_points').insert({ patrol_id: x.patrolId, at: x.at, lat: x.lat, lng: x.lng, accuracy: x.acc }));
  },
  async submitSelfie(x) {
    chk(await sb.from('selfies').insert({ patrol_id: x.patrolId, requested_at: x.requestedAt, taken_at: x.takenAt, photo_path: x.photoPath }));
  },
  async endPatrol({ patrolId, missed, handoverItems, handoverNote, selfieStatus }) {
    return chk(await sb.rpc('end_patrol', { p_patrol_id: patrolId, p_missed: missed, p_handover_items: handoverItems, p_note: handoverNote, p_selfie_status: selfieStatus }));
  },

  async myPatrols(limit = 30) {
    const id = await myId();
    const [rows, routes] = await Promise.all([
      sb.from('patrols').select(`*, scans(status,flags,server_at), ${prof('patrols')}`).eq('user_id', id).order('started_at', { ascending: false }).limit(limit).then(chk),
      routesWithPoints(false, false)]);
    return rows.map(p => summarize(p, routes));
  },

  async patrolDetail(id) {
    const p = chk(await sb.from('patrols').select(`*, scans(status,flags,server_at), ${prof('patrols')}`).eq('id', id).single());
    const routes = await routesWithPoints(false, false);
    const [scans, incidents, track, selfies] = await Promise.all([
      sb.from('scans').select(`*, checkpoint:checkpoints(${CP_COLS})`).eq('patrol_id', id).order('server_at').then(chk),
      sb.from('incidents').select('*').eq('patrol_id', id).then(chk),
      sb.from('track_points').select('at,lat,lng,accuracy').eq('patrol_id', id).order('at').limit(2000).then(chk),
      sb.from('selfies').select('*').eq('patrol_id', id).then(chk)]);
    return { patrol: summarize(p, routes), route: routes.find(r => r.id === p.route_id), scans, incidents, track, selfies };
  },

  // ===== 管理端 =====
  async dashboard() {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const today = t0.toISOString();
    const [active, sos, inc, pend, devs, selfies, tp, ts, routes] = await Promise.all([
      sb.from('patrols').select(`*, scans(status,flags,server_at), ${prof('patrols')}`).eq('status', 'active').then(chk),
      sb.from('sos_alerts').select(`*, ${prof('sos_alerts')}`).is('acknowledged_at', null).order('created_at', { ascending: false }).then(chk),
      sb.from('incidents').select(`*, ${prof('incidents')}`).neq('status', 'closed').order('created_at', { ascending: false }).then(chk),
      sb.from('scans').select('id', { count: 'exact', head: true }).eq('review_status', 'pending'),
      sb.from('devices').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      sb.from('selfies').select('id', { count: 'exact', head: true }).eq('result', 'pending'),
      sb.from('patrols').select('id', { count: 'exact', head: true }).gte('started_at', today),
      sb.from('scans').select('status,flags').gte('server_at', today).then(chk),
      routesWithPoints(false, false)]);
    return {
      active: active.map(p => summarize(p, routes)),
      sos: sos.map(s => ({ ...s, profile: s.profiles })),
      openIncidents: inc.map(i => ({ ...i, profile: i.profiles })),
      pendingReview: pend.count || 0, pendingDevices: devs.count || 0, pendingSelfies: selfies.count || 0,
      today: { patrols: tp.count || 0, scans: ts.length, abnormal: ts.filter(s => s.status === 'abnormal').length, flagged: ts.filter(s => s.flags.length).length },
    };
  },

  async listProfiles() { return chk(await sb.from('profiles').select('id,staff_no,name,role,active').order('staff_no')); },
  async updateProfile(id, patch) { chk(await sb.from('profiles').update(patch).eq('id', id)); },
  async createUser(u) { return api._admin('createUser', { ...u, email_domain: CONFIG.LOGIN_EMAIL_DOMAIN }); },
  async resetPassword(id, password) { return api._admin('resetPassword', { user_id: id, password }); },
  async purgePhotos(days) { return (await api._admin('purgePhotos', { days })).removed; },
  async _admin(action, body) {
    const { data, error } = await sb.functions.invoke('admin', { body: { action, ...body } });
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch { /* 保留原訊息 */ }
      throw new Error(msg);
    }
    return data;
  },

  async listDevices() {
    const rows = chk(await sb.from('devices').select(`*, ${prof('devices')}`).order('created_at', { ascending: false }));
    return rows.map(r => ({ ...r, profile: r.profiles }));
  },
  async setDeviceStatus(id, status) { chk(await sb.rpc('set_device_status', { p_id: id, p_status: status })); },

  async adminCheckpoints() { return chk(await sb.rpc('admin_checkpoints')); },
  async saveCheckpoint(cp) {
    const row = (({ code, name, type, lat, lng, radius_m, enforce_fence, checklist, min_photos, active, note }) =>
      ({ code, name, type, lat, lng, radius_m, enforce_fence, checklist, min_photos, active, note }))(cp);
    if (cp.id) chk(await sb.from('checkpoints').update({ ...row, updated_at: new Date().toISOString() }).eq('id', cp.id));
    else chk(await sb.from('checkpoints').insert(row));
  },
  async rotateToken(id) { chk(await sb.rpc('rotate_qr_token', { p_id: id })); },
  adminRoutes: () => routesWithPoints(false, true),
  async saveRoute({ id, name, mode, active, pointIds }) {
    chk(await sb.rpc('save_route', { p_id: id || null, p_name: name, p_mode: mode, p_active: active, p_point_ids: pointIds }));
  },

  async listPatrols({ from, to, userId } = {}) {
    let q = sb.from('patrols').select(`*, scans(status,flags,server_at), ${prof('patrols')}`).order('started_at', { ascending: false }).limit(500);
    if (from) q = q.gte('started_at', dayStart(from));
    if (to) q = q.lte('started_at', dayEnd(to));
    if (userId) q = q.eq('user_id', userId);
    const [rows, routes] = await Promise.all([q.then(chk), routesWithPoints(false, false)]);
    return rows.map(p => summarize(p, routes));
  },

  async queryScans({ from, to, userId, checkpointId, status, flaggedOnly, review } = {}) {
    let q = sb.from('scans').select(`*, checkpoint:checkpoints(${CP_COLS}), ${prof('scans')}`).order('server_at', { ascending: false }).limit(2000);
    if (from) q = q.gte('server_at', dayStart(from));
    if (to) q = q.lte('server_at', dayEnd(to));
    if (userId) q = q.eq('user_id', userId);
    if (checkpointId) q = q.eq('checkpoint_id', checkpointId);
    if (status) q = q.eq('status', status);
    if (review) q = q.eq('review_status', review);
    if (flaggedOnly) q = q.neq('flags', '{}');
    return chk(await q).map(s => ({ ...s, profile: s.profiles }));
  },
  async reviewScan(id, { review_status, review_note }) {
    chk(await sb.from('scans').update({ review_status, review_note, reviewed_by: await myId(), reviewed_at: new Date().toISOString() }).eq('id', id));
  },

  async listIncidents({ status, from, to } = {}) {
    let q = sb.from('incidents').select(`*, ${prof('incidents')}`).order('created_at', { ascending: false }).limit(500);
    if (status) q = q.eq('status', status);
    if (from) q = q.gte('created_at', dayStart(from));
    if (to) q = q.lte('created_at', dayEnd(to));
    return chk(await q).map(i => ({ ...i, profile: i.profiles }));
  },
  async updateIncident(id, { status, resolution }) {
    const patch = { status, resolution };
    if (status === 'closed') Object.assign(patch, { closed_by: await myId(), closed_at: new Date().toISOString() });
    chk(await sb.from('incidents').update(patch).eq('id', id));
  },
  async ackSOS(id) { chk(await sb.from('sos_alerts').update({ acknowledged_by: await myId(), acknowledged_at: new Date().toISOString() }).eq('id', id)); },

  async listSelfies({ pendingOnly } = {}) {
    let q = sb.from('selfies').select(`*, ${prof('selfies')}`).order('taken_at', { ascending: false }).limit(200);
    if (pendingOnly) q = q.eq('result', 'pending');
    return chk(await q).map(s => ({ ...s, profile: s.profiles }));
  },
  async reviewSelfie(id, result) { chk(await sb.from('selfies').update({ result, reviewed_by: await myId() }).eq('id', id)); },

  async changePassword(oldPw, newPw) {
    if (String(newPw).length < 8) throw new Error('新密碼至少 8 碼');
    const { data } = await sb.auth.getSession();
    const { error } = await sb.auth.signInWithPassword({ email: data.session.user.email, password: oldPw });
    if (error) throw new Error('目前密碼不正確');
    chk(await sb.auth.updateUser({ password: newPw }));
  },

  // ===== 日報表 =====
  async getReportSettings() { return { ...DEFAULT_REPORT_SETTINGS, ...chk(await sb.from('report_settings').select('*').eq('id', 1).single()) }; },
  async saveReportSettings(patch) {
    chk(await sb.from('report_settings').update({ ...patch, updated_at: new Date().toISOString(), updated_by: await myId() }).eq('id', 1));
  },
  async listReportRuns() { return chk(await sb.from('report_runs').select('*').order('run_at', { ascending: false }).limit(30)); },
  async sendReportNow(day, to) {
    const { data, error } = await sb.functions.invoke('daily-report', { body: { day, to } });
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch { /* 保留原訊息 */ }
      throw new Error(msg);
    }
    return data;
  },
  async reportData(day) {
    const st = await api.getReportSettings();
    const startHour = st.day_start_hour;
    const { from, to } = dutyWindow(day, startHour);
    const F = from.toISOString(), T = to.toISOString();
    const [patrols, incidents, sos, routes, cps] = await Promise.all([
      sb.from('patrols').select(`*, scans(status,flags,server_at), ${prof('patrols')}`).gte('started_at', new Date(from.getTime() - 36 * 3600000).toISOString())
        .lt('started_at', T).or(`ended_at.is.null,ended_at.gte.${F}`).order('started_at').then(chk),
      sb.from('incidents').select(`*, ${prof('incidents')}`).gte('created_at', F).lt('created_at', T).order('created_at').then(chk),
      sb.from('sos_alerts').select(`*, ${prof('sos_alerts')}`).gte('created_at', F).lt('created_at', T).order('created_at').then(chk),
      routesWithPoints(false, false),
      sb.from('checkpoints').select('id,code,name').then(chk)]);
    const ids = patrols.map(p => p.id);
    const scans = ids.length ? chk(await sb.from('scans').select(`*, checkpoint:checkpoints(${CP_COLS}), ${prof('scans')}`).in('patrol_id', ids)
      .gte('server_at', F).lt('server_at', T).order('server_at')) : [];
    const w = applyWindow(patrols.map(p => summarize(p, routes)), scans.map(x => ({ ...x, profile: x.profiles })), from, to);
    return {
      day, dayStartHour: startHour, patrols: w.patrols, scans: w.scans,
      incidents: incidents.map(i => ({ ...i, profile: i.profiles })),
      sos: sos.map(x => ({ ...x, profile: x.profiles })),
      checkpointNames: Object.fromEntries(cps.map(c => [c.id, `${c.code} ${c.name}`])),
    };
  },

  subscribe(cb) {
    const ch = sb.channel('admin-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sos_alerts' }, cb)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'incidents' }, cb)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scans' }, cb)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'patrols' }, cb)
      .subscribe();
    const t = setInterval(cb, 60000);
    return () => { sb.removeChannel(ch); clearInterval(t); };
  },
};
