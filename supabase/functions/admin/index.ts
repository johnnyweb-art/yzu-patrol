// 管理功能：審核巡邏員註冊（班長、管理者）；建立帳號、重設密碼、刪除過期照片（限管理者）。
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
    if (!me?.active || !['supervisor', 'admin'].includes(me.role)) return json({ error: '權限不足' }, 403);

    const body = await req.json();
    // 班長可審核巡邏員註冊；其餘功能限管理者
    if (!['approveRegistration', 'rejectRegistration'].includes(body.action) && me.role !== 'admin') return json({ error: '僅限管理者' }, 403);

    if (body.action === 'approveRegistration') {
      const { data: r } = await admin.from('registration_requests').select('*').eq('id', body.request_id).single();
      if (!r || r.status !== 'pending') return json({ error: '此申請已處理或不存在' }, 400);
      let userId: string;
      const { data: prof } = await admin.from('profiles').select('id,active').eq('staff_no', r.staff_no).maybeSingle();
      if (prof) {
        if (!prof.active) return json({ error: '此工號已停用' }, 400);
        userId = prof.id;
        await admin.from('passkeys').update({ active: false }).eq('user_id', userId);
      } else {
        // 臉部辨識登入不需要密碼，建立一組無人知道的隨機密碼
        const pw = crypto.randomUUID() + crypto.randomUUID();
        const { data, error } = await admin.auth.admin.createUser({
          email: `${r.staff_no.toLowerCase()}@${body.email_domain}`, password: pw, email_confirm: true,
          app_metadata: { staff_no: r.staff_no, name: r.name, role: 'guard' },
        });
        if (error) return json({ error: error.message }, 400);
        userId = data.user.id;
        await admin.from('profiles').upsert({ id: userId, staff_no: r.staff_no, name: r.name, role: 'guard', phone: r.phone });
      }
      // 一人一機：核准的手機成為唯一使用中的裝置
      await admin.from('devices').update({ status: 'revoked', decided_by: user.id, decided_at: new Date().toISOString() }).eq('user_id', userId).eq('status', 'active');
      await admin.from('devices').upsert({ user_id: userId, device_id: r.device_id, label: r.device_label, status: 'active', decided_by: user.id, decided_at: new Date().toISOString() },
        { onConflict: 'user_id,device_id' });
      const { error: pe } = await admin.from('passkeys').insert({ user_id: userId, device_id: r.device_id, credential_id: r.credential_id, public_key: r.public_key, counter: r.counter, transports: r.transports });
      if (pe) return json({ error: pe.message }, 400);
      await admin.from('registration_requests').update({ status: 'approved', user_id: userId, decided_by: user.id, decided_at: new Date().toISOString() }).eq('id', r.id);
      return json({ ok: true, user_id: userId });
    }

    if (body.action === 'rejectRegistration') {
      const reason = String(body.reason ?? '').trim();
      if (!reason) return json({ error: '請填寫退回原因' }, 400);
      const { error } = await admin.from('registration_requests').update({ status: 'rejected', reject_reason: reason, decided_by: user.id, decided_at: new Date().toISOString() })
        .eq('id', body.request_id).eq('status', 'pending');
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

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
