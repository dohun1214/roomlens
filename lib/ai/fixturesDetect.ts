// 원래 가구 찾기: 방을 바로 위에서 내려다본 그림(천장은 잘라 낸다)에서 Gemini가 찾은 상자(box_2d)를
// 방 좌표의 사각형으로 바꾼다. 그림은 방의 첫 번째 벽과 나란하게 찍으므로 상자가 곧 벽과 나란한 사각형이다.
// 넓은 방은 겹치게 여러 칸으로 나눠 찍고, 칸 경계에서 두 번 찾은 가구는 하나로 합친다.
// 결과는 "후보"다. 사용자가 3D에서 확인하고 틀린 것은 지운 뒤 저장한다. 네트워크·DB를 건드리지 않는다.
import { z } from 'zod';
import { pointInPolygon, type Point2 } from '@/lib/three/floorDrag';
import {
  FIXTURE_LABELS,
  fixtureAxes,
  fixtureRotation,
  LABEL_HEIGHTS,
  MAX_FIXTURE_HEIGHT,
  MAX_FIXTURE_SIZE,
  MAX_FIXTURES,
  MIN_FIXTURE_SIZE,
  nextFixtureId,
  type Fixture,
  type FixtureLabel,
} from '@/lib/rooms/fixtures';
import { MAX_IMAGE_BASE64 } from './analysis';

/** 그림 한 장(정사각형)의 크기 (px) */
export const TOP_VIEW_PX = 1280;
/** 카메라를 바닥에서 이만큼 위에 둔다 (m). 멀수록 원근이 줄어 높은 가구도 제자리에 보인다 */
export const TOP_VIEW_HEIGHT = 100;
/** 바닥에서 이 높이 위는 잘라 낸다 (천장·조명) (m) */
export const TOP_VIEW_CUT = 1.9;
/** 한 칸이 덮는 최대 길이 (m). 1280px에 약 7mm/px */
export const TILE_METERS = 9;
/** 이웃한 칸이 겹치는 길이 (m) */
export const TILE_OVERLAP = 0.8;
/**
 * 긴 변이 이 길이까지인 방은 칸을 조금 키워 한 칸에 담는다 (m). 1280px에 약 9mm/px.
 * TILE_METERS를 조금 넘는 방을 두 칸으로 나누면 두 그림이 거의 같아져 Gemini가 같은 상자를 두 번 돌려주고,
 * 칸이 조금만 어긋나 있어 같은 가구가 두 개로 잡힌다.
 */
export const SINGLE_TILE_MAX = 11;
/** 한 번에 보내는 그림 수 */
export const MAX_TILES = 4;
/** 방 둘레에 더 넣는 여백 (m) */
const MARGIN = 0.15;
/** 상자가 그림 가장자리에서 이 비율 안이면 가장자리에서 잘린 것으로 본다 */
const EDGE = 0.015;

/** 위에서 찍을 칸 하나: 가운데(방 좌표), 한 변의 길이(m, 정사각형), 그림의 가로 방향(회전) */
export type TopTile = { center: Point2; size: number; rotationDeg: number };

export const DetectFixturesInput = z.object({
  images: z
    .array(
      z.object({
        data: z.string().min(100, '그림이 비어 있습니다.').max(MAX_IMAGE_BASE64, '그림이 너무 큽니다.'),
      }),
    )
    .min(1, '그림이 없습니다.')
    .max(MAX_TILES, `그림은 ${MAX_TILES}장까지 보낼 수 있습니다.`),
  /** "AI로 방 준비하기": 바로 앞의 문·창문 찾기 호출. 같은 1회로 센다 */
  bundleOf: z.uuid().optional(),
});
export type DetectFixturesInput = z.infer<typeof DetectFixturesInput>;

/** Gemini가 돌려주는 것: 그림마다 찾은 가구의 상자 */
export const DetectedFixtures = z.object({
  fixtures: z.array(
    z.object({
      imageIndex: z.number().int().describe('그림 번호 (1부터)'),
      label: z.enum(FIXTURE_LABELS),
      box_2d: z.array(z.number()).length(4).describe('[ymin, xmin, ymax, xmax], 0~1000'),
      confidence: z.enum(['low', 'high']),
    }),
  ),
});
export type FixtureDetection = z.infer<typeof DetectedFixtures>['fixtures'][number];

const round2 = (v: number) => Math.round(v * 100) / 100 + 0;
const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0;
const dot = (p: Point2, u: Point2) => p[0] * u[0] + p[1] * u[1];

/** 그림의 가로(오른쪽)·세로(아래쪽) 방향 = 원래 가구의 가로·깊이 방향 */
export function tileAxes(rotationDeg: number): { right: Point2; down: Point2 } {
  const [right, down] = fixtureAxes(rotationDeg);
  return { right, down };
}

/** 방 전체를 덮는 칸들. 긴 변이 SINGLE_TILE_MAX까지면 한 칸, 더 크면 겹치게 나눈다 (최대 MAX_TILES칸) */
export function topViewPlan(polygon: Point2[]): TopTile[] {
  if (polygon.length < 3) return [];
  const rotationDeg = fixtureRotation(polygon);
  const { right, down } = tileAxes(rotationDeg);
  const as = polygon.map((p) => dot(p, right));
  const bs = polygon.map((p) => dot(p, down));
  const [a0, a1] = [Math.min(...as) - MARGIN, Math.max(...as) + MARGIN];
  const [b0, b1] = [Math.min(...bs) - MARGIN, Math.max(...bs) + MARGIN];
  const spanA = a1 - a0;
  const spanB = b1 - b0;
  const count = (span: number, size: number) => (span <= size ? 1 : Math.ceil((span - TILE_OVERLAP) / (size - TILE_OVERLAP)));
  const longest = Math.max(spanA, spanB);
  if (longest <= SINGLE_TILE_MAX) {
    return [{ center: [round3(right[0] * (a0 + spanA / 2) + down[0] * (b0 + spanB / 2)), round3(right[1] * (a0 + spanA / 2) + down[1] * (b0 + spanB / 2))], size: round3(longest), rotationDeg }];
  }
  let size = Math.min(TILE_METERS, longest);
  while (count(spanA, size) * count(spanB, size) > MAX_TILES) size += 0.5;
  const [na, nb] = [count(spanA, size), count(spanB, size)];
  const centers = (lo: number, span: number, n: number) => (n === 1 ? [lo + span / 2] : Array.from({ length: n }, (_, i) => lo + size / 2 + ((span - size) * i) / (n - 1)));
  const tiles: TopTile[] = [];
  for (const cb of centers(b0, spanB, nb)) {
    for (const ca of centers(a0, spanA, na)) {
      tiles.push({
        center: [round3(right[0] * ca + down[0] * cb), round3(right[1] * ca + down[1] * cb)],
        size: round3(size),
        rotationDeg,
      });
    }
  }
  return tiles;
}

/** 방 전체를 한 장에 담는 칸 (방 분석에서 가구 배치를 한눈에 보여 줄 때). 방이 크면 가구가 작게 보인다 */
export function wholeRoomTile(polygon: Point2[]): TopTile | null {
  if (polygon.length < 3) return null;
  const rotationDeg = fixtureRotation(polygon);
  const { right, down } = tileAxes(rotationDeg);
  const as = polygon.map((p) => dot(p, right));
  const bs = polygon.map((p) => dot(p, down));
  const [a0, a1] = [Math.min(...as) - MARGIN, Math.max(...as) + MARGIN];
  const [b0, b1] = [Math.min(...bs) - MARGIN, Math.max(...bs) + MARGIN];
  const [ca, cb] = [(a0 + a1) / 2, (b0 + b1) / 2];
  return { center: [round3(right[0] * ca + down[0] * cb), round3(right[1] * ca + down[1] * cb)], size: round3(Math.max(a1 - a0, b1 - b0)), rotationDeg };
}

/** 그림 축(가로 a, 세로 b) 위의 사각형 */
type Rect = { a0: number; a1: number; b0: number; b1: number };
type Found = Rect & {
  label: FixtureLabel;
  high: boolean;
  tiles: Set<number>;
  cut: boolean;
};

const area = (r: Rect) => (r.a1 - r.a0) * (r.b1 - r.b0);
function overlap(r: Rect, s: Rect): number {
  const w = Math.min(r.a1, s.a1) - Math.max(r.a0, s.a0);
  const d = Math.min(r.b1, s.b1) - Math.max(r.b0, s.b0);
  return w > 0 && d > 0 ? w * d : 0;
}
function iou(r: Rect, s: Rect): number {
  const inter = overlap(r, s);
  return inter > 0 ? inter / (area(r) + area(s) - inter) : 0;
}

/** 원래 가구가 그림 축 위에서 차지하는 범위 (회전이 달라도 네 모서리를 감싸는 사각형) */
function fixtureRect(f: Pick<Fixture, 'x' | 'z' | 'w' | 'd' | 'rotationDeg'>, rotationDeg: number): Rect {
  const [fx, fz] = fixtureAxes(f.rotationDeg);
  const { right, down } = tileAxes(rotationDeg);
  const corners: Point2[] = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ].map(([s, t]) => [f.x + (fx[0] * s * f.w) / 2 + (fz[0] * t * f.d) / 2, f.z + (fx[1] * s * f.w) / 2 + (fz[1] * t * f.d) / 2]);
  const as = corners.map((p) => dot(p, right));
  const bs = corners.map((p) => dot(p, down));
  return {
    a0: Math.min(...as),
    a1: Math.max(...as),
    b0: Math.min(...bs),
    b1: Math.max(...bs),
  };
}

/**
 * Gemini가 찾은 상자들을 원래 가구 후보로 바꾼다. 높이는 이름별로 흔한 값(나중에 스플랫에서 다시 잰다).
 * 방 밖, 너무 작거나 큰 것은 버리고, 이웃한 칸에서 두 번 찾은 것은 하나로 합친다. 방의 범위를 넘는 부분은 자른다.
 */
export function locateFixtures(detections: FixtureDetection[], tiles: TopTile[], polygon: Point2[]): Fixture[] {
  if (tiles.length === 0 || polygon.length < 3) return [];
  const rotationDeg = tiles[0].rotationDeg;
  const { right, down } = tileAxes(rotationDeg);
  const found: Found[] = [];
  for (const d of detections) {
    const tile = tiles[d.imageIndex - 1];
    if (!tile) continue;
    const [ymin, xmin, ymax, xmax] = d.box_2d.map((v) => Math.min(1, Math.max(0, v / 1000)));
    if (!(xmax > xmin) || !(ymax > ymin)) continue;
    const ca = dot(tile.center, right);
    const cb = dot(tile.center, down);
    const cut = xmin < EDGE || ymin < EDGE || xmax > 1 - EDGE || ymax > 1 - EDGE;
    const rect: Found = {
      a0: ca + (xmin - 0.5) * tile.size,
      a1: ca + (xmax - 0.5) * tile.size,
      b0: cb + (ymin - 0.5) * tile.size,
      b1: cb + (ymax - 0.5) * tile.size,
      label: d.label,
      high: d.confidence === 'high',
      tiles: new Set([d.imageIndex]),
      cut: cut && tiles.length > 1,
    };
    // 다른 칸에서 이미 찾은 같은 가구: 많이 겹치거나, 한쪽이 그림 가장자리에서 잘려 다른 쪽에 거의 들어가면 합친다
    const same = found.find((f) => {
      if (f.tiles.has(d.imageIndex)) return false;
      const inter = overlap(f, rect);
      const smaller = area(f) < area(rect) ? f : rect;
      return iou(f, rect) >= 0.4 || (smaller.cut && inter >= 0.8 * area(smaller));
    });
    if (!same) {
      found.push(rect);
      continue;
    }
    if (area(rect) > area(same)) same.label = rect.label;
    same.a0 = Math.min(same.a0, rect.a0);
    same.a1 = Math.max(same.a1, rect.a1);
    same.b0 = Math.min(same.b0, rect.b0);
    same.b1 = Math.max(same.b1, rect.b1);
    same.high ||= rect.high;
    same.cut &&= rect.cut;
    same.tiles.add(d.imageIndex);
  }

  const out: Fixture[] = [];
  // 확실한 것, 큰 것부터
  found.sort((p, q) => Number(q.high) - Number(p.high) || area(q) - area(p));
  // 벽 밖으로 나간 부분(벽에 붙은 가구를 조금 크게 감싼 것)은 방의 범위까지 자른다
  const as = polygon.map((p) => dot(p, right));
  const bs = polygon.map((p) => dot(p, down));
  const [minA, maxA, minB, maxB] = [Math.min(...as), Math.max(...as), Math.min(...bs), Math.max(...bs)];
  for (const f of found) {
    f.a0 = Math.max(f.a0, minA);
    f.a1 = Math.min(f.a1, maxA);
    f.b0 = Math.max(f.b0, minB);
    f.b1 = Math.min(f.b1, maxB);
    const w = round2(f.a1 - f.a0);
    const d = round2(f.b1 - f.b0);
    if (w < MIN_FIXTURE_SIZE || d < MIN_FIXTURE_SIZE || w > MAX_FIXTURE_SIZE || d > MAX_FIXTURE_SIZE) continue;
    const ca = (f.a0 + f.a1) / 2;
    const cb = (f.b0 + f.b1) / 2;
    const center: Point2 = [round3(right[0] * ca + down[0] * cb), round3(right[1] * ca + down[1] * cb)];
    if (!pointInPolygon(center, polygon)) continue;
    out.push({
      id: nextFixtureId(out),
      label: f.label,
      x: center[0],
      z: center[1],
      w,
      d,
      rotationDeg,
      h: LABEL_HEIGHTS[f.label],
      remove: false,
    });
    if (out.length >= MAX_FIXTURES) break;
  }
  return out;
}

/**
 * 후보를 지금 목록에 더한다. 이미 있는 원래 가구와 많이 겹치는 후보는 넣지 않고, id는 새로 붙인다.
 * @returns 더한 목록과 실제로 넣은 후보(새 id), 겹쳐서 뺀 수
 */
export function addCandidates(existing: Fixture[], candidates: Fixture[]): { fixtures: Fixture[]; added: Fixture[]; skipped: number } {
  const fixtures = [...existing];
  const added: Fixture[] = [];
  let skipped = 0;
  for (const c of candidates) {
    if (fixtures.length >= MAX_FIXTURES) {
      skipped += 1;
      continue;
    }
    const rect = fixtureRect(c, c.rotationDeg);
    const clash = existing.some((f) => {
      const other = fixtureRect(f, c.rotationDeg);
      const inter = overlap(rect, other);
      return iou(rect, other) >= 0.3 || inter >= 0.7 * Math.min(area(rect), area(other));
    });
    if (clash) {
      skipped += 1;
      continue;
    }
    const fixture = { ...c, id: nextFixtureId(fixtures) };
    fixtures.push(fixture);
    added.push(fixture);
  }
  return { fixtures, added, skipped };
}

/** 원래 가구 자리 안에서 높이를 잴 때 가장자리를 이만큼 덜어 낸다 (벽·이웃 가구의 스플랫을 피해서) */
export const HEIGHT_INSET = 0.15;
const HEIGHT_BIN = 0.05;
/** 이 높이 아래는 바닥으로 본다 (m) */
const FLOOR_SKIP = 0.08;
/** 높이 방향으로 이만큼 비면 다른 덩어리로 본다 (식탁 밑의 빈 곳, 그 위에 매달린 조명) */
const HEIGHT_GAP = 0.3;
/** 가구 본체로 보는 덩어리: 전체 표본의 이 비율 이상 */
const MAIN_SHARE = 0.2;
const MIN_SAMPLES = 20;

/**
 * 가구 자리 위의 스플랫 높이들로 가구의 높이를 잰다. 높이를 30cm 넘게 빈 곳으로 나눈 덩어리 가운데
 * 표본이 충분한(20% 이상) 가장 낮은 덩어리의 꼭대기: 식탁 밑의 바닥 부스러기나 위에 매달린 조명은 보지 않는다.
 * 표본이 너무 적으면 null.
 */
/**
 * 윗면 높이를 재는 이름: 위에 스탠드·TV·화분을 올려 두는 가구. 빽빽한 윗면을 높이로 보고 그 위의 듬성한 물건은 뺀다
 * (의자 등받이·침대 머리판은 듬성해도 가구의 일부라 이 목록에 넣지 않는다)
 */
export const SURFACE_LABELS: ReadonlySet<string> = new Set(['테이블', '수납장', 'TV장', '책상', '식탁']);
/** 윗면으로 보는 층: 덩어리 안에서 가장 빽빽한 칸의 이 비율 이상 */
const SURFACE_SHARE = 0.35;

export function topHeight(heights: ArrayLike<number>, surface = false): number | null {
  const bins = Math.ceil(MAX_FIXTURE_HEIGHT / HEIGHT_BIN);
  const counts = new Array<number>(bins).fill(0);
  let total = 0;
  for (let i = 0; i < heights.length; i += 1) {
    const h = heights[i];
    if (!(h >= FLOOR_SKIP) || h >= MAX_FIXTURE_HEIGHT) continue;
    counts[Math.floor(h / HEIGHT_BIN)] += 1;
    total += 1;
  }
  if (total < MIN_SAMPLES) return null;
  const enough = Math.max(3, total * 0.01);
  // 덩어리 나누기: [첫 칸, 마지막 칸, 표본 수]
  const clusters: [number, number, number][] = [];
  let empty = Infinity;
  for (let i = 0; i < bins; i += 1) {
    if (counts[i] < enough) {
      empty += 1;
      continue;
    }
    const last = clusters[clusters.length - 1];
    if (last && empty * HEIGHT_BIN < HEIGHT_GAP) {
      last[1] = i;
      last[2] += counts[i];
    } else clusters.push([i, i, counts[i]]);
    empty = 0;
  }
  const main = clusters.find((c) => c[2] >= total * MAIN_SHARE) ?? clusters.reduce<[number, number, number] | undefined>((best, c) => (!best || c[2] > best[2] ? c : best), undefined);
  if (!main) return null;
  let top = main[1];
  if (surface) {
    // 덩어리 안에서 빽빽한(윗면) 칸 가운데 가장 높은 칸. 위에 올려 둔 물건은 칸마다 표본이 적다
    let densest = 0;
    for (let i = main[0]; i <= main[1]; i += 1) densest = Math.max(densest, counts[i]);
    for (let i = main[1]; i >= main[0]; i -= 1) {
      if (counts[i] >= densest * SURFACE_SHARE) {
        top = i;
        break;
      }
    }
  }
  // 꼭대기 층 안에서 위쪽 끝(상위 10%)을 높이로 본다
  const ceiling = (top + 1) * HEIGHT_BIN;
  const inTop: number[] = [];
  for (let i = 0; i < heights.length; i += 1) if (heights[i] >= top * HEIGHT_BIN && heights[i] < ceiling) inTop.push(heights[i]);
  inTop.sort((p, q) => p - q);
  const value = inTop[Math.min(inTop.length - 1, Math.floor(inTop.length * 0.9))] ?? ceiling;
  return round2(Math.min(MAX_FIXTURE_HEIGHT, Math.max(0.05, value)));
}
