-- AI(Gemini) 호출 기록. 한 사람이 하루에 쓸 수 있는 횟수를 이 기록으로 센다:
-- 오늘(한국 시간) 만든 running·done 행의 수. 실패한 호출은 세지 않는다.
-- 쓰기는 서버(secret key)만 하고, 본인은 자기 기록을 읽을 수만 있다.
create table public.ai_calls (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid references public.rooms (id) on delete set null,
  -- layout = 배치 추천, analysis = 방 분석, openings = 문·창문 찾기
  kind text not null check (kind in ('layout', 'analysis', 'openings')),
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  model text check (char_length(model) <= 80),
  -- 한 번의 호출 안에서 Gemini를 부른 횟수 (다시 묻기 포함)와 쓴 토큰
  attempts integer not null default 0 check (attempts >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index ai_calls_owner_id_created_at_idx on public.ai_calls (owner_id, created_at desc);
create index ai_calls_room_id_idx on public.ai_calls (room_id);

alter table public.ai_calls enable row level security;
create policy "ai_calls: 본인 것 읽기" on public.ai_calls
  for select to authenticated
  using ((select auth.uid()) = owner_id);

revoke all on table public.ai_calls from anon, authenticated;
grant select on table public.ai_calls to authenticated;
