import { NextResponse } from 'next/server';
import { AiError, GEMINI_IMAGE_MODEL, generateImage } from '@/lib/ai/gemini';
import { DAILY_AI_LIMIT } from '@/lib/ai/limits';
import { FILL_PROMPTS } from '@/lib/ai/prompts';
import { finishAiCall, startAiCall } from '@/lib/ai/usage';
import { apiError, badRequest, notFound, readJson, unauthenticated } from '@/lib/api/http';
import { parseSavedCalibration } from '@/lib/rooms/calibration';
import { pieceAccess } from '@/lib/rooms/fixturePiece';
import { parseFixtures } from '@/lib/rooms/fixtures';
import { firstIssueMessage, FixtureFillInput, RoomId } from '@/lib/rooms/schemas';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

type Context = { params: Promise<{ id: string }> };

// 그림 한 장에 20~40초 (여러 장은 함께 부른다)
export const maxDuration = 120;

/**
 * 옮긴 원래 가구의 빈자리 채우기: 바닥(위에서)·벽(정면)을 찍어 구멍을 자홍색으로 칠한 그림을 받아,
 * Gemini 그림 모델이 구멍만 주변에 맞춰 이어 그린 그림을 돌려준다. 그림으로 스플랫을 까는 것은 브라우저가 한다.
 * 로그인한 사람 누구나(볼 수 있는 방), 원래 가구를 떼어 낸 뒤에. 방 주인이 아니면 아직 채우지 않았을 때만.
 * 그림 여러 장을 합쳐 부른 사람의 AI 1회로 센다.
 */
export async function POST(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const id = RoomId.safeParse((await params).id);
  if (!id.success) return notFound();
  const parsed = FixtureFillInput.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(firstIssueMessage(parsed.error));
  const { fixtureId, images } = parsed.data;

  const supabase = await createClient();
  const { data: room, error } = await supabase.from('rooms').select('id, owner_id, status, transform, floor_polygon, fixtures').eq('id', id.data).maybeSingle();
  if (error) return apiError(500, 'DB_ERROR', '방 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  // RLS가 남의 비공개 방을 가린다
  if (!room || room.status !== 'ready') return notFound();
  const calibration = parseSavedCalibration(room.transform, room.floor_polygon);
  if (!calibration) return apiError(400, 'NOT_CALIBRATED', '방의 크기·바닥 보정을 먼저 저장해 주세요.');
  const fixture = parseFixtures(room.fixtures, calibration.floorPolygon).find((f) => f.id === fixtureId);
  if (!fixture) return apiError(404, 'NO_FIXTURE', '원래 가구를 찾을 수 없습니다.');
  const access = pieceAccess(fixture, 'fill', room.owner_id === user.id);
  if (access === 'need-piece') return apiError(409, 'NO_PIECE', '원래 가구를 먼저 떼어 내 주세요.');
  if (access === 'taken') return apiError(409, 'ALREADY_FILLED', '다른 사람이 이미 빈자리를 채웠습니다. 새로 고침해 주세요.');

  const call = await startAiCall(user.id, room.id, 'fill', GEMINI_IMAGE_MODEL);
  if (!call.ok) {
    return call.reason === 'limit'
      ? apiError(429, 'AI_LIMIT', `오늘 쓸 수 있는 AI 횟수(${DAILY_AI_LIMIT}회)를 모두 썼습니다. 내일 다시 해 주세요.`)
      : apiError(500, 'DB_ERROR', 'AI 사용 횟수를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }

  let results;
  try {
    results = await Promise.all(images.map((image) => generateImage({ prompt: FILL_PROMPTS[image.kind], image: { mimeType: 'image/jpeg', data: image.data } })));
  } catch (err) {
    await finishAiCall(call.callId, { status: 'failed', attempts: 1, error: err instanceof AiError ? err.code : 'UNKNOWN' });
    if (!(err instanceof AiError)) console.error(err);
    return apiError(502, 'AI_ERROR', 'AI가 빈자리를 채우지 못했습니다. 잠시 뒤에 다시 해 주세요.');
  }
  await finishAiCall(call.callId, {
    status: 'done',
    attempts: 1,
    inputTokens: results.reduce((sum, r) => sum + r.inputTokens, 0),
    outputTokens: results.reduce((sum, r) => sum + r.outputTokens, 0),
  });
  return NextResponse.json({ images: results.map((r) => ({ mimeType: r.mimeType, data: r.data })), remaining: call.remaining });
}
