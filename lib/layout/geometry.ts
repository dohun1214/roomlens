// 가구 배치 검사에 쓰는 평면 기하. 모두 보정된 방 좌표(m)의 바닥 평면 [x, z]에서 계산한다.
// 가구는 회전된 직사각형(Footprint)으로 본다. 화면(사용자 배치)과 AI 배치 솔버가 같은 함수를 쓴다.
import { footprintCorners, pointInPolygon, type Footprint, type Point2 } from '@/lib/three/floorDrag';

export { pointInPolygon };

/** 이만큼(2cm)까지 파고든 것은 겹침·벗어남으로 보지 않는다 (벽·가구에 딱 붙인 경우의 계산 오차) */
export const TOLERANCE = 0.02;

const sub = (a: Point2, b: Point2): Point2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Point2, b: Point2) => a[0] * b[0] + a[1] * b[1];

/** 축 위에 꼭짓점들을 내려 얻은 [최소, 최대] */
function project(corners: Point2[], axis: Point2): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const c of corners) {
    const v = dot(c, axis);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/** 직사각형의 서로 수직인 두 변 방향(단위 벡터) */
function edgeAxes(corners: Point2[]): Point2[] {
  return [sub(corners[1], corners[0]), sub(corners[3], corners[0])].map((e) => {
    const len = Math.hypot(e[0], e[1]) || 1;
    return [e[0] / len, e[1] / len] as Point2;
  });
}

/**
 * 두 가구 밑면이 겹친 깊이(m). 분리축 정리(SAT): 네 축 가운데 하나라도 떨어져 있으면 겹치지 않는다.
 * 겹치지 않으면 0 이하(떨어진 거리의 음수), 겹치면 가장 얕게 겹친 축에서의 깊이.
 */
export function overlapDepth(a: Footprint, b: Footprint): number {
  const ca = footprintCorners(a);
  const cb = footprintCorners(b);
  let depth = Infinity;
  for (const axis of [...edgeAxes(ca), ...edgeAxes(cb)]) {
    const [minA, maxA] = project(ca, axis);
    const [minB, maxB] = project(cb, axis);
    depth = Math.min(depth, Math.min(maxA, maxB) - Math.max(minA, minB));
  }
  return depth;
}

export function footprintsOverlap(a: Footprint, b: Footprint, tolerance = TOLERANCE): boolean {
  return overlapDepth(a, b) > tolerance;
}

export function distanceToSegment(p: Point2, a: Point2, b: Point2): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 < 1e-12 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / len2));
  return Math.hypot(p[0] - (a[0] + ab[0] * t), p[1] - (a[1] + ab[1] * t));
}

/** 점에서 다각형 테두리(벽)까지의 가장 가까운 거리 */
export function distanceToPolygon(p: Point2, polygon: Point2[]): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    best = Math.min(best, distanceToSegment(p, polygon[i], polygon[(i + 1) % polygon.length]));
  }
  return best;
}

/**
 * 가구가 방 밖으로 나간 거리(m). 모두 방 안이면 0.
 * - 밑면 꼭짓점 가운데 방 밖에 있는 것의 벽까지 거리
 * - 오목한 방(ㄱ자 등)에서 안쪽으로 튀어나온 벽 모서리가 가구 밑면 속으로 파고든 깊이
 * 둘 가운데 큰 값이다.
 */
export function outsideDistance(f: Footprint, polygon: Point2[]): number {
  let worst = 0;
  for (const corner of footprintCorners(f)) {
    if (!pointInPolygon(corner, polygon)) worst = Math.max(worst, distanceToPolygon(corner, polygon));
  }
  // 방의 꼭짓점이 가구 밑면 안에 있으면, 가장 가까운 변까지의 거리만큼 파고든 것이다
  const r = (f.rotationDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  for (const [px, pz] of polygon) {
    const dx = px - f.x;
    const dz = pz - f.z;
    const depth = Math.min(f.w / 2 - Math.abs(dx * c - dz * s), f.d / 2 - Math.abs(dx * s + dz * c));
    if (depth > 0) worst = Math.max(worst, depth);
  }
  return worst;
}
export function footprintInsideRoom(f: Footprint, polygon: Point2[], tolerance = TOLERANCE): boolean {
  return outsideDistance(f, polygon) <= tolerance;
}

/**
 * 방 안쪽의 한 점: 새 가구를 놓기 시작하거나 카메라를 둘 자리.
 * 꼭짓점의 평균이 방 안이면 그 점(사각형 방에서는 정확히 가운데), 아니면(오목한 방) 벽에서 가장 먼 격자점.
 */
export function interiorPoint(polygon: Point2[]): Point2 {
  const mean: Point2 = [polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length, polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length];
  if (polygon.length < 3 || pointInPolygon(mean, polygon)) return mean;
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const STEPS = 32;
  let best = mean;
  let bestDistance = -1;
  for (let i = 1; i < STEPS; i += 1) {
    for (let j = 1; j < STEPS; j += 1) {
      const p: Point2 = [minX + ((maxX - minX) * i) / STEPS, minZ + ((maxZ - minZ) * j) / STEPS];
      if (!pointInPolygon(p, polygon)) continue;
      const distance = distanceToPolygon(p, polygon);
      if (distance > bestDistance) {
        bestDistance = distance;
        best = p;
      }
    }
  }
  return best;
}