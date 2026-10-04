-- 직접 찍지 않은 방(공개 데이터셋 등)도 올릴 수 있게 한다.
--  * source 에 'dataset' 추가
--  * credit: 출처·라이선스 표기 (CC BY 등은 저작자 표시가 조건이므로 방 화면에 함께 보여준다)
alter table public.rooms drop constraint rooms_source_check;
alter table public.rooms
  add constraint rooms_source_check check (source in ('scaniverse', 'worldlabs', 'dataset'));

alter table public.rooms
  add column credit text not null default '' check (char_length(credit) <= 300);

-- 데이터셋 방은 출처가 반드시 있어야 한다
alter table public.rooms
  add constraint rooms_dataset_credit_check check (source <> 'dataset' or char_length(btrim(credit)) > 0);

comment on column public.rooms.credit is '출처·라이선스 표기 (source = dataset 이면 필수)';

-- 방 주인이 넣고 고칠 수 있는 컬럼에 credit 추가 (source 는 만들 때만)
grant insert (credit) on table public.rooms to authenticated;
grant update (credit) on table public.rooms to authenticated;
