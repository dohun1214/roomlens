-- 배치 공유: 공개 방의 공개 배치에 쓰인 "내 가구"는 그 배치를 볼 수 있는 사람도 읽는다.
-- 배치에는 가구 id만 저장하므로 치수를 알아야 남의 배치를 그릴 수 있다.
-- 하위 질의의 layouts·rooms에도 RLS가 걸리므로, 볼 수 있는 공개 배치에 쓰인 가구만 읽힌다.
create policy "user_furniture: 공개 배치에 쓰인 것 읽기" on public.user_furniture
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.layouts l
      join public.rooms r on r.id = l.room_id
      where l.owner_id = user_furniture.owner_id
        and l.is_public
        and r.is_public
        and l.items @> jsonb_build_array(jsonb_build_object('kind', 'user', 'furnitureRef', user_furniture.id::text))
    )
  );

-- 비로그인은 그리는 데 필요한 열만 (model_key·source는 주지 않는다)
grant select (id, owner_id, name, category, width_m, depth_m, height_m) on table public.user_furniture to anon;
