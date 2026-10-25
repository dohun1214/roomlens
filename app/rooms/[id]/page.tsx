import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Avatar } from '@/components/SiteHeader';
import Icon from '@/components/ui/Icon';
import { LogoMark } from '@/components/ui/Logo';
import { loginUrlFor } from '@/lib/auth/paths';
import RoomOwnerControls from '@/components/rooms/RoomOwnerControls';
import RoomShareButton from '@/components/rooms/RoomShareButton';
import RoomInfoEditor from '@/components/rooms/RoomInfoEditor';
import SplatViewer from '@/components/viewer/SplatViewerClient';
import { presignGet } from '@/lib/r2';
import { fixturePieceKey, type FixturePieceUrls } from '@/lib/rooms/fixturePiece';
import { fromCatalogRow } from '@/lib/layout/catalog';
import { parseReport } from '@/lib/ai/analysis';
import { remainingToday } from '@/lib/ai/usage';
import { loadMyLayouts } from '@/lib/layout/store';
import { LAYOUT_PARAM, loadSharedLayout, parseLayoutParam, sharedLayoutPath } from '@/lib/layout/share';
import { loadUserFurniture } from '@/lib/layout/userFurniture';
import { parseSavedCalibration } from '@/lib/rooms/calibration';
import { parseOpenings } from '@/lib/rooms/openings';
import { parseFixtures } from '@/lib/rooms/fixtures';
import { RoomId } from '@/lib/rooms/schemas';
import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH, thumbnailSrc } from '@/lib/rooms/thumbnail';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

/** 공유 링크 미리보기: 방 이름·설명과 대표 사진. 볼 수 없는 방은 이름을 드러내지 않는다 */
export async function generateMetadata({ params }: PageProps<'/rooms/[id]'>): Promise<Metadata> {
  const { id } = await params;
  if (!RoomId.safeParse(id).success) return { title: '방 | RoomLens' };
  const supabase = await createClient();
  const { data: room } = await supabase.from('rooms').select('id, title, description, thumbnail_key').eq('id', id).maybeSingle();
  if (!room) return { title: '방 | RoomLens' };
  const description = room.description || '3D로 둘러보고 실제 치수의 가구를 놓아 보는 방';
  const image = thumbnailSrc(room.id, room.thumbnail_key);
  return {
    title: `${room.title} | RoomLens`,
    description,
    openGraph: {
      title: room.title,
      description,
      siteName: 'RoomLens',
      type: 'website',
      ...(image ? { images: [{ url: image, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, alt: room.title }] } : {}),
    },
    twitter: { card: image ? 'summary_large_image' : 'summary', title: room.title, description },
  };
}

/**
 * 방 3D 투어. 로그인한 사용자의 권한(RLS)으로 읽으므로 공개 방이거나 본인 방일 때만 보인다.
 * 파일은 비공개 버킷에 있어 1시간짜리 읽기 주소를 만들어 뷰어에 넘긴다.
 */
export default async function RoomPage({ params, searchParams }: PageProps<'/rooms/[id]'>) {
  const { id } = await params;
  // 공유 링크로 왔으면 그 배치 (?layout=)
  const sharedId = parseLayoutParam((await searchParams)[LAYOUT_PARAM]);
  if (!RoomId.safeParse(id).success) notFound();

  const user = await getCurrentUser();
  const supabase = await createClient();
  const { data: room } = await supabase
    .from('rooms')
    .select('id, owner_id, title, description, is_public, status, splat_key, source, credit, transform, floor_polygon, openings, fixtures, thumbnail_key')
    .eq('id', id)
    .maybeSingle();
  if (!room) notFound();

  const isOwner = user?.id === room.owner_id;
  const ready = room.status === 'ready' && Boolean(room.splat_key);
  // 파일을 아직 올리지 않은 방은 주인에게만 보인다 (지울 수 있게)
  if (!ready && !isOwner) notFound();

  const [splatUrl, { data: owner }, { data: catalogRows }, myLayouts, myFurniture, aiRemaining, { data: reportRow }, { data: me }] = await Promise.all([
    ready && room.splat_key ? presignGet(room.splat_key) : null,
    supabase.from('profiles').select('nickname').eq('id', room.owner_id).maybeSingle(),
    supabase
      .from('furniture_catalog')
      .select('id, name_ko, category, width_m, depth_m, height_m, clearance_m, model_key, license, style_ko')
      .order('sort_order'),
    // 이 방에 내가 저장해 둔 가구 배치들 (방 주인이 아니어도 공개 방이면 자기 배치를 가진다)
    ready && user ? loadMyLayouts(supabase, room.id, user.id) : undefined,
    // 3D 스캔으로 만든 내 가구는 모델 읽기 주소도 만든다
    ready && user ? loadUserFurniture(supabase, user.id, presignGet) : undefined,
    // 오늘 남은 AI 호출 횟수
    ready && user ? remainingToday(user.id) : null,
    // 가장 최근의 방 분석 리포트 (방을 볼 수 있으면 누구나 읽을 수 있다)
    supabase.from('room_reports').select('id, model, report, created_at').eq('room_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    // 머리말에 보여줄 내 닉네임 (방 주인이면 위에서 읽은 것을 쓴다)
    user && !isOwner ? supabase.from('profiles').select('nickname').eq('id', user.id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const report = reportRow ? parseReport(reportRow.report) : null;
  // 공유 링크: 내 배치면 그 배치로 시작하고, 남의 배치면 볼 수 있을 때(공개 방의 공개 배치) 그 배치를 보여 준다
  const mineShared = sharedId ? myLayouts?.find((l) => l.id === sharedId) : undefined;
  const sharedBase = ready && sharedId && !mineShared ? await loadSharedLayout(supabase, room.id, sharedId) : null;
  // 공유 배치에 쓰인 남의 3D 스캔 가구: 위에서 볼 수 있다고 확인된 가구만 서버 권한으로 모델 열쇠를 읽어 주소를 만든다
  // (비로그인은 model_key 열을 읽을 수 없으므로)
  const sharedLayout = sharedBase?.furniture.length
    ? await (async () => {
        const { data: keys } = await createAdminClient()
          .from('user_furniture')
          .select('id, model_key')
          .in(
            'id',
            sharedBase.furniture.map((f) => f.id),
          );
        const urls = new Map(await Promise.all((keys ?? []).filter((k) => k.model_key).map(async (k) => [k.id, await presignGet(k.model_key as string)] as const)));
        return { ...sharedBase, furniture: sharedBase.furniture.map((f) => (urls.has(f.id) ? { ...f, modelUrl: urls.get(f.id) } : f)) };
      })()
    : sharedBase;
  const startLayouts = mineShared && myLayouts ? [mineShared, ...myLayouts.filter((l) => l.id !== sharedId)] : myLayouts;
  // 카탈로그를 못 읽으면 뷰어가 기본 카탈로그를 쓴다
  // 모델 파일도 비공개 버킷에 있어 가구마다 읽기 주소를 만든다 (서명은 서버 안에서 계산하므로 요청이 나가지 않는다)
  const catalog = catalogRows?.length
    ? await Promise.all(catalogRows.map(async (row) => fromCatalogRow(row, row.model_key ? await presignGet(row.model_key) : null)))
    : undefined;
  const calibration = parseSavedCalibration(room.transform, room.floor_polygon);
  const fixtures = parseFixtures(room.fixtures, calibration?.floorPolygon ?? null);
  // 옮길 수 있게 떼어 낸 원래 가구 조각과 채운 빈자리 조각의 읽기 주소 (방을 볼 수 있으면 누구나 옮겨 볼 수 있다)
  const pieceUrls: FixturePieceUrls = Object.fromEntries(
    await Promise.all(
      fixtures
        .filter((f) => f.piece)
        .map(async (f) => [
          f.id,
          {
            piece: await presignGet(fixturePieceKey(room.id, f.id, 'piece', f.piece!.v)),
            ...(f.fill ? { fill: await presignGet(fixturePieceKey(room.id, f.id, 'fill', f.fill.v)) } : {}),
          },
        ] as const),
    ),
  );

  const ownerName = owner?.nickname ?? '알 수 없음';
  const myName = isOwner ? ownerName : (me?.nickname ?? user?.email ?? '내 정보');

  return (
    <main className="flex h-dvh w-full flex-col bg-ground">
      <header className="relative z-20 flex min-h-[60px] shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-3 py-2 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-4">
          <Link href="/" className="flex shrink-0 items-center gap-2 text-[17px] font-bold tracking-tight" aria-label="RoomLens 홈">
            <LogoMark size={30} />
            <span className="hidden lg:inline">RoomLens</span>
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <Link href="/" className="hidden shrink-0 text-sm text-sub hover:text-ink sm:inline">
              {isOwner ? '내 방' : '공개된 방'}
            </Link>
            <Icon name="chevronRight" className="hidden text-field sm:block" />
            <div className="flex min-w-0 flex-col">
              <h1 className="truncate text-[15px] leading-tight font-semibold" data-testid="room-title">
                {room.title}
              </h1>
              <p className="hidden truncate text-xs text-sub md:block">
                <span data-testid="room-owner">{ownerName}</span>
                {room.description ? ` · ${room.description}` : ''}
              </p>
            </div>
            {isOwner && <RoomInfoEditor roomId={room.id} title={room.title} description={room.description} />}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {room.is_public && ready && <RoomShareButton roomId={room.id} />}
          {isOwner && <RoomOwnerControls roomId={room.id} initialPublic={room.is_public} canPublish={ready} />}
          {user ? (
            <Link href="/account" className="hidden items-center gap-2 text-[13px] text-sub hover:text-ink sm:flex" title="내 정보">
              <Avatar name={myName} size={30} />
              <span className="hidden max-w-32 truncate xl:inline" data-testid="header-nickname">
                {myName}
              </span>
            </Link>
          ) : (
            <Link href={loginUrlFor(sharedId ? sharedLayoutPath(room.id, sharedId) : `/rooms/${room.id}`)} className="btn btn-outline h-[38px] px-4 text-[13px]">
              로그인
            </Link>
          )}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {splatUrl ? (
          <SplatViewer
            url={splatUrl}
            name={room.title}
            calibration={calibration}
            roomId={room.id}
            canEdit={isOwner}
            catalog={catalog}
            signedIn={Boolean(user)}
            initialLayouts={startLayouts}
            aiRemaining={aiRemaining}
            initialReport={report && reportRow ? { id: reportRow.id, model: reportRow.model, createdAt: reportRow.created_at, report } : null}
            userFurniture={myFurniture}
            initialOpenings={parseOpenings(room.openings, calibration?.floorPolygon ?? null)}
            initialFixtures={fixtures}
            initialPieceUrls={pieceUrls}
            credit={room.credit}
            ownerId={room.owner_id}
            viewer={user ? { id: user.id, name: myName } : null}
            isPublic={room.is_public}
            sharedLayout={sharedLayout}
            sharedMissing={Boolean(sharedId) && !mineShared && !sharedLayout}
            thumbnail={thumbnailSrc(room.id, room.thumbnail_key)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <p className="max-w-md rounded-3xl bg-surface p-8 text-center text-[15px] text-body shadow-card" data-testid="room-not-ready">
              아직 3D 파일을 올리지 않은 방입니다. 방을 지우고 새로 만들어 주세요.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
