-- 옮긴 원래 가구의 빈자리를 AI 그림으로 채우는 호출도 하루 AI 횟수에 센다
alter table public.ai_calls drop constraint ai_calls_kind_check;
alter table public.ai_calls add constraint ai_calls_kind_check check (kind in ('layout', 'analysis', 'openings', 'fixtures', 'fill'));
