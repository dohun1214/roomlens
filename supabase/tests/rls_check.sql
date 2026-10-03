-- RLS·권한 동작 확인. 임시 사용자 A, B와 비로그인(anon)으로 시나리오를 돌린 뒤
-- 일부러 예외를 던져 전부 되돌린다 (DB에는 아무것도 남지 않는다).
-- 결과는 오류 메시지 "RLS_TEST_RESULTS (rolled back): …" 로 나온다.
-- 기대값: =ALLOWED(bad) 가 하나도 없어야 한다.
do $$
declare
  a constant text := '00000000-0000-0000-0000-00000000000a';
  b constant text := '00000000-0000-0000-0000-00000000000b';
  room_a uuid; n int; r text := '';
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  values (a::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@test.invalid', now(), now()),
         (b::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@test.invalid', now(), now());
  select count(*) into n from public.profiles; r := r || format('profiles created by trigger=%s | ', n);

  -- A: 방 만들기. 상태·R2 키는 브라우저에서 쓸 수 없어야 한다
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.rooms (title, consent_at) values ('room A', now()) returning id into room_a;
  r := r || 'A insert room=ok | ';
  begin
    insert into public.rooms (title, consent_at, status, splat_key) values ('forged', now(), 'ready', 'rooms/x/scene.spz');
    r := r || 'A insert with status/splat_key=ALLOWED(bad) | ';
  exception when insufficient_privilege then r := r || 'A insert with status/splat_key=denied | '; end;
  begin
    update public.rooms set status = 'ready' where id = room_a;
    r := r || 'A update own status=ALLOWED(bad) | ';
  exception when insufficient_privilege then r := r || 'A update own status=denied | '; end;
  update public.rooms set title = 'new title', transform = '{"s":1,"q":[0,0,0,1],"t":[0,0,0]}' where id = room_a;
  get diagnostics n = row_count; r := r || format('A update own title/transform rows=%s | ', n);
  begin
    insert into public.jobs (owner_id, type) values (a::uuid, 'tripo');
    r := r || 'A insert job=ALLOWED(bad) | ';
  exception when insufficient_privilege then r := r || 'A insert job=denied | '; end;

  -- B: A의 비공개 방은 보이지 않고 건드릴 수 없다
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select count(*) into n from public.rooms where id = room_a; r := r || format('B sees A private room=%s | ', n);
  update public.rooms set title = 'hacked' where id = room_a; get diagnostics n = row_count; r := r || format('B updates A room rows=%s | ', n);
  begin
    insert into public.comments (room_id, body) values (room_a, 'hi');
    r := r || 'B comment on private room=ALLOWED(bad) | ';
  exception when insufficient_privilege then r := r || 'B comment on private room=denied | '; end;
  begin
    insert into public.layouts (room_id, items) values (room_a, '[]');
    r := r || 'B layout on private room=ALLOWED(bad) | ';
  exception when insufficient_privilege then r := r || 'B layout on private room=denied | '; end;
  update public.profiles set nickname = 'x' where id = a::uuid; get diagnostics n = row_count; r := r || format('B updates A profile rows=%s | ', n);
  update public.profiles set nickname = 'B nick', is_adult_confirmed = true where id = b::uuid; get diagnostics n = row_count; r := r || format('B updates own profile rows=%s | ', n);

  -- A가 공개로 바꾸면 B는 보고, 코멘트·배치를 남길 수 있지만 방은 못 고친다
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  update public.rooms set is_public = true where id = room_a;

  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select count(*) into n from public.rooms where id = room_a; r := r || format('B sees A public room=%s | ', n);
  insert into public.comments (room_id, body) values (room_a, 'nice'); r := r || 'B comment on public room=ok | ';
  insert into public.layouts (room_id, items, is_public) values (room_a, '[]', false); r := r || 'B private layout on public room=ok | ';
  update public.rooms set title = 'hacked' where id = room_a; get diagnostics n = row_count; r := r || format('B updates A public room rows=%s | ', n);

  -- A: B의 비공개 배치는 못 보고, 코멘트는 본다
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  select count(*) into n from public.layouts where room_id = room_a; r := r || format('A sees B private layout=%s | ', n);
  select count(*) into n from public.comments where room_id = room_a; r := r || format('A sees comments=%s | ', n);

  -- 비로그인
  set local role anon;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*) into n from public.rooms; r := r || format('anon sees public rooms=%s | ', n);
  select count(*) into n from public.furniture_catalog; r := r || format('anon sees catalog=%s | ', n);
  select count(*) into n from public.layouts; r := r || format('anon sees layouts=%s | ', n);
  begin
    insert into public.rooms (title, consent_at) values ('anon', now());
    r := r || 'anon insert room=ALLOWED(bad) | ';
  exception when insufficient_privilege then r := r || 'anon insert room=denied | '; end;
  begin
    select count(*) into n from public.jobs; r := r || 'anon reads jobs=ALLOWED(bad) | ';
  exception when insufficient_privilege then r := r || 'anon reads jobs=denied | '; end;

  raise exception 'RLS_TEST_RESULTS (rolled back): %', r;
end $$;
