// 보정한 뒤 바닥에 그리는 1 m 격자를 방 평면도 안쪽만 남긴다.
// 스플랫은 깊이를 남기지 않아 격자가 벽 위로 비쳐 보이므로, 아예 방 밖의 선은 그리지 않는다.
import type { Point2 } from './floorDrag';

/** 한 직선(축과 나란한 선)이 다각형 안에 있는 구간들. axis 0 = x가 c인 세로선(z 구간), 1 = z가 c인 가로선(x 구간) */
function insideSpans(polygon: Point2[], axis: 0 | 1, c: number): [number, number][] {
  const other = axis === 0 ? 1 : 0;
  const hits: number[] = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    // 반열린 구간 규칙: 꼭짓점을 두 번 세지 않는다
    if (a[axis] <= c !== b[axis] <= c) {
      const t = (c - a[axis]) / (b[axis] - a[axis]);
      hits.push(a[other] + (b[other] - a[other]) * t);
    }
  }
  hits.sort((p, q) => p - q);
  const spans: [number, number][] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) if (hits[i + 1] - hits[i] > 1e-9) spans.push([hits[i], hits[i + 1]]);
  return spans;
}

/** 원점을 지나는 step 간격 격자 가운데 방 안쪽에 있는 선분들 ([x, z] 두 점씩) */
export function gridSegmentsInside(polygon: Point2[], step = 1): [Point2, Point2][] {
  if (polygon.length < 3 || !(step > 0)) return [];
  const segments: [Point2, Point2][] = [];
  for (const axis of [0, 1] as const) {
    const values = polygon.map((p) => p[axis]);
    const lo = Math.ceil(Math.min(...values) / step);
    const hi = Math.floor(Math.max(...values) / step);
    for (let k = lo; k <= hi; k += 1) {
      const c = k * step + 0;
      for (const [s, e] of insideSpans(polygon, axis, c)) {
        segments.push(axis === 0 ? [[c, s], [c, e]] : [[s, c], [e, c]]);
      }
    }
  }
  return segments;
}
