-- 사용 기록: 사용자 테스트 기간의 방문·방 조회·가구 놓기 횟수를 센다.
-- 사람을 알아볼 수 있는 값(계정·IP·이메일)은 남기지 않는다. visitor는 브라우저마다 만든 무작위 값이다.
-- 서버(secret key)만 쓰고 읽는다: 정책 없이 RLS만 켠다
create table public.usage_events (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('home_view', 'room_view', 'furniture_place')),
  room_id uuid references public.rooms(id) on delete set null,
  visitor text not null check (char_length(visitor) between 8 and 64),
  created_at timestamptz not null default now()
);
alter table public.usage_events enable row level security;
create index usage_events_created_at_idx on public.usage_events (created_at);
create index usage_events_room_id_idx on public.usage_events (room_id);
