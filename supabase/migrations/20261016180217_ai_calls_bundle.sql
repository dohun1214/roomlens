-- "AI로 방 준비하기": 문·창문 찾기에 이어 부른 원래 가구 찾기를 한 번의 AI 사용으로 센다.
-- 이어 부른 호출은 앞 호출을 bundle_of로 가리키고 하루 횟수에서 빠진다. 앞 호출 하나에 하나만 붙는다.
alter table public.ai_calls add column bundle_of uuid references public.ai_calls (id) on delete set null;
create unique index ai_calls_bundle_of_key on public.ai_calls (bundle_of) where bundle_of is not null;
