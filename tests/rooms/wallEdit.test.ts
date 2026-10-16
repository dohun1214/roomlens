import { describe, expect, it } from 'vitest';
import { moveWall, scaleCalibration } from '@/lib/rooms/wallEdit';
import type { Point2 } from '@/lib/three/floorDrag';

const ROOM: Point2[] = [
  [0, 0],
  [4, 0],
  [4, 3],
  [0, 3],
];

describe('moveWall', () => {
  it('벽을 직각 방향으로만 옮긴다 (끈 방향의 벽 쪽 성분은 무시)', () => {
    // 벽 1 (x=4) 을 +x로 0.3, 벽 방향(z) 성분 0.5는 무시
    const out = moveWall(ROOM, 1, [0.3, 0.5])!;
    expect(out).toEqual([
      [0, 0],
      [4.3, 0],
      [4.3, 3],
      [0, 3],
    ]);
  });

  it('1cm 단위로 맞추고, 옆 벽이 너무 짧아지거나 뒤집히면 막는다', () => {
    expect(moveWall(ROOM, 0, [0, 0.123])![0]).toEqual([0, 0.12]);
    expect(moveWall(ROOM, 0, [0, 2.9])).toBeNull();
    expect(moveWall(ROOM, 0, [0, 3.5])).toBeNull();
  });
});

describe('scaleCalibration', () => {
  it('변환과 평면도를 함께 늘린다', () => {
    const { transform, floorPolygon } = scaleCalibration({ s: 0.5, q: [0, 0, 0, 1], t: [1, 0, -2] }, ROOM, 2);
    expect(transform).toEqual({ s: 1, q: [0, 0, 0, 1], t: [2, 0, -4] });
    expect(floorPolygon[2]).toEqual([8, 6]);
  });
});
