import { describe, expect, it } from 'vitest';
import type { Footprint, Point2 } from '@/lib/three/floorDrag';
import { categoryColor, DEFAULT_CATALOG, fromCatalogRow } from '@/lib/layout/catalog';
import { checkLayout, findFreeSpot, violatingIds, type LayoutItem } from '@/lib/layout/check';
import {
  distanceToPolygon,
  distanceToSegment,
  footprintInsideRoom,
  footprintsOverlap,
  outsideDistance,
  overlapDepth,
  pointInPolygon,
} from '@/lib/layout/geometry';

// 4m × 3m 방, 원점이 가운데
const room: Point2[] = [
  [-2, -1.5],
  [2, -1.5],
  [2, 1.5],
  [-2, 1.5],
];
const box = (x: number, z: number, w = 1, d = 1, rotationDeg = 0): Footprint => ({ x, z, w, d, rotationDeg });
const item = (id: string, name: string, f: Footprint): LayoutItem => ({ ...f, id, name });

describe('overlapDepth / footprintsOverlap', () => {
  it('떨어져 있으면 음수(떨어진 거리)', () => {
    expect(overlapDepth(box(0, 0), box(1.5, 0))).toBeCloseTo(-0.5);
    expect(footprintsOverlap(box(0, 0), box(1.5, 0))).toBe(false);
  });

  it('딱 붙어 있으면 겹침이 아니다', () => {
    expect(overlapDepth(box(0, 0), box(1, 0))).toBeCloseTo(0);
    expect(footprintsOverlap(box(0, 0), box(1, 0))).toBe(false);
  });

  it('2cm 이내로 파고든 것은 허용, 그보다 깊으면 겹침', () => {
    expect(footprintsOverlap(box(0, 0), box(0.985, 0))).toBe(false); // 1.5cm
    expect(footprintsOverlap(box(0, 0), box(0.97, 0))).toBe(true); // 3cm
  });

  it('완전히 포개지면 겹침', () => {
    expect(footprintsOverlap(box(0, 0), box(0, 0, 0.5, 0.5))).toBe(true);
  });

  it('45° 돌린 가구: 축에 나란한 상자끼리는 안 닿는 거리에서도 모서리가 닿는다', () => {
    // 한 변 1m 정사각형을 45° 돌리면 가운데에서 꼭짓점까지 0.707m
    expect(footprintsOverlap(box(0, 0), box(1.1, 0, 1, 1, 45))).toBe(true);
    expect(footprintsOverlap(box(0, 0), box(1.25, 0, 1, 1, 45))).toBe(false);
  });

  it('대각선으로 비껴 있으면 경계 상자는 겹쳐도 겹침이 아니다', () => {
    // 길쭉한 가구 둘을 45°로 나란히 (경계 상자는 겹치지만 실제로는 떨어져 있음)
    const a = box(0, 0, 2, 0.2, 45);
    const b = box(0.6, 0.6, 2, 0.2, 45); // 긴 방향(1, -1)에 수직으로 0.85m 떨어짐
    expect(footprintsOverlap(a, b)).toBe(false);
  });

  it('90° 회전은 가로·깊이를 바꾼 것과 같다', () => {
    expect(footprintsOverlap(box(0, 0, 2, 0.5), box(0, 1, 2, 0.5, 90))).toBe(true);
    expect(footprintsOverlap(box(0, 0, 2, 0.5), box(0, 1.3, 2, 0.5, 90))).toBe(false);
  });
});

describe('다각형', () => {
  it('pointInPolygon', () => {
    expect(pointInPolygon([0, 0], room)).toBe(true);
    expect(pointInPolygon([2.5, 0], room)).toBe(false);
    expect(pointInPolygon([0, -1.6], room)).toBe(false);
  });

  it('distanceToSegment / distanceToPolygon', () => {
    expect(distanceToSegment([0, 1], [-1, 0], [1, 0])).toBeCloseTo(1);
    expect(distanceToSegment([3, 0], [-1, 0], [1, 0])).toBeCloseTo(2); // 끝점 밖
    expect(distanceToPolygon([0, 0], room)).toBeCloseTo(1.5);
    expect(distanceToPolygon([2.3, 0], room)).toBeCloseTo(0.3);
  });

  it('방 안·벽에 딱 붙음·방 밖', () => {
    expect(footprintInsideRoom(box(0, 0), room)).toBe(true);
    expect(footprintInsideRoom(box(1.5, 1), room)).toBe(true); // 모서리에 딱 붙음
    expect(outsideDistance(box(1.8, 0), room)).toBeCloseTo(0.3);
    expect(footprintInsideRoom(box(1.8, 0), room)).toBe(false);
    expect(footprintInsideRoom(box(1.51, 0), room)).toBe(true); // 1cm는 허용
  });
});

describe('checkLayout', () => {
  it('문제가 없으면 빈 목록', () => {
    expect(checkLayout([item('a', '책상', box(-1, 0)), item('b', '옷장', box(1, 0))], room)).toEqual([]);
  });

  it('겹치면 양쪽 가구 모두에 알린다', () => {
    const violations = checkLayout([item('a', '책상', box(0, 0)), item('b', '옷장', box(0.5, 0))], room);
    expect(violations).toEqual([
      { itemId: 'a', type: 'overlap', otherId: 'b', message: '책상: 옷장와(과) 겹칩니다' },
      { itemId: 'b', type: 'overlap', otherId: 'a', message: '옷장: 책상와(과) 겹칩니다' },
    ]);
    expect([...violatingIds(violations)].sort()).toEqual(['a', 'b']);
  });

  it('방 밖으로 나간 가구', () => {
    const violations = checkLayout([item('a', '침대', box(1.9, 0))], room);
    expect(violations).toEqual([{ itemId: 'a', type: 'outside', message: '침대: 방 밖으로 나갔습니다' }]);
  });

  it('방 정보가 없으면 겹침만 검사한다', () => {
    expect(checkLayout([item('a', '침대', box(99, 0))], null)).toEqual([]);
  });

  it('세 가구가 한데 겹치면 쌍마다 알린다', () => {
    const three = [item('a', 'A', box(0, 0)), item('b', 'B', box(0.3, 0)), item('c', 'C', box(0.6, 0))];
    expect(checkLayout(three, room).filter((v) => v.type === 'overlap')).toHaveLength(6);
  });
});

describe('findFreeSpot', () => {
  it('빈 방에서는 가운데', () => {
    expect(findFreeSpot({ w: 1.2, d: 0.6 }, [], room)).toMatchObject({ x: 0, z: 0, rotationDeg: 0 });
  });

  it('가운데에 가구가 있으면 겹치지 않는 가까운 자리', () => {
    const desk = box(0, 0, 1.2, 0.6);
    const spot = findFreeSpot({ w: 0.9, d: 0.6 }, [desk], room);
    expect(footprintsOverlap(spot, desk)).toBe(false);
    expect(footprintInsideRoom(spot, room)).toBe(true);
    expect(Math.hypot(spot.x, spot.z)).toBeLessThan(1.5);
  });

  it('여러 개를 차례로 놓아도 서로 겹치지 않는다', () => {
    const placed: Footprint[] = [];
    for (let i = 0; i < 5; i += 1) placed.push(findFreeSpot({ w: 0.8, d: 0.6 }, placed, room));
    expect(checkLayout(placed.map((f, i) => item(`f${i}`, `가구${i}`, f)), room)).toEqual([]);
  });

  it('자리가 없으면 가운데에 둔다 (검사에서 겹침으로 알림)', () => {
    const full = box(0, 0, 4, 3);
    expect(findFreeSpot({ w: 1, d: 1 }, [full], room)).toMatchObject({ x: 0, z: 0 });
  });

  it('방 가운데가 원점이 아니어도 방 안에 놓는다', () => {
    const shifted: Point2[] = room.map(([x, z]) => [x + 10, z + 5]);
    const spot = findFreeSpot({ w: 1, d: 1 }, [], shifted);
    expect(spot.x).toBeCloseTo(10);
    expect(spot.z).toBeCloseTo(5);
  });
});

describe('카탈로그', () => {
  it('DB 행을 화면에서 쓰는 모양으로 바꾼다 (numeric이 문자열로 와도 숫자로)', () => {
    const row = { id: 'desk', name_ko: '책상', category: 'desk', width_m: '1.20' as unknown as number, depth_m: 0.6, height_m: 0.73, clearance_m: 0.7 };
    expect(fromCatalogRow(row)).toEqual({ id: 'desk', nameKo: '책상', category: 'desk', w: 1.2, d: 0.6, h: 0.73, clearance: 0.7 });
  });

  it('기본 카탈로그는 10종이고 id가 겹치지 않는다', () => {
    expect(DEFAULT_CATALOG).toHaveLength(10);
    expect(new Set(DEFAULT_CATALOG.map((c) => c.id)).size).toBe(10);
  });

  it('종류별 색, 모르는 종류는 회색', () => {
    expect(categoryColor('bed')).not.toBe(categoryColor('desk'));
    expect(categoryColor('unknown')).toBe(0xb7b7b7);
  });
});
