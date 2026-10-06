import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { DAILY_AI_LIMIT, kstDayStart, remainingCalls } from './limits';

// AI 호출 기록(ai_calls)을 쓰고 센다. 기록은 서버 전용 클라이언트로만 쓴다
// (브라우저가 자기 횟수를 지우거나 고칠 수 없게). 부르기 전에 반드시 로그인한 사용자를 확인한다.

export type AiCallKind = 'layout' | 'analysis' | 'openings';

/** 오늘(한국 시간) 쓴 횟수: 진행 중이거나 끝난 호출. 실패한 호출은 세지 않는다. 읽지 못하면 null */
export async function countCallsToday(userId: string): Promise<number | null> {
  const { count, error } = await createAdminClient()
    .from('ai_calls')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', userId)
    .in('status', ['running', 'done'])
    .gte('created_at', kstDayStart().toISOString());
  return error || count === null ? null : count;
}

/** 오늘 남은 횟수. 읽지 못하면 0으로 보지 않고 null */
export async function remainingToday(userId: string): Promise<number | null> {
  const used = await countCallsToday(userId);
  return used === null ? null : remainingCalls(used);
}

export type StartedCall = { ok: true; callId: string; remaining: number } | { ok: false; reason: 'limit' | 'db' };

/** 횟수를 확인하고 호출 기록을 시작한다. 한도를 넘었으면 시작하지 않는다 */
export async function startAiCall(userId: string, roomId: string, kind: AiCallKind, model: string): Promise<StartedCall> {
  const used = await countCallsToday(userId);
  if (used === null) return { ok: false, reason: 'db' };
  if (used >= DAILY_AI_LIMIT) return { ok: false, reason: 'limit' };
  const { data, error } = await createAdminClient().from('ai_calls').insert({ owner_id: userId, room_id: roomId, kind, model }).select('id').maybeSingle();
  if (error || !data) return { ok: false, reason: 'db' };
  return { ok: true, callId: data.id, remaining: remainingCalls(used + 1) };
}

/** 호출이 끝났음을 기록한다. 실패(failed)로 끝난 호출은 횟수에서 빠진다. 기록 실패는 무시한다 */
export async function finishAiCall(
  callId: string,
  result: { status: 'done' | 'failed'; attempts?: number; inputTokens?: number; outputTokens?: number; error?: string },
): Promise<void> {
  await createAdminClient()
    .from('ai_calls')
    .update({
      status: result.status,
      attempts: result.attempts ?? 0,
      input_tokens: result.inputTokens ?? 0,
      output_tokens: result.outputTokens ?? 0,
      error: result.error ? result.error.slice(0, 500) : null,
      finished_at: new Date().toISOString(),
    })
    .eq('id', callId);
}
