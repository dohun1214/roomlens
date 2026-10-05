import { describe, expect, it } from 'vitest';
import { accessBlocked, accessRule, blocksAccess, findBlockedAccess, frontDirection, sideZone, type AccessItem } from '@/lib/layout/accessSide';
import { checkLayout, findFreeSpot, violatingIds, warningIds, type LayoutItem } from '@/lib/layout/check';
import type { Point2 } from '@/lib/three/floorDrag';

// 4 × 3 m 방. x -2~2, z -1.5~1.5
const ROOM: Point2[] = [
  [-2, -1.5],
  [2, -1.5],
  [2, 1.5],
  [-2, 1.5],
];

const make = (id: string, category: string, w: number, d: number, clearance: number) => (x: number, z: number, rotationDeg = 0): AccessItem & { name: string } => ({
  id,
  name: id,
  category,
  clearance,
  w,
  d,
  x,
  z,
  rotationDeg,
});
const desk = make('desk', 'desk', 1.2, 0.6, 0.7);
const wardrobe = make('wardrobe', 'storage', 0.9, 0.6, 0.6);
const bed = make('bed', 'bed', 1.0, 2.0, 0.6);
const table = make('table', 'table', 0.8, 0.6, 0.6);
const chair = make('chair', 'chair', 0.5, 0.5, 0);

describe('가구 종류별 쓰는 쪽', () => {
  it('책상·수납은 앞, 침대는 긴 변 한쪽, 식탁은 긴 변 양쪽', () => {
    expect(accessRule(desk(0, 0))).toMatchObject({ sides: ['front'], mode: 'all' });
    expect(accessRule(wardrobe(0, 0))).toMatchObject({ sides: ['front'], mode: 'all' });
    expect(accessRule(bed(0, 0))).toMatchObject({ sides: ['left', 'right'], mode: 'any', footHalf: true });
    expect(accessRule(table(0, 0))).toMatchObject({ sides: ['front', 'back'], mode: 'all' });
  });

  it('긴 변은 치수로 정한다', () => {
    expect(accessRule({ category: 'bed', clearance: 0.6, w: 2.0, d: 1.0 })?.sides).toEqual(['front', 'back']);
    expect(accessRule({ category: 'table', clearance: 0.6, w: 0.6, d: 1.4 })?.sides).toEqual(['left', 'right']);
  });

  it('의자·내 가구·비워 둘 깊이가 없는 가구는 검사하지 않는다', () => {
    expect(accessRule(chair(0, 0))).toBeNull();
    expect(accessRule({ category: 'etc', clearance: 0.6, w: 1, d: 1 })).toBeNull();
    expect(accessRule({ category: 'desk', clearance: 0, w: 1, d: 1 })).toBeNull();
    expect(accessRule({ w: 1, d: 1 })).toBeNull();
  });

  it('이유에 필요한 깊이를 cm로 적는다', () => {
    expect(accessRule(desk(0, 0))?.message).toBe('앞이 막혀 있습니다 (앞에 70cm 필요)');
  });
});

describe('가구 옆 구역', () => {
  const f = { x: 0, z: 0, w: 1.2, d: 0.6, rotationDeg: 0 };

  it('앞은 +z, 뒤는 -z, 좌우는 x 방향', () => {
    const rounded = (zone: typeof f) => [zone.x, zone.z, zone.w, zone.d].map((v) => Math.round(v * 1000) / 1000 + 0);
    expect(rounded(sideZone(f, 'front', 0.7))).toEqual([0, 0.65, 1.2, 0.7]);
    expect(rounded(sideZone(f, 'back', 0.7))).toEqual([0, -0.65, 1.2, 0.7]);
    expect(rounded(sideZone(f, 'right', 0.6))).toEqual([0.9, 0, 0.6, 0.6]);
    expect(rounded(sideZone(f, 'left', 0.6))).toEqual([-0.9, 0, 0.6, 0.6]);
  });

  it('발치 절반: 좌우 구역이 앞쪽 절반만 차지한다', () => {
    const bedShape = { x: 0, z: 0, w: 1.0, d: 2.0, rotationDeg: 0 };
    const zone = sideZone(bedShape, 'right', 0.6, true);
    expect([zone.x, zone.z, zone.w, zone.d]).toEqual([0.8, 0.5, 0.6, 1.0]);
  });

  it('가구를 돌리면 구역도 같이 돈다 (90°: 앞이 +x)', () => {
    const zone = sideZone({ ...f, rotationDeg: 90 }, 'front', 0.7);
    expect(zone.x).toBeCloseTo(0.65);
    expect(zone.z).toBeCloseTo(0);
    const [fx, fz] = frontDirection(90);
    expect(fx).toBeCloseTo(1);
    expect(fz).toBeCloseTo(0);
    expect(frontDirection(0)).toEqual([0, 1]);
  });
});

describe('쓰는 쪽이 막혔는지', () => {
  it('벽을 등진 책상은 괜찮고, 벽을 보고 선 책상은 막혔다', () => {
    expect(accessBlocked(desk(0, -1.2, 0), [], ROOM)).toBe(false);
    expect(accessBlocked(desk(0, -1.2, 180), [], ROOM)).toBe(true);
  });

  it('앞의 60cm 가운데 일부만 방 밖이어도 막힌 것으로 본다', () => {
    // 옷장 앞면이 z=0.4 → 앞 구역 z 0.4~1.0 은 방 안, z=1.0 → 1.0~1.6 은 벽(1.5)을 넘는다
    expect(accessBlocked(wardrobe(0, 0.1), [], ROOM)).toBe(false);
    expect(accessBlocked(wardrobe(0, 0.7), [], ROOM)).toBe(true);
  });

  it('다른 가구가 앞을 막으면 막힌 것, 의자는 막는 것으로 보지 않는다', () => {
    const w = wardrobe(0, -1.2);
    expect(accessBlocked(w, [w, bed(0, 0.2)], ROOM)).toBe(true);
    expect(accessBlocked(w, [w, chair(0, -0.6)], ROOM)).toBe(false);
    // 옆에 붙은 가구는 앞을 막지 않는다
    expect(accessBlocked(w, [w, desk(1.05, -1.2)], ROOM)).toBe(false);
  });

  it('침대는 긴 변 한쪽만 비면 된다', () => {
    // 왼쪽 긴 변이 벽(x=-2)에 붙음, 오른쪽은 비어 있음
    const b = bed(-1.5, -0.5);
    expect(accessBlocked(b, [b], ROOM)).toBe(false);
    // 오른쪽에 옷장을 붙이면 양쪽이 다 막힌다
    expect(accessBlocked(b, [b, wardrobe(-0.55, -0.5)], ROOM)).toBe(true);
    // 머리맡(뒤쪽 절반)에 붙인 협탁은 막지 않는다
    expect(accessBlocked(b, [b, wardrobe(-0.55, -1.2)], ROOM)).toBe(false);
  });

  it('식탁은 긴 변 양쪽이 다 비어야 한다', () => {
    expect(accessBlocked(table(0, 0), [], ROOM)).toBe(false);
    expect(accessBlocked(table(0, -1.2), [], ROOM)).toBe(true);
  });

  it('방 평면도가 없으면 가구끼리만 본다', () => {
    expect(accessBlocked(desk(0, -1.2, 180), [], null)).toBe(false);
  });

  it('막힌 가구와 이유를 모아 준다', () => {
    const items = [desk(0, -1.2, 180), wardrobe(-1.5, -1.2), chair(1.5, 1)];
    expect(findBlockedAccess(items, ROOM)).toEqual([{ id: 'desk', message: '앞이 막혀 있습니다 (앞에 70cm 필요)' }]);
  });
});

describe('새 가구를 놓을 자리', () => {
  it('새 가구가 막히거나 다른 가구를 새로 막으면 알려 준다', () => {
    const w = wardrobe(0, -1.2);
    // 옷장 앞(z -0.9~-0.3)에 놓는 서랍장
    expect(blocksAccess({ ...make('drawer', 'storage', 0.8, 0.45, 0.6)(0, -0.6) }, [w], ROOM)).toBe(true);
    // 옷장 옆에 나란히 놓는 서랍장
    expect(blocksAccess({ ...make('drawer', 'storage', 0.8, 0.45, 0.6)(1.0, -1.25) }, [w], ROOM)).toBe(false);
    // 이미 막혀 있던 가구는 새 가구 탓이 아니다
    const stuck = desk(0, -1.2, 180);
    expect(blocksAccess(chair(1.5, 1), [stuck], ROOM)).toBe(false);
  });

  it('빈자리 찾기: 쓰는 쪽을 막지 않는 자리를 먼저 고르고, 없으면 조건 없이 고른다', () => {
    const d = desk(0, 0);
    const size = { w: 0.9, d: 0.6 };
    const plain = findFreeSpot(size, [d], ROOM);
    const careful = findFreeSpot(size, [d], ROOM, (spot) => !blocksAccess({ ...spot, id: 'new', category: 'storage', clearance: 0.6 }, [d], ROOM));
    expect(blocksAccess({ ...careful, id: 'new', category: 'storage', clearance: 0.6 }, [d], ROOM)).toBe(false);
    expect(checkLayout([d, { ...careful, id: 'new', name: 'new', category: 'storage', clearance: 0.6 }] as LayoutItem[], ROOM)).toEqual([]);
    // 지킬 수 없는 조건이면 조건이 없을 때와 같은 자리
    expect(findFreeSpot(size, [d], ROOM, () => false)).toEqual(plain);
  });
});

describe('배치 검사에서의 쓰는 쪽', () => {
  it('막히면 경고로 알린다 (고쳐야 하는 문제는 아님)', () => {
    const violations = checkLayout([desk(0, -1.2, 180)] as LayoutItem[], ROOM);
    expect(violations).toEqual([{ itemId: 'desk', type: 'access', severity: 'warning', message: 'desk: 앞이 막혀 있습니다 (앞에 70cm 필요)' }]);
    expect(violatingIds(violations).size).toBe(0);
    expect([...warningIds(violations)]).toEqual(['desk']);
  });

  it('종류를 모르는 가구는 검사하지 않는다', () => {
    expect(checkLayout([{ id: 'a', name: '상자', x: 0, z: -1.2, w: 1.2, d: 0.6, rotationDeg: 180 }], ROOM)).toEqual([]);
  });

  it('다른 문제 뒤에 붙는다', () => {
    const w = wardrobe(0, -1.2);
    const b = { ...bed(0, 0.2), name: 'bed' };
    const types = checkLayout([w, b] as LayoutItem[], ROOM).map((v) => `${v.itemId}:${v.type}`);
    expect(types).toEqual(['wardrobe:access']);
    const overlapping = checkLayout([w, { ...b, z: -0.5 }] as LayoutItem[], ROOM).map((v) => `${v.itemId}:${v.type}`);
    expect(overlapping).toEqual(['wardrobe:overlap', 'bed:overlap', 'wardrobe:access']);
  });
});
