import { NextResponse } from 'next/server';
import { apiError, badRequest, notFound, readJson, unauthenticated } from '@/lib/api/http';
import { deleteObject, headObject, presignGet, presignPut, readObjectHead, URL_TTL_SECONDS } from '@/lib/r2';
import { parseSavedCalibration } from '@/lib/rooms/calibration';
import { fixturePieceKey, MAX_PIECE_BYTES, PIECE_GROW, pieceAccess } from '@/lib/rooms/fixturePiece';
import { parseFixtures, type Fixture } from '@/lib/rooms/fixtures';
import { firstIssueMessage, FixturePieceFinishInput, FixturePieceStartInput, RoomId } from '@/lib/rooms/schemas';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

type Context = { params: Promise<{ id: string }> };

const CONTENT_TYPE = 'application/octet-stream';
/** 올릴 주소를 받은 뒤 이 시간 안에 끝내야 한다 (주소 유효 시간과 같다) */
const MAX_AGE_MS = URL_TTL_SECONDS * 1000;

/**
 * 볼 수 있는 방(내 방이나 공개 방)이고 보정이 저장돼 있으면 방과 원래 가구 목록을 돌려준다.
 * 원래 가구는 로그인한 사람이면 누구나 원할 때 떼어 낼 수 있다 (방 주인이 아니면 처음 한 번만, pieceAccess).
 */
async function visibleRoom(roomId: string, userId: string) {
  const supabase = await createClient();
  // RLS가 남의 비공개 방을 가린다
  const { data: room, error } = await supabase.from('rooms').select('id, owner_id, status, transform, floor_polygon, fixtures, updated_at').eq('id', roomId).maybeSingle();
  if (error) return { error: apiError(500, 'DB_ERROR', '방 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.') } as const;
  if (!room || room.status !== 'ready') return { error: notFound() } as const;
  const calibration = parseSavedCalibration(room.transform, room.floor_polygon);
  if (!calibration) return { error: apiError(400, 'NOT_CALIBRATED', '방의 크기·바닥 보정을 먼저 저장해 주세요.') } as const;
  return { room, isOwner: room.owner_id === userId, fixtures: parseFixtures(room.fixtures, calibration.floorPolygon) } as const;
}

function accessError(access: 'need-piece' | 'taken') {
  return access === 'need-piece'
    ? apiError(409, 'NO_PIECE', '원래 가구를 먼저 떼어 내 주세요.')
    : apiError(409, 'ALREADY_PREPARED', '다른 사람이 이미 떼어 냈습니다. 새로 고침해 주세요.');
}

/**
 * 원래 가구의 3D 조각을 R2에 직접 올릴 주소(presigned PUT, 1시간)를 발급한다.
 * 로그인한 사람 누구나 (볼 수 있는 방). 방 주인은 다시 만들 수 있고, 다른 사람은 아직 없을 때만.
 * kind piece: 원래 가구를 떼어 낸 조각 (배치에서 옮길 수 있게 한다)
 * kind fill : 옮긴 뒤의 빈자리를 채운 조각 (가구 조각이 먼저 있어야 한다)
 */
export async function POST(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const id = RoomId.safeParse((await params).id);
  if (!id.success) return notFound();
  const parsed = FixturePieceStartInput.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(firstIssueMessage(parsed.error));
  const { fixtureId, kind, size } = parsed.data;

  const found = await visibleRoom(id.data, user.id);
  if ('error' in found) return found.error;
  const fixture = found.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return apiError(404, 'NO_FIXTURE', '원래 가구를 찾을 수 없습니다. 원래 가구를 먼저 저장해 주세요.');
  const access = pieceAccess(fixture, kind, found.isOwner);
  if (access !== 'ok') return accessError(access);

  const v = Date.now();
  const url = await presignPut(fixturePieceKey(found.room.id, fixtureId, kind, v), CONTENT_TYPE, size);
  return NextResponse.json({ url, method: 'PUT', headers: { 'Content-Type': CONTENT_TYPE }, v, expiresIn: URL_TTL_SECONDS });
}

/**
 * 올리기를 끝냈다고 알린다: R2에 파일이 있는지·크기·형식(gzip으로 묶은 SPZ)을 확인한 뒤
 * 원래 가구에 조각 정보를 적고, 예전 조각 파일은 지운다(방 주인이 다시 만들 때). 새 읽기 주소를 돌려준다.
 * 방 주인이 아니면 rooms를 바꿀 수 없어(RLS) 서버 키로 적는다. 그 사이 방이 바뀌었으면(다른 사람이 먼저 떼어 냄 등) 409.
 */
export async function PATCH(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const id = RoomId.safeParse((await params).id);
  if (!id.success) return notFound();
  const parsed = FixturePieceFinishInput.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(firstIssueMessage(parsed.error));
  const { fixtureId, kind, v, top, box } = parsed.data;
  if (kind === 'piece' && top === undefined) return badRequest('조각의 높이가 없습니다.');
  const age = Date.now() - v;
  if (!(age >= 0 && age <= MAX_AGE_MS)) return badRequest('올릴 주소가 만료되었습니다. 다시 해 주세요.');

  const found = await visibleRoom(id.data, user.id);
  if ('error' in found) return found.error;
  const fixture = found.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return apiError(404, 'NO_FIXTURE', '원래 가구를 찾을 수 없습니다.');
  // 떼어 낸 사각형은 원래 가구를 넓혀 고른 곳 안이어야 한다
  const reach = PIECE_GROW + 0.02;
  if (box && (Math.abs(box.cu) + box.w / 2 > fixture.w / 2 + reach || Math.abs(box.cv) + box.d / 2 > fixture.d / 2 + reach)) return badRequest('조각의 자리가 원래 가구와 맞지 않습니다.');
  const key = fixturePieceKey(found.room.id, fixtureId, kind, v);
  const access = pieceAccess(fixture, kind, found.isOwner);
  if (access !== 'ok') {
    // 올리는 사이 다른 사람이 먼저 끝냈으면 이 사람이 올린 파일은 쓰지 않는다
    if ((kind === 'piece' ? fixture.piece?.v : fixture.fill?.v) !== v) await deleteObject(key).catch(() => {});
    return accessError(access);
  }

  const [object, head] = await Promise.all([headObject(key), readObjectHead(key, 2)]);
  if (!object || !head) return apiError(409, 'NOT_UPLOADED', '조각 파일이 올라가지 않았습니다. 다시 해 주세요.');
  if (object.size === 0 || object.size > MAX_PIECE_BYTES || head[0] !== 0x1f || head[1] !== 0x8b) {
    await deleteObject(key).catch(() => {});
    return badRequest('조각 파일의 형식이 올바르지 않습니다.');
  }

  const old = kind === 'piece' ? fixture.piece?.v : fixture.fill?.v;
  const next: Fixture[] = found.fixtures.map((f) =>
    f.id !== fixtureId ? f : kind === 'piece' ? { ...f, piece: { v, top: Math.round((top ?? f.h) * 100) / 100, ...(box ? { box } : {}) } } : { ...f, fill: { v } },
  );
  // 읽은 뒤로 방이 바뀌지 않았을 때만 적는다 (updated_at은 바뀔 때마다 트리거가 새로 적는다)
  const { data: written, error } = await createAdminClient()
    .from('rooms')
    .update({ fixtures: next })
    .eq('id', found.room.id)
    .eq('updated_at', found.room.updated_at)
    .select('id');
  if (error) return apiError(500, 'DB_ERROR', '원래 가구 정보를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (!written || written.length === 0) {
    await deleteObject(key).catch(() => {});
    return apiError(409, 'ROOM_CHANGED', '그 사이 방 정보가 바뀌었습니다. 새로 고침한 뒤 다시 해 주세요.');
  }
  if (old && old !== v) await deleteObject(fixturePieceKey(found.room.id, fixtureId, kind, old)).catch(() => {});

  return NextResponse.json({ fixture: next.find((f) => f.id === fixtureId), url: await presignGet(key) });
}
