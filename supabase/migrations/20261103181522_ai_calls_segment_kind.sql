-- 원래 가구를 떼어 낼 때 AI로 가구 윤곽을 고르는 호출도 하루 AI 횟수에 센다
alter table public.ai_calls drop constraint ai_calls_kind_check;
alter table public.ai_calls add constraint ai_calls_kind_check check (kind in ('layout', 'analysis', 'openings', 'fixtures', 'fill', 'segment'));
