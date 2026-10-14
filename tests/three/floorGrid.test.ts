import { describe, expect, it } from 'vitest';
import { gridSegmentsInside } from '@/lib/three/floorGrid';
import { pointInPolygon, type Point2 } from '@/lib/three/floorDrag';

const RECT: Point2[] = [
  [-2.5, -1.5],
  [2.5, -1.5],
  [2.5, 1.5],
  [-2.5, 1.5],
];
const L_SHAPE: Point2[] = [
  [0, 0],
  [4, 0],
  [4, 2],
  [2, 2],
  [2, 4],
  [0, 4],
];

describe('gridSegmentsInside', () => {
  it('사각형 방: 1 m마다 세로선 5개(x = -2~2)와 가로선 3개(z = -1~1), 모두 벽에서 벽까지', () => {
    const segs = gridSegmentsInside(RECT);
    const vertical = segs.filter(([a, b]) => a[0] === b[0]);
    const horizontal = segs.filter(([a, b]) => a[1] === b[1]);
    expect(vertical.map(([a]) => a[0])).toEqual([-2, -1, 0, 1, 2]);
    expect(horizontal.map(([a]) => a[1])).toEqual([-1, 0, 1]);
    for (const [a, b] of vertical) expect([a[1], b[1]]).toEqual([-1.5, 1.5]);
    for (const [a, b] of horizontal) expect([a[0], b[0]]).toEqual([-2.5, 2.5]);
  });

  it('ㄱ자 방: 빠진 자리에는 선이 없다', () => {
    const segs = gridSegmentsInside(L_SHAPE);
    for (const [a, b] of segs) {
      const mid: Point2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      expect(pointInPolygon(mid, L_SHAPE)).toBe(true);
    }
    // x = 3인 세로선은 z 0~2까지만
    const x3 = segs.filter(([a, b]) => a[0] === 3 && b[0] === 3);
    expect(x3).toEqual([[[3, 0], [3, 2]]]);
  });

  it('평면도가 없으면 빈 목록', () => {
    expect(gridSegmentsInside([])).toEqual([]);
  });
});
