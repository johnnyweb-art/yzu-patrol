// 管理者專用功能：建立帳號、重設密碼、刪除過期照片。
// 部署：supabase functions deploy admin
// 需要伺服器端金鑰（SUPABASE_SERVICE_ROLE_KEY），由 Supabase 自動提供，不會出現在前端。
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: '請重新登入' }, 401);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: me } = await admin.from('profiles').select('role,active').eq('id', user.id).single();
    if (!me?.active || me.role !== 'admin') return json({ error: '僅限管理者' }, 403);

    const body = await req.json();

    if (body.action === 'createUser') {
      const staff_no = String(body.staff_no || '').trim().toUpperCase();
      const role = ['guard', 'supervisor', 'admin'].includes(body.role) ? body.role : 'guard';
      if (!/^[A-Z0-9_-]{2,20}$/.test(staff_no)) return json({ error: '工號格式不正確' }, 400);
      if (String(body.password || '').length < 8) return json({ error: '密碼至少 8 碼' }, 400);
      const { data, error } = await admin.auth.admin.createUser({
        email: `${staff_no.toLowerCase()}@${body.email_domain}`,
        password: body.password,
        email_confirm: true,
        app_metadata: { staff_no, name: body.name, role },
      });
      if (error) return json({ error: /already/i.test(error.message) ? '工號已存在' : error.message }, 400);
      await admin.from('profiles').upsert({ id: data.user.id, staff_no, name: body.name, role });
      return json({ id: data.user.id });
    }

    if (body.action === 'resetPassword') {
      if (String(body.password || '').length < 8) return json({ error: '密碼至少 8 碼' }, 400);
      const { error } = await admin.auth.admin.updateUserById(body.user_id, { password: body.password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (body.action === 'purgePhotos') {
      const days = Math.max(30, Number(body.days) || 180);
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const { data: rows } = await admin.from('scans').select('id,photo_paths').lt('server_at', cutoff).neq('photo_paths', '{}').limit(1000);
      let removed = 0;
      for (const r of rows ?? []) {
        const { error } = await admin.storage.from('patrol-photos').remove(r.photo_paths);
        if (!error) {
          removed += r.photo_paths.length;
          await admin.from('scans').update({ photo_paths: [], photos_purged_at: new Date().toISOString() }).eq('id', r.id);
        }
      }
      const { data: selfies } = await admin.from('selfies').select('id,photo_path').lt('taken_at', cutoff).not('photo_path', 'is', null).limit(1000);
      for (const s of selfies ?? []) {
        const { error } = await admin.storage.from('patrol-photos').remove([s.photo_path]);
        if (!error) { removed++; await admin.from('selfies').update({ photo_path: null }).eq('id', s.id); }
      }
      return json({ removed });
    }

    return json({ error: '未知的操作' }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
