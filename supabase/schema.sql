-- =====================================================================
-- 元智大學 校園巡邏系統｜資料庫結構（Supabase / PostgreSQL）
-- 使用方式：Supabase 專案 → SQL Editor → 貼上全文 → Run
-- 設計原則：
--   1. 巡邏員只能讀寫自己的資料（Row Level Security）
--   2. 巡邏紀錄只能透過資料庫函式建立，前端無法直接寫入或修改
--   3. 時間戳記一律由伺服器產生
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- 人員 ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  staff_no text unique not null,
  name text not null,
  role text not null default 'guard' check (role in ('guard','supervisor','admin')),
  active boolean not null default true,
  phone text,
  created_at timestamptz not null default now()
);

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('supervisor','admin'), false)
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'admin', false)
$$;

-- 新帳號自動建立人員資料。角色取自 app_metadata（只有伺服器端能設定），避免使用者自行宣告為管理者
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, staff_no, name, role)
  values (
    new.id,
    upper(coalesce(new.raw_app_meta_data->>'staff_no', split_part(new.email, '@', 1))),
    coalesce(new.raw_app_meta_data->>'name', split_part(new.email, '@', 1)),
    case when new.raw_app_meta_data->>'role' in ('guard','supervisor','admin') then new.raw_app_meta_data->>'role' else 'guard' end
  )
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 裝置綁定 ----------
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_id text not null,
  label text,
  status text not null default 'pending' check (status in ('active','pending','revoked')),
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  unique (user_id, device_id)
);

-- ---------- 據點與路線 ----------
create table if not exists public.checkpoints (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  type text not null default '一般',
  lat double precision,
  lng double precision,
  radius_m int not null default 30 check (radius_m between 5 and 500),
  enforce_fence boolean not null default true,
  checklist jsonb not null default '[]'::jsonb,
  min_photos int not null default 1 check (min_photos between 0 and 3),
  qr_token text not null default encode(gen_random_bytes(9), 'hex'),
  active boolean not null default true,
  note text,
  updated_at timestamptz not null default now()
);

create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mode text not null default 'free' check (mode in ('free','ordered')),
  active boolean not null default true
);
create table if not exists public.route_points (
  route_id uuid not null references public.routes(id) on delete cascade,
  checkpoint_id uuid not null references public.checkpoints(id) on delete cascade,
  seq int not null,
  primary key (route_id, checkpoint_id)
);

-- ---------- 巡邏紀錄 ----------
create table if not exists public.patrols (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  device_id text,
  route_id uuid references public.routes(id),
  shift text,
  weather text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'active' check (status in ('active','ended')),
  uv_ok boolean not null default false,
  start_lat double precision,
  start_lng double precision,
  flags text[] not null default '{}',
  missed jsonb not null default '[]'::jsonb,
  handover_items jsonb not null default '{}'::jsonb,
  handover_note text,
  selfie_status text not null default 'none'
);
create index if not exists patrols_user_idx on public.patrols(user_id, started_at desc);
create unique index if not exists patrols_one_active on public.patrols(user_id) where status = 'active';

create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  patrol_id uuid not null references public.patrols(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  checkpoint_id uuid not null references public.checkpoints(id),
  server_at timestamptz not null default now(),
  device_at timestamptz,
  lat double precision,
  lng double precision,
  accuracy double precision,
  distance_m int,
  status text not null check (status in ('normal','abnormal')),
  checklist jsonb not null default '{}'::jsonb,
  category text,
  severity text,
  note text,
  photo_paths text[] not null default '{}',
  photo_hashes text[] not null default '{}',
  photos_purged_at timestamptz,
  flags text[] not null default '{}',
  review_status text not null default 'none' check (review_status in ('none','pending','ok','rejected')),
  review_note text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  unique (patrol_id, checkpoint_id)
);
create index if not exists scans_time_idx on public.scans(server_at desc);

create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  patrol_id uuid references public.patrols(id) on delete set null,
  user_id uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  type text not null,
  severity text,
  handling text,
  description text,
  lat double precision,
  lng double precision,
  photo_paths text[] not null default '{}',
  status text not null default 'open' check (status in ('open','processing','closed')),
  resolution text,
  closed_by uuid references public.profiles(id),
  closed_at timestamptz
);

create table if not exists public.sos_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id),
  patrol_id uuid references public.patrols(id) on delete set null,
  created_at timestamptz not null default now(),
  lat double precision,
  lng double precision,
  accuracy double precision,
  acknowledged_by uuid references public.profiles(id),
  acknowledged_at timestamptz
);

create table if not exists public.track_points (
  id bigserial primary key,
  patrol_id uuid not null references public.patrols(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id),
  at timestamptz not null,
  received_at timestamptz not null default now(),
  lat double precision not null,
  lng double precision not null,
  accuracy double precision
);
create index if not exists track_patrol_idx on public.track_points(patrol_id, at);

create table if not exists public.selfies (
  id uuid primary key default gen_random_uuid(),
  patrol_id uuid not null references public.patrols(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id),
  requested_at timestamptz,
  taken_at timestamptz,
  received_at timestamptz not null default now(),
  photo_path text,
  result text not null default 'pending' check (result in ('pending','ok','fail')),
  reviewed_by uuid references public.profiles(id)
);

-- ---------- 工具函式 ----------
create or replace function public.haversine_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- ---------- 巡邏員操作（RPC） ----------
create or replace function public.register_device(p_device_id text, p_label text)
returns text language plpgsql security definer set search_path = public as $$
declare v_status text; v_has_active boolean;
begin
  if auth.uid() is null then raise exception '未登入'; end if;
  if not exists (select 1 from profiles where id = auth.uid() and active) then raise exception '此帳號已停用，請洽管理者'; end if;
  select status into v_status from devices where user_id = auth.uid() and device_id = p_device_id;
  if found then return v_status; end if;
  select exists (select 1 from devices where user_id = auth.uid() and status = 'active') into v_has_active;
  insert into devices (user_id, device_id, label, status)
  values (auth.uid(), p_device_id, left(p_label, 120), case when v_has_active then 'pending' else 'active' end)
  returning status into v_status;
  return v_status;
end $$;

create or replace function public.start_patrol(p_route_id uuid, p_shift text, p_weather text, p_device_id text,
  p_lat double precision, p_lng double precision, p_uv_ok boolean)
returns public.patrols language plpgsql security definer set search_path = public as $$
declare v_row patrols;
begin
  if not exists (select 1 from profiles where id = auth.uid() and active) then raise exception '此帳號已停用，請洽管理者'; end if;
  if not exists (select 1 from devices where user_id = auth.uid() and device_id = p_device_id and status = 'active') then
    raise exception '此裝置未獲授權，請洽主管';
  end if;
  if not exists (select 1 from routes where id = p_route_id and active) then raise exception '巡邏路線不存在或已停用'; end if;
  select * into v_row from patrols where user_id = auth.uid() and status = 'active';
  if found then return v_row; end if;
  insert into patrols (user_id, device_id, route_id, shift, weather, start_lat, start_lng, uv_ok, flags)
  values (auth.uid(), p_device_id, p_route_id, p_shift, p_weather, p_lat, p_lng, coalesce(p_uv_ok, false),
          case when coalesce(p_uv_ok, false) then '{}'::text[] else array['UV_SKIPPED'] end)
  returning * into v_row;
  return v_row;
end $$;

-- 判定門檻與 js/config.js 的 RULES 相同
create or replace function public.submit_scan(
  p_patrol_id uuid, p_code text, p_token text, p_device_id text,
  p_lat double precision, p_lng double precision, p_acc double precision, p_device_at timestamptz,
  p_status text, p_checklist jsonb, p_category text, p_severity text, p_note text,
  p_photo_paths text[], p_photo_hashes text[], p_client_flags text[])
returns public.scans language plpgsql security definer set search_path = public as $$
declare
  c_max_speed constant double precision := 2.5;
  c_min_gap constant double precision := 20;
  c_low_acc constant double precision := 50;
  c_block_acc constant double precision := 100;
  c_tol_max constant double precision := 30;
  v_p patrols; v_cp checkpoints; v_mode text; v_prev scans; v_prev_cp checkpoints; v_row scans;
  v_flags text[]; v_dist double precision; v_tol double precision; v_gap double precision; v_need double precision; v_expected uuid;
begin
  select * into v_p from patrols where id = p_patrol_id and user_id = auth.uid();
  if not found then raise exception '找不到此巡邏場次'; end if;
  if v_p.status <> 'active' then raise exception '此巡邏已結束'; end if;
  if not exists (select 1 from devices where user_id = auth.uid() and device_id = p_device_id and status = 'active') then
    raise exception '此裝置未獲授權';
  end if;
  select * into v_cp from checkpoints where code = p_code and active;
  if not found or v_cp.qr_token <> p_token then raise exception 'QR Code 無效或已更換，請通報管理者'; end if;
  if not exists (select 1 from route_points where route_id = v_p.route_id and checkpoint_id = v_cp.id) then
    raise exception '此據點不在本次巡邏路線';
  end if;
  if exists (select 1 from scans where patrol_id = p_patrol_id and checkpoint_id = v_cp.id) then
    raise exception '此據點本場次已完成';
  end if;
  if p_status not in ('normal','abnormal') then raise exception '狀態不正確'; end if;
  if p_status = 'abnormal' and coalesce(btrim(p_note), '') = '' then raise exception '異常需填寫說明'; end if;
  if coalesce(array_length(p_photo_paths, 1), 0) < v_cp.min_photos then raise exception '照片數量不足'; end if;
  if exists (select 1 from unnest(coalesce(p_photo_paths, '{}')) x where split_part(x, '/', 1) <> auth.uid()::text) then
    raise exception '照片路徑不正確';
  end if;

  -- 只接受前端回報「非即時拍攝」這一種旗標，其餘一律由伺服器判定
  v_flags := array(select distinct f from unnest(coalesce(p_client_flags, '{}')) f where f = 'NON_LIVE_PHOTO');

  -- 位置
  if p_lat is null or p_lng is null then
    if v_cp.enforce_fence then raise exception '無法取得定位，請開啟 GPS 後再掃描'; end if;
    v_flags := array_append(v_flags, 'NO_GPS');
  elsif v_cp.lat is not null then
    v_dist := haversine_m(p_lat, p_lng, v_cp.lat, v_cp.lng);
    v_tol := v_cp.radius_m + least(coalesce(p_acc, 0), c_tol_max);
    if coalesce(p_acc, 9999) > c_low_acc then v_flags := array_append(v_flags, 'LOW_ACCURACY'); end if;
    if v_dist > v_tol then
      if v_cp.enforce_fence and coalesce(p_acc, 9999) <= c_block_acc then
        raise exception '位置驗證失敗：距離據點 % 公尺，超出允許範圍 % 公尺', round(v_dist::numeric), round(v_tol::numeric);
      end if;
      v_flags := array_append(v_flags, 'OUT_OF_FENCE');
    end if;
  end if;

  -- 時間
  if p_device_at is not null then
    if now() - p_device_at > interval '10 minutes' then v_flags := array_append(v_flags, 'DELAYED_UPLOAD'); end if;
    if p_device_at - now() > interval '120 seconds' then v_flags := array_append(v_flags, 'CLOCK_SKEW'); end if;
  end if;
  select * into v_prev from scans where patrol_id = p_patrol_id order by coalesce(device_at, server_at) desc limit 1;
  if found then
    v_gap := extract(epoch from (coalesce(p_device_at, now()) - coalesce(v_prev.device_at, v_prev.server_at)));
    select * into v_prev_cp from checkpoints where id = v_prev.checkpoint_id;
    v_need := c_min_gap;
    if v_prev_cp.lat is not null and v_cp.lat is not null then
      v_need := greatest(v_need, haversine_m(v_prev_cp.lat, v_prev_cp.lng, v_cp.lat, v_cp.lng) / c_max_speed);
    end if;
    if v_gap < v_need then v_flags := array_append(v_flags, 'TOO_FAST'); end if;
  end if;

  -- 順序
  select mode into v_mode from routes where id = v_p.route_id;
  if v_mode = 'ordered' then
    select rp.checkpoint_id into v_expected from route_points rp
    where rp.route_id = v_p.route_id
      and not exists (select 1 from scans s where s.patrol_id = p_patrol_id and s.checkpoint_id = rp.checkpoint_id)
    order by rp.seq limit 1;
    if v_expected is distinct from v_cp.id then v_flags := array_append(v_flags, 'OUT_OF_ORDER'); end if;
  end if;

  insert into scans (patrol_id, user_id, checkpoint_id, device_at, lat, lng, accuracy, distance_m, status, checklist,
                     category, severity, note, photo_paths, photo_hashes, flags, review_status)
  values (p_patrol_id, auth.uid(), v_cp.id, p_device_at, p_lat, p_lng, p_acc, round(v_dist)::int, p_status,
          coalesce(p_checklist, '{}'::jsonb), nullif(p_category, ''), nullif(p_severity, ''), p_note,
          coalesce(p_photo_paths, '{}'), coalesce(p_photo_hashes, '{}'), v_flags,
          case when cardinality(v_flags) > 0 then 'pending' else 'none' end)
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.end_patrol(p_patrol_id uuid, p_missed jsonb, p_handover_items jsonb, p_note text, p_selfie_status text)
returns public.patrols language plpgsql security definer set search_path = public as $$
declare v_p patrols;
begin
  select * into v_p from patrols where id = p_patrol_id and user_id = auth.uid();
  if not found or v_p.status <> 'active' then raise exception '此巡邏已結束或不存在'; end if;
  if exists (
    select 1 from route_points rp
    where rp.route_id = v_p.route_id
      and not exists (select 1 from scans s where s.patrol_id = v_p.id and s.checkpoint_id = rp.checkpoint_id)
      and not exists (select 1 from jsonb_array_elements(coalesce(p_missed, '[]'::jsonb)) m
                      where m->>'checkpoint_id' = rp.checkpoint_id::text and coalesce(m->>'reason', '') <> '')
  ) then raise exception '未巡據點須填寫原因'; end if;
  update patrols set status = 'ended', ended_at = now(), missed = coalesce(p_missed, '[]'::jsonb),
         handover_items = coalesce(p_handover_items, '{}'::jsonb), handover_note = p_note,
         selfie_status = coalesce(p_selfie_status, 'none'),
         flags = case when p_selfie_status = 'missed' and not ('SELFIE_MISSED' = any(flags)) then array_append(flags, 'SELFIE_MISSED') else flags end
  where id = p_patrol_id
  returning * into v_p;
  return v_p;
end $$;

-- ---------- 管理端函式 ----------
create or replace function public.admin_checkpoints() returns setof public.checkpoints
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception '權限不足'; end if;
  return query select * from checkpoints order by code;
end $$;

create or replace function public.rotate_qr_token(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v text := encode(gen_random_bytes(9), 'hex');
begin
  if not is_admin() then raise exception '僅限管理者'; end if;
  update checkpoints set qr_token = v, updated_at = now() where id = p_id;
  return v;
end $$;

create or replace function public.save_route(p_id uuid, p_name text, p_mode text, p_active boolean, p_point_ids uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_id;
begin
  if not is_admin() then raise exception '僅限管理者'; end if;
  if v_id is null then
    insert into routes (name, mode, active) values (p_name, p_mode, p_active) returning id into v_id;
  else
    update routes set name = p_name, mode = p_mode, active = p_active where id = v_id;
    delete from route_points where route_id = v_id;
  end if;
  insert into route_points (route_id, checkpoint_id, seq)
  select v_id, x.id, x.ord from unnest(p_point_ids) with ordinality as x(id, ord);
  return v_id;
end $$;

-- 核准新裝置時，同一人原本的裝置自動停用（一人一機）
create or replace function public.set_device_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not is_staff() then raise exception '權限不足'; end if;
  if p_status not in ('active','pending','revoked') then raise exception '狀態不正確'; end if;
  select user_id into v_user from devices where id = p_id;
  if p_status = 'active' then
    update devices set status = 'revoked', decided_by = auth.uid(), decided_at = now()
    where user_id = v_user and status = 'active' and id <> p_id;
  end if;
  update devices set status = p_status, decided_by = auth.uid(), decided_at = now() where id = p_id;
end $$;

-- ---------- 權限 ----------
alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.checkpoints enable row level security;
alter table public.routes enable row level security;
alter table public.route_points enable row level security;
alter table public.patrols enable row level security;
alter table public.scans enable row level security;
alter table public.incidents enable row level security;
alter table public.sos_alerts enable row level security;
alter table public.track_points enable row level security;
alter table public.selfies enable row level security;

drop policy if exists p_profiles_sel on public.profiles;
create policy p_profiles_sel on public.profiles for select to authenticated using (id = auth.uid() or is_staff());
drop policy if exists p_profiles_upd on public.profiles;
create policy p_profiles_upd on public.profiles for update to authenticated using (is_admin()) with check (is_admin());

drop policy if exists p_devices_sel on public.devices;
create policy p_devices_sel on public.devices for select to authenticated using (user_id = auth.uid() or is_staff());

drop policy if exists p_cp_sel on public.checkpoints;
create policy p_cp_sel on public.checkpoints for select to authenticated using (true);
drop policy if exists p_cp_ins on public.checkpoints;
create policy p_cp_ins on public.checkpoints for insert to authenticated with check (is_admin());
drop policy if exists p_cp_upd on public.checkpoints;
create policy p_cp_upd on public.checkpoints for update to authenticated using (is_admin()) with check (is_admin());

drop policy if exists p_routes_sel on public.routes;
create policy p_routes_sel on public.routes for select to authenticated using (true);
drop policy if exists p_rp_sel on public.route_points;
create policy p_rp_sel on public.route_points for select to authenticated using (true);

drop policy if exists p_patrols_sel on public.patrols;
create policy p_patrols_sel on public.patrols for select to authenticated using (user_id = auth.uid() or is_staff());

drop policy if exists p_scans_sel on public.scans;
create policy p_scans_sel on public.scans for select to authenticated using (user_id = auth.uid() or is_staff());
drop policy if exists p_scans_review on public.scans;
create policy p_scans_review on public.scans for update to authenticated using (is_staff()) with check (is_staff());

drop policy if exists p_inc_sel on public.incidents;
create policy p_inc_sel on public.incidents for select to authenticated using (user_id = auth.uid() or is_staff());
drop policy if exists p_inc_ins on public.incidents;
create policy p_inc_ins on public.incidents for insert to authenticated with check (user_id = auth.uid());
drop policy if exists p_inc_upd on public.incidents;
create policy p_inc_upd on public.incidents for update to authenticated using (is_staff()) with check (is_staff());

drop policy if exists p_sos_sel on public.sos_alerts;
create policy p_sos_sel on public.sos_alerts for select to authenticated using (user_id = auth.uid() or is_staff());
drop policy if exists p_sos_ins on public.sos_alerts;
create policy p_sos_ins on public.sos_alerts for insert to authenticated with check (user_id = auth.uid());
drop policy if exists p_sos_upd on public.sos_alerts;
create policy p_sos_upd on public.sos_alerts for update to authenticated using (is_staff()) with check (is_staff());

drop policy if exists p_track_sel on public.track_points;
create policy p_track_sel on public.track_points for select to authenticated using (user_id = auth.uid() or is_staff());
drop policy if exists p_track_ins on public.track_points;
create policy p_track_ins on public.track_points for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.patrols p where p.id = patrol_id and p.user_id = auth.uid() and p.status = 'active'));

drop policy if exists p_selfie_sel on public.selfies;
create policy p_selfie_sel on public.selfies for select to authenticated using (user_id = auth.uid() or is_staff());
drop policy if exists p_selfie_ins on public.selfies;
create policy p_selfie_ins on public.selfies for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.patrols p where p.id = patrol_id and p.user_id = auth.uid()));
drop policy if exists p_selfie_upd on public.selfies;
create policy p_selfie_upd on public.selfies for update to authenticated using (is_staff()) with check (is_staff());

-- 欄位層級權限：資料表只開放必要欄位，其餘一律經由上方函式處理
revoke all on public.profiles, public.devices, public.checkpoints, public.routes, public.route_points, public.patrols,
  public.scans, public.incidents, public.sos_alerts, public.track_points, public.selfies from anon, authenticated;

grant select on public.profiles, public.devices, public.routes, public.route_points, public.patrols, public.scans,
  public.incidents, public.sos_alerts, public.track_points, public.selfies to authenticated;
-- 巡邏員看不到 QR 金鑰欄位
grant select (id, code, name, type, lat, lng, radius_m, enforce_fence, checklist, min_photos, active, note, updated_at)
  on public.checkpoints to authenticated;
grant insert (code, name, type, lat, lng, radius_m, enforce_fence, checklist, min_photos, active, note) on public.checkpoints to authenticated;
grant update (code, name, type, lat, lng, radius_m, enforce_fence, checklist, min_photos, active, note, updated_at) on public.checkpoints to authenticated;
grant update (name, role, active, phone) on public.profiles to authenticated;
grant update (review_status, review_note, reviewed_by, reviewed_at) on public.scans to authenticated;
grant insert (patrol_id, user_id, type, severity, handling, description, lat, lng, photo_paths) on public.incidents to authenticated;
grant update (status, resolution, closed_by, closed_at) on public.incidents to authenticated;
grant insert (user_id, patrol_id, lat, lng, accuracy) on public.sos_alerts to authenticated;
grant update (acknowledged_by, acknowledged_at) on public.sos_alerts to authenticated;
grant insert (patrol_id, user_id, at, lat, lng, accuracy) on public.track_points to authenticated;
grant usage on sequence public.track_points_id_seq to authenticated;
grant insert (patrol_id, user_id, requested_at, taken_at, photo_path) on public.selfies to authenticated;
grant update (result, reviewed_by) on public.selfies to authenticated;

revoke execute on function public.register_device(text, text), public.start_patrol(uuid, text, text, text, double precision, double precision, boolean),
  public.submit_scan(uuid, text, text, text, double precision, double precision, double precision, timestamptz, text, jsonb, text, text, text, text[], text[], text[]),
  public.end_patrol(uuid, jsonb, jsonb, text, text), public.admin_checkpoints(), public.rotate_qr_token(uuid),
  public.save_route(uuid, text, text, boolean, uuid[]), public.set_device_status(uuid, text) from public, anon;
grant execute on function public.register_device(text, text), public.start_patrol(uuid, text, text, text, double precision, double precision, boolean),
  public.submit_scan(uuid, text, text, text, double precision, double precision, double precision, timestamptz, text, jsonb, text, text, text, text[], text[], text[]),
  public.end_patrol(uuid, jsonb, jsonb, text, text), public.admin_checkpoints(), public.rotate_qr_token(uuid),
  public.save_route(uuid, text, text, boolean, uuid[]), public.set_device_status(uuid, text) to authenticated;

-- ---------- 照片儲存空間（私有，只能新增、不能修改或刪除） ----------
insert into storage.buckets (id, name, public) values ('patrol-photos', 'patrol-photos', false) on conflict (id) do nothing;
drop policy if exists "patrol photos insert own" on storage.objects;
create policy "patrol photos insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'patrol-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "patrol photos read" on storage.objects;
create policy "patrol photos read" on storage.objects for select to authenticated
  using (bucket_id = 'patrol-photos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_staff()));

-- ---------- 即時推播（SOS、事件、掃描） ----------
do $$ begin
  alter publication supabase_realtime add table public.sos_alerts, public.incidents, public.scans, public.patrols;
exception when others then null; end $$;
