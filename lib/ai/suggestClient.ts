// 브라우저에서 배치 추천 API를 부른다. 서버가 돌려준 값도 다시 검증해서 쓴다.
import { z } from 'zod';
import { fromLayoutRow, type MyLayout } from '@/lib/layout/store';
import type { SavedItem } from '@/lib/layout/saved';

const Note = z.object({ itemId: z.string(), message: z.string() });

const SuggestResponse = z.object({
  layout: z.object({ id: z.string(), name: z.string(), items: z.array(z.unknown()), aiSummary: z.string() }),
  removedLayoutIds: z.array(z.string()).default([]),
  summary: z.string(),
  reasons: z.array(z.object({ itemId: z.string(), name: z.string(), reason: z.string() })),
  failures: z.array(Note),
  unmet: z.array(Note),
  attempts: z.number(),
  remaining: z.number(),
});

/** 화면에 보여줄 추천 결과 */
export type AiResultView = {
  layoutId: string;
  summary: string;
  reasons: { itemId: string; name: string; reason: string }[];
  /** 놓지 못한 가구 */
  failures: { itemId: string; message: string }[];
  /** 놓았지만 지키지 못한 조건 */
  unmet: { itemId: string; message: string }[];
};

export type SuggestOutcome =
  | { ok: true; layout: MyLayout; removedLayoutIds: string[]; result: AiResultView; remaining: number }
  | { ok: false; code: string; message: string };

const FALLBACK = 'AI 추천을 받지 못했습니다. 잠시 뒤에 다시 해 주세요.';

/** 지금 놓인 가구와 요청 글로 추천을 받는다. 성공하면 새로 저장된 AI 배치가 온다 */
export async function requestLayoutSuggestion(roomId: string, items: SavedItem[], request: string): Promise<SuggestOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/rooms/${roomId}/layout-suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items.map(({ id, furnitureRef, kind }) => ({ id, furnitureRef, kind })), request }),
    });
  } catch {
    return { ok: false, code: 'NETWORK', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' };
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(json);
    return error.success ? { ok: false, ...error.data.error } : { ok: false, code: 'UNKNOWN', message: FALLBACK };
  }
  const parsed = SuggestResponse.safeParse(json);
  if (!parsed.success) return { ok: false, code: 'BAD_RESPONSE', message: FALLBACK };
  const { layout, removedLayoutIds, summary, reasons, failures, unmet, remaining } = parsed.data;
  return {
    ok: true,
    layout: fromLayoutRow({ id: layout.id, name: layout.name, items: layout.items, created_by: 'ai', ai_summary: layout.aiSummary }),
    removedLayoutIds,
    result: { layoutId: layout.id, summary, reasons, failures, unmet },
    remaining,
  };
}
