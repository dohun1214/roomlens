// 문·창문 찾기 (벽 정면 방식): 벽마다 방 안쪽에서 벽을 정면으로 본 그림을 찍는다. 카메라를 아주 멀리 두고 시야를 좁혀
// 원근을 거의 없애고, near 평면으로 벽 앞 35cm보다 가까운 것(가구)은 잘라 내고 far 평면으로 벽 뒤 2m까지만 남긴다.
// 그래서 그림에는 벽면과 벽에 난 문·창문(뚫린 곳 너머로 옆방·바깥이 조금 보인다)만 남고, 그림의 가로 위치가 곧 벽 위의 위치다.
// Gemini가 그림마다 문·창문 상자를 돌려주면 벽 번호·시작·끝으로 바꾼다. 네트워크·DB를 건드리지 않는다.
import { z } from 'zod';
import { makeOpening, overlapsExisting, wallsOf, type Opening, type OpeningType } from '@/lib/rooms/openings';
import { signedArea, type Point2 } from '@/lib/three/floorDrag';
import { MAX_IMAGE_BASE64 } from './analysis';

/** 그림 한 장(정사각형)의 크기 (px) */
export const WALL_VIEW_PX = 1024;
/** 카메라를 벽에서 이만큼 떨어뜨린다 (m) */
export const WALL_VIEW_DISTANCE = 60;
/** 벽 앞에서 남길 두께 (m). 이보다 앞의 가구는 잘라 낸다 */
export const WALL_VIEW_FRONT = 0.35;
/** 벽 뒤로 보이게 둘 깊이 (m) */
export const WALL_VIEW_BEHIND = 2;
/** 한 장이 덮는 벽 길이 (m). 긴 벽은 겹치게 나눈다 */
export const WALL_TILE = 5.5;
const WALL_TILE_OVERLAP = 0.8;
/** 이보다 짧은 벽은 찍지 않는다 (m) */
const MIN_WALL_LENGTH = 0.6;
/** 한 번에 보내는 그림 수 */
export const MAX_WALL_VIEWS = 16;
/** 그림에 담는 높이의 위·아래 여유 (m) */
const MARGIN = 0.08;

export type WallView = {
  /** 이 그림이 보는 곧은 벽(한 줄로 이어진 벽 조각들)의 첫 벽 번호 */
  wallIndex: number;
  /** 곧은 벽의 시작 꼭짓점에서 잰, 그림 가운데의 위치 (m) */
  along: number;
  /** 그림 가운데의 높이 (m) */
  centerY: number;
  /** 그림 한 변이 덮는 길이 (m) */
  size: number;
  /** 카메라 (방 좌표) */
  position: [number, number, number];
  target: [number, number, number];
  /** 그림의 오른쪽이 벽 방향(시작→끝)과 같은지 */
  rightIsForward: boolean;
};

/**
 * 벽 정면 그림을 찍을 자리. 벽마다 한 장(긴 벽은 여러 장), 긴 벽부터 MAX_WALL_VIEWS장까지.
 * @param ceiling 천장 높이 (m). 그림의 위쪽 끝
 */
export function wallViewPlan(polygon: Point2[], ceiling: number): WallView[] {
  if (polygon.length < 3) return [];
  const ccw = signedArea(polygon) > 0;
  const top = Math.min(Math.max(ceiling, 2.2), 3.4);
  const height = top + 2 * MARGIN;
  const centerY = top / 2;
  const views: (WallView & { length: number })[] = [];
  for (const wall of straightWalls(polygon)) {
    if (wall.length < MIN_WALL_LENGTH) continue;
    const u: Point2 = [(wall.b[0] - wall.a[0]) / wall.length, (wall.b[1] - wall.a[1]) / wall.length];
    // 방 안쪽 법선: 꼭짓점이 도는 방향에 따라 왼쪽 또는 오른쪽
    const inward: Point2 = ccw ? [-u[1], u[0]] : [u[1], -u[0]];
    const count = wall.length <= WALL_TILE ? 1 : Math.ceil((wall.length - WALL_TILE_OVERLAP) / (WALL_TILE - WALL_TILE_OVERLAP));
    const tile = count === 1 ? wall.length : WALL_TILE;
    for (let k = 0; k < count; k += 1) {
      const along = count === 1 ? wall.length / 2 : tile / 2 + ((wall.length - tile) * k) / (count - 1);
      const size = Math.max(tile + 0.3, height);
      const p: Point2 = [wall.a[0] + u[0] * along, wall.a[1] + u[1] * along];
      const position: [number, number, number] = [p[0] + inward[0] * WALL_VIEW_DISTANCE, centerY, p[1] + inward[1] * WALL_VIEW_DISTANCE];
      // 카메라는 -inward 를 본다. 화면 오른쪽 = 보는 방향 × 위쪽 = (-inward) × (0,1,0) → [inward.z, 0, -inward.x]
      const right: Point2 = [inward[1], -inward[0]];
      views.push({
        wallIndex: wall.index,
        along: round3(along),
        centerY: round3(centerY),
        size: round3(size),
        position: [round3(position[0]), round3(position[1]), round3(position[2])],
        target: [round3(p[0]), round3(centerY), round3(p[1])],
        rightIsForward: right[0] * u[0] + right[1] * u[1] > 0,
        length: wall.length,
      });
    }
  }
  return views
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_WALL_VIEWS)
    .sort((a, b) => a.wallIndex - b.wallIndex || a.along - b.along)
    .map((v) => ({ wallIndex: v.wallIndex, along: v.along, centerY: v.centerY, size: v.size, position: v.position, target: v.target, rightIsForward: v.rightIsForward }));
}

const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0;

/** 한 줄로 이어진 벽 조각 사이의 방향 차이 허용 (sin) */
const STRAIGHT_SIN = 0.035;

export type StraightWall = {
  /** 첫 벽 번호 */
  index: number;
  a: Point2;
  b: Point2;
  length: number;
  /** 이 곧은 벽을 이루는 벽들과 각 벽이 시작하는 위치 (m) */
  parts: { index: number; start: number; length: number }[];
};

/**
 * 같은 방향으로 이어진 벽 조각(문·창문 끝에서 나뉜 꼭짓점 등)을 하나의 곧은 벽으로 묶는다.
 * 그렇지 않으면 창문이 이웃 조각의 그림에 걸쳐 보여 같은 창문을 두 번 찾는다.
 */
export function straightWalls(polygon: Point2[]): StraightWall[] {
  const walls = wallsOf(polygon).filter((w) => w.length > 1e-6);
  const n = walls.length;
  if (n < 3) return [];
  const dir = (w: (typeof walls)[number]): Point2 => [(w.b[0] - w.a[0]) / w.length, (w.b[1] - w.a[1]) / w.length];
  const straight = (w0: (typeof walls)[number], w1: (typeof walls)[number]) => {
    const [u, v] = [dir(w0), dir(w1)];
    return Math.abs(u[0] * v[1] - u[1] * v[0]) < STRAIGHT_SIN && u[0] * v[0] + u[1] * v[1] > 0;
  };
  // 앞 벽과 이어지지 않는 벽에서 시작한다 (모두 이어지면 0번부터)
  let first = walls.findIndex((w, k) => !straight(walls[(k + n - 1) % n], w));
  if (first < 0) first = 0;
  const out: StraightWall[] = [];
  for (let k = 0; k < n; k += 1) {
    const w = walls[(first + k) % n];
    const last = out.at(-1);
    if (last && k > 0 && straight(walls[(first + k - 1) % n], w)) {
      last.parts.push({ index: w.index, start: last.length, length: w.length });
      last.b = w.b;
      last.length += w.length;
      continue;
    }
    out.push({ index: w.index, a: w.a, b: w.b, length: w.length, parts: [{ index: w.index, start: 0, length: w.length }] });
  }
  return out.sort((x, y) => x.index - y.index);
}

export const WallDetectInput = z.object({
  method: z.literal('walls'),
  images: z
    .array(z.object({ data: z.string().min(100, '그림이 비어 있습니다.').max(MAX_IMAGE_BASE64, '그림이 너무 큽니다.') }))
    .min(1, '그림이 없습니다.')
    .max(MAX_WALL_VIEWS, `그림은 ${MAX_WALL_VIEWS}장까지 보낼 수 있습니다.`),
  /** 그림을 찍을 때 쓴 천장 높이 (m). 서버가 같은 자리를 다시 계산한다 */
  ceiling: z.number().min(1.5).max(6),
});
export type WallDetectInput = z.infer<typeof WallDetectInput>;

/** Gemini가 돌려주는 것 */
export const DetectedWallOpenings = z.object({
  openings: z.array(
    z.object({
      imageIndex: z.number().int().describe('그림 번호 (1부터)'),
      type: z.enum(['door', 'window']),
      box_2d: z.array(z.number()).length(4).describe('[ymin, xmin, ymax, xmax], 0~1000'),
      confidence: z.enum(['low', 'high']),
    }),
  ),
});
export type WallDetection = z.infer<typeof DetectedWallOpenings>['openings'][number];

type Found = { type: OpeningType; wallIndex: number; from: number; to: number; bottom: number; top: number; votes: number; high: boolean };

/**
 * Gemini의 상자들을 문·창문 후보로 바꾼다. 같은 벽의 이웃한 그림에서 두 번 찾은 것은 합친다.
 * 너무 좁거나 낮은 것은 버리고, 바닥에서 시작하는 큰 창문은 문으로 보지 않는다(Gemini의 판단을 따른다).
 */
export function locateWallDetections(detections: WallDetection[], views: WallView[], polygon: Point2[]): Opening[] {
  const walls = new Map(straightWalls(polygon).map((w) => [w.index, w]));
  const found: Found[] = [];
  for (const d of detections) {
    const view = views[d.imageIndex - 1];
    if (!view) continue;
    const wall = walls.get(view.wallIndex);
    if (!wall) continue;
    const [ymin, xmin, ymax, xmax] = d.box_2d.map((v) => Math.min(1, Math.max(0, v / 1000)));
    if (!(xmax > xmin) || !(ymax > ymin)) continue;
    const sign = view.rightIsForward ? 1 : -1;
    const p0 = view.along + sign * (xmin - 0.5) * view.size;
    const p1 = view.along + sign * (xmax - 0.5) * view.size;
    const from = Math.max(0, Math.min(p0, p1));
    const to = Math.min(wall.length, Math.max(p0, p1));
    const bottom = view.centerY + (0.5 - ymax) * view.size;
    const top = view.centerY + (0.5 - ymin) * view.size;
    if (to - from < 0.25 || top - bottom < 0.3) continue;
    const item: Found = { type: d.type, wallIndex: view.wallIndex, from, to, bottom, top, votes: 1, high: d.confidence === 'high' };
    // 같은 벽에서 많이 겹치는 것(이웃한 그림)은 합친다
    const same = found.find((f) => f.wallIndex === item.wallIndex && overlapShare(f, item) >= 0.5);
    if (same) {
      same.from = Math.min(same.from, item.from);
      same.to = Math.max(same.to, item.to);
      same.bottom = Math.min(same.bottom, item.bottom);
      same.top = Math.max(same.top, item.top);
      same.votes += 1;
      same.high ||= item.high;
      continue;
    }
    found.push(item);
  }
  const out: Opening[] = [];
  // 확실한 것, 넓은 것부터 (겹치는 것은 먼저 넣은 쪽만)
  found.sort((a, b) => Number(b.high) - Number(a.high) || b.to - b.from - (a.to - a.from));
  for (const f of found) {
    // 곧은 벽 위의 구간 → 가장 많이 겹치는 벽 조각 위의 구간
    const wall = walls.get(f.wallIndex);
    if (!wall) continue;
    const part = wall.parts.reduce((best, p) => (overlapLength(p.start, p.start + p.length, f) > overlapLength(best.start, best.start + best.length, f) ? p : best));
    const from = Math.max(f.from, part.start) - part.start;
    const to = Math.min(f.to, part.start + part.length) - part.start;
    if (to - from < 0.25) continue;
    const made = makeOpening(f.type, part.index, round2(from), round2(to - from), polygon);
    if (!made.ok || overlapsExisting(made.opening, out)) continue;
    out.push(made.opening);
  }
  return out.sort((a, b) => a.wallIndex - b.wallIndex || a.from - b.from);
}

const round2 = (v: number) => Math.round(v * 100) / 100 + 0;
/** 두 구간이 겹치는 길이 ÷ 짧은 쪽 길이 */
function overlapShare(a: { from: number; to: number }, b: { from: number; to: number }): number {
  const inter = Math.min(a.to, b.to) - Math.max(a.from, b.from);
  if (inter <= 0) return 0;
  return inter / Math.min(a.to - a.from, b.to - b.from);
}
/** 구간 [from, to] 와 f가 겹치는 길이 */
function overlapLength(from: number, to: number, f: { from: number; to: number }): number {
  return Math.max(0, Math.min(to, f.to) - Math.max(from, f.from));
}
