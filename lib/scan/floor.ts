// 3D 스캔 가구(메시)에서 함께 찍힌 바닥을 찾아 지우는 계산. 브라우저 없이 시험할 수 있게 숫자 배열만 다룬다.
// 스캔은 위가 +y(중력 방향 정렬)라고 본다 (Scaniverse 메시가 그렇다).
//  1) 가장 낮은 곳의 위를 향한 면들로 바닥 평면 y = a·x + b·z + c 를 찾는다 (RANSAC, 넓이 가중)
//  2) 세 꼭짓점이 모두 바닥에서 cut보다 낮은 면을 지운다 (사각형으로 잘린 모서리의 바닥 조각)
//  3) 바닥이 수평이 되게 돌리고, 위에서 본 테두리 상자가 가장 작아지는 방향으로 돌린다

/** 바닥 평면: y = a·x + b·z + c (스캔 좌표, m) */
export type FloorPlane = { a: number; b: number; c: number };

/** 바닥으로 볼 높이 (가장 낮은 점에서 이만큼 안의 위를 향한 면만 바닥 후보) (m) */
export const FLOOR_BAND = 0.06;
/** 평면에서 이만큼 안이면 바닥 위의 면으로 센다 (RANSAC) (m) */
const INLIER = 0.006;
/** 바닥에서 이 높이까지의 면을 지운다 (기본값과 화면에서 고를 수 있는 범위) (m) */
export const DEFAULT_FLOOR_CUT = 0.015;
export const MAX_FLOOR_CUT = 0.06;
/** 위를 향한 면: 법선의 y가 이보다 크다 (약 37° 이내) */
const UP = 0.8;
/** 바닥을 찾았다고 보려면 후보 면이 이만큼 넓어야 한다 (m²) */
const MIN_FLOOR_AREA = 0.002;

type Face = { cx: number; cy: number; cz: number; area: number };

/** 면마다 가운데·넓이·법선 y */
function faces(pos: ArrayLike<number>, idx: ArrayLike<number>): (Face & { ny: number })[] {
  const out: (Face & { ny: number })[] = [];
  for (let f = 0; f + 2 < idx.length; f += 3) {
    const i = idx[f] * 3;
    const j = idx[f + 1] * 3;
    const k = idx[f + 2] * 3;
    const ux = pos[j] - pos[i];
    const uy = pos[j + 1] - pos[i + 1];
    const uz = pos[j + 2] - pos[i + 2];
    const vx = pos[k] - pos[i];
    const vy = pos[k + 1] - pos[i + 1];
    const vz = pos[k + 2] - pos[i + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    out.push({
      cx: (pos[i] + pos[j] + pos[k]) / 3,
      cy: (pos[i + 1] + pos[j + 1] + pos[k + 1]) / 3,
      cz: (pos[i + 2] + pos[j + 2] + pos[k + 2]) / 3,
      area: len / 2,
      ny: len > 0 ? ny / len : 0,
    });
  }
  return out;
}

/** 같은 입력이면 같은 결과가 나오게 하는 간단한 난수 */
function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 세 점을 지나는 평면 y = a·x + b·z + c. 세 점이 한 줄이면 null */
function planeThrough(p: Face, q: Face, r: Face): FloorPlane | null {
  const ux = q.cx - p.cx;
  const uz = q.cz - p.cz;
  const vx = r.cx - p.cx;
  const vz = r.cz - p.cz;
  const det = ux * vz - uz * vx;
  if (Math.abs(det) < 1e-9) return null;
  const uy = q.cy - p.cy;
  const vy = r.cy - p.cy;
  const a = (uy * vz - uz * vy) / det;
  const b = (ux * vy - uy * vx) / det;
  return { a, b, c: p.cy - a * p.cx - b * p.cz };
}

/** 넓이 가중 최소제곱으로 평면을 다시 맞춘다 */
function fitPlane(list: Face[]): FloorPlane | null {
  // [Σw x², Σw xz, Σw x; Σw xz, Σw z², Σw z; Σw x, Σw z, Σw] · [a b c] = [Σw xy, Σw zy, Σw y]
  let sxx = 0;
  let sxz = 0;
  let sx = 0;
  let szz = 0;
  let sz = 0;
  let s = 0;
  let sxy = 0;
  let szy = 0;
  let sy = 0;
  for (const f of list) {
    const w = f.area;
    sxx += w * f.cx * f.cx;
    sxz += w * f.cx * f.cz;
    sx += w * f.cx;
    szz += w * f.cz * f.cz;
    sz += w * f.cz;
    s += w;
    sxy += w * f.cx * f.cy;
    szy += w * f.cz * f.cy;
    sy += w * f.cy;
  }
  const m = [
    [sxx, sxz, sx],
    [sxz, szz, sz],
    [sx, sz, s],
  ];
  const det3 = (q: number[][]) => q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) - q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) + q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const d = det3(m);
  if (Math.abs(d) < 1e-12) return null;
  const rhs = [sxy, szy, sy];
  const col = (k: number) => m.map((row, i) => row.map((v, j) => (j === k ? rhs[i] : v)));
  return { a: det3(col(0)) / d, b: det3(col(1)) / d, c: det3(col(2)) / d };
}

/** 점의 바닥 위 높이 (m, 수직 방향으로 잰 값과 거의 같다: 바닥 기울기가 작으므로) */
export function heightAbove(plane: FloorPlane, x: number, y: number, z: number): number {
  return (y - (plane.a * x + plane.b * z + plane.c)) / Math.sqrt(1 + plane.a * plane.a + plane.b * plane.b);
}

/**
 * 함께 찍힌 바닥 평면을 찾는다. 바닥이 거의 없으면(이미 잘라 낸 스캔) null.
 * 넓이가 충분히 모이는 평면 가운데 가장 낮은 것을 고르고, 그 평면 가까이의 면으로 다시 맞춘다.
 */
export function findFloorPlane(pos: ArrayLike<number>, idx: ArrayLike<number>, tries = 300): FloorPlane | null {
  const all = faces(pos, idx);
  if (all.length === 0) return null;
  let minY = Infinity;
  for (let i = 1; i < pos.length; i += 3) minY = Math.min(minY, pos[i]);
  const candidates = all.filter((f) => f.ny > UP && f.cy < minY + FLOOR_BAND && f.area > 0);
  const total = candidates.reduce((sum, f) => sum + f.area, 0);
  if (candidates.length < 3 || total < MIN_FLOOR_AREA) return null;

  const rand = random(candidates.length);
  const pick = () => candidates[Math.floor(rand() * candidates.length)];
  // 가운데(위에서 본 후보들의 무게중심)에서의 평면 높이로 평면끼리 높낮이를 견준다
  let mx = 0;
  let mz = 0;
  for (const f of candidates) {
    mx += f.cx * f.area;
    mz += f.cz * f.area;
  }
  mx /= total;
  mz /= total;
  const found: { plane: FloorPlane; score: number; y: number }[] = [];
  for (let t = 0; t < tries; t += 1) {
    const plane = planeThrough(pick(), pick(), pick());
    // 바닥은 거의 수평이다 (15° 넘게 기울면 버림)
    if (!plane || Math.hypot(plane.a, plane.b) > 0.27) continue;
    let score = 0;
    for (const f of candidates) if (Math.abs(heightAbove(plane, f.cx, f.cy, f.cz)) < INLIER) score += f.area;
    found.push({ plane, score, y: plane.a * mx + plane.b * mz + plane.c });
  }
  const top = Math.max(0, ...found.map((f) => f.score));
  if (top < MIN_FLOOR_AREA) return null;
  // 가구 받침의 윗면(둥근 받침 등)도 넓은 위를 향한 면이다. 바닥은 그보다 아래에 있으므로,
  // 충분히 넓은(가장 넓은 것의 30% 이상) 평면 가운데 가장 낮은 것을 바닥으로 본다
  const enough = found.filter((f) => f.score >= Math.max(MIN_FLOOR_AREA, top * 0.3));
  const lowest = enough.reduce((low, f) => (f.y < low.y - INLIER || (Math.abs(f.y - low.y) <= INLIER && f.score > low.score) ? f : low));
  const inliers = candidates.filter((f) => Math.abs(heightAbove(lowest.plane, f.cx, f.cy, f.cz)) < INLIER);
  return fitPlane(inliers) ?? lowest.plane;
}

/** 바닥 조각을 지운 면 목록(꼭짓점 번호). 세 꼭짓점이 모두 바닥에서 cut보다 낮거나 바닥 아래인 면을 지운다 */
export function cutFloor(pos: ArrayLike<number>, idx: ArrayLike<number>, plane: FloorPlane, cut: number): { kept: Uint32Array; removed: Uint32Array } {
  const kept: number[] = [];
  const removed: number[] = [];
  const h = (v: number) => heightAbove(plane, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
  for (let f = 0; f + 2 < idx.length; f += 3) {
    const tri = [idx[f], idx[f + 1], idx[f + 2]];
    (Math.max(h(tri[0]), h(tri[1]), h(tri[2])) < cut ? removed : kept).push(...tri);
  }
  return { kept: Uint32Array.from(kept), removed: Uint32Array.from(removed) };
}

/**
 * 바닥 평면의 법선을 +y로 돌리는 회전(3×3, 행 우선)과, 돌린 뒤 바닥의 높이.
 * 점 p를 R·p로 옮긴 뒤 y에서 floorY를 빼면 바닥이 y = 0 이 된다.
 */
export function levelRotation(plane: FloorPlane): { m: number[]; floorY: number } {
  const len = Math.sqrt(plane.a * plane.a + 1 + plane.b * plane.b);
  const n = [-plane.a / len, 1 / len, -plane.b / len];
  // n → (0,1,0): 축 = n × y, 각 = acos(n·y) (로드리게스 회전)
  const ax = -n[2];
  const az = n[0];
  const s = Math.hypot(ax, az);
  const c = n[1];
  let m: number[];
  if (s < 1e-9) m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  else {
    const kx = ax / s;
    const kz = az / s;
    const t = 1 - c;
    m = [c + kx * kx * t, -kz * s, kx * kz * t, kz * s, c, -kx * s, kx * kz * t, kx * s, c + kz * kz * t];
  }
  // 평면 위의 한 점 (0, c, 0) 이 돌린 뒤 놓이는 높이
  const floorY = m[4] * plane.c;
  return { m, floorY };
}

/**
 * 위에서 본 점들(x, z)의 테두리 상자가 가장 작아지는 회전각(라디안, 0~π/2). 점들을 −각만큼 돌리면 상자가 축에 나란해진다.
 * 1°씩 재고 가장 좋은 곳 근처를 0.1°씩 다시 잰다.
 */
export function footprintAngle(xz: ArrayLike<number>): number {
  const n = Math.floor(xz.length / 2);
  if (n < 3) return 0;
  // 점이 많으면 고르게 덜어 낸다
  const step = Math.max(1, Math.floor(n / 4000));
  const area = (angle: number) => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < n; i += step) {
      const x = xz[i * 2];
      const z = xz[i * 2 + 1];
      const u = x * c + z * s;
      const v = -x * s + z * c;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    return (maxU - minU) * (maxV - minV);
  };
  let best = 0;
  let bestArea = area(0);
  for (let deg = 1; deg < 90; deg += 1) {
    const a = area((deg * Math.PI) / 180);
    if (a < bestArea - 1e-12) {
      bestArea = a;
      best = deg;
    }
  }
  let fine = best;
  for (let deg = best - 1; deg <= best + 1; deg += 0.1) {
    const a = area((deg * Math.PI) / 180);
    if (a < bestArea - 1e-12) {
      bestArea = a;
      fine = deg;
    }
  }
  // 거의 0°(축에 나란한 스캔)면 돌리지 않는다
  const rad = (((fine % 90) + 90) % 90) * (Math.PI / 180);
  return Math.abs(rad) < 0.2 * (Math.PI / 180) ? 0 : rad;
}
