import { z } from 'zod';

/**
 * Gemini에 넘기는 출력 스키마. `z.toJSONSchema(스키마)`를 `config.responseJsonSchema`에 넣고,
 * 응답은 같은 스키마로 다시 검증한다 (모델이 스키마를 어길 수 있다고 가정).
 */

/** 가구 배치 의도: LLM은 "어느 벽·구역에 무엇을 둘지"만 정하고 좌표는 솔버가 계산한다. */
export const LayoutIntent = z.object({
  placements: z.array(
    z.object({
      itemId: z.string(),
      zone: z.enum(['against_wall', 'corner', 'under_window', 'beside_item', 'center']),
      wallId: z.string().describe('W1..Wn, 해당 없으면 빈 문자열'),
      nearItemId: z.string().describe('beside_item일 때 기준 가구, 아니면 빈 문자열'),
      facing: z.enum(['into_room', 'toward_window', 'toward_wall', 'any']),
      priority: z.number().int().min(1).max(10),
      reason: z.string(),
    }),
  ),
  summary: z.string(),
});
export type LayoutIntent = z.infer<typeof LayoutIntent>;

/** 방 사진 분석 리포트 */
export const RoomReport = z.object({
  options: z.array(
    z.object({
      name: z.enum([
        '에어컨',
        '세탁기',
        '냉장고',
        '인덕션/가스레인지',
        '전자레인지',
        '붙박이장',
        '신발장',
        '책상',
        '침대',
        '옷장',
        'TV',
        '베란다',
      ]),
      status: z.enum(['present', 'absent', 'unknown']),
      evidence: z.string().describe('몇 번째 사진에서 무엇을 봤는지'),
    }),
  ),
  storage: z.object({ level: z.enum(['low', 'medium', 'high', 'unknown']), notes: z.string() }),
  naturalLight: z.object({ level: z.enum(['low', 'medium', 'high', 'unknown']), notes: z.string() }),
  issues: z.array(
    z.object({
      type: z.enum(['곰팡이', '얼룩', '균열', '파손', '기타']),
      photoIndex: z.number().int(),
      description: z.string(),
      confidence: z.enum(['low', 'medium', 'high']),
    }),
  ),
  summary: z.string().describe('한국어 3문장 이내'),
});
export type RoomReport = z.infer<typeof RoomReport>;
