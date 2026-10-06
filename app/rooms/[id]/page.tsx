import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Avatar } from '@/components/SiteHeader';
import Icon from '@/components/ui/Icon';
import { LogoMark } from '@/components/ui/Logo';
import { loginUrlFor } from '@/lib/auth/paths';
import RoomOwnerControls from '@/components/rooms/RoomOwnerControls';
import SplatViewer from '@/components/viewer/SplatViewerClient';
import { presignGet } from '@/lib/r2';
import { fromCatalogRow } from '@/lib/layout/catalog';
import { parseReport } from '@/lib/ai/analysis';
import { remainingToday } from '@/lib/ai/usage';
import { loadMyLayouts } from '@/lib/layout/store';
import { loadUserFurniture } from '@/lib/layout/userFurniture';
import { parseSavedCalibration } from '@/lib/rooms/calibration';
import { parseOpenings } from '@/lib/rooms/openings';
import { RoomId } from '@/lib/rooms/schemas';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

export const metadata: Metadata = { title: '방 | RoomLens' };

/**
 * 방 3D 투어. 로그인한 사용자의 권한(RLS)으로 읽으므로 공개 방이거나 본인 방일 때만 보인다.
 * 파일은 비공개 버킷에 있어 1시간짜리 읽기 주소를 만들어 뷰어에 넘긴다.
 */
export default async function RoomPage({ params }: PageProps<'/rooms/[id]'>) {
  const { id } = await params;
  if (!RoomId.safeParse(id).success) notFound();

  const user = await getCurrentUser();
  const supabase = await createClient();
  const { data: room } = await supabase
    .from('rooms')
    .select('id, owner_id, title, description, is_public, status, splat_key, source, credit, transform, floor_polygon, openings')
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
      .select('id, name_ko, category, width_m, depth_m, height_m, clearance_m, model_key')
      .order('sort_order'),
    // 이 방에 내가 저장해 둔 가구 배치들 (방 주인이 아니어도 공개 방이면 자기 배치를 가진다)
    ready && user ? loadMyLayouts(supabase, room.id, user.id) : undefined,
    ready && user ? loadUserFurniture(supabase, user.id) : undefined,
    // 오늘 남은 AI 호출 횟수
    ready && user ? remainingToday(user.id) : null,
    // 가장 최근의 방 분석 리포트 (방을 볼 수 있으면 누구나 읽을 수 있다)
    supabase.from('room_reports').select('id, model, report, created_at').eq('room_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    // 머리말에 보여줄 내 닉네임 (방 주인이면 위에서 읽은 것을 쓴다)
    user && !isOwner ? supabase.from('profiles').select('nickname').eq('id', user.id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const report = reportRow ? parseReport(reportRow.report) : null;
  // 카탈로그를 못 읽으면 뷰어가 기본 카탈로그를 쓴다
  // 모델 파일도 비공개 버킷에 있어 가구마다 읽기 주소를 만든다 (서명은 서버 안에서 계산하므로 요청이 나가지 않는다)
  const catalog = catalogRows?.length
    ? await Promise.all(catalogRows.map(async (row) => fromCatalogRow(row, row.model_key ? await presignGet(row.model_key) : null)))
    : undefined;
  const calibration = parseSavedCalibration(room.transform, room.floor_polygon);

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
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {isOwner && <RoomOwnerControls roomId={room.id} initialPublic={room.is_public} canPublish={ready} />}
          {user ? (
            <Link href="/account" className="hidden items-center gap-2 text-[13px] text-sub hover:text-ink sm:flex" title="내 정보">
              <Avatar name={myName} size={30} />
              <span className="hidden max-w-32 truncate xl:inline" data-testid="header-nickname">
                {myName}
              </span>
            </Link>
          ) : (
            <Link href={loginUrlFor(`/rooms/${room.id}`)} className="btn btn-outline h-[38px] px-4 text-[13px]">
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
            initialLayouts={myLayouts}
            aiRemaining={aiRemaining}
            initialReport={report && reportRow ? { id: reportRow.id, model: reportRow.model, createdAt: reportRow.created_at, report } : null}
            userFurniture={myFurniture}
            initialOpenings={parseOpenings(room.openings, calibration?.floorPolygon ?? null)}
            credit={room.credit}
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
