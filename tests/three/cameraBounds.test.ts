import { describe, expect, it } from 'vitest';
import { CEILING_MARGIN, MIN_EYE_HEIGHT, WALL_MARGIN, clampHeight, heightRange, isInsideRoom, keepCameraInRoom, keepInsideRoom } from '@/lib/three/cameraBounds';
import { distanceToPolygon } from '@/lib/layout/geometry';
import type { Point2 } from '@/lib/three/floorDrag';

// 4 × 3 m 방
const RECT: Point2[] = [
  [-2, -1.5],
  [2, -1.5],
  [2, 1.5],
  [-2, 1.5],
];
// ㄱ자 방: 4 × 4에서 오른쪽 위 2 × 2가 빠짐
const L_SHAPE: Point2[] = [
  [0, 0],
  [4, 0],
  [4, 2],
  [2, 2],
  [2, 4],
  [0, 4],
];
const M = WALL_MARGIN;

describe('keepInsideRoom', () => {
  it('방 안의 점은 그대로 (같은 배열을 돌려준다)', () => {
    const p: Point2 = [0.5, -0.3];
    expect(keepInsideRoom(p, RECT)).toBe(p);
  });

  it('벽을 넘어가면 그 벽에서 margin 떨어진 자리로, 벽을 따라서는 그대로 (미끄러짐)', () => {
    const [x, z] = keepInsideRoom([2.7, 0.4], RECT);
    expect(x).toBeCloseTo(2 - M, 3);
    expect(z).toBeCloseTo(0.4, 9);
  });

  it('방 안이지만 벽에 너무 붙으면 margin만큼 떨어뜨린다', () => {
    const [x, z] = keepInsideRoom([-1.95, 1.0], RECT);
    expect(x).toBeCloseTo(-2 + M, 3);
    expect(z).toBeCloseTo(1.0, 9);
  });

  it('구석 너머로 나가면 두 벽에서 모두 떨어진 자리', () => {
    const p = keepInsideRoom([3, 2.4], RECT);
    expect(isInsideRoom(p, RECT)).toBe(true);
    expect(p[0]).toBeCloseTo(2 - M, 2);
    expect(p[1]).toBeCloseTo(1.5 - M, 2);
  });

  it('ㄱ자 방: 빠진 자리로 들어가면 가까운 벽 안쪽으로', () => {
    const p = keepInsideRoom([2.6, 3.0], L_SHAPE);
    expect(isInsideRoom(p, L_SHAPE)).toBe(true);
    expect(p[0]).toBeCloseTo(2 - M, 3);
    expect(p[1]).toBeCloseTo(3.0, 9);
  });

  it('ㄱ자 방: 안쪽으로 튀어나온 모서리 근처에서도 벽에서 margin 이상', () => {
    for (const p of [[2.05, 2.05], [2.1, 1.95], [1.95, 2.1], [2.3, 2.3]] as Point2[]) {
      const q = keepInsideRoom(p, L_SHAPE);
      expect(isInsideRoom(q, L_SHAPE)).toBe(true);
      expect(distanceToPolygon(q, L_SHAPE)).toBeGreaterThanOrEqual(M - 1e-6);
    }
  });

  it('아주 멀리 나가도 방 안으로 돌아온다', () => {
    for (const p of [[50, 0], [-30, -40], [0, 99], [1e4, 1e4]] as Point2[]) {
      expect(isInsideRoom(keepInsideRoom(p, RECT), RECT)).toBe(true);
      expect(isInsideRoom(keepInsideRoom(p, L_SHAPE), L_SHAPE)).toBe(true);
    }
  });

  it('정확히 벽 위의 점도 안으로', () => {
    expect(isInsideRoom(keepInsideRoom([2, 0], RECT), RECT)).toBe(true);
    expect(isInsideRoom(keepInsideRoom([2, 1.5], RECT), RECT)).toBe(true);
  });

  it('margin의 두 배보다 좁은 방: 직전 자리가 없으면 방 안쪽의 한 점', () => {
    const thin: Point2[] = [
      [0, 0],
      [3, 0],
      [3, 0.3],
      [0, 0.3],
    ];
    const p = keepInsideRoom([5, 0.1], thin);
    expect(p[0]).toBeGreaterThan(0);
    expect(p[0]).toBeLessThan(3);
    expect(p[1]).toBeGreaterThan(0);
    expect(p[1]).toBeLessThan(0.3);
  });

  it('평면도가 없거나 숫자가 아니면 그대로', () => {
    expect(keepInsideRoom([9, 9], [])).toEqual([9, 9]);
    const nan: Point2 = [Number.NaN, 0];
    expect(keepInsideRoom(nan, RECT)).toBe(nan);
  });

  it('여러 방향에서 걸어 들어가도 늘 방 안 (무작위 점 500개)', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 12 - 4;
    for (let i = 0; i < 500; i += 1) {
      const q = keepInsideRoom([rand(), rand()], L_SHAPE);
      expect(isInsideRoom(q, L_SHAPE)).toBe(true);
    }
  });
});

describe('높이', () => {
  it('바닥 아래로 내려가지 않고 천장 위로 올라가지 않는다', () => {
    expect(clampHeight(-1, 2.6)).toBe(MIN_EYE_HEIGHT);
    expect(clampHeight(9, 2.6)).toBeCloseTo(2.6 - CEILING_MARGIN, 9);
    expect(clampHeight(1.5, 2.6)).toBe(1.5);
  });

  it('천장 높이를 모르면 위는 막지 않는다', () => {
    expect(clampHeight(9, null)).toBe(9);
    expect(heightRange(Number.NaN).max).toBe(Infinity);
  });

  it('천장을 아주 낮게 재었어도 1.8m까지는 올라간다', () => {
    expect(clampHeight(1.7, 0.9)).toBe(1.7);
    expect(clampHeight(3, 0.9)).toBe(1.8);
  });
});

describe('keepCameraInRoom', () => {
  it('방 안이면 null', () => {
    expect(keepCameraInRoom([0, 1.5, 0], RECT, 2.6)).toBeNull();
  });

  it('벽 너머·천장 위를 함께 바로잡는다', () => {
    const p = keepCameraInRoom([5, 6, 0.2], RECT, 2.6);
    expect(p?.[0]).toBeCloseTo(2 - M, 3);
    expect(p?.[1]).toBeCloseTo(2.6 - CEILING_MARGIN, 9);
    expect(p?.[2]).toBeCloseTo(0.2, 9);
  });
});
