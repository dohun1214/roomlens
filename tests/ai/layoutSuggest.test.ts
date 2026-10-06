import { describe, expect, it } from 'vitest';
import { aiLayoutName, AI_SUMMARY_MAX, composeAiSummary, suggestLayout, type GenerateIntent } from '@/lib/ai/layoutSuggest';
import { DAILY_AI_LIMIT, kstDayStart, kstStamp, remainingCalls } from '@/lib/ai/limits';
import { LAYOUT_SYSTEM_PROMPT, layoutUserPrompt } from '@/lib/ai/prompts';
import { LayoutIntent, LayoutSuggestInput } from '@/lib/ai/schemas';
import { checkLayout } from '@/lib/layout/check';
import type { SolverItem, SolverRoom } from '@/lib/layout/solver';

// 3.2 × 4.0 m 원룸. W1(북쪽)에 문, W3(남쪽)에 창문
const ROOM: SolverRoom = {
  polygon: [
    [-1.6, -2],
    [1.6, -2],
    [1.6, 2],
    [-1.6, 2],
  ],
  openings: [
    { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 },
    { type: 'window', wallIndex: 2, from: 0.8, to: 2.4, widthM: 1.6 },
  ],
};
const DESK: SolverItem = { id: 'f1', name: '책상', category: 'desk', w: 1.2, d: 0.6, h: 0.73, clearance: 0.7 };
const LONG: SolverItem = { id: 'f2', name: '긴 수납장', category: 'storage', w: 3.0, d: 0.5, h: 0.8, clearance: 0.6 };

type P = LayoutIntent['placements'][number];
const place = (itemId: string, zone: P['zone'], wallId = '', priority = 5): P => ({ itemId, zone, wallId, nearItemId: '', facing: 'into_room', priority, reason: `${itemId}의 이유` });

/** 미리 정해 둔 의도를 차례로 돌려주는 가짜 Gemini */
function scripted(intents: LayoutIntent[]): { generate: GenerateIntent; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    generate: async (prompt) => {
      prompts.push(prompt);
      const intent = intents[Math.min(i, intents.length - 1)];
      i += 1;
      return { intent, inputTokens: 100, outputTokens: 50 };
    },
  };
}

describe('하루 횟수', () => {
  it('한국 시간 0시부터 센다', () => {
    // 한국 10/7 04:30 = UTC 10/6 19:30 → 한국 10/7 00:00 = UTC 10/6 15:00
    expect(kstDayStart(new Date('2026-10-06T19:30:00Z')).toISOString()).toBe('2026-10-06T15:00:00.000Z');
    // 한국 10/7 23:59 = UTC 10/7 14:59 → 같은 날
    expect(kstDayStart(new Date('2026-10-07T14:59:59Z')).toISOString()).toBe('2026-10-06T15:00:00.000Z');
    // 한국 10/8 00:00 = UTC 10/7 15:00 → 다음 날
    expect(kstDayStart(new Date('2026-10-07T15:00:00Z')).toISOString()).toBe('2026-10-07T15:00:00.000Z');
  });

  it('남은 횟수는 0 아래로 내려가지 않는다', () => {
    expect(remainingCalls(0)).toBe(DAILY_AI_LIMIT);
    expect(remainingCalls(3)).toBe(DAILY_AI_LIMIT - 3);
    expect(remainingCalls(DAILY_AI_LIMIT + 5)).toBe(0);
  });

  it('AI 배치 이름에 한국 시간을 넣는다 (40자 이내)', () => {
    expect(kstStamp(new Date('2026-10-06T19:05:00Z'))).toBe('10/7 04:05');
    expect(aiLayoutName(new Date('2026-12-31T15:00:00Z'))).toBe('AI 배치 1/1 00:00');
    expect(aiLayoutName().length).toBeLessThanOrEqual(40);
  });
});

describe('프롬프트', () => {
  it('문제가 없으면 방 요약 그대로, 있으면 뒤에 붙인다', () => {
    expect(layoutUserPrompt('요약')).toBe('요약');
    expect(layoutUserPrompt('요약', ['책상: W3의 벽에 자리가 없음']).split('\n')).toEqual(['요약', '', '이전 시도의 문제 (이 가구들은 요청한 자리에 놓지 못했다):', '- 책상: W3의 벽에 자리가 없음']);
  });

  it('지시문에 구역의 뜻과 사용자 요청을 다루는 법이 들어 있다', () => {
    for (const word of ['against_wall', 'corner', 'under_window', 'beside_item', 'center', 'into_room', '사용자 요청']) {
      expect(LAYOUT_SYSTEM_PROMPT).toContain(word);
    }
  });
});

describe('요청 형식', () => {
  it('가구가 없거나 너무 많으면 거부한다', () => {
    expect(LayoutSuggestInput.safeParse({ items: [] }).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `f${i}`, furnitureRef: 'desk', kind: 'catalog' }));
    expect(LayoutSuggestInput.safeParse({ items: many }).success).toBe(false);
  });

  it('요청 글은 없어도 된다. 모르는 kind는 거부한다', () => {
    const ok = LayoutSuggestInput.safeParse({ items: [{ id: 'f1', furnitureRef: 'desk', kind: 'catalog' }] });
    expect(ok.success && ok.data.request).toBe('');
    expect(LayoutSuggestInput.safeParse({ items: [{ id: 'f1', furnitureRef: 'desk', kind: 'admin' }] }).success).toBe(false);
  });
});

describe('추천 흐름', () => {
  it('한 번에 다 놓이면 다시 묻지 않는다', async () => {
    const fake = scripted([{ placements: [place('f1', 'under_window', 'W3')], summary: '책상을 창가에 둡니다.' }]);
    const result = await suggestLayout(ROOM, [DESK], '책상은 창가에', fake.generate);
    expect(result.attempts).toBe(1);
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]).toContain('사용자 요청: 책상은 창가에');
    expect(result.placed.map((p) => p.id)).toEqual(['f1']);
    expect(result.placed[0].reason).toBe('f1의 이유');
    expect(result.summary).toBe('책상을 창가에 둡니다.');
    expect(result.failures).toEqual([]);
    expect(result.unmet).toEqual([]);
    expect([result.inputTokens, result.outputTokens]).toEqual([100, 50]);
  });

  it('요청한 자리에 못 놓으면 그 이유를 붙여 다시 묻고, 고친 계획을 쓴다', async () => {
    const bad: LayoutIntent = { placements: [place('f2', 'against_wall', 'W3', 1), place('f1', 'against_wall', 'W3', 2)], summary: '첫 계획' };
    const good: LayoutIntent = { placements: [place('f2', 'against_wall', 'W3', 1), place('f1', 'against_wall', 'W2', 2)], summary: '고친 계획' };
    const fake = scripted([bad, good]);
    const result = await suggestLayout(ROOM, [DESK, LONG], '', fake.generate);
    expect(result.attempts).toBe(2);
    expect(fake.prompts[1]).toContain('이전 시도의 문제');
    expect(fake.prompts[1]).toContain('- 책상: W3의 벽에 자리가 없음 (긴 수납장와(과) 겹침)');
    expect(result.summary).toBe('고친 계획');
    expect(result.placed).toHaveLength(2);
    expect(result.failures).toEqual([]);
    expect(result.unmet).toEqual([]);
    expect([result.inputTokens, result.outputTokens]).toEqual([200, 100]);
  });

  it('끝까지 못 고치면 세 번만 묻고, 다른 자리에라도 놓은 결과를 돌려준다', async () => {
    const bad: LayoutIntent = { placements: [place('f2', 'against_wall', 'W3', 1), place('f1', 'against_wall', 'W3', 2)], summary: '같은 계획' };
    const fake = scripted([bad]);
    const result = await suggestLayout(ROOM, [DESK, LONG], '', fake.generate);
    expect(result.attempts).toBe(3);
    expect(result.placed).toHaveLength(2);
    expect(result.failures).toEqual([]);
    expect(result.unmet.map((n) => n.itemId)).toEqual(['f1']);
    expect(checkLayout(result.placed, ROOM.polygon, ROOM.openings).filter((v) => v.severity === 'error')).toEqual([]);
  });

  it('Gemini가 없는 가구를 말하거나 가구를 빠뜨려도 주어진 가구만, 모두 놓는다', async () => {
    const fake = scripted([{ placements: [place('ghost', 'center'), place('f1', 'against_wall', 'W2')], summary: '' }]);
    const result = await suggestLayout(ROOM, [DESK, LONG], '', fake.generate);
    expect(result.placed.map((p) => p.id).sort()).toEqual(['f1', 'f2']);
  });

  it('이유와 요약이 길거나 여러 줄이면 한 줄로 줄인다', async () => {
    const long = `${'가'.repeat(500)}\n둘째 줄`;
    const fake = scripted([{ placements: [{ ...place('f1', 'against_wall', 'W2'), reason: long }], summary: long }]);
    const result = await suggestLayout(ROOM, [DESK], '', fake.generate);
    expect(result.placed[0].reason.length).toBeLessThanOrEqual(200);
    expect(result.summary.length).toBeLessThanOrEqual(300);
    expect(result.summary).not.toContain('\n');
  });

  it('Gemini 호출이 실패하면 그 오류를 그대로 던진다', async () => {
    const failing: GenerateIntent = async () => {
      throw new Error('upstream');
    };
    await expect(suggestLayout(ROOM, [DESK], '', failing)).rejects.toThrow('upstream');
  });
});

describe('AI 배치에 저장하는 글', () => {
  it('전체 의도 한 줄 + 가구마다 이유 한 줄', () => {
    expect(composeAiSummary('창가에 책상을 둡니다.', [{ name: '책상', reason: '햇빛이 잘 듭니다.' }, { name: '옷장', reason: '' }])).toBe('창가에 책상을 둡니다.\n- 책상: 햇빛이 잘 듭니다.');
  });

  it('너무 길면 자른다', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `가구${i}`, reason: '나'.repeat(100) }));
    expect(composeAiSummary('요약', many).length).toBeLessThanOrEqual(AI_SUMMARY_MAX);
  });
});
