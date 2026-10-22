-- 내 가구의 출처에 3D 스캔(scan)을 더한다: 사용자가 스캔한 GLB를 올려 만든 가구 (model_key = R2 furniture/user/{사용자}/{가구}.glb)
alter table public.user_furniture drop constraint user_furniture_source_check;
alter table public.user_furniture add constraint user_furniture_source_check check (source in ('manual', 'tripo', 'scan'));
