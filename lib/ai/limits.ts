// AI 호출 횟수 제한에 쓰는 계산 (브라우저·서버 공용, DB를 건드리지 않는 부분).

/** 한 사람이 하루에 쓸 수 있는 AI 호출 수 (배치 추천·방 분석·문·창문 찾기를 합쳐서) */
export const DAILY_AI_LIMIT = 10;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 한국 시간으로 "오늘 0시"에 해당하는 시각. 하루 횟수는 이때부터 센다 */
export function kstDayStart(now: Date = new Date()): Date {
  const shifted = now.getTime() + KST_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - KST_OFFSET_MS);
}

/** "AI로 방 준비하기"에서 문·창문 찾기에 이어 부른 원래 가구 찾기를 같은 1회로 칠 수 있는 시간 */
export const BUNDLE_WINDOW_MS = 15 * 60 * 1000;

/** 이어서 부른 호출이 기댈 앞 호출 (ai_calls 행) */
export type BundleParent = { owner_id: string; room_id: string | null; kind: string; status: string; created_at: string; bundle_of?: string | null };

/**
 * 앞 호출에 이어 붙여 횟수를 한 번만 셀 수 있는지: 같은 사람·같은 방의, 끝난 문·창문 찾기이고, 15분 안이어야 한다.
 * (앞 호출 하나에 하나만 붙는 것은 DB의 유일 색인이 지킨다)
 */
export function canBundle(parent: BundleParent | null, userId: string, roomId: string, now: Date = new Date()): boolean {
  if (!parent || parent.owner_id !== userId || parent.room_id !== roomId) return false;
  if (parent.kind !== 'openings' || parent.status !== 'done' || parent.bundle_of) return false;
  const age = now.getTime() - new Date(parent.created_at).getTime();
  return Number.isFinite(age) && age >= 0 && age <= BUNDLE_WINDOW_MS;
}

/** 오늘 남은 횟수 */
export function remainingCalls(usedToday: number): number {
  return Math.max(0, DAILY_AI_LIMIT - Math.max(0, usedToday));
}

/** 한국 시간 "10/7 04:30" (AI 배치 이름에 쓴다) */
export function kstStamp(now: Date = new Date()): string {
  const t = new Date(now.getTime() + KST_OFFSET_MS);
  const two = (v: number) => String(v).padStart(2, '0');
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()} ${two(t.getUTCHours())}:${two(t.getUTCMinutes())}`;
}
