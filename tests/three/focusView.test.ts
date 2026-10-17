import { describe, expect, it } from 'vitest';
import { easeInOut, focusDistance, furnitureViewpoint } from '@/lib/three/focusView';
import { distanceToPolygon } from '@/lib/layout/geometry';
import { pointInPolygon, type Point2 } from '@/lib/three/floorDrag';

const ROOM: Point2[] = [
  [-3, -2],
  [3, -2],
  [3, 2],
  [-3, 2],
];
// ㄱ자 방: 오른쪽 위 4×2 칸이 빠짐
const L_ROOM: Point2[] = [
  [0, 0],
  [6, 0],
  [6, 2],
  [2, 2],
  [2, 5],
  [0, 5],
];
const chair = { x: 0, z: 0, w: 0.5, d: 0.5, h: 0.8 };
const bed = { x: -1.8, z: 0.8, w: 2.0, d: 1.6, h: 0.9 };
const flat = (p: [number, number, number]): Point2 => [p[0], p[2]];
const inside = (p: Point2, poly: Point2[]) => pointInPolygon(p, poly) && distanceToPolygon(p, poly) >= 0.299;

describe('furnitureViewpoint', () => {
  it('가구를 내려다보고(카메라가 가구보다 높음), 방 안 벽에서 30cm 넘게 떨어진 자리', () => {
    for (const box of [chair, bed]) {
      const view = furnitureViewpoint(box, ROOM);
      expect(inside(flat(view.position), ROOM)).toBe(true);
      expect(view.target[0]).toBe(box.x);
      expect(view.target[2]).toBe(box.z);
      expect(view.position[1]).toBeGreaterThan(box.h + 0.5);
    }
  });

  it('큰 가구일수록 멀리서 본다', () => {
    expect(focusDistance(bed)).toBeGreaterThan(focusDistance(chair));
    const d = (box: typeof chair) => {
      const v = furnitureViewpoint(box, ROOM);
      return Math.hypot(v.position[0] - box.x, v.position[2] - box.z);
    };
    expect(d({ ...chair, x: 0, z: 0 })).toBeLessThan(d({ ...bed, x: 0, z: 0 }));
  });

  it('지금 카메라가 있는 쪽에서 본다 (시점이 덜 바뀌게)', () => {
    const fromRight = furnitureViewpoint(chair, ROOM, [2.5, 0]);
    const fromLeft = furnitureViewpoint(chair, ROOM, [-2.5, 0]);
    expect(fromRight.position[0]).toBeGreaterThan(0.5);
    expect(fromLeft.position[0]).toBeLessThan(-0.5);
  });

  it('ㄱ자 방에서 벽 너머(빠진 칸)에 서지 않는다', () => {
    const box = { x: 1, z: 4, w: 0.8, d: 0.6, h: 0.75 };
    // 지금 카메라는 오른쪽 아래 방(5, 1)에 있지만, 그쪽으로 물러나면 벽(빠진 칸)을 넘는다
    const view = furnitureViewpoint(box, L_ROOM, [5, 1]);
    const p = flat(view.position);
    expect(inside(p, L_ROOM)).toBe(true);
    // 가구와 카메라 사이가 모두 방 안
    for (let t = 0; t <= 1; t += 0.05) expect(pointInPolygon([box.x + (p[0] - box.x) * t, box.z + (p[1] - box.z) * t], L_ROOM)).toBe(true);
  });

  it('좁은 방에서도 자리를 낸다', () => {
    const tiny: Point2[] = [
      [0, 0],
      [1.2, 0],
      [1.2, 1.2],
      [0, 1.2],
    ];
    const view = furnitureViewpoint({ x: 0.6, z: 0.6, w: 0.5, d: 0.5, h: 0.5 }, tiny);
    expect(Number.isFinite(view.position[0])).toBe(true);
    expect(view.position[1]).toBeGreaterThan(1);
  });
});

describe('easeInOut', () => {
  it('0 → 0, 0.5 → 0.5, 1 → 1, 범위 밖은 자름', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(2)).toBe(1);
    expect(easeInOut(-1)).toBe(0);
  });
});
