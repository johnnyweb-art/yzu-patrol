// 手機生物辨識（指紋／臉部），使用 WebAuthn 平台驗證器。
// 限制：目前僅在手機端確認「解鎖者為手機擁有人」，伺服器端尚未驗證簽章（見 docs/已知限制.md）。
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const KEY = 'yzup-cred-';

export async function available() {
  try {
    return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

export function storedCredential(userId) {
  try { return localStorage.getItem(KEY + userId); } catch { return null; }
}

export async function enroll(profile) {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: '校園巡邏' },
      user: { id: new TextEncoder().encode(profile.id).slice(0, 64), name: profile.staff_no, displayName: profile.name },
      challenge: rand(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60000,
      attestation: 'none',
    },
  });
  const id = b64(cred.rawId);
  try { localStorage.setItem(KEY + profile.id, id); } catch { /* 無法保存時下次再設定 */ }
  return id;
}

export async function verify(userId) {
  const id = storedCredential(userId);
  if (!id) return false;
  try {
    const a = await navigator.credentials.get({
      publicKey: { challenge: rand(32), allowCredentials: [{ type: 'public-key', id: unb64(id) }], userVerification: 'required', timeout: 60000 },
    });
    return !!a;
  } catch { return false; }
}
