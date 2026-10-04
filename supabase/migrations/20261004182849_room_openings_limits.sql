-- 문·창문(rooms.openings)은 방 주인이 브라우저에서 바로 저장한다.
-- 형식이 깨졌거나 지나치게 큰 값이 들어가지 않게 DB에서도 막는다.
-- (항목 하나하나의 모양은 앱이 읽을 때 검증한다: lib/rooms/openings.ts)
alter table public.rooms
  add constraint rooms_openings_check check (
    case when jsonb_typeof(openings) = 'array' then jsonb_array_length(openings) <= 20 else false end
    and octet_length(openings::text) <= 4096
  );
