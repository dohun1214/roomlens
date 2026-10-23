import { NextResponse } from 'next/server';
import { isJpegBase64, MAX_TOTAL_BASE64, totalBase64 } from '@/lib/ai/analysis';
import { AiError, GEMINI_MODEL, generateJson } from '@/lib/ai/gemini';
import { DAILY_AI_LIMIT } from '@/lib/ai/limits';
import { DetectedOpenings, DetectInput, locateDetections } from '@/lib/ai/openingsDetect';
import { OPENINGS_SYSTEM_PROMPT, WALL_OPENINGS_SYSTEM_PROMPT } from '@/lib/ai/prompts';
import { finishAiCall, startAiCall } from '@/lib/ai/usage';
import { DetectedWallOpenings, locateWallDetections, WallDetectInput, wallViewPlan } from '@/lib/ai/wallViews';
import { apiError, badRequest, notFound, readJson, unauthenticated } from '@/lib/api/http';
import { parseSavedCalibration } from '@/lib/rooms/calibration';
import type { Opening } from '@/lib/rooms/openings';
import { firstIssueMessage, RoomId } from '@/lib/rooms/schemas';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

type Context = { params: Promise<{ id: string }> };

export const maxDuration = 120;

/**
 * 문·창문 후보 찾기. 방 주인이 보낸 3D 화면 캡처에서 Gemini가 문·창문을 찾고, 그것이 어느 벽의 어디인지 계산해 후보로 돌려준다.
 *   method: 'walls' — 벽마다 정면에서 본 그림 (기본). 서버가 저장된 평면도로 같은 자리를 다시 계산한다
 *   (없음)          — 방 안 몇 곳에서 여러 방향으로 찍은 그림과 찍은 자리 (예전 방식)
 * 아무것도 저장하지 않는다: 방 주인이 화면에서 확인하고 고친 뒤 직접 저장한다.
 * 방 주인만, 한 사람당 하루 10회(다른 AI 기능과 합쳐서).
 */
export async function POST(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();

  const id = RoomId.safeParse((await params).id);
  if (!id.success) return notFound();
  const body = await readJson(request);
  const walls = (body as { method?: unknown } | null)?.method === 'walls';
  const parsedWalls = walls ? WallDetectInput.safeParse(body) : null;
  const parsedViews = walls ? null : DetectInput.safeParse(body);
  if (parsedWalls && !parsedWalls.success) return badRequest(firstIssueMessage(parsedWalls.error));
  if (parsedViews && !parsedViews.success) return badRequest(firstIssueMessage(parsedViews.error));
  const images = (parsedWalls?.data ?? parsedViews?.data)!.images;
  if (parsedViews?.data && images.length !== parsedViews.data.views.length) return badRequest('그림 수와 찍은 자리의 수가 다릅니다.');
  if (!images.every((image) => isJpegBase64(image.data))) return badRequest('JPEG 그림만 보낼 수 있습니다.');
  if (totalBase64(images) > MAX_TOTAL_BASE64) return apiError(413, 'TOO_LARGE', '그림이 너무 큽니다.');

  const supabase = await createClient();
  const { data: room, error } = await supabase.from('rooms').select('id, owner_id, status, transform, floor_polygon').eq('id', id.data).maybeSingle();
  if (error) return apiError(500, 'DB_ERROR', '방 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (!room || room.owner_id !== user.id || room.status !== 'ready') return notFound();
  // 벽 번호는 저장된 평면도 기준이다
  const calibration = parseSavedCalibration(room.transform, room.floor_polygon);
  if (!calibration) return apiError(400, 'NOT_CALIBRATED', '방의 크기·바닥 보정을 먼저 저장해 주세요.');
  const plan = parsedWalls?.data ? wallViewPlan(calibration.floorPolygon, parsedWalls.data.ceiling) : null;
  if (plan && plan.length !== images.length) return badRequest('그림 수가 벽 수와 다릅니다. 화면을 새로 고친 뒤 다시 해 주세요.');

  const call = await startAiCall(user.id, room.id, 'openings', GEMINI_MODEL);
  if (!call.ok) {
    return call.reason === 'limit'
      ? apiError(429, 'AI_LIMIT', `오늘 쓸 수 있는 AI 횟수(${DAILY_AI_LIMIT}회)를 모두 썼습니다. 내일 다시 해 주세요.`)
      : apiError(500, 'DB_ERROR', 'AI 사용 횟수를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }

  const parts = images.map((image) => ({ inlineData: { mimeType: 'image/jpeg', data: image.data } }));
  let candidates: Opening[];
  let detected: number;
  let tokens: { inputTokens?: number; outputTokens?: number };
  try {
    if (plan) {
      const generated = await generateJson(DetectedWallOpenings, {
        system: WALL_OPENINGS_SYSTEM_PROMPT,
        parts: [...parts, { text: `벽 정면 그림 ${images.length}장에서 문과 창문을 찾아라.` }],
        timeoutMs: 90_000,
      });
      candidates = locateWallDetections(generated.data.openings, plan, calibration.floorPolygon);
      detected = generated.data.openings.length;
      tokens = generated;
    } else {
      const { views, aspect, fovDeg } = parsedViews!.data!;
      const generated = await generateJson(DetectedOpenings, {
        system: OPENINGS_SYSTEM_PROMPT,
        parts: [...parts, { text: `그림 ${images.length}장에서 문과 창문을 찾아라.` }],
        timeoutMs: 90_000,
      });
      candidates = locateDetections(generated.data.openings, views, { aspect, fovDeg }, calibration.floorPolygon);
      detected = generated.data.openings.length;
      tokens = generated;
    }
  } catch (err) {
    await finishAiCall(call.callId, { status: 'failed', error: err instanceof AiError ? err.code : 'UNKNOWN' });
    if (!(err instanceof AiError)) console.error(err);
    return apiError(502, 'AI_ERROR', 'AI가 답하지 못했습니다. 잠시 뒤에 다시 해 주세요.');
  }

  await finishAiCall(call.callId, { status: 'done', attempts: 1, inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens });
  // callId: "AI로 방 준비하기"가 이어서 부르는 원래 가구 찾기를 같은 1회로 세게 한다
  return NextResponse.json({ candidates, detected, remaining: call.remaining, callId: call.callId });
}
