import { NextResponse } from 'next/server';
import { AiError, GEMINI_MODEL } from '@/lib/ai/gemini';
import { DAILY_AI_LIMIT } from '@/lib/ai/limits';
import { segmentFixture } from '@/lib/ai/segment';
import { finishAiCall, startAiCall } from '@/lib/ai/usage';
import { apiError, badRequest, notFound, readJson, unauthenticated } from '@/lib/api/http';
import { parseSavedCalibration } from '@/lib/rooms/calibration';
import { pieceAccess } from '@/lib/rooms/fixturePiece';
import { parseFixtures } from '@/lib/rooms/fixtures';
import { describeFixture } from '@/lib/rooms/fixtureSegment';
import { firstIssueMessage, FixtureSegmentInput, RoomId } from '@/lib/rooms/schemas';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

type Context = { params: Promise<{ id: string }> };

// 그림 4장을 한 번에 보낸다 (5~10초)
export const maxDuration = 60;

/**
 * 원래 가구 떼어 내기의 AI 분할: 브라우저가 고른 곳만 가구 둘레 여러 시점에서 찍은 그림을 받아,
 * 시점마다 그 가구·위에 얹힌 물건·옆에 따로 선 물건의 상자를 돌려준다. 투영·고르기는 브라우저가 한다.
 * 떼어 낼 수 있는 사람(로그인, 볼 수 있는 방, 방 주인이 아니면 아직 떼어 내지 않은 가구)만. 부른 사람의 AI 1회로 센다.
 * 한도를 넘었거나 실패하면 브라우저는 AI 없이 떼어 낸다.
 */
export async function POST(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const id = RoomId.safeParse((await params).id);
  if (!id.success) return notFound();
  const parsed = FixtureSegmentInput.safeParse(await readJson(request));
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
  if (pieceAccess(fixture, 'piece', room.owner_id === user.id) === 'taken') return apiError(409, 'ALREADY_PREPARED', '다른 사람이 이미 떼어 냈습니다. 새로 고침해 주세요.');

  const call = await startAiCall(user.id, room.id, 'segment', GEMINI_MODEL);
  if (!call.ok) {
    return call.reason === 'limit'
      ? apiError(429, 'AI_LIMIT', `오늘 쓸 수 있는 AI 횟수(${DAILY_AI_LIMIT}회)를 모두 썼습니다.`)
      : apiError(500, 'DB_ERROR', 'AI 사용 횟수를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  try {
    const result = await segmentFixture(describeFixture(fixture.label, fixture.w, fixture.d, fixture.h), images);
    await finishAiCall(call.callId, { status: 'done', attempts: 1, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    return NextResponse.json({ views: result.views, remaining: call.remaining });
  } catch (err) {
    await finishAiCall(call.callId, { status: 'failed', attempts: 1, error: err instanceof AiError ? err.code : 'UNKNOWN' });
    if (!(err instanceof AiError)) console.error(err);
    return apiError(502, 'AI_ERROR', 'AI가 가구 모양을 고르지 못했습니다.');
  }
}
