// AI 배치 추천의 흐름: 방 요약 → Gemini의 배치 의도 → 솔버 → 못 놓은 이유를 붙여 다시 묻기 → 가장 나은 결과.
// Gemini 호출은 밖에서 넣어 주므로(generate) 이 파일은 네트워크 없이 테스트할 수 있다.
import { solveLayout, type SolvedItem, type SolverItem, type SolverNote, type SolverRoom } from '@/lib/layout/solver';
import { kstStamp } from './limits';
import { layoutUserPrompt } from './prompts';
import { summarizeRoom } from './roomSummary';
import type { LayoutIntent } from './schemas';

/** 한 번에 추천받을 수 있는 가구 수 */
export const MAX_SUGGEST_ITEMS = 20;
/** Gemini에 묻는 횟수 (처음 + 다시 묻기) */
export const MAX_ATTEMPTS = 3;
/** layouts.ai_summary 에 넣는 글의 최대 길이 */
export const AI_SUMMARY_MAX = 2000;

export type GenerateIntent = (prompt: string) => Promise<{ intent: LayoutIntent; inputTokens: number; outputTokens: number }>;

export type Suggestion = {
  placed: SolvedItem[];
  /** Gemini가 적은 전체 배치의 의도 */
  summary: string;
  /** 놓지 못한 가구와 이유 */
  failures: SolverNote[];
  /** 놓았지만 지키지 못한 조건 */
  unmet: SolverNote[];
  /** Gemini에 물은 횟수와 쓴 토큰 */
  attempts: number;
  inputTokens: number;
  outputTokens: number;
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * 가구들을 어디에 둘지 추천한다.
 * 먼저 "요청한 자리에만" 놓아 보고(fallback 끔), 못 놓은 가구가 있으면 그 이유를 붙여 다시 묻는다.
 * 끝까지 다 놓지 못하면, 시도한 것 가운데 "다른 자리에라도 놓은" 결과 중 가장 나은 것을 돌려준다.
 */
export async function suggestLayout(
  room: SolverRoom,
  items: SolverItem[],
  request: string,
  generate: GenerateIntent,
  maxAttempts = MAX_ATTEMPTS,
): Promise<Suggestion> {
  const summaryText = summarizeRoom(room.polygon, room.openings, items, request);
  let problems: string[] = [];
  let best: { result: ReturnType<typeof solveLayout>; summary: string; cost: number } | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts += 1;
    const generated = await generate(layoutUserPrompt(summaryText, problems));
    inputTokens += generated.inputTokens;
    outputTokens += generated.outputTokens;
    const { placements, summary } = generated.intent;

    const strict = solveLayout(room, items, placements, { fallback: false });
    if (strict.failures.length === 0) {
      best = { result: strict, summary, cost: 0 };
      break;
    }
    const loose = solveLayout(room, items, placements, { fallback: true });
    const cost = loose.failures.length * 100 + loose.unmet.length;
    if (!best || cost < best.cost) best = { result: loose, summary, cost };
    problems = strict.failures.map((f) => f.message);
  }

  // maxAttempts >= 1 이면 best는 항상 있다
  const chosen = best ?? { result: solveLayout(room, items, []), summary: '', cost: 0 };
  return {
    placed: chosen.result.placed.map((p) => ({ ...p, reason: clip(oneLine(p.reason), 200) })),
    summary: clip(oneLine(chosen.summary), 300),
    failures: chosen.result.failures,
    unmet: chosen.result.unmet,
    attempts,
    inputTokens,
    outputTokens,
  };
}

/** AI 배치와 함께 저장해 두는 글: 전체 의도 한 줄 + 가구마다 이유 한 줄 */
export function composeAiSummary(summary: string, placed: Pick<SolvedItem, 'name' | 'reason'>[]): string {
  const lines = [summary, ...placed.filter((p) => p.reason !== '').map((p) => `- ${p.name}: ${p.reason}`)].filter((line) => line !== '');
  return clip(lines.join('\n'), AI_SUMMARY_MAX);
}

/** AI 배치의 이름: "AI 배치 10/7 04:30" (한국 시간) */
export function aiLayoutName(now: Date = new Date()): string {
  return `AI 배치 ${kstStamp(now)}`;
}
