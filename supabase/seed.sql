-- 範例據點與路線（選用）。名稱、座標與崗位分配皆為示意，待總務處提供大門、側門的實際巡邏範圍後替換。
insert into public.checkpoints (code, name, type, post, lat, lng, radius_m, enforce_fence, min_photos, checklist, note) values
 ('P01', '行政大樓正門', '門禁', '大門', 24.970200, 121.266000, 30, true,  0, '["門窗已上鎖","門禁設備正常"]', null),
 ('P03', '體育館周邊',   '戶外', '大門', 24.972536, 121.265208, 30, true,  0, '["照明正常","無可疑人員"]', null),
 ('P05', '地下停車場 B1', '停車場', '大門', 24.969392, 121.267980, 30, false, 0, '["照明正常","無違規停車"]', '室內點，GPS 訊號弱，不強制圍欄'),
 ('P02', '圖書館側門',   '門禁', '側門', 24.971278, 121.266891, 30, true,  0, '["門窗已上鎖","門禁設備正常"]', null),
 ('P04', '學生宿舍區',   '宿舍', '側門', 24.973613, 121.267584, 30, true,  0, '["出入口管制正常","無可疑人員"]', null),
 ('P06', '配電室',       '機電', '側門', 24.968853, 121.265406, 30, false, 0, '["無異味或異音","無漏水"]', '室內點，GPS 訊號弱，不強制圍欄')
on conflict (code) do nothing;

with r as (insert into public.routes (name, mode, post) values ('大門巡邏路線', 'free', '大門') returning id)
insert into public.route_points (route_id, checkpoint_id, seq)
select r.id, c.id, row_number() over (order by c.code) from r, public.checkpoints c where c.post = '大門';

with r as (insert into public.routes (name, mode, post) values ('側門巡邏路線', 'free', '側門') returning id)
insert into public.route_points (route_id, checkpoint_id, seq)
select r.id, c.id, row_number() over (order by c.code) from r, public.checkpoints c where c.post = '側門';
