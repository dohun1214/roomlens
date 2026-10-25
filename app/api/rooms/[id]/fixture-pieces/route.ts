import { NextResponse } from 'next/server';
import { apiError, badRequest, notFound, readJson, unauthenticated } from '@/lib/api/http';
import { deleteObject, headObject, presignGet, presignPut, readObjectHead, URL_TTL_SECONDS } from '@/lib/r2';
import { parseSavedCalibration } from '@/lib/rooms/calibration';
import { fixturePieceKey, MAX_PIECE_BYTES } from '@/lib/rooms/fixturePiece';
import { parseFixtures, type Fixture } from '@/lib/rooms/fixtures';
import { firstIssueMessage, FixturePieceFinishInput, FixturePieceStartInput, RoomId } from '@/lib/rooms/schemas';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

type Context = { params: Promise<{ id: string }> };

const CONTENT_TYPE = 'application/octet-stream';
/** 올릴 주소를 받은 뒤 이 시간 안에 끝내야 한다 (주소 유효 시간과 같다) */
const MAX_AGE_MS = URL_TTL_SECONDS * 1000;

/** 본인 방이고 보정이 저장돼 있으면 방과 원래 가구 목록을 돌려준다 */
async function ownedRoom(roomId: string, userId: string) {
  const supabase = await createClient();
  const { data: room, error } = await supabase.from('rooms').select('id, owner_id, status, transform, floor_polygon, fixtures').eq('id', roomId).maybeSingle();
  if (error) return { error: apiError(500, 'DB_ERROR', '방 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.') } as const;
  // 남의 방(공개 방 포함)은 없는 방과 똑같이 답한다
  if (!room || room.owner_id !== userId || room.status !== 'ready') return { error: notFound() } as const;
  const calibration = parseSavedCalibration(room.transform, room.floor_polygon);
  if (!calibration) return { error: apiError(400, 'NOT_CALIBRATED', '방의 크기·바닥 보정을 먼저 저장해 주세요.') } as const;
  return { supabase, room, fixtures: parseFixtures(room.fixtures, calibration.floorPolygon) } as const;
}

/**
 * 원래 가구의 3D 조각을 R2에 직접 올릴 주소(presigned PUT, 1시간)를 발급한다. 방 주인만.
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

  const owned = await ownedRoom(id.data, user.id);
  if ('error' in owned) return owned.error;
  const fixture = owned.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return apiError(404, 'NO_FIXTURE', '원래 가구를 찾을 수 없습니다. 원래 가구를 먼저 저장해 주세요.');
  if (kind === 'fill' && !fixture.piece) return apiError(409, 'NO_PIECE', '원래 가구를 먼저 옮길 수 있게 준비해 주세요.');

  const v = Date.now();
  const url = await presignPut(fixturePieceKey(owned.room.id, fixtureId, kind, v), CONTENT_TYPE, size);
  return NextResponse.json({ url, method: 'PUT', headers: { 'Content-Type': CONTENT_TYPE }, v, expiresIn: URL_TTL_SECONDS });
}

/**
 * 올리기를 끝냈다고 알린다: R2에 파일이 있는지·크기·형식(gzip으로 묶은 SPZ)을 확인한 뒤
 * 원래 가구에 조각 정보를 적고, 예전 조각 파일은 지운다. 새 읽기 주소를 돌려준다.
 */
export async function PATCH(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const id = RoomId.safeParse((await params).id);
  if (!id.success) return notFound();
  const parsed = FixturePieceFinishInput.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(firstIssueMessage(parsed.error));
  const { fixtureId, kind, v, top } = parsed.data;
  if (kind === 'piece' && top === undefined) return badRequest('조각의 높이가 없습니다.');
  const age = Date.now() - v;
  if (!(age >= 0 && age <= MAX_AGE_MS)) return badRequest('올릴 주소가 만료되었습니다. 다시 해 주세요.');

  const owned = await ownedRoom(id.data, user.id);
  if ('error' in owned) return owned.error;
  const fixture = owned.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return apiError(404, 'NO_FIXTURE', '원래 가구를 찾을 수 없습니다.');
  if (kind === 'fill' && !fixture.piece) return apiError(409, 'NO_PIECE', '원래 가구를 먼저 옮길 수 있게 준비해 주세요.');

  const key = fixturePieceKey(owned.room.id, fixtureId, kind, v);
  const [object, head] = await Promise.all([headObject(key), readObjectHead(key, 2)]);
  if (!object || !head) return apiError(409, 'NOT_UPLOADED', '조각 파일이 올라가지 않았습니다. 다시 해 주세요.');
  if (object.size === 0 || object.size > MAX_PIECE_BYTES || head[0] !== 0x1f || head[1] !== 0x8b) {
    await deleteObject(key).catch(() => {});
    return badRequest('조각 파일의 형식이 올바르지 않습니다.');
  }

  const old = kind === 'piece' ? fixture.piece?.v : fixture.fill?.v;
  const next: Fixture[] = owned.fixtures.map((f) =>
    f.id !== fixtureId ? f : kind === 'piece' ? { ...f, piece: { v, top: Math.round((top ?? f.h) * 100) / 100 } } : { ...f, fill: { v } },
  );
  const { error } = await owned.supabase.from('rooms').update({ fixtures: next }).eq('id', owned.room.id);
  if (error) return apiError(500, 'DB_ERROR', '원래 가구 정보를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (old && old !== v) await deleteObject(fixturePieceKey(owned.room.id, fixtureId, kind, old)).catch(() => {});

  return NextResponse.json({ fixture: next.find((f) => f.id === fixtureId), url: await presignGet(key) });
}
