import { NextResponse } from 'next/server';
import { isJpegBase64, MAX_TOTAL_BASE64, totalBase64 } from '@/lib/ai/analysis';
import { DetectedFixtures, DetectFixturesInput, locateFixtures, topViewPlan } from '@/lib/ai/fixturesDetect';
import { AiError, GEMINI_MODEL, generateJson } from '@/lib/ai/gemini';
import { DAILY_AI_LIMIT } from '@/lib/ai/limits';
import { FIXTURES_SYSTEM_PROMPT } from '@/lib/ai/prompts';
import { finishAiCall, startAiCall } from '@/lib/ai/usage';
import { apiError, badRequest, notFound, readJson, unauthenticated } from '@/lib/api/http';
import { parseSavedCalibration } from '@/lib/rooms/calibration';
import { firstIssueMessage, RoomId } from '@/lib/rooms/schemas';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

type Context = { params: Promise<{ id: string }> };

export const maxDuration = 120;

/**
 * 원래 가구 후보 찾기. 방 주인이 보낸 "위에서 내려다본 그림"(저장된 평면도로 정한 칸마다 한 장)에서
 * Gemini가 가구를 찾고, 그 상자를 방 좌표의 사각형으로 바꿔 후보로 돌려준다.
 * 아무것도 저장하지 않는다: 방 주인이 화면에서 확인하고 고친 뒤 직접 저장한다.
 * 방 주인만, 한 사람당 하루 10회(다른 AI 기능과 합쳐서).
 */
export async function POST(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();

  const id = RoomId.safeParse((await params).id);
  if (!id.success) return notFound();
  const parsed = DetectFixturesInput.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(firstIssueMessage(parsed.error));
  const { images } = parsed.data;
  if (!images.every((image) => isJpegBase64(image.data))) return badRequest('JPEG 그림만 보낼 수 있습니다.');
  if (totalBase64(images) > MAX_TOTAL_BASE64) return apiError(413, 'TOO_LARGE', '그림이 너무 큽니다.');

  const supabase = await createClient();
  const { data: room, error } = await supabase.from('rooms').select('id, owner_id, status, transform, floor_polygon').eq('id', id.data).maybeSingle();
  if (error) return apiError(500, 'DB_ERROR', '방 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (!room || room.owner_id !== user.id || room.status !== 'ready') return notFound();
  const calibration = parseSavedCalibration(room.transform, room.floor_polygon);
  if (!calibration) return apiError(400, 'NOT_CALIBRATED', '방의 크기·바닥 보정을 먼저 저장해 주세요.');
  // 칸은 저장된 평면도로 정해진다. 브라우저도 같은 평면도로 같은 칸을 찍는다
  const tiles = topViewPlan(calibration.floorPolygon);
  if (images.length !== tiles.length) return badRequest('그림 수가 방의 크기와 맞지 않습니다. 화면을 새로 고친 뒤 다시 해 주세요.');

  const call = await startAiCall(user.id, room.id, 'fixtures', GEMINI_MODEL);
  if (!call.ok) {
    return call.reason === 'limit'
      ? apiError(429, 'AI_LIMIT', `오늘 쓸 수 있는 AI 횟수(${DAILY_AI_LIMIT}회)를 모두 썼습니다. 내일 다시 해 주세요.`)
      : apiError(500, 'DB_ERROR', 'AI 사용 횟수를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }

  let generated;
  try {
    generated = await generateJson(DetectedFixtures, {
      system: FIXTURES_SYSTEM_PROMPT,
      parts: [
        ...images.map((image) => ({
          inlineData: { mimeType: 'image/jpeg', data: image.data },
        })),
        {
          text: images.length === 1 ? '이 그림에서 바닥에 놓인 가구를 모두 찾아라.' : `그림 ${images.length}장에서 바닥에 놓인 가구를 모두 찾아라.`,
        },
      ],
      timeoutMs: 90_000,
    });
  } catch (err) {
    await finishAiCall(call.callId, {
      status: 'failed',
      error: err instanceof AiError ? err.code : 'UNKNOWN',
    });
    if (!(err instanceof AiError)) console.error(err);
    return apiError(502, 'AI_ERROR', 'AI가 답하지 못했습니다. 잠시 뒤에 다시 해 주세요.');
  }

  const candidates = locateFixtures(generated.data.fixtures, tiles, calibration.floorPolygon);
  await finishAiCall(call.callId, {
    status: 'done',
    attempts: 1,
    inputTokens: generated.inputTokens,
    outputTokens: generated.outputTokens,
  });
  return NextResponse.json({
    candidates,
    detected: generated.data.fixtures.length,
    remaining: call.remaining,
  });
}
