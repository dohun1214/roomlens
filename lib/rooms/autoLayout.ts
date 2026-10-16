// 자동 보정: 스플랫 장면의 표면 점(lib/three/scenePoints.ts)에서 방의 위쪽 방향, 바닥·천장 높이, 크기(단위), 벽 윤곽을 찾는다.
// 사람이 탭하던 "바닥 세 곳 + 모서리"를 계산으로 대신한다. 결과 모서리는 파일 좌표의 바닥 위 점이라
// 기존 보정 계산(lib/three/roomTransform.ts의 calibrateRoom)에 그대로 넣을 수 있다.
//
// 1) 주된 방향: 납작한 스플랫의 법선을 모아 가장 많은 방향 셋(서로 직각)을 찾는다 (벽·바닥이 만드는 맨해튼 축)
// 2) 위쪽: 세 축 × 두 방향 중 "바닥·천장답게" 보이는 것 (아래쪽에 넓은 수평면, 그 위로 가구, 위쪽에 넓은 수평면)
// 3) 크기: 바닥~천장이 사람 사는 방 높이(2.1~3.1 m)면 파일 단위가 m라고 보고, 아니면 2.45 m로 맞춘다 (사용자가 확인)
// 4) 벽 윤곽: 문틀 위·천장 아래 높이의 세로 표면을 격자에 찍어 "벽"을 만들고, 바닥이 보이는 곳에서 벽에 막힐 때까지
//    채운 영역을 직각 다각형으로 줄인다. 가구는 이 높이에 거의 없어서 모서리를 가리지 않는다.
// 순수 계산이라 node에서도 돈다 (점 파일로 성능을 잴 때).
import type { ScenePoints } from '@/lib/three/scenePoints';

export type Vec3 = [number, number, number];
export type Point2 = [number, number];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

/** 사람 사는 방으로 보는 천장 높이 범위 (m). 이 안이면 파일 단위가 m라고 본다 (거실·다락의 높은 천장까지) */
export const METRIC_HEIGHT_RANGE: [number, number] = [2.1, 3.6];
/** 단위를 모를 때 가정하는 천장 높이 (m) */
export const ASSUMED_CEILING = 2.45;
/** 벽 윤곽 격자 한 칸 (m) */
export const GRID = 0.05;
/** 이보다 짧은 벽 조각(오목·볼록한 작은 턱)은 지운다 (m) */
export const MIN_WALL = 0.45;

export type LayoutEstimate = {
  /** 위쪽 방향 (파일 좌표, 단위 벡터) */
  up: Vec3;
  /** 바닥 위의 두 직각 방향 (파일 좌표) */
  axes: [Vec3, Vec3];
  /** up 방향으로 잰 바닥·천장 위치 (파일 단위) */
  floor: number;
  ceiling: number;
  /** 1 파일 단위 = scale m */
  scale: number;
  /** 단위를 천장 높이로 짐작했는지 (사용자 확인이 필요) */
  scaleGuessed: boolean;
  /** 방 모서리 (파일 좌표의 바닥 위 점), 방을 한 바퀴 도는 순서 */
  corners: Vec3[];
  /** 방 모서리 (바닥 위 2D, m, axes 기준) */
  outline: Point2[];
  /** 장면에서 찾은 방의 수 (여러 방이 함께 찍혔으면 다른 방을 고를 수 있다) */
  rooms: number;
  /** 확인용 정보 */
  info: { upScores: number[]; floorShare: number; wallCells: number; regionCells: number };
};

// ---------- 1) 주된 방향 ----------

/** 반구를 고르게 덮는 방향들 (피보나치 격자) */
function hemisphere(count: number): Vec3[] {
  const out: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const z = 1 - i / (count - 1); // 1 → 0 (위쪽 반구)
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const t = golden * i;
    out.push([Math.cos(t) * r, Math.sin(t) * r, z]);
  }
  return out;
}

/** 법선들(부호 무시)을 모아 가장 많이 몰린 방향. exclude가 있으면 그 방향과 직각(±tol)인 것만 */
function peakDirection(normals: Vec3[], weights: number[], candidates: Vec3[], perpendicularTo?: Vec3): Vec3 | null {
  const cosNear = Math.cos((6 * Math.PI) / 180);
  const sinPerp = Math.sin((6 * Math.PI) / 180);
  let best: { c: Vec3; score: number } | null = null;
  for (const c of candidates) {
    if (perpendicularTo && Math.abs(dot(c, perpendicularTo)) > sinPerp) continue;
    let score = 0;
    for (let i = 0; i < normals.length; i += 1) if (Math.abs(dot(normals[i], c)) > cosNear) score += weights[i];
    if (!best || score > best.score) best = { c, score };
  }
  if (!best) return null;
  // 가까운 법선들의 평균으로 다듬는다 (부호를 맞춰서)
  const sum: Vec3 = [0, 0, 0];
  for (let i = 0; i < normals.length; i += 1) {
    const d = dot(normals[i], best.c);
    if (Math.abs(d) <= cosNear) continue;
    const s = d >= 0 ? weights[i] : -weights[i];
    sum[0] += normals[i][0] * s;
    sum[1] += normals[i][1] * s;
    sum[2] += normals[i][2] * s;
  }
  let dir = norm(sum);
  if (perpendicularTo) {
    const d = dot(dir, perpendicularTo);
    dir = norm([dir[0] - perpendicularTo[0] * d, dir[1] - perpendicularTo[1] * d, dir[2] - perpendicularTo[2] * d]);
  }
  return dir;
}

/** 서로 직각인 주된 방향 셋 (맨해튼 축) */
export function dominantAxes(points: ScenePoints, samples = 20_000): [Vec3, Vec3, Vec3] {
  const normals: Vec3[] = [];
  const weights: number[] = [];
  // 파일 순서는 공간적으로 몰려 있으므로 전체를 고르게 건너뛴다
  const step = Math.max(1, Math.floor(points.count / samples));
  for (let i = 0; i < points.count; i += step) {
    const k = i * 3;
    const n: Vec3 = [points.normals[k], points.normals[k + 1], points.normals[k + 2]];
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue;
    normals.push(n);
    weights.push(points.weights[i]);
  }
  const candidates = hemisphere(2500);
  const d1 = peakDirection(normals, weights, candidates) ?? [0, 1, 0];
  // d1에 직각인 후보: d1과 직각인 원 위의 방향들
  const ref: Vec3 = Math.abs(d1[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = norm(cross(d1, ref));
  const e2 = cross(d1, e1);
  const circle: Vec3[] = [];
  for (let k = 0; k < 360; k += 1) {
    const t = (k * Math.PI) / 360; // 0~180° (부호 무시)
    circle.push(norm([e1[0] * Math.cos(t) + e2[0] * Math.sin(t), e1[1] * Math.cos(t) + e2[1] * Math.sin(t), e1[2] * Math.cos(t) + e2[2] * Math.sin(t)]));
  }
  const d2 = peakDirection(normals, weights, circle, d1) ?? e1;
  const d3 = norm(cross(d1, d2));
  return [d1, d2, d3];
}

// ---------- 2) 위쪽·바닥·천장 ----------

export type UpCandidate = { up: Vec3; floor: number; ceiling: number; score: number };

/** 가중 히스토그램 */
function histogram(values: Float32Array, weights: Float32Array, mask: Uint8Array, lo: number, hi: number, bins: number): Float64Array {
  const h = new Float64Array(bins);
  const k = bins / (hi - lo);
  for (let i = 0; i < values.length; i += 1) {
    if (!mask[i]) continue;
    const b = Math.floor((values[i] - lo) * k);
    if (b >= 0 && b < bins) h[b] += weights[i];
  }
  return h;
}

const quantile = (sorted: Float32Array, t: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(t * sorted.length)))];

/**
 * 한 방향을 위쪽이라고 볼 때의 바닥·천장과 점수.
 * 바닥 = 아래쪽 범위에서 수평면이 가장 많이 몰린 높이, 천장 = 위쪽 범위에서 그런 높이.
 * 점수: 바닥이 넓게 깔려 있고(수평면 무게), 가구는 바닥 쪽 절반에 몰려 있고(아래·위 비대칭), 천장도 있는지.
 */
/** 한 방향(up)으로 본 높이 분포: 바닥·천장 후보와 위아래를 가릴 단서들 */
export type HeightProfile = {
  /** 점들의 높이 범위 (0.5~99.5%, 파일 단위) */
  span: number;
  /** 아래쪽 끝의 넓은 수평면(바닥 후보)과 위쪽 끝의 것(천장 후보)의 높이 */
  low: number;
  high: number;
  /** 그 두 수평면의 무게 비율 (전체 대비) */
  lowShare: number;
  highShare: number;
  /** 그 두 수평면의 평균 밝기 (0~1, 밝기를 모르면 0.5) */
  lowBright: number;
  highBright: number;
  /** 두 면 사이에서 아래 절반 무게 - 위 절반 무게 (비율). 가구는 바닥 쪽에 있다 */
  asym: number;
  /** 세로 표면(벽)이 있는 높이의 아래·위 끝 (2%, 98%). 천장이 스캔되지 않았을 때 벽의 꼭대기를 천장으로 본다 */
  wallLow: number;
  wallHigh: number;
  /** 아래·위 수평면에 속한 점들의 평균 법선 (부호는 up 쪽으로). 바닥이 맨해튼 축과 조금 기울었을 때 쓴다 */
  lowNormal: Vec3;
  highNormal: Vec3;
};

/** 위쪽 방향 up(부호 포함)으로 본 높이 분포 */
export function heightProfile(points: ScenePoints, up: Vec3): HeightProfile {
  const n = points.count;
  const h = new Float32Array(n);
  const horiz = new Uint8Array(n);
  const any = new Uint8Array(n).fill(1);
  const cos20 = Math.cos((20 * Math.PI) / 180);
  for (let i = 0; i < n; i += 1) {
    const k = i * 3;
    h[i] = points.positions[k] * up[0] + points.positions[k + 1] * up[1] + points.positions[k + 2] * up[2];
    const nd = points.normals[k] * up[0] + points.normals[k + 1] * up[1] + points.normals[k + 2] * up[2];
    horiz[i] = Math.abs(nd) > cos20 ? 1 : 0;
  }
  const sorted = Float32Array.from(h).sort();
  const q0 = quantile(sorted, 0.005);
  const q1 = quantile(sorted, 0.995);
  // 바닥·천장이 범위 끝에 걸리지 않게 조금 넓힌다
  const pad = (q1 - q0) * 0.03;
  const lo = q0 - pad;
  const hi = q1 + pad;
  const span = q1 - q0;
  const empty: HeightProfile = { span, low: q0, high: q1, lowShare: 0, highShare: 0, lowBright: 0.5, highBright: 0.5, asym: 0, wallLow: q0, wallHigh: q1, lowNormal: up, highNormal: up };
  if (!(span > 0)) return empty;
  const bins = 400;
  const hz = histogram(h, points.weights, horiz, lo, hi, bins);
  const all = histogram(h, points.weights, any, lo, hi, bins);
  const total = all.reduce((sum, v) => sum + v, 0) || 1;
  const smooth = (arr: Float64Array, i: number) => (arr[i - 1] ?? 0) + arr[i] + (arr[i + 1] ?? 0);
  const half = Math.floor(bins / 2);
  // 아래쪽 끝: 아래 절반에서 가장 큰 수평면 봉우리의 25% 이상인 가장 낮은 봉우리
  let lowMax = 0;
  for (let i = 0; i < half; i += 1) lowMax = Math.max(lowMax, smooth(hz, i));
  let lb = 0;
  for (let i = 0; i < half; i += 1) {
    if (smooth(hz, i) >= lowMax * 0.25 && smooth(hz, i) >= smooth(hz, i - 1) && smooth(hz, i) >= smooth(hz, i + 1)) {
      lb = i;
      break;
    }
  }
  let highMax = 0;
  for (let i = bins - 1; i >= half; i -= 1) highMax = Math.max(highMax, smooth(hz, i));
  let hb = bins - 1;
  for (let i = bins - 1; i >= half; i -= 1) {
    if (smooth(hz, i) >= highMax * 0.25 && smooth(hz, i) >= smooth(hz, i - 1) && smooth(hz, i) >= smooth(hz, i + 1)) {
      hb = i;
      break;
    }
  }
  const at = (b: number) => lo + ((b + 0.5) / bins) * (hi - lo);
  // 두 면의 밝기
  const bright = (b: number) => {
    if (!points.brightness) return 0.5;
    const [b0, b1] = [at(b - 2), at(b + 2)];
    let sum = 0;
    let w = 0;
    for (let i = 0; i < n; i += 1) {
      if (!horiz[i] || h[i] < b0 || h[i] > b1) continue;
      sum += points.brightness[i] * points.weights[i];
      w += points.weights[i];
    }
    return w > 0 ? sum / w : 0.5;
  };
  // 두 면의 평균 법선 (up 쪽 부호로 맞춘다)
  const meanNormal = (b: number): Vec3 => {
    const [b0, b1] = [at(b - 2), at(b + 2)];
    const sum: Vec3 = [0, 0, 0];
    for (let i = 0; i < n; i += 1) {
      if (!horiz[i] || h[i] < b0 || h[i] > b1) continue;
      const k = i * 3;
      const nn: Vec3 = [points.normals[k], points.normals[k + 1], points.normals[k + 2]];
      const sgn = dot(nn, up) >= 0 ? points.weights[i] : -points.weights[i];
      sum[0] += nn[0] * sgn;
      sum[1] += nn[1] * sgn;
      sum[2] += nn[2] * sgn;
    }
    return sum[0] === 0 && sum[1] === 0 && sum[2] === 0 ? up : norm(sum);
  };
  // 세로 표면의 높이 범위
  const sin25 = Math.sin((25 * Math.PI) / 180);
  const vh: number[] = [];
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 100_000))) {
    const k = i * 3;
    const nd = Math.abs(points.normals[k] * up[0] + points.normals[k + 1] * up[1] + points.normals[k + 2] * up[2]);
    const has = points.normals[k] !== 0 || points.normals[k + 1] !== 0 || points.normals[k + 2] !== 0;
    if (has && nd < sin25) vh.push(h[i]);
  }
  vh.sort((p, q) => p - q);
  const vq = (t: number) => (vh.length ? vh[Math.min(vh.length - 1, Math.floor(t * vh.length))] : t < 0.5 ? q0 : q1);
  let lower = 0;
  let upper = 0;
  const mid = Math.floor((lb + hb) / 2);
  for (let i = lb + 3; i < hb - 2; i += 1) {
    if (i < mid) lower += all[i];
    else upper += all[i];
  }
  return {
    span,
    low: at(lb),
    high: at(hb),
    lowShare: smooth(hz, lb) / total,
    highShare: smooth(hz, hb) / total,
    lowBright: bright(lb),
    highBright: bright(hb),
    asym: (lower - upper) / Math.max(1e-9, lower + upper),
    wallLow: vq(0.02),
    wallHigh: vq(0.98),
    lowNormal: meanNormal(lb),
    highNormal: meanNormal(hb),
  };
}

/** 위쪽이 +up 쪽이라는 쪽의 표 (음수면 반대가 위쪽). 가구가 아래에 몰림 + 아래 수평면이 더 넓음 + 위(천장)가 더 밝음 */
export function upVote(p: HeightProfile): number {
  const share = (p.lowShare - p.highShare) / Math.max(1e-9, p.lowShare + p.highShare);
  return p.asym + 0.3 * share + 0.3 * (p.highBright - p.lowBright);
}

/**
 * 위쪽 방향과 바닥·천장. 방은 보통 높이(2~3 m)가 가로·세로보다 짧으므로 점들의 범위가 가장 좁은 주된 방향을 위아래로 보고,
 * 부호는 upVote로 정한다. 천장이 스캔되지 않았으면(위쪽 수평면이 약하면) 벽의 꼭대기를 천장으로 본다.
 */
export function chooseUp(points: ScenePoints, axes: [Vec3, Vec3, Vec3], flip = false): UpCandidate & { profile: HeightProfile; spans: number[] } {
  const profiles = axes.map((a) => heightProfile(points, a));
  const spans = profiles.map((p) => p.span);
  const k = spans.indexOf(Math.min(...spans));
  const p = profiles[k];
  let positive = upVote(p) >= 0;
  if (flip) positive = !positive;
  let up = positive ? axes[k] : neg(axes[k]);
  // 위쪽 방향으로 잰 높이: 반대 방향이면 부호와 위·아래가 바뀐다
  let floor = positive ? p.low : -p.high;
  const strongCeiling = (positive ? p.highShare : p.lowShare) >= 0.15 * (positive ? p.lowShare : p.highShare);
  const ceilingRaw = positive ? p.high : -p.low;
  // 천장이 스캔되지 않았으면 벽의 꼭대기
  const wallTop = positive ? p.wallHigh : -p.wallLow;
  let ceiling = strongCeiling ? ceilingRaw : Math.max(floor + 0.5, wallTop);
  // 바닥이 맨해튼 축과 뚜렷하게(4~20°) 기울었으면 바닥면의 법선을 위쪽으로 쓴다 (벽보다 바닥이 보정의 기준이다).
  // 스플랫의 법선은 몇 도씩 흔들리므로 작은 차이는 무시한다
  const floorNormal = positive ? p.lowNormal : neg(p.highNormal);
  const tilt = (Math.acos(Math.min(1, Math.abs(dot(floorNormal, up)))) * 180) / Math.PI;
  if (tilt > 4 && tilt < 20) {
    const height = ceiling - floor;
    up = dot(floorNormal, up) >= 0 ? floorNormal : neg(floorNormal);
    // 기울인 위쪽으로 바닥 높이를 다시 잰다: 바닥면 점들의 높이 가운뎃값
    const hs: number[] = [];
    const cosF = Math.cos((20 * Math.PI) / 180);
    for (let i = 0; i < points.count; i += 1) {
      const k3 = i * 3;
      const pv: Vec3 = [points.positions[k3], points.positions[k3 + 1], points.positions[k3 + 2]];
      const nv: Vec3 = [points.normals[k3], points.normals[k3 + 1], points.normals[k3 + 2]];
      const hh = dot(pv, up);
      if (Math.abs(dot(nv, up)) > cosF && Math.abs(hh - floor) < 0.15 * height) hs.push(hh);
    }
    if (hs.length > 50) {
      hs.sort((a, b) => a - b);
      floor = hs[Math.floor(hs.length / 2)];
      ceiling = floor + height;
    }
  }
  return { up, floor, ceiling, score: upVote(p), profile: p, spans };
}

// ---------- 4) 벽 윤곽 ----------

type Grid = { nx: number; nz: number; x0: number; z0: number; cell: number };

/** 직각 다각형의 경계를 따라 꼭짓점을 구한다 (마스크 1인 칸들의 바깥 경계). 가장 큰 덩어리 하나만 */
export function traceOutline(mask: Uint8Array, g: Grid): Point2[] {
  const { nx, nz } = g;
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < nx && j < nz ? mask[j * nx + i] : 0);
  // 시작: 맨 아래 줄의 가장 왼쪽 칸의 왼쪽 아래 꼭짓점
  let si = -1;
  let sj = -1;
  for (let j = 0; j < nz && si < 0; j += 1)
    for (let i = 0; i < nx; i += 1)
      if (at(i, j)) {
        si = i;
        sj = j;
        break;
      }
  if (si < 0) return [];
  // 격자 꼭짓점 위를 걷는다. 방향: 0=+x,1=+z,2=-x,3=-z. 영역을 왼쪽에 두고 돈다
  const dirs: Point2[] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  // 꼭짓점 (vi, vj)에서 방향 d로 나아갈 때 왼쪽·오른쪽 칸
  const leftCell = (vi: number, vj: number, d: number): [number, number] => [
    [vi, vj],
    [vi - 1, vj],
    [vi - 1, vj - 1],
    [vi, vj - 1],
  ][d] as [number, number];
  const rightCell = (vi: number, vj: number, d: number): [number, number] => [
    [vi, vj - 1],
    [vi, vj],
    [vi - 1, vj],
    [vi - 1, vj - 1],
  ][d] as [number, number];
  let vi = si;
  let vj = sj;
  let d = 0;
  const pts: Point2[] = [];
  const limit = (nx + 1) * (nz + 1) * 4;
  for (let steps = 0; steps < limit; steps += 1) {
    // 왼쪽으로 꺾을 수 있으면 꺾고, 아니면 곧장, 아니면 오른쪽
    let turned = false;
    for (const nd of [(d + 1) % 4, d, (d + 3) % 4, (d + 2) % 4]) {
      const [li, lj] = leftCell(vi, vj, nd);
      const [ri, rj] = rightCell(vi, vj, nd);
      if (at(li, lj) && !at(ri, rj)) {
        if (nd !== d || pts.length === 0) pts.push([vi, vj]);
        d = nd;
        turned = true;
        break;
      }
    }
    if (!turned) break;
    vi += dirs[d][0];
    vj += dirs[d][1];
    if (vi === si && vj === sj) break;
  }
  return pts.map(([i, j]) => [g.x0 + i * g.cell, g.z0 + j * g.cell]);
}

/** 직각 다각형에서 짧은 벽 조각을 지운다: 가장 짧은 변을 없애고 양옆의 평행한 변을 길이로 가중 평균한 자리에 맞춘다 */
export function simplifyOrthogonal(poly: Point2[], minEdge = MIN_WALL): Point2[] {
  let pts = dedupe(poly);
  for (let guard = 0; guard < 20000 && pts.length > 4; guard += 1) {
    const n = pts.length;
    let k = -1;
    let shortest = minEdge;
    for (let i = 0; i < n; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
      if (len < shortest) {
        shortest = len;
        k = i;
      }
    }
    if (k < 0) break;
    // 변 k = pts[k] → pts[k+1]. 앞뒤 변 (k-1: pts[k-1]→pts[k], k+1: pts[k+1]→pts[k+2]) 은 서로 평행
    const p0 = pts[(k + n - 1) % n];
    const p1 = pts[k];
    const p2 = pts[(k + 1) % n];
    const p3 = pts[(k + 2) % n];
    const horizontal = Math.abs(p1[1] - p0[1]) < 1e-9; // 앞 변이 x 방향
    const l0 = Math.abs(p1[0] - p0[0]) + Math.abs(p1[1] - p0[1]);
    const l2 = Math.abs(p3[0] - p2[0]) + Math.abs(p3[1] - p2[1]);
    const w = l0 + l2 || 1;
    if (horizontal) {
      const z = (p0[1] * l0 + p2[1] * l2) / w;
      p0[1] = z;
      p3[1] = z;
    } else {
      const x = (p0[0] * l0 + p2[0] * l2) / w;
      p0[0] = x;
      p3[0] = x;
    }
    // p1, p2를 지운다
    const remove = new Set([k, (k + 1) % n]);
    pts = dedupe(pts.filter((_, i) => !remove.has(i)));
  }
  return pts;
}

/** 거의 같은 점과 한 직선 위의 점을 뺀다 */
function dedupe(poly: Point2[]): Point2[] {
  let pts = poly.map((p) => [p[0], p[1]] as Point2);
  for (let changed = true; changed && pts.length > 3; ) {
    changed = false;
    const n = pts.length;
    for (let i = 0; i < n; i += 1) {
      const a = pts[(i + n - 1) % n];
      const p = pts[i];
      const b = pts[(i + 1) % n];
      const same = Math.abs(p[0] - b[0]) < 1e-6 && Math.abs(p[1] - b[1]) < 1e-6;
      const straight = (Math.abs(a[0] - p[0]) < 1e-6 && Math.abs(p[0] - b[0]) < 1e-6) || (Math.abs(a[1] - p[1]) < 1e-6 && Math.abs(p[1] - b[1]) < 1e-6);
      if (same || straight) {
        pts = pts.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/** 4방향으로 이어진 덩어리 번호 매기기 */
function components(mask: Uint8Array, nx: number, nz: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(nx * nz).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < nx * nz; s += 1) {
    if (!mask[s] || labels[s] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    labels[s] = id;
    stack.push(s);
    while (stack.length) {
      const c = stack.pop()!;
      size += 1;
      const i = c % nx;
      const j = (c - i) / nx;
      const next = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < nz - 1 ? c + nx : -1];
      for (const q of next) {
        if (q >= 0 && mask[q] && labels[q] < 0) {
          labels[q] = id;
          stack.push(q);
        }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/** 문틀 위의 벽(인방)이 안 보이는 출입구도 방의 경계로 막는다 (m) */
export const DOOR_GAP = 1.25;
/** 이만큼 이상 가로·세로로 이어진 벽끼리만 잇는다 (세로로 지나가는 벽의 단면은 짧아서 잇지 않는다) (m) */
const MIN_WALL_RUN = 0.3;

/**
 * 같은 줄(가로 또는 세로) 위에서 maxGap칸 이하로 끊긴 벽을 잇는다. 끊긴 양쪽 벽이 그 줄 방향으로 minRun칸 넘게 이어질 때만.
 * 벽이 끊긴 곳은 대부분 출입구라서, 이어야 이웃한 방으로 새어 나가지 않는다.
 */
export function closeDoorways(mask: Uint8Array, nx: number, nz: number, maxGap: number, minRun: number): void {
  const fill = (len: number, at: (k: number) => number) => {
    const runs: [number, number][] = [];
    let start = -1;
    for (let k = 0; k <= len; k += 1) {
      const on = k < len && mask[at(k)] === 1;
      if (on && start < 0) start = k;
      if (!on && start >= 0) {
        runs.push([start, k - 1]);
        start = -1;
      }
    }
    for (let r = 1; r < runs.length; r += 1) {
      const [a0, a1] = runs[r - 1];
      const [b0, b1] = runs[r];
      const gap = b0 - a1 - 1;
      if (gap > 0 && gap <= maxGap && a1 - a0 + 1 >= minRun && b1 - b0 + 1 >= minRun) for (let k = a1 + 1; k < b0; k += 1) mask[at(k)] = 2;
    }
  };
  for (let j = 0; j < nz; j += 1) fill(nx, (i) => j * nx + i);
  for (let i = 0; i < nx; i += 1) fill(nz, (j) => j * nx + i);
  for (let c = 0; c < mask.length; c += 1) if (mask[c] === 2) mask[c] = 1;
}

function dilate(mask: Uint8Array, nx: number, nz: number, r: number): Uint8Array {
  let cur = mask;
  for (let k = 0; k < r; k += 1) {
    const out = new Uint8Array(cur);
    for (let j = 0; j < nz; j += 1)
      for (let i = 0; i < nx; i += 1) {
        const c = j * nx + i;
        if (cur[c]) continue;
        if ((i > 0 && cur[c - 1]) || (i < nx - 1 && cur[c + 1]) || (j > 0 && cur[c - nx]) || (j < nz - 1 && cur[c + nx])) out[c] = 1;
      }
    cur = out;
  }
  return cur;
}

export type OutlineInput = {
  /** 바닥 위 2D 좌표 (m) */
  xs: Float32Array;
  zs: Float32Array;
  /** 바닥에서의 높이 (m) */
  hs: Float32Array;
  /** 표면이 수평인지(1)·수직인지(2)·모름(0) */
  kind: Uint8Array;
  weights: Float32Array;
  /** 천장 높이 (m) */
  height: number;
};

/** 벽 윤곽 (2D, m). 실패하면 빈 배열 */
export type OutlineDebug = { nx: number; nz: number; x0: number; z0: number; cell: number; wall: Uint8Array; floor: Float32Array; region: Uint8Array };

export type OutlineOptions = {
  /** 바닥이 많이 보이는 순서로 몇 번째 방을 고를지 (0 = 가장 많이 보이는 방) */
  pick?: number;
  /** 이 점(2D)이 들어 있는 방을 고른다 */
  seed?: Point2;
};

export type OutlineResult = { outline: Point2[]; wallCells: number; regionCells: number; candidates: number; center?: Point2 };

export function roomOutline(input: OutlineInput, cell = GRID, debug?: (d: OutlineDebug) => void, options: OutlineOptions = {}): OutlineResult {
  const { xs, zs, hs, kind, weights, height } = input;
  const n = xs.length;
  // 범위: 바닥 점들의 1~99%
  const floorX: number[] = [];
  const floorZ: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (Math.abs(hs[i]) >= 0.1) continue;
    floorX.push(xs[i]);
    floorZ.push(zs[i]);
  }
  if (floorX.length < 50) return { outline: [], wallCells: 0, regionCells: 0, candidates: 0 };
  floorX.sort((a, b) => a - b);
  floorZ.sort((a, b) => a - b);
  const q = (arr: number[], t: number) => arr[Math.floor(t * (arr.length - 1))];
  const margin = 0.6;
  const x0 = q(floorX, 0.005) - margin;
  const z0 = q(floorZ, 0.005) - margin;
  const nx = Math.min(800, Math.ceil((q(floorX, 0.995) + margin - x0) / cell));
  const nz = Math.min(800, Math.ceil((q(floorZ, 0.995) + margin - z0) / cell));
  const g: Grid = { nx, nz, x0, z0, cell };
  const floor = new Float32Array(nx * nz);
  const low = new Float32Array(nx * nz);
  // 벽 찾기: 칸마다 "세로 표면이 어느 높이들에 있는지"를 10cm 칸(최대 32칸)으로 적어 둔다.
  // 벽은 바닥에서 천장까지 이어지고, 가구는 낮고, 천장 근처의 흐린 점은 한 높이에만 있다
  const slotH = Math.max(0.1, height / 32);
  const any = new Uint32Array(nx * nz); // 수평이 아닌 점(세로 + 방향 모름)
  const vert = new Uint32Array(nx * nz); // 세로 표면만
  for (let i = 0; i < n; i += 1) {
    const ci = Math.floor((xs[i] - x0) / cell);
    const cj = Math.floor((zs[i] - z0) / cell);
    if (ci < 0 || cj < 0 || ci >= nx || cj >= nz) continue;
    const c = cj * nx + ci;
    const h = hs[i];
    if (Math.abs(h) < 0.06 && kind[i] !== 2) floor[c] += weights[i];
    else if (h > 0.06 && h < 1.8) low[c] += weights[i];
    if (kind[i] === 1 || h < 0 || h >= height) continue;
    const bit = 1 << Math.min(31, Math.floor(h / slotH));
    any[c] |= bit;
    if (kind[i] === 2) vert[c] |= bit;
  }
  const slotsBetween = (lo: number, hi: number) => {
    let mask = 0;
    for (let k = Math.max(0, Math.floor(lo / slotH)); k <= Math.min(31, Math.floor(hi / slotH)); k += 1) mask |= 1 << k;
    return mask >>> 0;
  };
  const popcount = (v: number) => {
    let x = v >>> 0;
    let count = 0;
    while (x) {
      x &= x - 1;
      count += 1;
    }
    return count;
  };
  // 1) 벽 몸통: 1 m부터 천장 조금 아래까지 60% 넘게 채워진 칸
  const body = slotsBetween(1.0, height - 0.2);
  const bodyN = popcount(body);
  // 벽은 천장까지 닿는다 (옷장·책장은 천장 아래에서 끝난다)
  const top = slotsBetween(height - 0.6, height - 0.2);
  const topN = popcount(top);
  // 2) 문·창문 위의 벽(인방): 2 m부터 천장 조금 아래까지, 세로 표면이 절반 넘게 (천장의 흐린 점은 세로 표면이 아니다)
  const header = height - 0.12 > 2.15 ? slotsBetween(2.02, height - 0.12) : 0;
  const headerN = popcount(header);
  // 점이 듬성한 장면에서도 벽이 끊기지 않게 이웃 칸(3×3)의 높이 표시를 합쳐서 본다
  const near = (src: Uint32Array, c: number) => {
    const i = c % nx;
    const j = (c - i) / nx;
    let v = 0;
    for (let dj = -1; dj <= 1; dj += 1) {
      if (j + dj < 0 || j + dj >= nz) continue;
      for (let di = -1; di <= 1; di += 1) if (i + di >= 0 && i + di < nx) v |= src[c + dj * nx + di];
    }
    return v >>> 0;
  };
  const wallMask = new Uint8Array(nx * nz);
  let wallCells = 0;
  for (let c = 0; c < nx * nz; c += 1) {
    if (!any[c]) continue;
    const column = near(any, c);
    const isBody = bodyN > 0 && popcount(column & body) >= bodyN * 0.6 && popcount(column & top) >= topN * 0.5;
    const isHeader = headerN >= 2 && popcount(near(vert, c) & header) >= headerN * 0.5;
    if (isBody || isHeader) {
      wallMask[c] = 1;
      wallCells += 1;
    }
  }
  closeDoorways(wallMask, nx, nz, Math.round(DOOR_GAP / cell), Math.round(MIN_WALL_RUN / cell));
  const wallThick = dilate(wallMask, nx, nz, 1);
  // 방 안 후보: 벽이 아니고, 바닥이나 가구가 보이는 칸 + 벽으로 둘러싸인 칸(바닥이 스캔되지 않은 곳도 방이다)
  const seen = new Uint8Array(nx * nz);
  for (let c = 0; c < nx * nz; c += 1) if (floor[c] > 0 || low[c] > 0) seen[c] = 1;
  const seenNear = dilate(seen, nx, nz, 1);
  const free = new Uint8Array(nx * nz);
  for (let c = 0; c < nx * nz; c += 1) free[c] = wallThick[c] ? 0 : 1;
  const enclosed = enclosedCells(free, nx, nz);
  const open = new Uint8Array(nx * nz);
  for (let c = 0; c < nx * nz; c += 1) if (free[c] && (seenNear[c] || enclosed[c])) open[c] = 1;
  const { labels, sizes } = components(open, nx, nz);
  if (sizes.length === 0) return { outline: [], wallCells, regionCells: 0, candidates: 0 };
  // 덩어리마다 바닥이 보이는 정도. 가장 많이 보이는 것부터 (작은 덩어리는 방이 아니다)
  const floorBy = new Float64Array(sizes.length);
  for (let c = 0; c < nx * nz; c += 1) if (labels[c] >= 0) floorBy[labels[c]] += floor[c] + 0.3 * low[c];
  const minCells = Math.round(2 / (cell * cell));
  const ranked = sizes
    .map((size, k) => ({ k, size, score: floorBy[k] }))
    .filter((r) => r.size >= minCells)
    .sort((a, b) => b.score - a.score)
    .filter((r, i, all) => i === 0 || r.score >= all[0].score * 0.1)
    .slice(0, 5);
  if (ranked.length === 0) return { outline: [], wallCells, regionCells: 0, candidates: 0 };
  let pick = ranked[Math.min(options.pick ?? 0, ranked.length - 1)].k;
  if (options.seed) {
    const si = Math.floor((options.seed[0] - x0) / cell);
    const sj = Math.floor((options.seed[1] - z0) / cell);
    const at = si >= 0 && sj >= 0 && si < nx && sj < nz ? labels[sj * nx + si] : -1;
    if (at >= 0) pick = at;
  }
  const region = new Uint8Array(nx * nz);
  let regionCells = 0;
  for (let c = 0; c < nx * nz; c += 1)
    if (labels[c] === pick) {
      region[c] = 1;
      regionCells += 1;
    }
  // 영역 안의 구멍(가구 밑 등)을 메운다: 바깥에서 닿지 않는 빈칸
  const filled = enclosedCells(Uint8Array.from(region, (v) => (v ? 0 : 1)), nx, nz);
  for (let c = 0; c < nx * nz; c += 1) if (filled[c]) region[c] = 1;
  debug?.({ nx, nz, x0, z0, cell, wall: wallMask, floor, region });
  const raw = traceOutline(region, g);
  const outline = refineWalls(simplifyOrthogonal(raw), input);
  // 영역의 가운데 (다음 계산에서 같은 방을 고를 때)
  let sx = 0;
  let sz = 0;
  for (let c = 0; c < nx * nz; c += 1) {
    if (!region[c]) continue;
    const i = c % nx;
    sx += x0 + (i + 0.5) * cell;
    sz += z0 + ((c - i) / nx + 0.5) * cell;
  }
  return { outline, wallCells, regionCells, candidates: ranked.length, center: [sx / Math.max(1, regionCells), sz / Math.max(1, regionCells)] };
}

/** mask(1 = 지나갈 수 있음)에서 격자 가장자리와 이어지지 않는 칸 (둘러싸인 칸) */
function enclosedCells(mask: Uint8Array, nx: number, nz: number): Uint8Array {
  const out = new Uint8Array(nx * nz);
  const { labels } = components(mask, nx, nz);
  const touching = new Set<number>();
  for (let i = 0; i < nx; i += 1) {
    touching.add(labels[i]);
    touching.add(labels[(nz - 1) * nx + i]);
  }
  for (let j = 0; j < nz; j += 1) {
    touching.add(labels[j * nx]);
    touching.add(labels[j * nx + nx - 1]);
  }
  for (let c = 0; c < nx * nz; c += 1) if (mask[c] && !touching.has(labels[c])) out[c] = 1;
  return out;
}

/** 벽을 찾아 맞출 범위: 윤곽에서 안쪽·바깥쪽으로 이만큼 (m) */
const SNAP_RANGE = 0.45;

/**
 * 직각 윤곽의 벽마다, 그 벽 근처의 세로 표면 점들이 가장 많이 몰린 자리(실제 벽면)로 옮긴다.
 * 격자(5cm)와 벽 두께 때문에 생기는 몇 cm의 어긋남을 1cm 단위로 바로잡는다. 꼭짓점은 이웃한 두 벽의 교점이 된다.
 */
export function refineWalls(outline: Point2[], input: OutlineInput): Point2[] {
  const n = outline.length;
  if (n < 4) return outline;
  const { xs, zs, hs, kind, weights, height } = input;
  const lines = outline.map((a, i) => {
    const b = outline[(i + 1) % n];
    const horizontal = Math.abs(a[1] - b[1]) < 1e-6; // z가 일정한 벽
    return { horizontal, at: horizontal ? a[1] : a[0], lo: Math.min(horizontal ? a[0] : a[1], horizontal ? b[0] : b[1]), hi: Math.max(horizontal ? a[0] : a[1], horizontal ? b[0] : b[1]) };
  });
  const bins = Math.round((2 * SNAP_RANGE) / 0.01);
  const hist = lines.map(() => new Float64Array(bins));
  for (let i = 0; i < xs.length; i += 1) {
    if (kind[i] === 1 || hs[i] < 0.9 || hs[i] > height - 0.15) continue;
    for (let k = 0; k < n; k += 1) {
      const line = lines[k];
      const along = line.horizontal ? xs[i] : zs[i];
      const across = line.horizontal ? zs[i] : xs[i];
      // 벽 끝 15cm는 모서리의 다른 벽이 섞이므로 뺀다
      if (along < line.lo + 0.15 || along > line.hi - 0.15) continue;
      const b = Math.floor((across - line.at + SNAP_RANGE) / 0.01);
      if (b >= 0 && b < bins) hist[k][b] += weights[i];
    }
  }
  // 바깥쪽 방향: 꼭짓점이 도는 방향에 따라 벽의 왼쪽 또는 오른쪽 (윤곽 좌표의 +across 쪽이면 +1)
  let area2 = 0;
  for (let i = 0; i < n; i += 1) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  const outwardSign = outline.map((a, i) => {
    const b = outline[(i + 1) % n];
    // 진행 방향 (dx, dz)의 오른쪽 법선은 (dz, -dx). 반시계(넓이 +)면 바깥은 오른쪽
    const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
    const out = area2 > 0 ? [dz, -dx] : [-dz, dx];
    return lines[i].horizontal ? Math.sign(out[1]) : Math.sign(out[0]);
  });
  const at = lines.map((line, k) => {
    const h = hist[k];
    const smooth = (b: number) => (h[b - 1] ?? 0) + h[b] + (h[b + 1] ?? 0);
    let bestV = 0;
    for (let b = 0; b < bins; b += 1) bestV = Math.max(bestV, smooth(b));
    const total = h.reduce((sum, v) => sum + v, 0);
    // 뚜렷한 벽면이 없으면 그대로
    if (bestV <= 0 || bestV < total * 0.08) return line.at;
    // 벽 앞의 가구·커튼 면보다 벽이 바깥에 있으므로, 충분히 큰 봉우리 가운데 가장 바깥 것
    const order = outwardSign[k] > 0 ? Array.from({ length: bins }, (_, b) => bins - 1 - b) : Array.from({ length: bins }, (_, b) => b);
    for (const b of order) {
      if (smooth(b) >= bestV * 0.45 && smooth(b) >= smooth(b - 1) && smooth(b) >= smooth(b + 1)) return line.at - SNAP_RANGE + (b + 0.5) * 0.01;
    }
    return line.at;
  });
  return outline.map((_, i) => {
    // 꼭짓점 i = 벽 i-1 과 벽 i 가 만나는 곳
    const prev = lines[(i + n - 1) % n];
    const prevAt = at[(i + n - 1) % n];
    const nextAt = at[i];
    const x = prev.horizontal ? nextAt : prevAt;
    const z = prev.horizontal ? prevAt : nextAt;
    return [Math.round(x * 1000) / 1000, Math.round(z * 1000) / 1000] as Point2;
  });
}

// ---------- 전체 ----------

/** 표면 점에서 방의 위쪽·바닥·천장·크기·벽 윤곽을 찾는다 */
export type EstimateOptions = {
  /** 위아래를 반대로 (자동 판단이 틀렸을 때) */
  flipUp?: boolean;
  /** 여러 방이 함께 찍힌 장면에서 몇 번째 방을 고를지 (0 = 바닥이 가장 많이 보이는 방) */
  pick?: number;
  debug?: (d: OutlineDebug) => void;
};

/** 방 하나 근처의 세로 표면 방향으로 잰 벽의 방향(라디안, -45°~45°). 집 전체와 방의 방향이 다를 때 */
function localWallAngle(
  xs: Float32Array,
  zs: Float32Array,
  hs: Float32Array,
  height: number,
  kind: Uint8Array,
  nxs: Float32Array,
  nzs: Float32Array,
  weights: Float32Array,
  box: [number, number, number, number],
): number {
  // 90°마다 같은 방향으로 보고(벽은 서로 직각) 1° 칸의 히스토그램에서 가장 많은 방향을 고른다.
  // 평균을 내면 이웃한 방(다른 방향)의 벽이 섞여 흐려진다
  const hist = new Float64Array(90);
  for (let i = 0; i < xs.length; i += 1) {
    // 가구보다 높은 곳의 세로 표면 = 벽
    if (kind[i] !== 2 || hs[i] < 1.2 || hs[i] > height - 0.3 || xs[i] < box[0] || xs[i] > box[1] || zs[i] < box[2] || zs[i] > box[3]) continue;
    const deg = (((Math.atan2(nzs[i], nxs[i]) * 180) / Math.PI) % 90 + 90) % 90;
    hist[Math.floor(deg) % 90] += weights[i];
  }
  let best = 0;
  let bestV = -1;
  for (let d = 0; d < 90; d += 1) {
    let v = 0;
    for (let k = -2; k <= 2; k += 1) v += hist[(d + k + 90) % 90];
    if (v > bestV) {
      bestV = v;
      best = d;
    }
  }
  // 가운데 칸 주변의 가중 평균으로 다듬는다
  let sum = 0;
  let w = 0;
  for (let k = -2; k <= 2; k += 1) {
    sum += (best + k + 0.5) * hist[(best + k + 90) % 90];
    w += hist[(best + k + 90) % 90];
  }
  const deg = w > 0 ? sum / w : best;
  const folded = deg > 45 ? deg - 90 : deg;
  return (folded * Math.PI) / 180;
}

/** 표면 점에서 방의 위쪽·바닥·천장·크기·벽 윤곽을 찾는다 */
export function estimateRoomLayout(points: ScenePoints, options: EstimateOptions = {}): LayoutEstimate | null {
  if (points.count < 1000) return null;
  const axes = dominantAxes(points);
  const best = chooseUp(points, axes, options.flipUp);
  const up = best.up;
  const other = axes.filter((a) => Math.abs(dot(a, up)) < 0.5)[0] ?? axes[1];
  // 위쪽과 정확히 직각이 되게 다듬는다 (바닥 기울기를 바로잡았을 때)
  let ax = norm([other[0] - up[0] * dot(other, up), other[1] - up[1] * dot(other, up), other[2] - up[2] * dot(other, up)]);
  let az = norm(cross(ax, up)); // 오른손 좌표: x × up = -z 이므로 az는 화면의 +z 방향과 같게
  const heightFile = best.ceiling - best.floor;
  if (!(heightFile > 0)) return null;
  const metric = heightFile >= METRIC_HEIGHT_RANGE[0] && heightFile <= METRIC_HEIGHT_RANGE[1];
  const scale = metric ? 1 : ASSUMED_CEILING / heightFile;

  const n = points.count;
  const xs = new Float32Array(n);
  const zs = new Float32Array(n);
  const hs = new Float32Array(n);
  const kind = new Uint8Array(n);
  // 세로 표면의 바닥 위 방향 (방의 벽 방향을 다시 잴 때)
  const nxs = new Float32Array(n);
  const nzs = new Float32Array(n);
  const cos25 = Math.cos((25 * Math.PI) / 180);
  const sin25 = Math.sin((25 * Math.PI) / 180);
  let floorW = 0;
  let totalW = 0;
  const project = () => {
    for (let i = 0; i < n; i += 1) {
      const k = i * 3;
      const p: Vec3 = [points.positions[k], points.positions[k + 1], points.positions[k + 2]];
      xs[i] = dot(p, ax) * scale;
      zs[i] = dot(p, az) * scale;
    }
  };
  for (let i = 0; i < n; i += 1) {
    const k = i * 3;
    const p: Vec3 = [points.positions[k], points.positions[k + 1], points.positions[k + 2]];
    hs[i] = (dot(p, up) - best.floor) * scale;
    const nv: Vec3 = [points.normals[k], points.normals[k + 1], points.normals[k + 2]];
    const nd = Math.abs(dot(nv, up));
    kind[i] = nv[0] === 0 && nv[1] === 0 && nv[2] === 0 ? 0 : nd > cos25 ? 1 : nd < sin25 ? 2 : 0;
    nxs[i] = dot(nv, ax);
    nzs[i] = dot(nv, az);
    totalW += points.weights[i];
    if (Math.abs(hs[i]) < 0.06) floorW += points.weights[i];
  }
  project();
  const input = { xs, zs, hs, kind, weights: points.weights, height: heightFile * scale };
  let result = roomOutline(input, GRID, undefined, { pick: options.pick });
  // 고른 방의 벽 방향이 집 전체의 주된 방향과 다르면(비스듬히 놓인 방), 그 방향으로 돌려서 다시 찾는다
  if (result.outline.length >= 4 && result.center) {
    const ox = result.outline.map((q) => q[0]);
    const oz = result.outline.map((q) => q[1]);
    const box: [number, number, number, number] = [Math.min(...ox) - 0.3, Math.max(...ox) + 0.3, Math.min(...oz) - 0.3, Math.max(...oz) + 0.3];
    const angle = localWallAngle(xs, zs, hs, heightFile * scale, kind, nxs, nzs, points.weights, box);
    if (Math.abs(angle) > (1.5 * Math.PI) / 180) {
      const [c, sn] = [Math.cos(angle), Math.sin(angle)];
      const center = result.center;
      const rotated: Point2 = [center[0] * c + center[1] * sn, -center[0] * sn + center[1] * c];
      // 새 x축 = 벽의 방향
      const nax = norm([ax[0] * c + az[0] * sn, ax[1] * c + az[1] * sn, ax[2] * c + az[2] * sn]);
      ax = nax;
      az = norm(cross(ax, up));
      project();
      result = roomOutline(input, GRID, options.debug, { seed: rotated });
    } else if (options.debug) {
      roomOutline(input, GRID, options.debug, { pick: options.pick });
    }
  }
  const { outline, wallCells, regionCells, candidates } = result;
  const corners: Vec3[] = outline.map(([x, z]) => {
    const fx = x / scale;
    const fz = z / scale;
    return [ax[0] * fx + az[0] * fz + up[0] * best.floor, ax[1] * fx + az[1] * fz + up[1] * best.floor, ax[2] * fx + az[2] * fz + up[2] * best.floor];
  });
  return {
    up,
    axes: [ax, az],
    floor: best.floor,
    ceiling: best.ceiling,
    scale,
    scaleGuessed: !metric,
    corners,
    outline,
    rooms: candidates,
    info: { upScores: best.spans.map((v) => Math.round(v * 100) / 100), floorShare: floorW / Math.max(1e-9, totalW), wallCells, regionCells },
  };
}
