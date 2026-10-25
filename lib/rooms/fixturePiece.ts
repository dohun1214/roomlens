// 원래 가구 옮기기: 스캔 속 원래 가구를 3D 조각으로 떼어 내는 계산 (브라우저·서버 공용, three.js를 쓰지 않는 부분).
// 조각은 원래 가구의 바닥 사각형 안, 바닥 바로 위부터 위에 얹힌 물건(스탠드 등)까지의 스플랫이다.
// 벽에 붙은 가구는 벽 스플랫까지 딸려 오지 않게 벽에서 조금 떨어진 곳까지만 고른다.
// 조각은 원래 가구의 가운데를 원점(바닥 y=0), 원래 가구의 회전을 0°로 본 좌표로 저장한다 → 배치에서 가구처럼 옮기고 돌린다.
import type { Footprint, Point2 } from '@/lib/three/floorDrag';
import { fixtureAxes, MAX_FIXTURE_HEIGHT, type Fixture } from './fixtures';

/** 이 높이 아래는 바닥으로 보고 조각에 넣지 않는다 (m) */
export const PIECE_FLOOR_CUT = 0.025;
/** 벽과 이만큼은 떨어진 곳까지만 고른다 (m). 벽 스플랫이 딸려 오지 않게 */
export const PIECE_WALL_GAP = 0.04;
/** 위에 얹힌 물건을 찾을 때 쓰는 높이 칸 (m) */
export const STACK_BIN = 0.05;
/** 이만큼 빈 칸이 이어지면 가구 위 물건이 끝난 것으로 본다 */
export const STACK_GAP_BINS = 2;
/** 원래 가구 높이보다 이만큼 위까지만 얹힌 물건을 찾는다 (m) */
export const MAX_STACK = 1.2;
/** 조각의 가장 높은 곳 (m). 천장이 딸려 오지 않게 */
export const MAX_PIECE_TOP = 2.4;
/** 조각 파일 하나의 최대 크기 (R2에 직접 올린다) */
export const MAX_PIECE_BYTES = 30 * 1024 * 1024;
/** 상자를 이보다 좁게는 줄이지 않는다 (m) */
const MIN_BOX = 0.1;

export type PieceKind = 'piece' | 'fill';

/** 원래 가구 id → 조각 읽기 주소 */
export type FixturePieceUrls = Record<string, { piece?: string; fill?: string }>;

/** R2 열쇠: 방 파일과 같은 폴더라 방을 지우면 함께 지워진다. 버전(만든 시각)을 넣어 다시 만들면 새 주소가 된다 */
export function fixturePieceKey(roomId: string, fixtureId: string, kind: PieceKind, v: number): string {
  return `rooms/${roomId}/fixtures/${fixtureId}-${kind}-${v}.spz`;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0;

/**
 * 조각을 고를 바닥 사각형: 원래 가구 사각형에서 벽 쪽 변을 벽에서 PIECE_WALL_GAP만큼 떨어지게 줄인다.
 * 사각형의 변과 나란한(10° 안) 벽만 본다.
 */
export function pieceBox(f: Pick<Fixture, 'x' | 'z' | 'w' | 'd' | 'rotationDeg'>, polygon: Point2[]): Footprint {
  const [u, v] = fixtureAxes(f.rotationDeg);
  // 가운데에서 본 각 방향의 끝 (u는 가로, v는 깊이 방향)
  const ext = { uMin: -f.w / 2, uMax: f.w / 2, vMin: -f.d / 2, vMax: f.d / 2 };
  const c: Point2 = [f.x, f.z];
  const dot = (a: Point2, b: Point2) => a[0] * b[0] + a[1] * b[1];
  for (let i = 0; i < polygon.length; i += 1) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 1e-6) continue;
    const t: Point2 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
    const n: Point2 = [-t[1], t[0]];
    for (const [axis, other, key, otherHalf] of [
      [u, v, 'u', f.d / 2],
      [v, u, 'v', f.w / 2],
    ] as const) {
      const facing = dot(n, axis);
      if (Math.abs(facing) < Math.cos((10 * Math.PI) / 180)) continue;
      // 벽이 사각형 옆을 지나가는지: 벽 끝점을 다른 축에 비춘 구간이 사각형과 겹쳐야 한다
      const a = dot([p[0] - c[0], p[1] - c[1]], other);
      const b = dot([q[0] - c[0], q[1] - c[1]], other);
      if (Math.max(a, b) < -otherHalf || Math.min(a, b) > otherHalf) continue;
      // 가운데에서 axis 방향으로 벽 직선까지의 거리 (부호: axis 쪽이 +)
      const along = -dot([c[0] - p[0], c[1] - p[1]], n) / facing;
      const limit = along > 0 ? along - PIECE_WALL_GAP : along + PIECE_WALL_GAP;
      if (along > 0) {
        if (key === 'u') ext.uMax = Math.min(ext.uMax, limit);
        else ext.vMax = Math.min(ext.vMax, limit);
      } else if (key === 'u') ext.uMin = Math.max(ext.uMin, limit);
      else ext.vMin = Math.max(ext.vMin, limit);
    }
  }
  const w = ext.uMax - ext.uMin;
  const d = ext.vMax - ext.vMin;
  if (w < MIN_BOX || d < MIN_BOX) return { x: f.x, z: f.z, w: f.w, d: f.d, rotationDeg: f.rotationDeg };
  const cu = (ext.uMin + ext.uMax) / 2;
  const cv = (ext.vMin + ext.vMax) / 2;
  return { x: round3(f.x + u[0] * cu + v[0] * cv), z: round3(f.z + u[1] * cu + v[1] * cv), w: round3(w), d: round3(d), rotationDeg: f.rotationDeg };
}

/** 방 좌표의 바닥 점이 사각형 안인지 (회전 포함) */
export function inFootprint(box: Footprint, x: number, z: number): boolean {
  const [u, v] = fixtureAxes(box.rotationDeg);
  const dx = x - box.x;
  const dz = z - box.z;
  return Math.abs(dx * u[0] + dz * u[1]) <= box.w / 2 && Math.abs(dx * v[0] + dz * v[1]) <= box.d / 2;
}

/**
 * 위에 얹힌 물건까지 포함한 높이: 사각형 안 스플랫의 높이(바닥 위)를 STACK_BIN 칸으로 세어,
 * 원래 가구 높이 h에서 시작해 빈 칸이 STACK_GAP_BINS개 이어질 때까지 올라간다.
 * 칸이 비었는지는 가장 많은 칸의 1%(최소 3개)로 본다. 결과는 h 이상, MAX_PIECE_TOP 이하.
 */
export function pieceTop(heights: ArrayLike<number>, h: number): number {
  const limit = Math.min(MAX_PIECE_TOP, MAX_FIXTURE_HEIGHT, h + MAX_STACK);
  const bins = Math.ceil(limit / STACK_BIN) + 1;
  const counts = new Array<number>(bins).fill(0);
  for (let i = 0; i < heights.length; i += 1) {
    const y = heights[i];
    if (!(y >= 0) || y > limit) continue;
    counts[Math.min(bins - 1, Math.floor(y / STACK_BIN))] += 1;
  }
  const busy = Math.max(3, Math.max(...counts) * 0.01);
  let top = Math.min(h, limit);
  let empty = 0;
  for (let bin = Math.floor(Math.min(h, limit) / STACK_BIN); bin < bins; bin += 1) {
    if (counts[bin] >= busy) {
      empty = 0;
      top = Math.max(top, Math.min(limit, (bin + 1) * STACK_BIN));
    } else {
      empty += 1;
      if (empty >= STACK_GAP_BINS) break;
    }
  }
  return Math.round(top * 100) / 100;
}

/** 방 좌표 → 조각 좌표 (원래 가구 가운데가 원점, 원래 가구의 회전을 0°로) */
export function toPieceFrame(f: Pick<Fixture, 'x' | 'z' | 'rotationDeg'>, x: number, z: number): Point2 {
  // 가구 메시는 rotation.y = rotationDeg 로 돈다: 방 = R(θ)·조각 → 조각 = R(-θ)·(방 - 가운데)
  const r = (f.rotationDeg * Math.PI) / 180;
  const dx = x - f.x;
  const dz = z - f.z;
  return [dx * Math.cos(r) - dz * Math.sin(r), dx * Math.sin(r) + dz * Math.cos(r)];
}

/** 이 원래 가구를 옮길 수 있는지 (조각이 있음) */
export function canMoveFixture(f: Fixture): boolean {
  return Boolean(f.piece);
}

// ---- 빈자리 채우기 ----
// 옮긴 뒤의 빈자리(안 찍힌 바닥·벽)는 평면이라, 바닥은 위에서·벽은 정면에서 좁은 시야로 찍고
// 구멍을 칠해 그림 AI에 이어 그리게 한 뒤, 돌려받은 그림의 색으로 구멍 자리에 납작한 스플랫을 깐다.

/** 빈자리 둘레로 더 찍는 너비 (m) */
export const FILL_MARGIN = 0.03;
/** 원래 가구에서 이만큼 안의 벽은 함께 채운다 (m) */
export const FILL_WALL_REACH = 0.25;
/** 채우는 그림의 크기 (가로 × 세로 px, 16:10) */
export const FILL_IMAGE = { width: 1280, height: 800 } as const;

/**
 * 채울 평면 하나. c: 그림 가운데(방 좌표). 바닥은 u = x, v = z (그림 오른쪽 = +x, 아래 = +z),
 * 벽은 u = 벽을 따라 r 방향, v = 높이 (그림 오른쪽 = r, 위 = +y). n은 벽의 방 안쪽 방향.
 * Wm × Hm: 그림이 담는 크기 (m). hole: 칠해서 채울 구간 (c 기준 u, v)
 */
export type FillPlane = {
  kind: 'floor' | 'wall';
  c: [number, number, number];
  n?: [number, number, number];
  r?: [number, number, number];
  Wm: number;
  Hm: number;
  hole: { u0: number; u1: number; v0: number; v1: number };
};

const ASPECT = FILL_IMAGE.width / FILL_IMAGE.height;

/** 원래 가구 사각형의 네 모서리 (방 좌표) */
function footprintCorners(f: Pick<Fixture, 'x' | 'z' | 'w' | 'd' | 'rotationDeg'>): Point2[] {
  const [u, v] = fixtureAxes(f.rotationDeg);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, b]) => [f.x + (u[0] * a * f.w) / 2 + (v[0] * b * f.d) / 2, f.z + (u[1] * a * f.w) / 2 + (v[1] * b * f.d) / 2]);
}

/**
 * 옮긴 원래 가구의 빈자리를 채울 평면들: 바닥 하나 + 가구에서 FILL_WALL_REACH 안의 벽마다 하나.
 * @param top 벽에서 채울 높이 (조각 높이)
 */
export function fillPlanes(f: Pick<Fixture, 'x' | 'z' | 'w' | 'd' | 'rotationDeg'>, top: number, polygon: Point2[]): FillPlane[] {
  const corners = footprintCorners(f);
  const xs = corners.map((c) => c[0]);
  const zs = corners.map((c) => c[1]);
  const holeW = Math.max(...xs) - Math.min(...xs) + 2 * FILL_MARGIN;
  const holeD = Math.max(...zs) - Math.min(...zs) + 2 * FILL_MARGIN;
  // 구멍 둘레가 그림의 대략 40% 이상 보이게 (주변을 보고 이어 그린다)
  const Hm = Math.max(holeD * 1.7, (holeW * 1.7) / ASPECT);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cz = (Math.max(...zs) + Math.min(...zs)) / 2;
  const planes: FillPlane[] = [{ kind: 'floor', c: [cx, 0, cz], Wm: Hm * ASPECT, Hm, hole: { u0: -holeW / 2, u1: holeW / 2, v0: -holeD / 2, v1: holeD / 2 } }];

  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const [x1, z1] = polygon[i];
    const [x2, z2] = polygon[(i + 1) % polygon.length];
    area += x1 * z2 - x2 * z1;
  }
  for (let i = 0; i < polygon.length; i += 1) {
    const [x1, z1] = polygon[i];
    const [x2, z2] = polygon[(i + 1) % polygon.length];
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 1e-6) continue;
    const tx = (x2 - x1) / len;
    const tz = (z2 - z1) / len;
    // 방 안쪽 법선 (다각형이 도는 방향에 맞춘다)
    const n: Point2 = area > 0 ? [-tz, tx] : [tz, -tx];
    const dist = Math.min(...corners.map(([x, z]) => (x - x1) * n[0] + (z - z1) * n[1]));
    const along = corners.map(([x, z]) => (x - x1) * tx + (z - z1) * tz);
    const a0 = Math.max(0, Math.min(...along) - FILL_MARGIN);
    const a1 = Math.min(len, Math.max(...along) + FILL_MARGIN);
    if (dist > FILL_WALL_REACH || dist < -0.1 || a1 - a0 < 0.1) continue;
    const height = Math.min(MAX_PIECE_TOP, top + 0.3);
    const Wm = Math.max((a1 - a0) * 1.8, (height + 0.2) * 1.25 * ASPECT);
    const H = Wm / ASPECT;
    const mid = (a0 + a1) / 2;
    const c: [number, number, number] = [x1 + tx * mid, H / 2 - 0.08, z1 + tz * mid];
    planes.push({
      kind: 'wall',
      c,
      n: [n[0], 0, n[1]],
      // 정면에서 볼 때 그림 오른쪽 = (-n) × 위
      r: [n[1], 0, -n[0]],
      Wm,
      Hm: H,
      hole: { u0: -(a1 - a0) / 2, u1: (a1 - a0) / 2, v0: -c[1], v1: height - c[1] },
    });
  }
  return planes;
}

/** 평면 위의 (u, v) → 그림 픽셀 (FILL_IMAGE 크기) */
export function planePixel(plane: FillPlane, u: number, v: number): Point2 {
  const px = (u / plane.Wm + 0.5) * FILL_IMAGE.width;
  const py = plane.kind === 'floor' ? (v / plane.Hm + 0.5) * FILL_IMAGE.height : (-v / plane.Hm + 0.5) * FILL_IMAGE.height;
  return [px, py];
}

/** 그림에서 칠할(채울) 사각형 [x, y, w, h] px */
export function holeRect(plane: FillPlane): [number, number, number, number] {
  const a = planePixel(plane, plane.hole.u0, plane.hole.v0);
  const b = planePixel(plane, plane.hole.u1, plane.hole.v1);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])];
}

/** 평면 위의 (u, v) → 방 좌표 */
export function planePoint(plane: FillPlane, u: number, v: number): [number, number, number] {
  if (plane.kind === 'floor') return [plane.c[0] + u, 0, plane.c[2] + v];
  const r = plane.r ?? [1, 0, 0];
  return [plane.c[0] + r[0] * u, plane.c[1] + v, plane.c[2] + r[2] * u];
}

/**
 * 원래 가구 조각을 만들 수 있는지. 방을 볼 수 있는 로그인한 사람은 누구나 원하는 원래 가구를 처음 떼어 내거나 처음 채울 수 있고
 * (만든 조각은 그 방을 보는 모두가 함께 쓴다), 이미 만든 것을 다시 만드는 것은 방 주인만 한다.
 * - ok: 만들 수 있음
 * - need-piece: 빈자리를 채우려면 먼저 떼어 내야 함
 * - taken: 이미 있어서 방 주인만 다시 만들 수 있음
 */
export function pieceAccess(f: Pick<Fixture, 'piece' | 'fill'>, kind: PieceKind, isOwner: boolean): 'ok' | 'need-piece' | 'taken' {
  if (kind === 'fill' && !f.piece) return 'need-piece';
  if (isOwner) return 'ok';
  const existing = kind === 'piece' ? f.piece : f.fill;
  return existing ? 'taken' : 'ok';
}
