-- 방 대표 사진(썸네일): R2 키. 방 주인이 화면에서 찍어 올리면 서버(서버 전용 키)가 쓴다.
-- 읽기는 방을 볼 수 있는 사람이면 누구나 (RLS는 rooms 그대로). 브라우저 권한으로는 바꿀 수 없다
alter table public.rooms add column thumbnail_key text;
grant select (thumbnail_key) on table public.rooms to anon, authenticated;
