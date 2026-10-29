// 巡邏員臉部辨識註冊與登入（通行金鑰），由伺服器驗證手機回傳的簽章。
// 部署：supabase functions deploy passkey --no-verify-jwt
// 環境變數（Edge Functions → Secrets）：
//   WEBAUTHN_RP_ID        網站網域，例如 johnnyweb-art.github.io
//   WEBAUTHN_ORIGINS      網站來源，可多個以逗號分隔，例如 https://johnnyweb-art.github.io
//   LOGIN_EMAIL_DOMAIN    與 js/config.js 相同，預設 patrol.yzu.local
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { authOptions, regOptions, verifyAuth, verifyReg, type RP } from '../_shared/webauthn.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
class UserError extends Error {}
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const rp: RP = {
    rpID: Deno.env.get('WEBAUTHN_RP_ID') ?? '',
    origins: (Deno.env.get('WEBAUTHN_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
  const domain = Deno.env.get('LOGIN_EMAIL_DOMAIN') ?? 'patrol.yzu.local';

  async function saveChallenge(challenge: string, purpose: string) {
    const { data, error } = await db.from('webauthn_challenges').insert({ challenge, purpose }).select('id').single();
    if (error) throw error;
    return data.id as string;
  }
  async function takeChallenge(id: string, purpose: string) {
    const { data } = await db.from('webauthn_challenges').delete().eq('id', id).eq('purpose', purpose).select().maybeSingle();
    if (!data || Date.now() - new Date(data.created_at).getTime() > CHALLENGE_TTL_MS) throw new UserError('驗證逾時，請再試一次');
    return data.challenge as string;
  }

  try {
    if (!rp.rpID || !rp.origins.length) throw new Error('伺服器尚未設定 WEBAUTHN_RP_ID 與 WEBAUTHN_ORIGINS');
    const b = await req.json();
    // 順手清除過期的驗證碼
    await db.from('webauthn_challenges').delete().lt('created_at', new Date(Date.now() - CHALLENGE_TTL_MS).toISOString());

    switch (b.action) {
      case 'register-options': {
        const staff_no = String(b.staff_no ?? '').trim().toUpperCase();
        const name = String(b.name ?? '').trim();
        if (!/^[A-Z0-9_-]{2,20}$/.test(staff_no)) throw new UserError('工號格式不正確');
        if (!name || name.length > 30) throw new UserError('請填寫姓名');
        const options = await regOptions(rp, staff_no, name);
        return json({ challengeId: await saveChallenge(options.challenge, 'register'), options });
      }

      case 'register-submit': {
        const staff_no = String(b.staff_no ?? '').trim().toUpperCase();
        const name = String(b.name ?? '').trim();
        if (!/^[A-Z0-9_-]{2,20}$/.test(staff_no) || !name) throw new UserError('工號或姓名不正確');
        if (b.consent !== true) throw new UserError('需同意個人資料蒐集告知才能申請');
        if (!b.device_id) throw new UserError('缺少裝置資訊');
        const cred = await verifyReg(rp, b.response, await takeChallenge(b.challengeId, 'register'));
        const { data: existing } = await db.from('profiles').select('id,active').eq('staff_no', staff_no).maybeSingle();
        if (existing && !existing.active) throw new UserError('此工號已停用，請洽總務處');
        // 同一工號只保留一筆待審申請
        await db.from('registration_requests').delete().eq('staff_no', staff_no).eq('status', 'pending');
        const { data, error } = await db.from('registration_requests').insert({
          kind: existing ? 'rebind' : 'new', staff_no, name, phone: String(b.phone ?? '').slice(0, 30) || null, org: String(b.org ?? '').slice(0, 60) || null,
          post: String(b.post ?? '').slice(0, 20) || null,
          device_id: String(b.device_id).slice(0, 80), device_label: String(b.device_label ?? '').slice(0, 120),
          credential_id: cred.credentialId, public_key: cred.publicKey, counter: cred.counter, transports: cred.transports,
          consent_at: new Date().toISOString(),
        }).select('id').single();
        if (error) throw error;
        return json({ requestId: data.id, credentialId: cred.credentialId, status: 'pending' });
      }

      case 'status': {
        const { data } = await db.from('registration_requests').select('status,reject_reason,device_id').eq('id', b.requestId).maybeSingle();
        if (!data || data.device_id !== b.device_id) return json({ status: 'missing' });
        return json({ status: data.status, reason: data.reject_reason });
      }

      case 'login-options': {
        const { data: pk } = await db.from('passkeys').select('credential_id,transports,active').eq('credential_id', b.credential_id).maybeSingle();
        if (!pk?.active) throw new UserError('此手機的臉部登入已失效，請重新申請註冊');
        const options = await authOptions(rp, pk.credential_id, pk.transports ?? []);
        return json({ challengeId: await saveChallenge(options.challenge, 'login'), options });
      }

      case 'login-verify': {
        const challenge = await takeChallenge(b.challengeId, 'login');
        const { data: pk } = await db.from('passkeys').select('*').eq('credential_id', b.response?.id).eq('active', true).maybeSingle();
        if (!pk) throw new UserError('此手機的臉部登入已失效，請重新申請註冊');
        const { data: prof } = await db.from('profiles').select('id,staff_no,active').eq('id', pk.user_id).single();
        if (!prof?.active) throw new UserError('此帳號已停用，請洽總務處');
        if (pk.device_id !== b.device_id) throw new UserError('臉部登入只能在註冊時的手機使用');
        const { data: dev } = await db.from('devices').select('id,status').eq('user_id', pk.user_id).eq('device_id', b.device_id).maybeSingle();
        if (dev?.status !== 'active') throw new UserError('此手機未獲授權，請洽班長');
        const counter = await verifyAuth(rp, b.response, challenge, pk);
        const now = new Date().toISOString();
        await db.from('passkeys').update({ counter, last_used_at: now }).eq('id', pk.id);
        // 伺服器記錄「剛通過臉部辨識」，開始巡邏時據此判定，不採信手機自行回報
        await db.from('devices').update({ last_uv_at: now }).eq('id', dev.id);
        const { data: link, error } = await db.auth.admin.generateLink({ type: 'magiclink', email: `${prof.staff_no.toLowerCase()}@${domain}` });
        if (error) throw error;
        return json({ token_hash: link.properties.hashed_token });
      }
    }
    return json({ error: '未知的操作' }, 400);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    return json({ error: e instanceof UserError || /驗證|臉部/.test(msg) ? msg : `伺服器錯誤：${msg}` }, e instanceof UserError ? 400 : 500);
  }
});
