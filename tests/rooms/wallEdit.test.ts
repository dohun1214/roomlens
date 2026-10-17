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

  it('얕은 단차: 짧은 벽을 끝까지 끌면 단차 벽이 없어지고 벽이 합쳐진다', () => {
    // 오른쪽 벽 위쪽 0.7 m가 0.2 m 안으로 들어와 있다 (벽 1 = (3.8,0)→(3.8,0.7), 벽 2 = 0.2 m 단차)
    const notched: Point2[] = [
      [0, 0],
      [3.8, 0],
      [3.8, 0.7],
      [4, 0.7],
      [4, 3],
      [0, 3],
    ];
    // 벽 1을 +x로 조금만 끌어도(남는 단차가 20cm 안) 단차가 없어지게 붙는다
    const out = moveWall(notched, 1, [0.15, 0])!;
    expect(out).toEqual([
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]);
    expect(moveWall(notched, 1, [0.05, 0])).toHaveLength(4);
    // 반대로(단차가 깊어지게) 끌면 보통처럼 옮긴다
    expect(moveWall(notched, 1, [-0.1, 0])).toHaveLength(6);
  });
});

describe('scaleCalibration', () => {
  it('변환과 평면도를 함께 늘린다', () => {
    const { transform, floorPolygon } = scaleCalibration({ s: 0.5, q: [0, 0, 0, 1], t: [1, 0, -2] }, ROOM, 2);
    expect(transform).toEqual({ s: 1, q: [0, 0, 0, 1], t: [2, 0, -4] });
    expect(floorPolygon[2]).toEqual([8, 6]);
  });
});
