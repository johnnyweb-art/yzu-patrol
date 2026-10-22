// 資料存取介面。示範模式與正式模式（Supabase）提供相同的函式。
import { DEMO } from './config.js';

const mod = DEMO ? await import('./backend-demo.js') : await import('./backend-supabase.js');
export const api = mod.api;
export { DEMO };

// 判斷是否為網路問題（應放入離線佇列，而非視為驗證失敗）
export function isNetworkError(e) {
  if (!navigator.onLine) return true;
  const m = String(e?.message || e);
  return e?.code === 'NETWORK' || /Failed to fetch|NetworkError|Load failed|network/i.test(m);
}
