import { NextResponse } from 'next/server';
import { AnalyzeInput, isJpegBase64, MAX_TOTAL_BASE64, tidyReport, totalBase64 } from '@/lib/ai/analysis';
import { AiError, GEMINI_MODEL, generateJson } from '@/lib/ai/gemini';
import { DAILY_AI_LIMIT } from '@/lib/ai/limits';
import { ANALYSIS_SYSTEM_PROMPT, analysisUserPrompt } from '@/lib/ai/prompts';
import { RoomReport } from '@/lib/ai/schemas';
import { finishAiCall, startAiCall } from '@/lib/ai/usage';
import { apiError, badRequest, notFound, readJson, unauthenticated } from '@/lib/api/http';
import { firstIssueMessage, RoomId } from '@/lib/rooms/schemas';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

type Context = { params: Promise<{ id: string }> };

export const maxDuration = 120;

/**
 * 방 분석. 방 주인이 보낸 그림(3D 화면 캡처, 사진)을 Gemini에 보내 옵션·수납·채광·상태 리포트를 받는다.
 * 그림은 저장하지 않고 분석에만 쓴다. 리포트는 방마다 가장 최근 것 하나만 남긴다.
 * 방 주인만, 한 사람당 하루 10회(배치 추천과 합쳐서).
 */
export async function POST(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();

  const id = RoomId.safeParse((await params).id);
  if (!id.success) return notFound();
  const parsed = AnalyzeInput.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(firstIssueMessage(parsed.error));
  const { images } = parsed.data;
  if (!images.every((image) => isJpegBase64(image.data))) return badRequest('JPEG 그림만 보낼 수 있습니다.');
  if (totalBase64(images) > MAX_TOTAL_BASE64) return apiError(413, 'TOO_LARGE', '그림이 너무 큽니다. 장수를 줄여 주세요.');

  const supabase = await createClient();
  const { data: room, error } = await supabase.from('rooms').select('id, owner_id, status').eq('id', id.data).maybeSingle();
  if (error) return apiError(500, 'DB_ERROR', '방 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  // 리포트는 방에 붙는 것이라 방 주인만 만들 수 있다
  if (!room || room.owner_id !== user.id || room.status !== 'ready') return notFound();

  const call = await startAiCall(user.id, room.id, 'analysis', GEMINI_MODEL);
  if (!call.ok) {
    return call.reason === 'limit'
      ? apiError(429, 'AI_LIMIT', `오늘 쓸 수 있는 AI 횟수(${DAILY_AI_LIMIT}회)를 모두 썼습니다. 내일 다시 해 주세요.`)
      : apiError(500, 'DB_ERROR', 'AI 사용 횟수를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }

  let generated;
  try {
    generated = await generateJson(RoomReport, {
      system: ANALYSIS_SYSTEM_PROMPT,
      parts: [...images.map((image) => ({ inlineData: { mimeType: 'image/jpeg', data: image.data } })), { text: analysisUserPrompt(images.map((image) => image.source)) }],
      timeoutMs: 90_000,
    });
  } catch (err) {
    await finishAiCall(call.callId, { status: 'failed', error: err instanceof AiError ? err.code : 'UNKNOWN' });
    if (!(err instanceof AiError)) console.error(err);
    return apiError(502, 'AI_ERROR', 'AI가 답하지 못했습니다. 잠시 뒤에 다시 해 주세요.');
  }
  const usage = { attempts: 1, inputTokens: generated.inputTokens, outputTokens: generated.outputTokens };
  const report = tidyReport(generated.data, images.length);

  // room_reports는 서버만 쓸 수 있다 (방 주인인지는 위에서 확인함)
  const admin = createAdminClient();
  const { data: saved, error: saveError } = await admin
    .from('room_reports')
    .insert({ room_id: room.id, model: GEMINI_MODEL, report })
    .select('id, model, created_at')
    .maybeSingle();
  if (saveError || !saved) {
    await finishAiCall(call.callId, { status: 'failed', ...usage, error: 'SAVE_FAILED' });
    return apiError(500, 'DB_ERROR', '리포트를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  // 이전 리포트는 지운다 (방마다 최근 것 하나)
  await admin.from('room_reports').delete().eq('room_id', room.id).neq('id', saved.id);

  await finishAiCall(call.callId, { status: 'done', ...usage });
  return NextResponse.json({
    report: { id: saved.id, model: saved.model, createdAt: saved.created_at, imageCount: images.length, report },
    remaining: call.remaining,
  });
}
