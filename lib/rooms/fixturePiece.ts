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
