// 가구 배치 검사에 쓰는 평면 기하. 모두 보정된 방 좌표(m)의 바닥 평면 [x, z]에서 계산한다.
// 가구는 회전된 직사각형(Footprint)으로 본다. 화면(사용자 배치)과 AI 배치 솔버가 같은 함수를 쓴다.
import { footprintCorners, type Footprint, type Point2 } from '@/lib/three/floorDrag';

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

/** 점이 다각형 안에 있는지 (경계 위는 구현에 따라 달라지므로 distanceToPolygon과 함께 쓴다) */
export function pointInPolygon(p: Point2, polygon: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
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
 * 가구가 방 밖으로 나간 거리(m): 밑면 꼭짓점 가운데 방 밖에 있는 것의 벽까지 거리의 최댓값.
 * 모두 방 안이면 0. (볼록한 방 기준. 오목한 방에서는 변이 벽을 가로지르는 경우를 놓칠 수 있다)
 */
export function outsideDistance(f: Footprint, polygon: Point2[]): number {
  let worst = 0;
  for (const corner of footprintCorners(f)) {
    if (!pointInPolygon(corner, polygon)) worst = Math.max(worst, distanceToPolygon(corner, polygon));
  }
  return worst;
}

export function footprintInsideRoom(f: Footprint, polygon: Point2[], tolerance = TOLERANCE): boolean {
  return outsideDistance(f, polygon) <= tolerance;
}
