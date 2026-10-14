-- 방에 원래 있는 가구 (스캔에 함께 찍힌 침대·옷장·냉장고 등). 새 가구는 이 자리를 피해서 놓는다.
-- rooms.fixtures = [{ id, label, x, z, w, d, rotationDeg, h, remove }] (방 좌표, m). 형식은 lib/rooms/fixtures.ts
-- 문·창문처럼 방 주인이 브라우저에서 바로 저장하므로, 지나치게 큰 값이 들어가지 않게 DB에서도 막는다.
alter table public.rooms add column if not exists fixtures jsonb not null default '[]'::jsonb;

alter table public.rooms
  add constraint rooms_fixtures_check check (
    case when jsonb_typeof(fixtures) = 'array' then jsonb_array_length(fixtures) <= 30 else false end
    and octet_length(fixtures::text) <= 8192
  );

grant update (fixtures) on table public.rooms to authenticated;
