import { describe, expect, it } from 'vitest';
import { closestPointOnPolygon, placeOnFloor, pointInPolygon, snapToWalls, type Footprint, type Point2 } from '@/lib/three/floorDrag';
import { findUnreachable } from '@/lib/layout/access';
import { checkLayout, findFreeSpot } from '@/lib/layout/check';
import { distanceToPolygon, footprintInsideRoom, interiorPoint, outsideDistance } from '@/lib/layout/geometry';
import { startPoseForRoom } from '@/lib/rooms/calibration';
import type { Opening } from '@/lib/rooms/openings';

// ㄱ자 방: 4 × 4 m에서 오른쪽 위(x > 2, z > 2)가 빠진 모양. (2, 2)가 안쪽으로 튀어나온 모서리다.
//   아래쪽 구역: x 0~4, z 0~2   왼쪽 구역: x 0~2, z 2~4
const L_ROOM: Point2[] = [
  [0, 0],
  [4, 0],
  [4, 2],
  [2, 2],
  [2, 4],
  [0, 4],
];
// ㄷ자 방: 6 × 4 m에서 가운데 위(x 2~4, z > 1)가 빠진 모양. 꼭짓점의 평균이 방 밖이다.
const U_ROOM: Point2[] = [
  [0, 0],
  [6, 0],
  [6, 4],
  [4, 4],
  [4, 1],
  [2, 1],
  [2, 4],
  [0, 4],
];
const box = (x: number, z: number, w = 1, d = 1, rotationDeg = 0): Footprint => ({ x, z, w, d, rotationDeg });

describe('오목한 방에서 벽에 붙이기', () => {
  it('다른 구역 벽의 연장선에는 붙지 않는다', () => {
    // 아래쪽 구역 한가운데. 벽 x=2(왼쪽 구역의 오른쪽 벽)의 연장선 너머에 있지만 그대로다
    expect(snapToWalls(box(3, 1), L_ROOM)).toEqual(box(3, 1));
    // 왼쪽 구역 한가운데. 벽 z=2(아래쪽 구역의 위쪽 벽)의 연장선 너머
    expect(snapToWalls(box(1, 3), L_ROOM)).toEqual(box(1, 3));
  });

  it('자기 구역의 벽에는 붙는다', () => {
    const nearInnerWall = snapToWalls(box(1.45, 3), L_ROOM); // 벽 x=2와의 틈 5cm
    expect(nearInnerWall.x).toBeCloseTo(1.5);
    expect(nearInnerWall.z).toBeCloseTo(3);
    const nearTop = snapToWalls(box(3, 1.44), L_ROOM); // 벽 z=2와의 틈 6cm
    expect(nearTop.z).toBeCloseTo(1.5);
  });

  it('튀어나온 모서리를 덮으면 밀려나 방 안에 놓인다', () => {
    const pushed = snapToWalls(box(1.8, 1.8), L_ROOM);
    expect(footprintInsideRoom(pushed, L_ROOM)).toBe(true);
    expect(Math.hypot(pushed.x - 1.8, pushed.z - 1.8)).toBeLessThan(0.5);
  });

  it('빠진 구역이나 방 밖으로 끌면 가장 가까운 벽 안쪽에 놓인다', () => {
    const intoNotch = snapToWalls(box(3.5, 3.5), L_ROOM);
    expect(footprintInsideRoom(intoNotch, L_ROOM)).toBe(true);
    expect(intoNotch.z).toBeCloseTo(1.5); // 가장 가까운 벽 z=2 아래로
    const beyondRight = snapToWalls(box(5, 1), L_ROOM);
    expect(beyondRight.x).toBeCloseTo(3.5);
    expect(beyondRight.z).toBeCloseTo(1);
    const beyondCorner = snapToWalls(box(-1, -1), L_ROOM);
    expect(beyondCorner.x).toBeCloseTo(0.5);
    expect(beyondCorner.z).toBeCloseTo(0.5);
  });

  it('회전한 가구와 격자 맞춤도 그대로 된다', () => {
    const placed = placeOnFloor(box(1.83, 3.02, 1.2, 0.6, 90), L_ROOM); // 가로 0.6으로 보임
    expect(placed.x).toBeCloseTo(1.7); // 벽 x=2 − 0.3
    expect(placed.z).toBeCloseTo(3.0);
  });
});

describe('오목한 방에서 방 밖 판정', () => {
  it('네 꼭짓점이 모두 방 안이어도 튀어나온 모서리가 파고들면 방 밖이다', () => {
    // 45° 돌린 길고 얇은 가구가 (2, 2) 모서리를 덮는다. 꼭짓점 넷은 모두 방 안에 있다
    const diagonal = box(1.8, 1.8, 3, 0.8, 45);
    expect(outsideDistance(diagonal, L_ROOM)).toBeCloseTo(0.4 - 0.4 / Math.SQRT2, 3);
    expect(footprintInsideRoom(diagonal, L_ROOM)).toBe(false);
    expect(checkLayout([{ ...diagonal, id: 'a', name: '긴 가구' }], L_ROOM).map((v) => v.type)).toEqual(['outside']);
  });

  it('모서리에 딱 붙인 가구는 방 안이다', () => {
    expect(footprintInsideRoom(box(1.5, 1.5), L_ROOM)).toBe(true); // 꼭짓점 (2, 2)가 가구의 꼭짓점과 겹침
    expect(footprintInsideRoom(box(1.5, 3), L_ROOM)).toBe(true);
    expect(footprintInsideRoom(box(3, 1.5), L_ROOM)).toBe(true);
  });

  it('빠진 구역에 걸치면 방 밖이다', () => {
    expect(footprintInsideRoom(box(2.2, 2.2), L_ROOM)).toBe(false);
    expect(footprintInsideRoom(box(3, 3), L_ROOM)).toBe(false);
  });
});

describe('방 안쪽의 점 · 빈자리 · 처음 카메라', () => {
  it('사각형 방에서는 가운데', () => {
    expect(interiorPoint([[-2, -1.5], [2, -1.5], [2, 1.5], [-2, 1.5]])).toEqual([0, 0]);
  });

  it('ㄷ자 방에서는 꼭짓점의 평균이 방 밖이므로 벽에서 먼 방 안의 점을 고른다', () => {
    const mean: Point2 = [3, 2.25];
    expect(pointInPolygon(mean, U_ROOM)).toBe(false);
    const p = interiorPoint(U_ROOM);
    expect(pointInPolygon(p, U_ROOM)).toBe(true);
    expect(distanceToPolygon(p, U_ROOM)).toBeGreaterThan(0.8);
  });

  it('새 가구는 방 안의 빈자리에 놓인다', () => {
    const first = findFreeSpot({ w: 1.5, d: 2 }, [], U_ROOM);
    expect(footprintInsideRoom(first, U_ROOM)).toBe(true);
    const second = findFreeSpot({ w: 1.2, d: 0.6 }, [first], U_ROOM);
    expect(footprintInsideRoom(second, U_ROOM)).toBe(true);
    expect(checkLayout([{ ...first, id: 'a', name: 'a' }, { ...second, id: 'b', name: 'b' }], U_ROOM)).toEqual([]);
  });

  it('처음 카메라는 방 안에서 방 안의 점을 본다', () => {
    for (const room of [L_ROOM, U_ROOM]) {
      const pose = startPoseForRoom(room as [number, number][]);
      expect(pointInPolygon([pose.position[0], pose.position[2]], room)).toBe(true);
      expect(pointInPolygon([pose.target[0], pose.target[2]], room)).toBe(true);
      expect(pose.position[1]).toBe(1.5);
    }
  });

  it('closestPointOnPolygon', () => {
    expect(closestPointOnPolygon([3, 3], L_ROOM)).toEqual([3, 2]);
    expect(closestPointOnPolygon([5, 5], L_ROOM)).toEqual([4, 2]);
  });
});

describe('오목한 방에서 통로 검사', () => {
  // 아래쪽 벽의 왼쪽에 문 (x 0.5~1.4)
  const DOOR: Opening = { type: 'door', wallIndex: 0, from: 0.5, to: 1.4, widthM: 0.9 };

  it('모퉁이를 돌아 다른 구역의 가구까지 갈 수 있다', () => {
    expect(findUnreachable([{ ...box(1, 3.5, 1, 0.6), id: 'far' }, { ...box(3.4, 1, 0.8, 0.6), id: 'right' }], L_ROOM, [DOOR])).toEqual([]);
  });

  it('구역의 입구를 가구로 막으면 그 안쪽은 갈 수 없다', () => {
    // 왼쪽 구역(폭 2m)의 입구를 2.0 × 0.5 가구로 벽에서 벽까지 막는다
    const items = [{ ...box(1, 2.3, 2, 0.5), id: 'blocker' }, { ...box(1, 3.5, 1, 0.6), id: 'far' }];
    expect(findUnreachable(items, L_ROOM, [DOOR])).toEqual(['far']);
  });

  it('빠진 구역 쪽 벽의 문 앞 구역도 방 안쪽을 향한다', () => {
    // 벽 3: (2, 2) → (2, 4). 방 안쪽은 −x 방향
    const inner: Opening = { type: 'door', wallIndex: 3, from: 0.5, to: 1.4, widthM: 0.9 };
    const violations = checkLayout([{ ...box(1.5, 2.95, 0.8, 0.8), id: 'a', name: '서랍장' }], L_ROOM, [inner]);
    expect(violations.map((v) => v.type)).toContain('door');
  });
});
