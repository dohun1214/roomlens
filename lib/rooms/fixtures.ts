// 방에 원래 있는 가구 (스캔에 함께 찍힌 침대·옷장·냉장고 등). rooms.fixtures = [{ id, label, x, z, w, d, rotationDeg, h, remove }]
//   x, z      : 바닥 사각형의 가운데 (방 좌표, m)
//   w, d      : 가로·깊이 (m). 회전 0°일 때 가로가 x 방향
//   rotationDeg: 가구 배치와 같은 규칙의 회전. 방의 첫 번째 벽 방향에 맞춘다 (보정된 방은 벽이 가로·세로라 0° 또는 90°)
//   h         : 높이 (m)
//   remove    : "치울 가구" → 배치 검사·AI 추천에서 없는 것으로 본다
// 새 가구는 이 자리를 피해서 놓고, 겹치면 배치 검사가 알려 준다.
// 방 주인이 브라우저에서 바로 저장하므로, 읽을 때 반드시 검증한다.
import { z } from 'zod';
import { pointInPolygon, type Footprint, type Point2 } from '@/lib/three/floorDrag';

/** DB의 rooms_fixtures_check 와 같은 값 */
export const MAX_FIXTURES = 30;
/** 이보다 작은 사각형은 잘못 찍은 것으로 본다 (m) */
export const MIN_FIXTURE_SIZE = 0.15;
export const MAX_FIXTURE_SIZE = 8;
export const MAX_FIXTURE_HEIGHT = 3;
/** 위 모서리를 찍었는데 높이가 이보다 낮으면 바닥을 찍은 것으로 보고 기본 높이를 쓴다 (m) */
export const MIN_TOP_HEIGHT = 0.15;
export const DEFAULT_FIXTURE_HEIGHT = 0.8;
export const FIXTURE_LABEL_MAX = 12;
/** 이름을 고르는 칸의 보기 */
export const FIXTURE_LABELS = ['침대', '소파', '책상', '식탁', '옷장', '수납장', '책장', '냉장고', '세탁기', '가구'] as const;

export type Fixture = { id: string; label: string; x: number; z: number; w: number; d: number; rotationDeg: number; h: number; remove: boolean };

/** 배치 검사·솔버에 넘기는 모양: 가구처럼 겹침·통로를 막는다 */
export type FixtureObstacle = Footprint & { id: string; name: string; h: number };

export type FixtureResult = { ok: true; fixture: Fixture } | { ok: false; message: string };

const FixtureSchema = z.object({
  id: z.string().regex(/^x\d{1,4}$/),
  label: z.string().trim().min(1).max(FIXTURE_LABEL_MAX),
  x: z.number().min(-1000).max(1000),
  z: z.number().min(-1000).max(1000),
  w: z.number().min(MIN_FIXTURE_SIZE).max(MAX_FIXTURE_SIZE),
  d: z.number().min(MIN_FIXTURE_SIZE).max(MAX_FIXTURE_SIZE),
  rotationDeg: z.number().min(0).max(360),
  h: z.number().min(0.05).max(MAX_FIXTURE_HEIGHT),
  remove: z.boolean(),
});

const round2 = (v: number) => Math.round(v * 100) / 100 + 0;
const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0;
const fail = (message: string): FixtureResult => ({ ok: false, message });

/**
 * 원래 가구의 사각형을 맞출 방향 (회전 각도). 방의 첫 번째 벽과 나란하게 한다.
 * 회전 r의 가로 방향은 [cos r, -sin r] 이다 (floorDrag의 footprintCorners와 같은 규칙).
 */
export function fixtureRotation(polygon: Point2[]): number {
  if (polygon.length < 2) return 0;
  const [a, b] = polygon;
  const deg = (Math.atan2(-(b[1] - a[1]), b[0] - a[0]) * 180) / Math.PI;
  // 사각형은 90°마다 같으므로 0~90° 사이로 줄인다
  const r = round2(((deg % 90) + 90) % 90);
  return r >= 90 ? 0 : r;
}

/** 회전 r의 가로·깊이 방향 */
function axes(rotationDeg: number): [Point2, Point2] {
  const r = (rotationDeg * Math.PI) / 180;
  return [
    [Math.cos(r), -Math.sin(r)],
    [Math.sin(r), Math.cos(r)],
  ];
}

/** 다음에 쓸 id (x1, x2, …) */
export function nextFixtureId(fixtures: Fixture[]): string {
  const used = new Set(fixtures.map((f) => f.id));
  for (let n = 1; ; n += 1) if (!used.has(`x${n}`)) return `x${n}`;
}

/**
 * 마주 보는 두 모서리(방 좌표 [x, z])로 원래 가구의 바닥 사각형을 만든다. 방의 벽과 나란하게 맞춘다.
 * @param h 높이 (m)
 */
export function fixtureFromCorners(a: Point2, b: Point2, h: number, polygon: Point2[], existing: Fixture[], label: string = FIXTURE_LABELS[FIXTURE_LABELS.length - 1]): FixtureResult {
  if (polygon.length < 3) return fail('먼저 방을 보정해 주세요.');
  if (existing.length >= MAX_FIXTURES) return fail(`원래 가구는 ${MAX_FIXTURES}개까지 넣을 수 있습니다.`);
  if (![...a, ...b, h].every(Number.isFinite)) return fail('위치를 알 수 없습니다. 다시 찍어 주세요.');
  const rotationDeg = fixtureRotation(polygon);
  const [ux, uz] = axes(rotationDeg);
  const along = (p: Point2, u: Point2) => p[0] * u[0] + p[1] * u[1];
  const [a1, a2] = [along(a, ux), along(b, ux)];
  const [b1, b2] = [along(a, uz), along(b, uz)];
  const w = round2(Math.abs(a1 - a2));
  const d = round2(Math.abs(b1 - b2));
  if (w < MIN_FIXTURE_SIZE || d < MIN_FIXTURE_SIZE) return fail(`가로·깊이가 ${Math.round(MIN_FIXTURE_SIZE * 100)}cm보다 작습니다. 가구의 마주 보는 두 모서리를 찍어 주세요.`);
  if (w > MAX_FIXTURE_SIZE || d > MAX_FIXTURE_SIZE) return fail('너무 큽니다. 가구 하나의 마주 보는 두 모서리를 찍어 주세요.');
  const ca = (a1 + a2) / 2;
  const cb = (b1 + b2) / 2;
  const center: Point2 = [round3(ux[0] * ca + uz[0] * cb), round3(ux[1] * ca + uz[1] * cb)];
  if (!pointInPolygon(center, polygon)) return fail('방 밖입니다. 방 안의 가구를 찍어 주세요.');
  const height = round2(Math.min(MAX_FIXTURE_HEIGHT, Math.max(0.05, h)));
  return {
    ok: true,
    fixture: { id: nextFixtureId(existing), label, x: center[0], z: center[1], w, d, rotationDeg, h: height, remove: false },
  };
}

/** 화면에서 찍은 두 위 모서리(방 좌표 [x, y, z])의 높이로 가구 높이를 정한다. 바닥을 찍었으면 기본 높이 */
export function heightFromTaps(y1: number, y2: number): number {
  const top = Math.max(y1, y2);
  return top >= MIN_TOP_HEIGHT ? round2(top) : DEFAULT_FIXTURE_HEIGHT;
}

/** DB에서 읽은 fixtures를 검증한다. 모양이 틀렸거나 방 밖이거나 id가 겹치는 항목은 버린다 */
export function parseFixtures(raw: unknown, polygon: Point2[] | null): Fixture[] {
  if (!Array.isArray(raw) || !polygon || polygon.length < 3) return [];
  const out: Fixture[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_FIXTURES) break;
    const parsed = FixtureSchema.safeParse(entry);
    if (!parsed.success) continue;
    const f = parsed.data;
    if (out.some((o) => o.id === f.id) || !pointInPolygon([f.x, f.z], polygon)) continue;
    out.push(f);
  }
  return out;
}

/** 이름·높이·치울지를 고친다. 값이 맞지 않으면 그대로 둔다 */
export function updateFixture(fixtures: Fixture[], id: string, change: Partial<Pick<Fixture, 'label' | 'h' | 'remove'>>): Fixture[] {
  return fixtures.map((f) => {
    if (f.id !== id) return f;
    const next = { ...f, ...change };
    next.label = next.label.trim().slice(0, FIXTURE_LABEL_MAX) || f.label;
    next.h = Number.isFinite(next.h) ? round2(Math.min(MAX_FIXTURE_HEIGHT, Math.max(0.05, next.h))) : f.h;
    return next;
  });
}

/** 배치 검사·솔버·빈자리 찾기가 피할 원래 가구 ("치울 가구"는 뺀다) */
export function fixtureObstacles(fixtures: Fixture[]): FixtureObstacle[] {
  return fixtures
    .filter((f) => !f.remove)
    .map((f) => ({ id: `fixture:${f.id}`, name: `원래 있던 ${f.label}`, x: f.x, z: f.z, w: f.w, d: f.d, rotationDeg: f.rotationDeg, h: f.h }));
}

/** "침대 · 100×200 · 높이 0.45 m" */
export function describeFixture(f: Fixture): string {
  return `${f.label} · ${Math.round(f.w * 100)}×${Math.round(f.d * 100)} · 높이 ${f.h.toFixed(2)} m${f.remove ? ' · 치울 가구' : ''}`;
}

export function sameFixtures(a: Fixture[], b: Fixture[]): boolean {
  return a.length === b.length && a.every((f, i) => JSON.stringify(f) === JSON.stringify(b[i]));
}

/** 원래 가구를 비스듬히 내려다보는 자리 (3D 화면에서 위치를 확인할 때) */
export function fixtureViewpoint(f: Fixture, polygon: Point2[]): { position: [number, number, number]; target: [number, number, number] } {
  // 방 가운데 쪽으로 물러나서 본다. 방 안에 머무는 가장 먼 거리
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  const middle: Point2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
  let dir: Point2 = [middle[0] - f.x, middle[1] - f.z];
  const length = Math.hypot(...dir);
  dir = length > 1e-6 ? [dir[0] / length, dir[1] / length] : [0, 1];
  const reach = Math.max(f.w, f.d) / 2;
  const back = [2.4, 2.0, 1.6, 1.2, 0.8].map((d) => d + reach).find((d) => pointInPolygon([f.x + dir[0] * d, f.z + dir[1] * d], polygon)) ?? reach + 0.5;
  return {
    position: [f.x + dir[0] * back, Math.max(1.5, f.h + 0.8), f.z + dir[1] * back],
    target: [f.x, f.h / 2, f.z],
  };
}
