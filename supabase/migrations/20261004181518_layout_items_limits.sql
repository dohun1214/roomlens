-- 배치(layouts.items)는 브라우저에서 본인 권한으로 바로 저장한다.
-- 형식이 깨졌거나 지나치게 큰 값이 들어가지 않게 DB에서도 막는다.
-- (항목 하나하나의 모양은 앱이 읽을 때 검증한다: lib/layout/saved.ts)
alter table public.layouts
  add constraint layouts_items_check check (
    case when jsonb_typeof(items) = 'array' then jsonb_array_length(items) <= 50 else false end
    and octet_length(items::text) <= 16384
  );
