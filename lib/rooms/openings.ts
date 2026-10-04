// 방의 문·창문. rooms.openings = [{ type, wallIndex, from, to, widthM }]
//   wallIndex: 평면도(floor_polygon)의 i번째 꼭짓점 → i+1번째 꼭짓점을 잇는 벽
//   from, to : 그 벽의 시작 꼭짓점에서 잰 거리 (m)
// 방 주인이 브라우저에서 바로 저장하므로, 읽을 때 반드시 검증한다.
import { z } from 'zod';
import type { Point2 } from '@/lib/three/floorDrag';

/** DB의 rooms_openings_check 와 같은 값 */
export const MAX_OPENINGS = 20;
export const MIN_OPENING_WIDTH = 0.3;
/** 탭한 점이 벽에서 이보다 멀면 그 벽의 문·창문으로 보지 않는다 (m) */
export const MAX_TAP_DISTANCE = 0.5;

export const OPENING_TYPES = ['door', 'window'] as const;
export type OpeningType = (typeof OPENING_TYPES)[number];
export type Opening = { type: OpeningType; wallIndex: number; from: number; to: number; widthM: number };

export const OPENING_LABEL: Record<OpeningType, string> = { door: '문', window: '창문' };
export const DEFAULT_OPENING_WIDTH: Record<OpeningType, number> = { door: 0.9, window: 1.2 };
/** 3D에 그릴 때의 아래·위 높이 (m). 높이는 저장하지 않는다 */
export const OPENING_HEIGHTS: Record<OpeningType, [number, number]> = { door: [0, 2.0], window: [0.9, 2.0] };

export type Wall = { index: number; a: Point2; b: Point2; length: number };
export type OpeningResult = { ok: true; opening: Opening } | { ok: false; message: string };

const OpeningSchema = z.object({
  type: z.enum(OPENING_TYPES),
  wallIndex: z.number().int().min(0).max(63),
  from: z.number().min(0).max(1000),
  to: z.number().min(0).max(1000),
  widthM: z.number().min(0).max(1000),
});

const round2 = (v: number) => Math.round(v * 100) / 100 + 0;
const fail = (message: string): OpeningResult => ({ ok: false, message });

/** 평면도의 벽 목록. i번째 벽은 i번째 꼭짓점에서 다음 꼭짓점까지 */
export function wallsOf(polygon: Point2[]): Wall[] {
  if (polygon.length < 3) return [];
  return polygon.map((a, index) => {
    const b = polygon[(index + 1) % polygon.length];
    return { index, a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  });
}

/** 같은 벽에서 구간이 겹치는 문·창문이 이미 있는지 (1cm까지는 맞닿아도 된다) */
export function overlapsExisting(opening: Opening, others: Opening[]): boolean {
  return others.some((o) => o.wallIndex === opening.wallIndex && opening.from < o.to - 0.01 && o.from < opening.to - 0.01);
}

/**
 * 벽·시작 위치·폭으로 문·창문을 만든다. 값은 cm 단위로 맞춘다.
 * 벽을 벗어나거나 너무 좁으면 이유와 함께 실패한다.
 */
export function makeOpening(type: OpeningType, wallIndex: number, from: number, width: number, polygon: Point2[]): OpeningResult {
  const wall = wallsOf(polygon)[wallIndex];
  if (!wall || !Number.isInteger(wallIndex)) return fail('벽을 골라 주세요.');
  if (!Number.isFinite(from) || !Number.isFinite(width)) return fail('시작 위치와 폭을 숫자로 넣어 주세요.');
  if (from < 0) return fail('시작 위치는 0 이상이어야 합니다.');
  if (width < MIN_OPENING_WIDTH) return fail(`폭은 ${MIN_OPENING_WIDTH} m 이상이어야 합니다.`);
  const start = round2(from);
  // 벽 끝을 1cm 이내로 넘는 것은 반올림 차이로 보고 벽 끝에 맞춘다
  if (start + width > wall.length + 0.01) {
    return fail(`벽 ${wallIndex + 1}의 길이(${wall.length.toFixed(2)} m)를 넘습니다.`);
  }
  const end = Math.min(round2(start + width), Math.floor(wall.length * 100) / 100);
  if (end - start < MIN_OPENING_WIDTH - 1e-9) return fail(`폭은 ${MIN_OPENING_WIDTH} m 이상이어야 합니다.`);
  return { ok: true, opening: { type, wallIndex, from: start, to: end, widthM: round2(end - start) } };
}

/** 점에서 가장 가까운 벽 위의 위치: 시작 꼭짓점에서의 거리(along)와 벽까지의 거리 */
function projectToWall(p: Point2, wall: Wall): { along: number; distance: number } {
  if (wall.length < 1e-9) return { along: 0, distance: Math.hypot(p[0] - wall.a[0], p[1] - wall.a[1]) };
  const ux = (wall.b[0] - wall.a[0]) / wall.length;
  const uz = (wall.b[1] - wall.a[1]) / wall.length;
  const along = Math.min(wall.length, Math.max(0, (p[0] - wall.a[0]) * ux + (p[1] - wall.a[1]) * uz));
  return { along, distance: Math.hypot(p[0] - (wall.a[0] + ux * along), p[1] - (wall.a[1] + uz * along)) };
}

/**
 * 화면에서 찍은 두 점(문·창문의 양 끝, 방 좌표 [x, z])으로 문·창문을 만든다.
 * 두 점에 함께 가장 가까운 벽을 고르고, 그 벽 위로 내린 두 위치를 양 끝으로 쓴다.
 */
export function openingFromPoints(type: OpeningType, p1: Point2, p2: Point2, polygon: Point2[]): OpeningResult {
  const walls = wallsOf(polygon);
  if (walls.length === 0) return fail('먼저 방을 보정해 주세요.');
  let best: { wall: Wall; a: number; b: number; worst: number } | null = null;
  for (const wall of walls) {
    const q1 = projectToWall(p1, wall);
    const q2 = projectToWall(p2, wall);
    const worst = Math.max(q1.distance, q2.distance);
    if (!best || worst < best.worst) best = { wall, a: q1.along, b: q2.along, worst };
  }
  if (!best || best.worst > MAX_TAP_DISTANCE) return fail('두 점이 같은 벽 위에 있지 않습니다. 문·창문의 양 끝을 찍어 주세요.');
  const from = Math.min(best.a, best.b);
  const width = Math.abs(best.a - best.b);
  if (width < MIN_OPENING_WIDTH) return fail('두 점이 너무 가깝습니다. 문·창문의 양 끝을 찍어 주세요.');
  return makeOpening(type, best.wall.index, from, width, polygon);
}

/** 문·창문의 양 끝점 (방 좌표 [x, z]) */
export function openingSegment(opening: Opening, polygon: Point2[]): [Point2, Point2] | null {
  const wall = wallsOf(polygon)[opening.wallIndex];
  if (!wall || wall.length < 1e-9) return null;
  const at = (d: number): Point2 => [
    wall.a[0] + ((wall.b[0] - wall.a[0]) * d) / wall.length,
    wall.a[1] + ((wall.b[1] - wall.a[1]) * d) / wall.length,
  ];
  return [at(opening.from), at(opening.to)];
}

/**
 * DB에서 읽은 openings를 평면도에 맞춰 검증한다.
 * 모양이 틀렸거나 벽을 벗어났거나 다른 것과 겹치는 항목은 버린다.
 */
export function parseOpenings(raw: unknown, polygon: Point2[] | null): Opening[] {
  if (!Array.isArray(raw) || !polygon) return [];
  const openings: Opening[] = [];
  for (const entry of raw) {
    if (openings.length >= MAX_OPENINGS) break;
    const parsed = OpeningSchema.safeParse(entry);
    if (!parsed.success) continue;
    const made = makeOpening(parsed.data.type, parsed.data.wallIndex, parsed.data.from, parsed.data.to - parsed.data.from, polygon);
    if (!made.ok || overlapsExisting(made.opening, openings)) continue;
    openings.push(made.opening);
  }
  return openings;
}

/** 목록에 새 문·창문을 넣는다. 겹치거나 개수를 넘으면 이유와 함께 실패한다 */
export function addOpening(openings: Opening[], opening: Opening): { ok: true; openings: Opening[] } | { ok: false; message: string } {
  if (openings.length >= MAX_OPENINGS) return { ok: false, message: `문·창문은 ${MAX_OPENINGS}개까지 넣을 수 있습니다.` };
  if (overlapsExisting(opening, openings)) return { ok: false, message: '같은 벽의 다른 문·창문과 겹칩니다.' };
  return { ok: true, openings: [...openings, opening] };
}

/** "문 · 벽 1 · 0.20~1.10 m (폭 0.90 m)" */
export function describeOpening(o: Opening): string {
  return `${OPENING_LABEL[o.type]} · 벽 ${o.wallIndex + 1} · ${o.from.toFixed(2)}~${o.to.toFixed(2)} m (폭 ${o.widthM.toFixed(2)} m)`;
}

/** "문 1 · 창문 2" */
export function summarizeOpenings(openings: Opening[]): string {
  return OPENING_TYPES.map((type) => [type, openings.filter((o) => o.type === type).length] as const)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => `${OPENING_LABEL[type]} ${n}`)
    .join(' · ');
}

export function sameOpenings(a: Opening[], b: Opening[]): boolean {
  return (
    a.length === b.length &&
    a.every((o, i) => o.type === b[i].type && o.wallIndex === b[i].wallIndex && o.from === b[i].from && o.to === b[i].to && o.widthM === b[i].widthM)
  );
}
