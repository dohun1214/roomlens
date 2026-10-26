// 원래 가구 옮기기: 스캔 속 원래 가구를 3D 조각으로 떼어 내는 계산 (브라우저·서버 공용, three.js를 쓰지 않는 부분).
// 조각은 원래 가구의 바닥 사각형 안, 바닥 바로 위부터 위에 얹힌 물건(스탠드 등)까지의 스플랫이다.
// 벽에 붙은 가구는 벽 스플랫까지 딸려 오지 않게 벽에서 조금 떨어진 곳까지만 고른다.
// 조각은 원래 가구의 가운데를 원점(바닥 y=0), 원래 가구의 회전을 0°로 본 좌표로 저장한다 → 배치에서 가구처럼 옮기고 돌린다.
import type { Footprint, Point2 } from '@/lib/three/floorDrag';
import { fixtureAxes, MAX_FIXTURE_HEIGHT, type Fixture, type PieceBox } from './fixtures';

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
/** 원래 가구 사각형(AI가 찾았거나 사람이 그린 것)은 조금씩 작거나 어긋나므로 이만큼 넓혀서 고른다 (m). 옆 물건은 다듬기로 뺀다 */
export const PIECE_GROW = 0.06;
/** 떼어 낸 스플랫이 차지한 사각형에 더하는 여유 (m) */
const KEPT_MARGIN = 0.015;
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

/** 조각을 고를 사각형: 원래 가구 사각형을 PIECE_GROW만큼 넓힌 뒤 벽 쪽을 줄인다 (pieceBox) */
export function pickBox(f: Pick<Fixture, 'x' | 'z' | 'w' | 'd' | 'rotationDeg'>, polygon: Point2[]): Footprint {
  return pieceBox({ ...f, w: f.w + 2 * PIECE_GROW, d: f.d + 2 * PIECE_GROW }, polygon);
}

/** 고른 사각형의 네 변 가운데 벽 때문에 줄인 변 (원래 가구 좌표의 가로 u·깊이 v 방향) */
export type WallSides = { uMin: boolean; uMax: boolean; vMin: boolean; vMax: boolean };

export function wallSides(f: Pick<Fixture, 'x' | 'z' | 'w' | 'd' | 'rotationDeg'>, polygon: Point2[]): WallSides {
  const pick = pickBox(f, polygon);
  const [u, v] = fixtureAxes(f.rotationDeg);
  const cu = (pick.x - f.x) * u[0] + (pick.z - f.z) * u[1];
  const cv = (pick.x - f.x) * v[0] + (pick.z - f.z) * v[1];
  const gu = f.w / 2 + PIECE_GROW;
  const gv = f.d / 2 + PIECE_GROW;
  const shrunk = (a: number, b: number) => a < b - 0.002;
  return { uMin: shrunk(-(cu - pick.w / 2), gu), uMax: shrunk(cu + pick.w / 2, gu), vMin: shrunk(-(cv - pick.d / 2), gv), vMax: shrunk(cv + pick.d / 2, gv) };
}

/** 원래 가구 좌표의 사각형 → 방 좌표의 바닥 사각형 */
export function boxFootprint(f: Pick<Fixture, 'x' | 'z' | 'rotationDeg'>, box: PieceBox): Footprint {
  const [u, v] = fixtureAxes(f.rotationDeg);
  return { x: round3(f.x + u[0] * box.cu + v[0] * box.cv), z: round3(f.z + u[1] * box.cu + v[1] * box.cv), w: box.w, d: box.d, rotationDeg: f.rotationDeg };
}

/**
 * 떼어 낸 스플랫이 차지한 바닥 사각형 (원래 가구 좌표, 원래 가구와 같은 방향).
 * 양쪽 끝 0.3%씩은 튀는 점으로 보고 빼고, KEPT_MARGIN을 더한 뒤 고른 사각형(within) 안으로 자른다
 */
export function keptBox(f: Pick<Fixture, 'x' | 'z' | 'rotationDeg'>, points: ArrayLike<Point2>, within: Footprint, walls?: WallSides): PieceBox | null {
  if (points.length === 0) return null;
  const [u, v] = fixtureAxes(f.rotationDeg);
  const us = new Float64Array(points.length);
  const vs = new Float64Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    const dx = points[i][0] - f.x;
    const dz = points[i][1] - f.z;
    us[i] = dx * u[0] + dz * u[1];
    vs[i] = dx * v[0] + dz * v[1];
  }
  us.sort();
  vs.sort();
  const at = (a: Float64Array, q: number) => a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];
  // 고른 사각형의 범위 (원래 가구 좌표)
  const wcu = (within.x - f.x) * u[0] + (within.z - f.z) * u[1];
  const wcv = (within.x - f.x) * v[0] + (within.z - f.z) * v[1];
  // 벽 쪽 변은 고른 사각형 끝(벽에서 PIECE_WALL_GAP)까지: 가구 뒤와 벽 사이의 흐린 스플랫도 숨긴다
  const u0 = walls?.uMin ? wcu - within.w / 2 : Math.max(wcu - within.w / 2, at(us, 0.003) - KEPT_MARGIN);
  const u1 = walls?.uMax ? wcu + within.w / 2 : Math.min(wcu + within.w / 2, at(us, 0.997) + KEPT_MARGIN);
  const v0 = walls?.vMin ? wcv - within.d / 2 : Math.max(wcv - within.d / 2, at(vs, 0.003) - KEPT_MARGIN);
  const v1 = walls?.vMax ? wcv + within.d / 2 : Math.min(wcv + within.d / 2, at(vs, 0.997) + KEPT_MARGIN);
  if (u1 - u0 < 0.05 || v1 - v0 < 0.05) return null;
  const r2 = (x: number) => Math.round(x * 100) / 100 + 0;
  return { cu: r2((u0 + u1) / 2), cv: r2((v0 + v1) / 2), w: r2(u1 - u0), d: r2(v1 - v0) };
}

/** 옮긴 원래 가구의 원래 자리에서 숨기고 채울 바닥 사각형: 떼어 낸 스플랫이 차지한 곳 (예전 조각은 pieceBox) */
export function hiddenBox(f: Fixture, polygon: Point2[]): Footprint {
  return f.piece?.box ? boxFootprint(f, f.piece.box) : pieceBox(f, polygon);
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

// ---- 조각 다듬기 ----
// 상자로 고른 스플랫에는 가구가 아닌 것도 섞인다: 상자 가장자리에 걸친 옆 물건(스탠드 받침), 벽·바닥에서 떨어져 나온 조각,
// 허공에 뜬 흐린 스플랫. 3cm 칸으로 이어진 덩어리를 나눠 가구 몸통과 그 위·안의 물건만 남긴다.

/** 덩어리를 나누는 칸 (m) */
export const PIECE_VOXEL = 0.03;
/** 상자 옆면에서 이 안쪽 띠 (m): 여기에 대부분 걸친 덩어리는 옆 물건이나 벽 조각으로 본다 */
export const PIECE_EDGE_BAND = 0.08;
/** 몸통 밖 덩어리 가운데 이보다 작은 것은 떠다니는 조각으로 버린다 (가장 큰 덩어리 대비) */
const MIN_PART = 0.01;
/** 띠에 이 비율 넘게 걸치면 버린다 */
const EDGE_SHARE = 0.6;
/** 이 크기(m)보다 큰 스플랫은 흐린 배경으로 본다 (불투명도가 낮으면 LOOSE_SCALE부터) */
export const MAX_SPLAT_SCALE = 0.15;
const LOOSE_SCALE = 0.05;
const LOOSE_OPACITY = 0.2;
/** 벽 쪽 변에서 이 안쪽 띠의 크거나 옅은 스플랫은 가구 뒤와 벽 사이의 흐린 얼룩으로 본다 (m) */
export const WALL_BLUR_BAND = 0.06;
const WALL_BLUR_SCALE = 0.03;
const WALL_BLUR_OPACITY = 0.3;
/** 바닥에서 이 높이 아래의 크거나 옅은 스플랫은 바닥·그림자 조각으로 본다 (다리는 가늘고 진하다) */
export const FLOOR_BLUR_BAND = 0.08;
/** 가구 높이 위(얹힌 물건 자리)에서 벽 쪽 변 이 안쪽은 벽에 달린 것(벽등·전선·커튼)으로 본다 (m) */
export const WALL_STACK_BAND = 0.06;
/** 몸통이 아닌 덩어리가 바닥(이 높이 아래)까지 내려오면 따로 선 물건(스탠드 등)으로 본다 (m) */
const STANDS_ON_FLOOR = 0.12;
/** 바닥까지 내려와도 몸통의 이 비율 넘게 크면 가구의 한 부분(나뉜 소파 등)으로 본다 */
const BIG_PART = 0.3;

export type PieceSplat = { x: number; y: number; z: number; scale: number; opacity: number };

/**
 * 고른 스플랫 가운데 원래 가구로 남길 것 (true = 남김).
 * 1) 너무 크거나(흐린 배경) 크고 옅은 스플랫, 벽 쪽 띠·바닥 바로 위의 크거나 옅은 스플랫(가구 뒤 얼룩, 바닥·그림자)을 뺀다
 * 2) 남은 것을 PIECE_VOXEL 칸으로 이어진 덩어리로 나눈다 (가로·세로·대각선 이웃 26칸)
 * 3) 가장 큰 덩어리(가구 몸통)는 남기고, 나머지는 작으면(떠다니는 조각), 상자 옆면 띠에 대부분 걸쳐 있으면(옆 물건·벽 조각),
 *    몸통과 떨어져 바닥에 따로 서 있으면(옆 스탠드) 버린다. 그 밖(가구 위·안의 물건)은 남긴다
 * 가구 높이 h 위에서 벽 쪽 변에 붙은 스플랫(벽등·전선)도 뺀다
 * @param box 고른 바닥 사각형 (pickBox)
 * @param walls 벽 때문에 줄인 변 (wallSides)
 * @param h 원래 가구 높이 (위에 얹힌 물건 자리를 가린다)
 */
export function cleanPieceMask(splats: ArrayLike<PieceSplat>, box: Footprint, walls?: WallSides, h = Infinity): Uint8Array {
  const n = splats.length;
  const keep = new Uint8Array(n);
  if (n === 0) return keep;
  const [u, v] = fixtureAxes(box.rotationDeg);
  // 벽 쪽 변까지의 거리 (벽이 없으면 Infinity)
  const wallGap = (s: PieceSplat) => {
    if (!walls) return Infinity;
    const lu = (s.x - box.x) * u[0] + (s.z - box.z) * u[1];
    const lv = (s.x - box.x) * v[0] + (s.z - box.z) * v[1];
    return Math.min(
      walls.uMin ? lu + box.w / 2 : Infinity,
      walls.uMax ? box.w / 2 - lu : Infinity,
      walls.vMin ? lv + box.d / 2 : Infinity,
      walls.vMax ? box.d / 2 - lv : Infinity,
    );
  };
  for (let i = 0; i < n; i += 1) {
    const s = splats[i];
    if (s.scale > MAX_SPLAT_SCALE || (s.scale > LOOSE_SCALE && s.opacity < LOOSE_OPACITY)) continue;
    if ((s.scale > WALL_BLUR_SCALE || s.opacity < WALL_BLUR_OPACITY) && (wallGap(s) < WALL_BLUR_BAND || s.y < FLOOR_BLUR_BAND)) continue;
    if (s.y > h + 0.05 && wallGap(s) < WALL_STACK_BAND) continue;
    keep[i] = 1;
  }
  const label = labelParts(splats, keep);
  // 덩어리마다 스플랫 수, 옆면 띠에 걸친 수, 가장 낮은 높이
  const size = new Map<number, number>();
  const edge = new Map<number, number>();
  const lowest = new Map<number, number>();
  const half = [box.w / 2, box.d / 2];
  for (let i = 0; i < n; i += 1) {
    if (!keep[i]) continue;
    const root = label[i];
    size.set(root, (size.get(root) ?? 0) + 1);
    const s = splats[i];
    lowest.set(root, Math.min(lowest.get(root) ?? Infinity, s.y));
    const dx = s.x - box.x;
    const dz = s.z - box.z;
    const inner = Math.min(half[0] - Math.abs(dx * u[0] + dz * u[1]), half[1] - Math.abs(dx * v[0] + dz * v[1]));
    if (inner < PIECE_EDGE_BAND) edge.set(root, (edge.get(root) ?? 0) + 1);
  }
  let main = -1;
  let mainSize = 0;
  for (const [root, count] of size) {
    if (count > mainSize) {
      main = root;
      mainSize = count;
    }
  }
  const drop = new Set<number>();
  for (const [root, count] of size) {
    if (root === main) continue;
    const small = count < Math.max(8, mainSize * MIN_PART);
    const atEdge = (edge.get(root) ?? 0) > count * EDGE_SHARE;
    const standsAlone = (lowest.get(root) ?? Infinity) < STANDS_ON_FLOOR && count < mainSize * BIG_PART;
    if (small || atEdge || standsAlone) drop.add(root);
  }
  for (let i = 0; i < n; i += 1) if (keep[i] && drop.has(label[i])) keep[i] = 0;
  return keep;
}

/**
 * mask가 켜진 스플랫을 PIECE_VOXEL 칸으로 이어진 덩어리로 나눈다 (가로·세로·대각선 이웃 26칸).
 * @returns 스플랫마다 덩어리 번호 (mask가 꺼진 것은 -1)
 */
function labelParts(splats: ArrayLike<PieceSplat>, mask: Uint8Array): Int32Array {
  const n = splats.length;
  const out = new Int32Array(n).fill(-1);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i += 1) {
    if (!mask[i]) continue;
    const s = splats[i];
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    minZ = Math.min(minZ, s.z);
    maxX = Math.max(maxX, s.x);
    maxY = Math.max(maxY, s.y);
    maxZ = Math.max(maxZ, s.z);
  }
  if (minX === Infinity) return out;
  const nx = Math.floor((maxX - minX) / PIECE_VOXEL) + 1;
  const ny = Math.floor((maxY - minY) / PIECE_VOXEL) + 1;
  const nz = Math.floor((maxZ - minZ) / PIECE_VOXEL) + 1;
  // 칸 번호 → 칸 순번 (스플랫이 있는 칸만)
  const cellOf = new Int32Array(n).fill(-1);
  const index = new Map<number, number>();
  const cells: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (!mask[i]) continue;
    const s = splats[i];
    const k = Math.floor((s.x - minX) / PIECE_VOXEL) + nx * (Math.floor((s.y - minY) / PIECE_VOXEL) + ny * Math.floor((s.z - minZ) / PIECE_VOXEL));
    let c = index.get(k);
    if (c === undefined) {
      c = cells.length;
      index.set(k, c);
      cells.push(k);
    }
    cellOf[i] = c;
  }
  // 이웃 칸끼리 묶기 (union-find)
  const parent = new Int32Array(cells.length).map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let c = 0; c < cells.length; c += 1) {
    const k = cells[c];
    const ix = k % nx;
    const iy = Math.floor(k / nx) % ny;
    const iz = Math.floor(k / (nx * ny));
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const jx = ix + dx;
          const jy = iy + dy;
          const jz = iz + dz;
          if (jx < 0 || jy < 0 || jz < 0 || jx >= nx || jy >= ny || jz >= nz) continue;
          const other = index.get(jx + nx * (jy + ny * jz));
          if (other === undefined || other <= c) continue;
          const a = find(c);
          const b = find(other);
          if (a !== b) parent[a] = b;
        }
      }
    }
  }
  for (let i = 0; i < n; i += 1) if (cellOf[i] >= 0) out[i] = find(cellOf[i]);
  return out;
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
  /** 벽: 벽이 실제로 있는 구간 (c 기준 u). 그 밖은 옆 벽·빈 곳이다 */
  span?: [number, number];
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
      span: [round3(-mid), round3(len - mid)],
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

/** 그림 픽셀 → 평면 위의 (u, v) (planePixel의 반대) */
export function pixelPlane(plane: FillPlane, px: number, py: number): Point2 {
  const u = (px / FILL_IMAGE.width - 0.5) * plane.Wm;
  const v = (py / FILL_IMAGE.height - 0.5) * plane.Hm;
  return [u, plane.kind === 'floor' ? v : -v];
}

/**
 * 그림의 이 픽셀에 실제 평면(바닥·벽 면)이 있는지: 바닥은 방 안(벽에서 2cm 안쪽), 벽은 그 벽의 구간 안·바닥 위.
 * 이어 붙일 때 이런 곳의 둘레만 기준으로 쓴다
 */
export function planeSurfaceAt(plane: FillPlane, px: number, py: number, polygon: Point2[], margin = 0.02): boolean {
  const [u, v] = pixelPlane(plane, px, py);
  if (plane.kind === 'wall') {
    const [a, b] = plane.span ?? [-Infinity, Infinity];
    return u >= a + margin && u <= b - margin && v >= -plane.c[1] + margin;
  }
  const [x, , z] = planePoint(plane, u, v);
  return insidePolygon(x, z, polygon, margin);
}

/** 점이 다각형 안이고 모든 변에서 margin 넘게 떨어져 있는지 */
function insidePolygon(x: number, z: number, polygon: Point2[], margin: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const dx = xi - xj;
    const dz = zi - zj;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - xj) * dx + (z - zj) * dz) / len2)) : 0;
    if (margin > 0 && Math.hypot(x - (xj + dx * t), z - (zj + dz * t)) < margin) return false;
  }
  return inside;
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
