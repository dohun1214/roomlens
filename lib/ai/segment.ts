import 'server-only';
import { z } from 'zod';
import { AiError, generateJson, type AiUsage } from './gemini';
import type { Box2d, SegmentBoxes } from '@/lib/rooms/fixtureSegment';

// 원래 가구 떼어 내기의 AI 분할: 고른 곳만 찍은 그림마다 떼어 낼 가구·그 위에 얹힌 물건·옆에 따로 선 물건의 상자를 받는다.
// 상자(box_2d)는 [ymin, xmin, ymax, xmax], 0~1000. (윤곽 다각형은 어긋나는 일이 많아 쓰지 않는다)

// 응답 스키마는 단순하게 둔다: tuple(prefixItems)이나 개수 제한(maxItems 등)을 넣으면
// Gemini가 400 INVALID_ARGUMENT로 거부한다 (11/04 확인). 개수는 받은 뒤 자른다
const Box = z.object({
  box_2d: z.array(z.number()),
  label: z.string(),
  role: z.string(),
});
/** 그림 한 장의 상자들 */
export const SegmentOutput = z.object({ boxes: z.array(Box) });
export type SegmentOutput = z.infer<typeof SegmentOutput>;
/** 여러 장을 한 번에 보낸 응답: 그림 순서대로 */
export const SegmentViewsOutput = z.object({ views: z.array(SegmentOutput) });
/** 그림 한 장에서 쓰는 상자 수 */
const MAX_BOXES = 16;

export const SEGMENT_SYSTEM = 'You detect objects in renders of 3D room scans. Answer only with the requested JSON. Box coordinates are [ymin, xmin, ymax, xmax] normalized to 0-1000.';

/**
 * 그림 여러 장(같은 곳을 여러 방향에서)에 보내는 지시. describe: describeFixture()의 가구 설명.
 * 시점마다 따로 물으면 같은 물건(발받침 등)을 어떤 그림에서는 가구 일부로, 어떤 그림에서는 따로 선 것으로 봐서
 * 반쪽만 빠진다 (11/04 시험) → 한 번에 보내 먼저 한 번 정하고 모든 그림에 똑같이 적게 한다.
 */
export function segmentPrompt(describe: string, count: number): string {
  return [
    `These ${count} images are renders of the same small region cut out of a 3D scan of a room, seen from ${count} different sides (image 1 to ${count}). The main object is a ${describe}.`,
    'First decide once which objects belong to that furniture, then label every image consistently with that decision.',
    `Output {"views": [...]} with exactly ${count} entries in image order. Each entry has "boxes": for every distinct visible object, "box_2d" as [ymin, xmin, ymax, xmax] normalized to 0-1000 in that image, a descriptive "label" (the same label for the same object in every image), and a "role":`,
    '- "target": the furniture itself (one box around all of it).',
    '- "on_top": something resting on it or attached to it that moves together with it (cushion, pillow, blanket, vase, plant, table lamp, books, tray, laptop).',
    '- "separate": something that only touches it or stands next to or behind it (side table, footstool, floor lamp, other furniture, wall, curtain, window frame).',
  ].join('\n');
}

/** 숫자 4개짜리 상자만 남기고 0~1000 안으로 */
export function toBox(values: number[]): Box2d | null {
  if (values.length !== 4 || !values.every(Number.isFinite)) return null;
  const c = values.map((v) => Math.min(1000, Math.max(0, v)));
  const box: Box2d = [Math.min(c[0], c[2]), Math.min(c[1], c[3]), Math.max(c[0], c[2]), Math.max(c[1], c[3])];
  return box[2] - box[0] > 1 && box[3] - box[1] > 1 ? box : null;
}

/** AI 상자들을 역할별로 나눈다 (알 수 없는 역할은 따로 선 물건으로) */
export function toSegmentBoxes(output: SegmentOutput): SegmentBoxes {
  const out: SegmentBoxes = { target: [], onTop: [], separate: [] };
  for (const b of output.boxes.slice(0, MAX_BOXES)) {
    const box = toBox(b.box_2d);
    if (!box) continue;
    const role = b.role.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (role === 'target') out.target.push(box);
    else if (role === 'on_top') out.onTop.push(box);
    else out.separate.push(box);
  }
  return out;
}

/** 그림 여러 장을 한 번에 보내 시점마다 상자를 받는다 (그림 수와 응답 수가 다르면 BAD_OUTPUT) */
export async function segmentFixture(describe: string, images: string[]): Promise<{ views: SegmentBoxes[] } & AiUsage> {
  const result = await generateJson(SegmentViewsOutput, {
    system: SEGMENT_SYSTEM,
    parts: [...images.flatMap((data, i) => [{ text: `Image ${i + 1}:` }, { inlineData: { mimeType: 'image/jpeg', data } }]), { text: segmentPrompt(describe, images.length) }],
    // gemini-3.8-flash는 thinking level minimal을 받지 않는다 (400). 가장 낮은 low로
    thinking: 'low',
    timeoutMs: 60_000,
  });
  if (result.data.views.length !== images.length) throw new AiError('BAD_OUTPUT', '그림 수와 응답 수가 다릅니다.');
  return { views: result.data.views.map(toSegmentBoxes), inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}
