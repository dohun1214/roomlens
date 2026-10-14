-- AI 호출 기록에 "원래 가구 찾기"(fixtures)를 더한다. 하루 횟수는 다른 AI 기능과 합쳐서 센다.
alter table public.ai_calls drop constraint ai_calls_kind_check;
alter table public.ai_calls add constraint ai_calls_kind_check check (kind in ('layout', 'analysis', 'openings', 'fixtures'));
