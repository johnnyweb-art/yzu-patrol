-- 範例據點與路線（選用）。名稱與座標皆為示意，正式使用前請於管理後台修改或刪除。
insert into public.checkpoints (code, name, type, lat, lng, radius_m, enforce_fence, checklist, note) values
 ('P01', '行政大樓正門', '門禁', 24.970200, 121.266000, 30, true,  '["門窗已上鎖","門禁設備正常","無破壞痕跡"]', null),
 ('P02', '圖書館側門',   '門禁', 24.971278, 121.266891, 30, true,  '["門窗已上鎖","門禁設備正常","無破壞痕跡"]', null),
 ('P03', '體育館周邊',   '戶外', 24.972536, 121.265208, 30, true,  '["照明正常","無積水或倒木","無可疑人員"]', null),
 ('P04', '學生宿舍區',   '宿舍', 24.973613, 121.267584, 30, true,  '["出入口管制正常","逃生通道淨空","無可疑人員"]', null),
 ('P05', '地下停車場 B1', '停車場', 24.969392, 121.267980, 30, false, '["照明正常","無違規停車","緊急求救鈴正常"]', '室內點，GPS 訊號弱，不強制圍欄'),
 ('P06', '配電室',       '機電', 24.968853, 121.265406, 30, false, '["無異味或異音","無漏水","滅火器壓力正常"]', '室內點，GPS 訊號弱，不強制圍欄')
on conflict (code) do nothing;

with r as (insert into public.routes (name, mode) values ('A 線・校園全區', 'free') returning id)
insert into public.route_points (route_id, checkpoint_id, seq)
select r.id, c.id, row_number() over (order by c.code) from r, public.checkpoints c where c.code in ('P01','P02','P03','P04','P05','P06');

with r as (insert into public.routes (name, mode) values ('B 線・夜間重點（依序）', 'ordered') returning id)
insert into public.route_points (route_id, checkpoint_id, seq)
select r.id, c.id, case c.code when 'P01' then 1 when 'P02' then 2 else 3 end from r, public.checkpoints c where c.code in ('P01','P02','P06');
