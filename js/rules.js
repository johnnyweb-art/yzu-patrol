// 防代巡判定規則。示範模式由此檔判定；正式環境由資料庫函式 submit_scan 判定，邏輯相同。
import { CONFIG } from './config.js';

export { FLAG_LABELS, flagLabel } from '../supabase/functions/_shared/labels.js';

export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export class RuleError extends Error {}

// 回傳 { flags, distance }；應直接拒絕的情形丟出 RuleError
export function evaluateScan({ cp, lat, lng, acc, deviceAt, serverAt, prev, prevCp, route, scannedIds, clientFlags = [] }) {
  const R = CONFIG.RULES;
  const flags = clientFlags.filter(f => f === 'NON_LIVE_PHOTO');
  let distance = null;
  if (lat == null || lng == null) {
    if (cp.enforce_fence) throw new RuleError('無法取得定位，請開啟 GPS 後再掃描');
    flags.push('NO_GPS');
  } else if (cp.lat != null) {
    distance = distanceM(lat, lng, cp.lat, cp.lng);
    const tol = cp.radius_m + Math.min(acc ?? 0, R.FENCE_TOLERANCE_MAX_M);
    const a = acc ?? 9999;
    if (a > R.LOW_ACC_M) flags.push('LOW_ACCURACY');
    if (distance > tol) {
      if (cp.enforce_fence && a <= R.BLOCK_MAX_ACC_M) {
        throw new RuleError(`位置驗證失敗：距離據點 ${Math.round(distance)} 公尺，超出允許範圍 ${Math.round(tol)} 公尺`);
      }
      flags.push('OUT_OF_FENCE');
    }
  }
  if (deviceAt) {
    if (serverAt - deviceAt > R.DELAY_MIN * 60000) flags.push('DELAYED_UPLOAD');
    if (deviceAt - serverAt > R.SKEW_SEC * 1000) flags.push('CLOCK_SKEW');
  }
  if (prev) {
    const gap = ((deviceAt || serverAt) - (prev.device_at ? new Date(prev.device_at) : new Date(prev.server_at))) / 1000;
    let need = R.MIN_GAP_SEC;
    if (prevCp?.lat != null && cp.lat != null) need = Math.max(need, distanceM(prevCp.lat, prevCp.lng, cp.lat, cp.lng) / R.MAX_SPEED_MPS);
    if (gap < need) flags.push('TOO_FAST');
  }
  if (route?.mode === 'ordered') {
    const expected = route.points.find(p => !scannedIds.includes(p.id));
    if (expected && expected.id !== cp.id) flags.push('OUT_OF_ORDER');
  }
  return { flags, distance };
}
