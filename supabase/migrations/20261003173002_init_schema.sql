-- RoomLens 초기 스키마: 테이블, RLS, 권한(grant)
--
-- 원칙
--  * 파일은 모두 Cloudflare R2에 두고 DB에는 메타데이터와 JSON만 둔다.
--  * 접근은 두 단계로 막는다: grant(역할이 테이블·컬럼을 건드릴 수 있는지) + RLS(어느 행인지).
--  * R2 키, 방 상태, 작업 상태처럼 위조되면 남의 파일에 접근할 수 있는 값은
--    브라우저에서 쓸 수 없게 하고 서버(secret key, RLS 우회)만 쓴다.

-- 내부용 함수는 Data API에 노출되지 않는 스키마에 둔다
create schema if not exists private;

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles: 가입하면 자동으로 한 줄 생성
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 30),
  is_adult_confirmed boolean not null default false,
  created_at timestamptz not null default now()
);

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, '사용자' || substr(replace(new.id::text, '-', ''), 1, 6));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

alter table public.profiles enable row level security;

create policy "profiles: 누구나 읽기" on public.profiles
  for select to anon, authenticated
  using (true);
create policy "profiles: 본인만 수정" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to anon, authenticated;
grant update (nickname, is_adult_confirmed) on table public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- rooms
-- ---------------------------------------------------------------------------
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  description text not null default '' check (char_length(description) <= 2000),
  is_public boolean not null default false,
  status text not null default 'uploading' check (status in ('uploading', 'ready', 'failed')),
  source text not null default 'scaniverse' check (source in ('scaniverse', 'worldlabs')),
  splat_key text,
  splat_format text check (splat_format in ('spz', 'ply', 'rad', 'sog')),
  splat_bytes bigint check (splat_bytes > 0),
  -- 보정: p' = s·R·p + t  →  { "s": number, "q": [x, y, z, w], "t": [x, y, z] }
  transform jsonb,
  -- 방 평면도 [[x, z], …] (m)
  floor_polygon jsonb,
  -- [{ "type": "door" | "window", "wallIndex", "from", "to", "widthM" }]
  openings jsonb not null default '[]'::jsonb,
  -- 개인정보(방 영상·사진) 업로드 동의 시각
  consent_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index rooms_owner_id_idx on public.rooms (owner_id);
create index rooms_public_created_at_idx on public.rooms (created_at desc) where is_public;

create trigger rooms_set_updated_at
  before update on public.rooms
  for each row execute function private.set_updated_at();

alter table public.rooms enable row level security;

create policy "rooms: 공개 방 또는 내 방 읽기" on public.rooms
  for select to anon, authenticated
  using (is_public or (select auth.uid()) = owner_id);
create policy "rooms: 내 방 만들기" on public.rooms
  for insert to authenticated
  with check ((select auth.uid()) = owner_id);
create policy "rooms: 내 방 수정" on public.rooms
  for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
create policy "rooms: 내 방 삭제" on public.rooms
  for delete to authenticated
  using ((select auth.uid()) = owner_id);

revoke all on table public.rooms from anon, authenticated;
grant select on table public.rooms to anon, authenticated;
-- status, splat_key, splat_format, splat_bytes, owner_id 는 브라우저에서 쓸 수 없다
grant insert (title, description, source, consent_at) on table public.rooms to authenticated;
grant update (title, description, is_public, transform, floor_polygon, openings) on table public.rooms to authenticated;
grant delete on table public.rooms to authenticated;

-- ---------------------------------------------------------------------------
-- room_photos, room_reports: 읽기는 방 규칙과 같고 쓰기는 서버만
-- ---------------------------------------------------------------------------
create table public.room_photos (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  r2_key text not null,
  created_at timestamptz not null default now()
);
create index room_photos_room_id_idx on public.room_photos (room_id);
alter table public.room_photos enable row level security;
create policy "room_photos: 볼 수 있는 방의 사진 읽기" on public.room_photos
  for select to anon, authenticated
  using (exists (
    select 1 from public.rooms r
    where r.id = room_id and (r.is_public or r.owner_id = (select auth.uid()))
  ));
revoke all on table public.room_photos from anon, authenticated;
grant select on table public.room_photos to anon, authenticated;

create table public.room_reports (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  model text not null,
  report jsonb not null,
  created_at timestamptz not null default now()
);
create index room_reports_room_id_idx on public.room_reports (room_id);
alter table public.room_reports enable row level security;
create policy "room_reports: 볼 수 있는 방의 리포트 읽기" on public.room_reports
  for select to anon, authenticated
  using (exists (
    select 1 from public.rooms r
    where r.id = room_id and (r.is_public or r.owner_id = (select auth.uid()))
  ));
revoke all on table public.room_reports from anon, authenticated;
grant select on table public.room_reports to anon, authenticated;

-- ---------------------------------------------------------------------------
-- furniture_catalog: 누구나 읽기, 쓰기는 마이그레이션(시드)으로만
-- ---------------------------------------------------------------------------
create table public.furniture_catalog (
  id text primary key,
  name_ko text not null,
  category text not null,
  width_m numeric(4, 2) not null check (width_m > 0),
  depth_m numeric(4, 2) not null check (depth_m > 0),
  height_m numeric(4, 2) not null check (height_m > 0),
  -- 접근면 앞에 비워 둘 깊이 (m). 0이면 없음
  clearance_m numeric(4, 2) not null default 0 check (clearance_m >= 0),
  model_key text,
  license text,
  sort_order integer not null default 0
);
alter table public.furniture_catalog enable row level security;
create policy "furniture_catalog: 누구나 읽기" on public.furniture_catalog
  for select to anon, authenticated
  using (true);
revoke all on table public.furniture_catalog from anon, authenticated;
grant select on table public.furniture_catalog to anon, authenticated;

-- ---------------------------------------------------------------------------
-- user_furniture: 본인만. model_key, source 는 서버만 쓴다 (Tripo 결과)
-- ---------------------------------------------------------------------------
create table public.user_furniture (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  category text not null default 'etc',
  width_m numeric(4, 2) not null check (width_m > 0 and width_m <= 10),
  depth_m numeric(4, 2) not null check (depth_m > 0 and depth_m <= 10),
  height_m numeric(4, 2) not null check (height_m > 0 and height_m <= 5),
  model_key text,
  source text not null default 'manual' check (source in ('manual', 'tripo')),
  created_at timestamptz not null default now()
);
create index user_furniture_owner_id_idx on public.user_furniture (owner_id);
alter table public.user_furniture enable row level security;
create policy "user_furniture: 본인 것 읽기" on public.user_furniture
  for select to authenticated
  using ((select auth.uid()) = owner_id);
create policy "user_furniture: 본인 것 만들기" on public.user_furniture
  for insert to authenticated
  with check ((select auth.uid()) = owner_id);
create policy "user_furniture: 본인 것 수정" on public.user_furniture
  for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
create policy "user_furniture: 본인 것 삭제" on public.user_furniture
  for delete to authenticated
  using ((select auth.uid()) = owner_id);
revoke all on table public.user_furniture from anon, authenticated;
grant select, delete on table public.user_furniture to authenticated;
grant insert (name, category, width_m, depth_m, height_m) on table public.user_furniture to authenticated;
grant update (name, category, width_m, depth_m, height_m) on table public.user_furniture to authenticated;

-- ---------------------------------------------------------------------------
-- layouts: 내 것 + 공개 방의 공개 배치 읽기
-- ---------------------------------------------------------------------------
create table public.layouts (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default '내 배치' check (char_length(name) between 1 and 40),
  -- [{ "id", "furnitureRef", "kind": "catalog" | "user", "x", "z", "rotationDeg" }]
  items jsonb not null default '[]'::jsonb,
  is_public boolean not null default false,
  created_by text not null default 'user' check (created_by in ('user', 'ai')),
  ai_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index layouts_room_id_idx on public.layouts (room_id);
create index layouts_owner_id_idx on public.layouts (owner_id);
create trigger layouts_set_updated_at
  before update on public.layouts
  for each row execute function private.set_updated_at();
alter table public.layouts enable row level security;
create policy "layouts: 내 것 또는 공개 방의 공개 배치 읽기" on public.layouts
  for select to anon, authenticated
  using (
    (select auth.uid()) = owner_id
    or (is_public and exists (select 1 from public.rooms r where r.id = room_id and r.is_public))
  );
-- 내 방이거나 공개 방이면 배치를 만들 수 있다 (공개 샘플 방을 누구나 체험)
create policy "layouts: 볼 수 있는 방에 내 배치 만들기" on public.layouts
  for insert to authenticated
  with check (
    (select auth.uid()) = owner_id
    and exists (
      select 1 from public.rooms r
      where r.id = room_id and (r.is_public or r.owner_id = (select auth.uid()))
    )
  );
create policy "layouts: 내 것 수정" on public.layouts
  for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
create policy "layouts: 내 것 삭제" on public.layouts
  for delete to authenticated
  using ((select auth.uid()) = owner_id);
revoke all on table public.layouts from anon, authenticated;
grant select on table public.layouts to anon, authenticated;
grant insert (room_id, name, items, is_public, created_by, ai_summary) on table public.layouts to authenticated;
grant update (name, items, is_public, created_by, ai_summary) on table public.layouts to authenticated;
grant delete on table public.layouts to authenticated;

-- ---------------------------------------------------------------------------
-- comments: 볼 수 있는 방에서 읽고, 로그인하면 쓴다
-- ---------------------------------------------------------------------------
create table public.comments (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  author_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index comments_room_id_created_at_idx on public.comments (room_id, created_at);
create index comments_author_id_idx on public.comments (author_id);
alter table public.comments enable row level security;
create policy "comments: 볼 수 있는 방의 코멘트 읽기" on public.comments
  for select to anon, authenticated
  using (exists (
    select 1 from public.rooms r
    where r.id = room_id and (r.is_public or r.owner_id = (select auth.uid()))
  ));
create policy "comments: 볼 수 있는 방에 쓰기" on public.comments
  for insert to authenticated
  with check (
    (select auth.uid()) = author_id
    and exists (
      select 1 from public.rooms r
      where r.id = room_id and (r.is_public or r.owner_id = (select auth.uid()))
    )
  );
create policy "comments: 작성자 또는 방 주인이 삭제" on public.comments
  for delete to authenticated
  using (
    (select auth.uid()) = author_id
    or exists (select 1 from public.rooms r where r.id = room_id and r.owner_id = (select auth.uid()))
  );
revoke all on table public.comments from anon, authenticated;
grant select on table public.comments to anon, authenticated;
grant insert (room_id, body) on table public.comments to authenticated;
grant delete on table public.comments to authenticated;

-- ---------------------------------------------------------------------------
-- jobs: 외부 작업(Tripo, World Labs, 분석) 상태. 본인만 읽고 쓰기는 서버만
-- ---------------------------------------------------------------------------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid references public.rooms (id) on delete cascade,
  type text not null check (type in ('tripo', 'worldlabs', 'analysis')),
  provider_task_id text,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  progress integer not null default 0 check (progress between 0 and 100),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_owner_id_idx on public.jobs (owner_id);
create index jobs_room_id_idx on public.jobs (room_id);
create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function private.set_updated_at();
alter table public.jobs enable row level security;
create policy "jobs: 본인 것 읽기" on public.jobs
  for select to authenticated
  using ((select auth.uid()) = owner_id);
revoke all on table public.jobs from anon, authenticated;
grant select on table public.jobs to authenticated;

-- 서버(secret key)는 모든 테이블을 읽고 쓴다
grant select, insert, update, delete on all tables in schema public to service_role;
