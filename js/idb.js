// 極簡 IndexedDB 鍵值儲存：用於離線佇列與示範模式的照片
const DB = 'yzu-patrol';
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('queue', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
}
export const kv = {
  get: k => tx('kv', 'readonly', s => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)),
  del: k => tx('kv', 'readwrite', s => s.delete(k)),
  clear: () => tx('kv', 'readwrite', s => s.clear()),
};
export const queueStore = {
  all: () => tx('queue', 'readonly', s => s.getAll()),
  put: item => tx('queue', 'readwrite', s => s.put(item)),
  del: id => tx('queue', 'readwrite', s => s.delete(id)),
  clear: () => tx('queue', 'readwrite', s => s.clear()),
};
