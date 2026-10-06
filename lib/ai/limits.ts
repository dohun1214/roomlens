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
