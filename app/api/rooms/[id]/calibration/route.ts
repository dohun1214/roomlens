import { NextResponse } from 'next/server';
import { apiError, badRequest, notFound, readJson, unauthenticated } from '@/lib/api/http';
import { parseSavedItems } from '@/lib/layout/saved';
import { parseSavedCalibration } from '@/lib/rooms/calibration';
import { parseFixtures } from '@/lib/rooms/fixtures';
import { parseOpenings } from '@/lib/rooms/openings';
import { remapFixtures, remapLayoutItems, remapOpenings, roomRemap } from '@/lib/rooms/recalibrate';
import { RoomId } from '@/lib/rooms/schemas';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

type Context = { params: Promise<{ id: string }> };

/**
 * 보정 저장 (방 주인). 이미 보정한 방이면 예전 방 좌표에 있던 것을 새 방 좌표로 옮긴다:
 * 문·창문(가장 가까운 새 벽에 다시 얹음), 원래 가구, 그리고 이 방의 모든 배치(다른 사람 것 포함, 서버 전용 키로).
 * 그래서 보정을 다시 해도 가구가 3D 안의 같은 자리에 남는다.
 */
export async function PUT(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const id = RoomId.safeParse((await params).id);
  if (!id.success) return notFound();

  const body = (await readJson(request)) as { transform?: unknown; floorPolygon?: unknown } | null;
  const after = parseSavedCalibration(body?.transform, body?.floorPolygon);
  if (!after) return badRequest('보정 값이 올바르지 않습니다.');

  const supabase = await createClient();
  const { data: room, error } = await supabase
    .from('rooms')
    .select('id, owner_id, status, transform, floor_polygon, openings, fixtures')
    .eq('id', id.data)
    .maybeSingle();
  if (error) return apiError(500, 'DB_ERROR', '방 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (!room || room.owner_id !== user.id) return notFound();
  if (room.status !== 'ready') return apiError(409, 'NOT_READY', '3D 파일을 올린 뒤에 보정할 수 있습니다.');

  const before = parseSavedCalibration(room.transform, room.floor_polygon);
  const remap = before ? roomRemap(before, after) : null;
  const openings = before && remap ? remapOpenings(parseOpenings(room.openings, before.floorPolygon), before.floorPolygon, after.floorPolygon, remap) : [];
  const fixtures = before && remap ? parseFixtures(remapFixtures(parseFixtures(room.fixtures, before.floorPolygon), remap), after.floorPolygon) : [];

  const { error: updateError } = await supabase
    .from('rooms')
    .update({ transform: { ...after.transform, flipX: after.flipX }, floor_polygon: after.floorPolygon, openings, fixtures })
    .eq('id', room.id);
  if (updateError) return apiError(500, 'DB_ERROR', '보정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');

  // 배치는 각자 자기 것만 고칠 수 있으므로(RLS) 서버 전용 키로 옮긴다 (방 주인은 위에서 확인함)
  const mine: { id: string; items: ReturnType<typeof parseSavedItems> }[] = [];
  let moved = 0;
  if (remap && !remap.identity) {
    const admin = createAdminClient();
    const { data: layouts, error: layoutError } = await admin.from('layouts').select('id, owner_id, items').eq('room_id', room.id);
    if (layoutError) console.error(layoutError);
    for (const layout of layouts ?? []) {
      const items = remapLayoutItems(parseSavedItems(layout.items), remap);
      const { error: moveError } = await admin.from('layouts').update({ items }).eq('id', layout.id);
      if (moveError) {
        console.error(moveError);
        continue;
      }
      moved += 1;
      if (layout.owner_id === user.id) mine.push({ id: layout.id, items });
    }
  }
  return NextResponse.json({ openings, fixtures, layouts: mine, movedLayouts: moved });
}
