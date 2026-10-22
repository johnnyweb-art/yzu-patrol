// 相機：QR 掃描、App 內即時拍照、浮水印、SHA-256 雜湊
import { CONFIG } from './config.js';

let stream = null;

export async function startCamera(video, facing = 'environment') {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('此瀏覽器不支援相機，請改用 Chrome 或 Safari，並確認網址為 https 開頭');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
  } catch (e) {
    throw new Error(e.name === 'NotAllowedError' ? '相機權限被拒絕，請到瀏覽器設定允許此網站使用相機' : '無法啟動相機：' + e.message);
  }
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();
  return stream;
}

export function stopCamera() {
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
}

// 持續掃描，取得結果後呼叫 onResult(text)；回傳停止函式
export function scanLoop(video, onResult) {
  let stop = false;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
  async function tick() {
    if (stop) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        let text = null;
        if (detector) {
          const r = await detector.detect(video);
          text = r[0]?.rawValue || null;
        } else if (window.jsQR) {
          const w = Math.min(640, video.videoWidth), h = Math.round(video.videoHeight * w / video.videoWidth);
          canvas.width = w; canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          text = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data || null;
        }
        if (text && !stop) { stop = true; onResult(text); return; }
      } catch { /* 單一影格失敗不影響下一格 */ }
    }
    setTimeout(tick, 180);
  }
  tick();
  return () => { stop = true; };
}

// QR 內容格式：YZUPATROL|據點代碼|金鑰
export function parseQR(text) {
  const p = String(text).trim().split('|');
  if (p.length !== 3 || p[0] !== 'YZUPATROL') return null;
  return { code: p[1], token: p[2] };
}
export const qrPayload = (code, token) => `YZUPATROL|${code}|${token}`;

function drawWatermark(ctx, w, h, lines) {
  const fs = Math.max(14, Math.round(w / 40));
  const bandH = fs * 1.5 * lines.length + fs;
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fillRect(0, h - bandH, w, bandH);
  ctx.fillStyle = '#e8650c';
  ctx.fillRect(0, h - bandH, Math.max(4, fs / 3), bandH);
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${fs}px "Noto Sans TC", "PingFang TC", sans-serif`;
  lines.forEach((l, i) => ctx.fillText(l, fs, h - bandH + fs * 1.5 * (i + 1)));
}

function toBlob(canvas) {
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', CONFIG.PHOTO_QUALITY));
}

export async function sha256(blob) {
  const buf = await blob.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function finish(canvas) {
  const blob = await toBlob(canvas);
  return { blob, hash: await sha256(blob), url: URL.createObjectURL(blob) };
}

function sizeFor(sw, sh) {
  const s = Math.min(1, CONFIG.PHOTO_MAX_EDGE / Math.max(sw, sh));
  return [Math.round(sw * s), Math.round(sh * s)];
}

// 從即時畫面擷取一張照片並壓上浮水印
export async function captureFrame(video, lines, { mirror = false } = {}) {
  const [w, h] = sizeFor(video.videoWidth, video.videoHeight);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, 0, 0, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawWatermark(ctx, w, h, lines);
  return finish(c);
}

// 備援：由檔案產生照片（會被標記「非即時拍攝」）
export async function photoFromFile(file, lines) {
  const img = await createImageBitmap(file);
  const [w, h] = sizeFor(img.width, img.height);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  drawWatermark(ctx, w, h, lines);
  return finish(c);
}

// 示範模式：電腦沒有相機時產生示意照片
export async function samplePhoto(lines) {
  const w = 960, h = 720;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#2b3a44'); g.addColorStop(1, '#0e161b');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#4a5c66'; ctx.fillRect(330, 170, 300, 440);
  ctx.fillStyle = '#e8650c'; ctx.fillRect(450, 380, 20, 44);
  ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = '600 28px sans-serif'; ctx.fillText('示範照片', 40, 60);
  drawWatermark(ctx, w, h, lines);
  return finish(c);
}
