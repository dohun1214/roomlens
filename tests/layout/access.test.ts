import { describe, expect, it } from 'vitest';
import type { Point2 } from '@/lib/three/floorDrag';
import { distanceToFootprint, doorZone, findUnreachable, windowZone } from '@/lib/layout/access';
import { checkLayout, violatingIds, warningIds, type LayoutItem } from '@/lib/layout/check';
import type { Opening } from '@/lib/rooms/openings';

// 4 × 3 m 방. 벽 1: 아래쪽(z=-1.5) 왼→오, 벽 2: 오른쪽(x=2), 벽 3: 위쪽(z=1.5) 오→왼, 벽 4: 왼쪽(x=-2)
const ROOM: Point2[] = [
  [-2, -1.5],
  [2, -1.5],
  [2, 1.5],
  [-2, 1.5],
];
// 벽 1의 왼쪽 끝에서 0.2~1.1m → x -1.8 ~ -0.9
const DOOR: Opening = { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 };
// 벽 3의 오른쪽 끝(x=2)에서 1~2.2m → x 1 ~ -0.2
const WINDOW: Opening = { type: 'window', wallIndex: 2, from: 1, to: 2.2, widthM: 1.2 };

const item = (id: string, x: number, z: number, w: number, d: number, extra: Partial<LayoutItem> = {}): LayoutItem => ({
  id,
  name: id,
  x,
  z,
  w,
  d,
  rotationDeg: 0,
  ...extra,
});
const types = (items: LayoutItem[], openings: Opening[]) => checkLayout(items, ROOM, openings).map((v) => `${v.itemId}:${v.type}`);

describe('문·창문 앞 구역', () => {
  it('문 앞 구역은 문 폭 × 문 폭 정사각형이고 방 안쪽에 있다', () => {
    const zone = doorZone(DOOR, ROOM)!;
    expect(zone.x).toBeCloseTo(-1.35);
    expect(zone.z).toBeCloseTo(-1.05);
    expect(zone.w).toBeCloseTo(0.9);
    expect(zone.d).toBeCloseTo(0.9);
  });

  it('꼭짓점이 반대 방향으로 도는 평면도에서도 방 안쪽이다', () => {
    const reversed = [...ROOM].reverse(); // 벽 1: (-2, 1.5) → (2, 1.5), 위쪽 벽
    const zone = doorZone({ ...DOOR, from: 0, to: 1, widthM: 1 }, reversed)!;
    expect(zone.x).toBeCloseTo(-1.5);
    expect(zone.z).toBeCloseTo(1.0);
  });

  it('세로 벽의 창문 앞 구역은 벽을 따라 길고 깊이 0.3m', () => {
    const zone = windowZone({ type: 'window', wallIndex: 1, from: 1, to: 2, widthM: 1 }, ROOM)!;
    expect(zone.x).toBeCloseTo(1.85);
    expect(zone.z).toBeCloseTo(0);
    expect(distanceToFootprint([1.85, 0.5], zone)).toBeCloseTo(0);
    expect(distanceToFootprint([1.85, 0.7], zone)).toBeCloseTo(0.2);
    expect(distanceToFootprint([1.5, 0], zone)).toBeCloseTo(0.2);
  });

  it('없는 벽이면 null', () => {
    expect(doorZone({ ...DOOR, wallIndex: 9 }, ROOM)).toBeNull();
  });
});

describe('distanceToFootprint', () => {
  it('안이면 0, 밖이면 가장 가까운 변·꼭짓점까지', () => {
    const f = { x: 0, z: 0, w: 2, d: 1, rotationDeg: 0 };
    expect(distanceToFootprint([0.5, 0.2], f)).toBe(0);
    expect(distanceToFootprint([1.5, 0], f)).toBeCloseTo(0.5);
    expect(distanceToFootprint([0, -1], f)).toBeCloseTo(0.5);
    expect(distanceToFootprint([1.3, 0.9], f)).toBeCloseTo(0.5);
  });

  it('회전한 가구', () => {
    const f = { x: 0, z: 0, w: 2, d: 1, rotationDeg: 90 };
    expect(distanceToFootprint([0, 0.9], f)).toBe(0);
    expect(distanceToFootprint([1, 0], f)).toBeCloseTo(0.5);
  });
});

describe('문 앞 검사', () => {
  it('문 앞 구역과 겹치면 문제', () => {
    expect(types([item('desk', -1.3, -1.2, 1.2, 0.6)], [DOOR])).toContain('desk:door');
  });

  it('문 옆 벽에 붙인 가구는 괜찮다', () => {
    expect(types([item('desk', 0.3, -1.2, 1.2, 0.6)], [DOOR])).toEqual([]);
  });

  it('문이 없으면 검사하지 않는다', () => {
    expect(types([item('desk', -1.3, -1.2, 1.2, 0.6)], [])).toEqual([]);
    expect(types([item('desk', -1.3, -1.2, 1.2, 0.6)], [WINDOW])).toEqual([]);
  });
});

describe('통로 검사', () => {
  it('빈 방에 놓은 가구는 문에서 갈 수 있다', () => {
    expect(findUnreachable([item('bed', 1.4, 0.5, 1.0, 2.0), item('desk', -1.4, 1.2, 1.2, 0.6)], ROOM, [DOOR])).toEqual([]);
  });

  it('가구가 방을 가로질러 막으면 그 뒤의 가구는 갈 수 없다', () => {
    const items = [item('left', -1, 0, 2, 0.5), item('right', 1, 0, 2, 0.5), item('behind', 0, 1.1, 0.8, 0.6)];
    expect(findUnreachable(items, ROOM, [DOOR])).toEqual(['behind']);
    expect(types(items, [DOOR])).toEqual(['behind:unreachable']);
    expect(checkLayout(items, ROOM, [DOOR])[0].message).toBe('behind: 문에서 갈 수 없습니다 (통로 60cm 부족)');
  });

  it('틈이 60cm면 지나가고 40cm면 못 지나간다', () => {
    const behind = item('behind', 0, 1.1, 0.8, 0.6);
    // 왼쪽 벽(x=-2)에서 x=1.4까지 막음 → 오른쪽 벽과의 틈 0.6m
    expect(findUnreachable([item('wall', -0.3, 0, 3.4, 0.5), behind], ROOM, [DOOR])).toEqual([]);
    // x=1.6까지 막음 → 틈 0.4m
    expect(findUnreachable([item('wall', -0.2, 0, 3.6, 0.5), behind], ROOM, [DOOR])).toEqual(['behind']);
  });

  it('두 가구 사이의 틈도 같다', () => {
    const behind = item('behind', 0, 1.1, 0.8, 0.6);
    // 가운데에 0.6m 틈
    expect(findUnreachable([item('a', -1.15, 0, 1.7, 0.5), item('b', 1.15, 0, 1.7, 0.5), behind], ROOM, [DOOR])).toEqual([]);
    // 가운데에 0.4m 틈
    expect(findUnreachable([item('a', -1.1, 0, 1.8, 0.5), item('b', 1.1, 0, 1.8, 0.5), behind], ROOM, [DOOR])).toEqual(['behind']);
  });

  it('문이 둘이면 어느 문에서든 갈 수 있으면 된다', () => {
    const items = [item('left', -1, 0, 2, 0.5), item('right', 1, 0, 2, 0.5), item('behind', 0, 1.1, 0.8, 0.6)];
    const backDoor: Opening = { type: 'door', wallIndex: 2, from: 3, to: 3.9, widthM: 0.9 };
    expect(findUnreachable(items, ROOM, [DOOR, backDoor])).toEqual([]);
  });

  it('문이 없거나 문 앞이 완전히 막혀 있으면 통로는 검사하지 않는다', () => {
    const blocker = item('blocker', -1.35, -1.0, 1.3, 1.0);
    expect(findUnreachable([blocker], ROOM, [])).toBeNull();
    expect(findUnreachable([blocker, item('far', 1.4, 1, 0.8, 0.6)], ROOM, [DOOR])).toBeNull();
    expect(types([blocker, item('far', 1.4, 1, 0.8, 0.6)], [DOOR])).toEqual(['blocker:door']);
  });

  it('회전한 가구도 밑면대로 막는다', () => {
    // 가로로 놓으면 방을 가로막는 3.6 × 0.5 가구(틈 0.4m)를 90° 돌려 세로로 세우면 옆으로 지나갈 수 있다
    const behind = item('behind', 0, 1.1, 0.8, 0.6);
    expect(findUnreachable([item('long', -0.2, 0, 3.6, 0.5), behind], ROOM, [DOOR])).toEqual(['behind']);
    expect(findUnreachable([item('long', 1.0, 0, 1.6, 0.5, { rotationDeg: 90 }), behind], ROOM, [DOOR])).toEqual([]);
    // 세로로 세운 2.0 × 0.5 가구는 위아래 틈이 0.5m라 문 쪽 구석을 가둔다
    expect(findUnreachable([item('long', -0.5, 0, 2.0, 0.5, { rotationDeg: 90 }), item('far', 1.4, 0, 0.8, 0.6)], ROOM, [DOOR])).toEqual(['far']);
  });
});

describe('창문 가림 경고', () => {
  it('키 큰 가구가 창문 바로 앞에 있으면 경고', () => {
    const violations = checkLayout([item('wardrobe', 0.4, 1.2, 0.9, 0.6, { h: 2.0 })], ROOM, [WINDOW]);
    expect(violations).toEqual([{ itemId: 'wardrobe', type: 'window', severity: 'warning', message: 'wardrobe: 창문을 가립니다' }]);
    expect(violatingIds(violations).size).toBe(0);
    expect([...warningIds(violations)]).toEqual(['wardrobe']);
  });

  it('낮은 가구, 높이를 모르는 가구, 창문에서 떨어진 가구, 창문 옆의 가구는 괜찮다', () => {
    expect(types([item('desk', 0.4, 1.2, 1.2, 0.6, { h: 0.73 })], [WINDOW])).toEqual([]);
    expect(types([item('box', 0.4, 1.2, 1.2, 0.6)], [WINDOW])).toEqual([]);
    expect(types([item('wardrobe', 0.4, 0.8, 0.9, 0.6, { h: 2.0 })], [WINDOW])).toEqual([]);
    expect(types([item('wardrobe', -1.5, 1.2, 0.9, 0.6, { h: 2.0 })], [WINDOW])).toEqual([]);
  });

  it('문제와 경고가 함께 있으면 문제로 센다', () => {
    const violations = checkLayout([item('wardrobe', 0.4, 1.2, 0.9, 0.6, { h: 2.0 }), item('desk', 0.4, 1.1, 1.2, 0.6)], ROOM, [WINDOW]);
    expect([...violatingIds(violations)].sort()).toEqual(['desk', 'wardrobe']);
    expect(warningIds(violations).size).toBe(0);
  });
});
