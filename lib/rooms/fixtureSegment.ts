// 원래 가구 떼어 내기의 AI 분할 (브라우저·서버 공용, DOM·three.js를 쓰지 않는 계산).
// 고른 상자 안의 스플랫만 가구 둘레 여러 시점에서 찍어 그림 AI(Gemini)에 가구·얹힌 물건·따로 선 물건의 상자를 받고,
// 스플랫마다 시점별로 투영해 안팎을 센다. 그 시점에서 다른 스플랫에 가려진 것은 세지 않는다 (가려진 가구 뒤쪽).
// 밖이라고 본 시점이 안이라고 본 시점보다 많으면 옆 물건으로 보고 뺀다. 높은 곳에서 기대 닿은 옆 물건(원탁 등)도 상자 밖으로 삐져나온 곳은 뺀다.
// (Gemini 3.8 Flash의 윤곽 다각형은 어긋나고 시점에 따라 빠지는 일이 많아(11/04 시험) 정확한 상자를 쓴다)
import type { Footprint } from '@/lib/three/floorDrag';
import { fixtureAxes } from './fixtures';

/** 분할에 쓰는 시점 수 (가구 대각선 네 방향) */
export const SEGMENT_VIEWS = 4;
/** 찍는 그림 한 변 (px, 정사각형) */
export const SEGMENT_IMAGE = 640;
/** 내려다보는 각도 (°) */
const ELEVATION_DEG = 30;
/** 세로 시야각 (°) */
const FOV_DEG = 40;
/** 가림을 따지는 칸 (px) */
const CELL_PX = 5;
/** 같은 칸에서 가장 가까운 스플랫보다 이만큼(m) 안쪽까지는 보이는 것으로 본다 (스플랫은 겹쳐 있다) */
const DEPTH_TOLERANCE = 0.05;
/** AI가 이 비율보다 적게 남기면 믿지 않는다 (엉뚱한 것을 골랐거나 가구를 못 찾음) */
export const MIN_SEGMENT_KEEP = 0.35;

export type SegmentView = {
  position: [number, number, number];
  target: [number, number, number];
  fovDeg: number;
  near: number;
  far: number;
};

/** 그림 속 상자: [ymin, xmin, ymax, xmax], 그림 세로·가로를 0~1000으로 */
export type Box2d = [number, number, number, number];
/**
 * AI가 돌려준 시점 하나: 떼어 낼 가구(target), 그 위에 얹혀 함께 옮길 물건(onTop), 옆·뒤에 따로 선 물건(separate)의 상자.
 * 가구를 못 찾았으면 target이 빈 배열
 */
export type SegmentBoxes = { target: Box2d[]; onTop: Box2d[]; separate: Box2d[] };

/**
 * 고른 상자(원래 가구 좌표의 가로 u·깊이 v, 높이 top)를 대각선 네 방향에서 내려다보는 시점.
 * 가구가 그림에 다 들어오게 거리를 잡는다.
 */
export function segmentViews(box: Footprint, top: number): SegmentView[] {
  const [u, v] = fixtureAxes(box.rotationDeg);
  const radius = Math.hypot(box.w / 2, box.d / 2, top / 2);
  const half = ((FOV_DEG / 2) * Math.PI) / 180;
  const dist = (radius / Math.sin(half)) * 1.05;
  const el = (ELEVATION_DEG * Math.PI) / 180;
  const target: [number, number, number] = [box.x, top / 2, box.z];
  const views: SegmentView[] = [];
  for (let k = 0; k < SEGMENT_VIEWS; k += 1) {
    const a = Math.PI / 4 + (k * 2 * Math.PI) / SEGMENT_VIEWS;
    const du = Math.cos(a);
    const dv = Math.sin(a);
    const dx = du * u[0] + dv * v[0];
    const dz = du * u[1] + dv * v[1];
    const h = Math.cos(el) * dist;
    views.push({
      position: [box.x + dx * h, target[1] + Math.sin(el) * dist, box.z + dz * h],
      target,
      fovDeg: FOV_DEG,
      near: Math.max(0.05, dist - radius * 1.5),
      far: dist + radius * 1.5,
    });
  }
  return views;
}

/** 시점의 카메라 축 (오른쪽 r, 위 up, 앞 f)과 화면 비례 */
function cameraOf(view: SegmentView) {
  const [px, py, pz] = view.position;
  let f = [view.target[0] - px, view.target[1] - py, view.target[2] - pz];
  const fl = Math.hypot(f[0], f[1], f[2]) || 1;
  f = f.map((c) => c / fl);
  // r = f × (0,1,0)
  let r = [-f[2], 0, f[0]];
  const rl = Math.hypot(r[0], r[2]) || 1;
  r = r.map((c) => c / rl);
  // up = r × f
  const up = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const t = Math.tan(((view.fovDeg / 2) * Math.PI) / 180);
  return { p: [px, py, pz], f, r, up, t };
}

/**
 * 방 좌표의 점을 그림 픽셀로 (정사각형 SEGMENT_IMAGE, 왼쪽 위 원점). 카메라 뒤면 null
 * @returns [x, y, 깊이(m)]
 */
export function projectToView(view: SegmentView, x: number, y: number, z: number, size = SEGMENT_IMAGE): [number, number, number] | null {
  const c = cameraOf(view);
  return projectWith(c, x, y, z, size);
}

function projectWith(c: ReturnType<typeof cameraOf>, x: number, y: number, z: number, size: number): [number, number, number] | null {
  const d = [x - c.p[0], y - c.p[1], z - c.p[2]];
  const depth = d[0] * c.f[0] + d[1] * c.f[1] + d[2] * c.f[2];
  if (depth <= 1e-3) return null;
  const sx = (d[0] * c.r[0] + d[1] * c.r[1] + d[2] * c.r[2]) / (depth * c.t);
  const sy = (d[0] * c.up[0] + d[1] * c.up[1] + d[2] * c.up[2]) / (depth * c.t);
  return [((sx + 1) / 2) * size, ((1 - sy) / 2) * size, depth];
}

export type SegmentVote = {
  /** 1 = 남김 */
  keep: Uint8Array;
  /** 가구를 찾은(쓸 수 있는) 시점 수 */
  usedViews: number;
  /** 고른 것 가운데 남긴 비율 */
  keptShare: number;
};

/** 가구·얹힌 물건 상자를 이만큼(0~1000) 넓혀 본다 (상자 가장자리에 걸친 다리·쿠션을 자르지 않게) */
const BOX_MARGIN = 25;

const inBox = (b: Box2d, x: number, y: number, margin: number) => y >= b[0] - margin && x >= b[1] - margin && y <= b[2] + margin && x <= b[3] + margin;

/**
 * 스플랫마다 시점별로 안팎을 세어 남길지 정한다. 그 시점에서 보이는 것(같은 칸에서 가장 가까운 스플랫보다 DEPTH_TOLERANCE 안)만 센다.
 * - 가구나 얹힌 물건 상자 안: 안 (단, 가구 상자 안이어도 따로 선 물건 상자와 겹친 곳이면 세지 않는다 — 앞뒤로 겹쳐 보인다)
 * - 어느 상자에도 없거나 따로 선 물건 상자에만 있음: 밖
 * 밖이 안보다 많으면 뺀다. 어느 시점에서도 세지 않은 점은, 뺀 점에 이어진 곳이면 함께 빼고(spreadDrop) 아니면 남긴다.
 * @param points 방 좌표 [x, y, z, …]
 * @param candidate 다듬기에서 남긴 것 (1). 0인 것은 그대로 0
 * @param boxes 시점마다 AI 상자 (target이 비면 그 시점은 쓰지 않는다)
 */
export function voteSegment(points: ArrayLike<number>, candidate: Uint8Array, views: SegmentView[], boxes: SegmentBoxes[]): SegmentVote {
  const n = candidate.length;
  const inside = new Uint8Array(n);
  const outside = new Uint8Array(n);
  let usedViews = 0;
  const cells = Math.ceil(SEGMENT_IMAGE / CELL_PX);
  const cellOf = new Int32Array(n);
  const depthOf = new Float32Array(n);
  const xOf = new Float32Array(n);
  const yOf = new Float32Array(n);
  for (let k = 0; k < views.length; k += 1) {
    const found = boxes[k];
    if (!found || found.target.length === 0) continue;
    usedViews += 1;
    const cam = cameraOf(views[k]);
    const nearest = new Float32Array(cells * cells).fill(Infinity);
    for (let i = 0; i < n; i += 1) {
      cellOf[i] = -1;
      if (!candidate[i]) continue;
      const hit = projectWith(cam, points[i * 3], points[i * 3 + 1], points[i * 3 + 2], SEGMENT_IMAGE);
      if (!hit) continue;
      const col = Math.floor(hit[0] / CELL_PX);
      const row = Math.floor(hit[1] / CELL_PX);
      if (col < 0 || row < 0 || col >= cells || row >= cells) continue;
      const c = row * cells + col;
      cellOf[i] = c;
      depthOf[i] = hit[2];
      xOf[i] = (hit[0] / SEGMENT_IMAGE) * 1000;
      yOf[i] = (hit[1] / SEGMENT_IMAGE) * 1000;
      if (hit[2] < nearest[c]) nearest[c] = hit[2];
    }
    for (let i = 0; i < n; i += 1) {
      const c = cellOf[i];
      if (c < 0 || depthOf[i] > nearest[c] + DEPTH_TOLERANCE) continue;
      const x = xOf[i];
      const y = yOf[i];
      const inTarget = found.target.some((b) => inBox(b, x, y, BOX_MARGIN));
      const onTop = found.onTop.some((b) => inBox(b, x, y, BOX_MARGIN));
      const separate = found.separate.some((b) => inBox(b, x, y, 0));
      if (onTop || (inTarget && !separate)) inside[i] += 1;
      else if (!inTarget) outside[i] += 1;
    }
  }
  const drop = spreadDrop(points, candidate, inside, outside);
  const keep = new Uint8Array(n);
  let total = 0;
  let kept = 0;
  for (let i = 0; i < n; i += 1) {
    if (!candidate[i]) continue;
    total += 1;
    if (drop[i]) continue;
    keep[i] = 1;
    kept += 1;
  }
  return { keep, usedViews, keptShare: total > 0 ? kept / total : 0 };
}

/** 판단을 미룬 점을 이어 붙여 빼는 칸 (m) */
const SPREAD_VOXEL = 0.03;

/**
 * 뺄 점: 밖 표가 안 표보다 많은 점, 그리고 그런 점에서 SPREAD_VOXEL 칸으로 이어진 "안 표가 하나도 없는" 칸의 점.
 * 옆 물건이 가구 상자와 겹쳐 보여 어느 시점에서도 판단하지 못한 부분(스탠드 아래쪽, 팔걸이 밑 원탁)을
 * 상자 밖으로 삐져나온 같은 물건의 부분에 이어 함께 뺀다. 안 표를 받은 칸(가구)에서 멈춘다.
 */
function spreadDrop(points: ArrayLike<number>, candidate: Uint8Array, inside: Uint8Array, outside: Uint8Array): Uint8Array {
  const n = candidate.length;
  const drop = new Uint8Array(n);
  const key = (i: number) => `${Math.floor(points[i * 3] / SPREAD_VOXEL)},${Math.floor(points[i * 3 + 1] / SPREAD_VOXEL)},${Math.floor(points[i * 3 + 2] / SPREAD_VOXEL)}`;
  // 칸마다 점 번호, 안 표를 받은 점이 있는지
  const cells = new Map<string, { members: number[]; hasInside: boolean; dropped: boolean }>();
  for (let i = 0; i < n; i += 1) {
    if (!candidate[i]) continue;
    const k = key(i);
    let cell = cells.get(k);
    if (!cell) {
      cell = { members: [], hasInside: false, dropped: false };
      cells.set(k, cell);
    }
    cell.members.push(i);
    if (inside[i] > 0 && inside[i] >= outside[i]) cell.hasInside = true;
  }
  const queue: string[] = [];
  for (let i = 0; i < n; i += 1) {
    if (!candidate[i] || outside[i] <= inside[i]) continue;
    drop[i] = 1;
    const k = key(i);
    const cell = cells.get(k)!;
    if (!cell.hasInside && !cell.dropped) {
      cell.dropped = true;
      queue.push(k);
    }
  }
  while (queue.length > 0) {
    const k = queue.pop()!;
    const [x, y, z] = k.split(',').map(Number);
    for (const i of cells.get(k)!.members) drop[i] = 1;
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nk = `${x + dx},${y + dy},${z + dz}`;
          const next = cells.get(nk);
          if (!next || next.dropped || next.hasInside) continue;
          next.dropped = true;
          queue.push(nk);
        }
      }
    }
  }
  return drop;
}

/** AI 결과를 쓸지: 가구를 찾은 시점이 둘 이상이고, 너무 적게 남기지 않았을 때 */
export function trustSegment(vote: SegmentVote): boolean {
  return vote.usedViews >= 2 && vote.keptShare >= MIN_SEGMENT_KEEP;
}

/** 원래 가구 이름 → 그림 AI에 함께 줄 영어 설명 */
const LABEL_HINTS: Record<string, string> = {
  침대: 'bed',
  소파: 'sofa',
  책상: 'desk',
  식탁: 'dining table',
  테이블: 'table',
  의자: 'chair or armchair',
  옷장: 'wardrobe',
  수납장: 'cabinet, nightstand, chest of drawers or counter',
  책장: 'bookshelf',
  냉장고: 'refrigerator',
  세탁기: 'washing machine',
  TV장: 'TV stand',
  가구: 'piece of furniture',
};

/** 그림 AI에 보낼 가구 설명: "의자 (chair or armchair), about 95 × 99 cm, 80 cm tall" */
export function describeFixture(label: string, w: number, d: number, h: number): string {
  const hint = LABEL_HINTS[label.trim()];
  const name = hint ? `${label.trim()} (${hint})` : label.trim();
  return `${name}, about ${Math.round(w * 100)} × ${Math.round(d * 100)} cm footprint, ${Math.round(h * 100)} cm tall`;
}
