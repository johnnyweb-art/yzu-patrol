// 手機臉部／指紋辨識（WebAuthn 通行金鑰）。手機只回傳「驗證通過」的簽章，臉部特徵不會離開手機。
import { startRegistration, startAuthentication, browserSupportsWebAuthn, platformAuthenticatorIsAvailable } from '../vendor/simplewebauthn-browser.js';
export { startRegistration, startAuthentication };

export async function supported() {
  try { return browserSupportsWebAuthn() && await platformAuthenticatorIsAvailable(); } catch { return false; }
}

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

// 示範模式在本機產生選項；正式模式由伺服器產生並驗證
export function localRegOptions({ staff_no, name }) {
  return {
    challenge: rand(32),
    rp: { name: '校園巡邏', id: location.hostname },
    user: { id: rand(16), name: staff_no, displayName: name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    timeout: 60000, attestation: 'none',
  };
}
export function localAuthOptions(credentialId) {
  return { challenge: rand(32), rpId: location.hostname, allowCredentials: [{ id: credentialId, type: 'public-key' }], userVerification: 'required', timeout: 60000 };
}

export function friendlyError(e) {
  const n = e?.name || '', m = String(e?.message || e);
  if (n === 'NotAllowedError' || /NotAllowed|cancel|timed out/i.test(m)) return '臉部辨識已取消或逾時，請再試一次';
  if (n === 'InvalidStateError') return '這支手機已經註冊過，請改用「掃臉進入」';
  if (n === 'SecurityError') return '網址不正確，請確認使用學校提供的 https 網址開啟';
  if (n === 'NotSupportedError') return '此手機或瀏覽器不支援臉部辨識。iPhone 請用 Safari，Android 請用 Chrome';
  return m;
}
