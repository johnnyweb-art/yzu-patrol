// 伺服器端通行金鑰驗證（SimpleWebAuthn）
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from 'npm:@simplewebauthn/server@13.3.3';

export type RP = { rpID: string; origins: string[] };
const enc = new TextEncoder();
const toB64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));

export function regOptions(rp: RP, staffNo: string, name: string) {
  return generateRegistrationOptions({
    rpName: '校園巡邏', rpID: rp.rpID, userName: staffNo, userDisplayName: name,
    userID: enc.encode(`${staffNo}:${crypto.randomUUID()}`).slice(0, 64),
    attestationType: 'none',
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
  });
}

// deno-lint-ignore no-explicit-any
export async function verifyReg(rp: RP, response: any, expectedChallenge: string) {
  const v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: true });
  if (!v.verified || !v.registrationInfo) throw new Error('臉部辨識註冊驗證失敗');
  const c = v.registrationInfo.credential;
  return { credentialId: c.id, publicKey: toB64url(c.publicKey), counter: c.counter, transports: response.response?.transports ?? [] };
}

export function authOptions(rp: RP, credentialId: string, transports: string[] = []) {
  // deno-lint-ignore no-explicit-any
  return generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', allowCredentials: [{ id: credentialId, transports: transports as any }] });
}

// deno-lint-ignore no-explicit-any
export async function verifyAuth(rp: RP, response: any, expectedChallenge: string, cred: { credential_id: string; public_key: string; counter: number; transports?: string[] }) {
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: true,
    // deno-lint-ignore no-explicit-any
    credential: { id: cred.credential_id, publicKey: fromB64url(cred.public_key), counter: Number(cred.counter), transports: (cred.transports ?? []) as any },
  });
  if (!v.verified) throw new Error('臉部辨識驗證失敗');
  return v.authenticationInfo.newCounter;
}
