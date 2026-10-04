import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import RoomOwnerControls from '@/components/rooms/RoomOwnerControls';
import SplatViewer from '@/components/viewer/SplatViewerClient';
import { presignGet } from '@/lib/r2';
import { fromCatalogRow } from '@/lib/layout/catalog';
import { parseSavedCalibration } from '@/lib/rooms/calibration';
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
    .select('id, owner_id, title, description, is_public, status, splat_key, source, credit, transform, floor_polygon')
    .eq('id', id)
    .maybeSingle();
  if (!room) notFound();

  const isOwner = user?.id === room.owner_id;
  const ready = room.status === 'ready' && Boolean(room.splat_key);
  // 파일을 아직 올리지 않은 방은 주인에게만 보인다 (지울 수 있게)
  if (!ready && !isOwner) notFound();

  const [splatUrl, { data: owner }, { data: catalogRows }] = await Promise.all([
    ready && room.splat_key ? presignGet(room.splat_key) : null,
    supabase.from('profiles').select('nickname').eq('id', room.owner_id).maybeSingle(),
    supabase
      .from('furniture_catalog')
      .select('id, name_ko, category, width_m, depth_m, height_m, clearance_m')
      .order('sort_order'),
  ]);
  // 카탈로그를 못 읽으면 뷰어가 기본 카탈로그를 쓴다
  const catalog = catalogRows?.length ? catalogRows.map(fromCatalogRow) : undefined;

  return (
    <main className="flex h-[calc(100dvh-3rem)] w-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-neutral-200 px-4 py-2 text-sm dark:border-neutral-800">
        <div className="min-w-0">
          <h1 className="truncate font-semibold" data-testid="room-title">
            {room.title}
          </h1>
          <p className="truncate text-neutral-500">
            <span data-testid="room-owner">{owner?.nickname ?? '알 수 없음'}</span>
            {room.description ? ` · ${room.description}` : ''}
          </p>
          {room.credit && (
            <p className="truncate text-xs text-neutral-500" data-testid="room-credit" title={room.credit}>
              출처: {room.credit}
            </p>
          )}
        </div>
        {isOwner && <RoomOwnerControls roomId={room.id} initialPublic={room.is_public} canPublish={ready} />}
      </div>

      <div className="relative min-h-0 flex-1 bg-neutral-900">
        {splatUrl ? (
          <SplatViewer
            url={splatUrl}
            name={room.title}
            calibration={parseSavedCalibration(room.transform, room.floor_polygon)}
            roomId={room.id}
            canEdit={isOwner}
            catalog={catalog}
          />
        ) : (
          <p className="p-6 text-sm text-neutral-300" data-testid="room-not-ready">
            아직 3D 파일을 올리지 않은 방입니다. 방을 지우고 새로 만들어 주세요.
          </p>
        )}
      </div>
    </main>
  );
}
