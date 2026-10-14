import { describe, expect, it } from 'vitest';
import type { Footprint, Point2 } from '@/lib/three/floorDrag';
import { lastInsideAlong } from '@/lib/layout/geometry';
import { readdirSync, readFileSync } from 'node:fs';
import { catalogLabel, catalogThumbnail, categoryColor, DEFAULT_CATALOG, fromCatalogRow, modelCredits } from '@/lib/layout/catalog';
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
      { itemId: 'a', type: 'overlap', severity: 'error', otherId: 'b', message: '책상: 옷장와(과) 겹칩니다' },
      { itemId: 'b', type: 'overlap', severity: 'error', otherId: 'a', message: '옷장: 책상와(과) 겹칩니다' },
    ]);
    expect([...violatingIds(violations)].sort()).toEqual(['a', 'b']);
  });

  it('방 밖으로 나간 가구', () => {
    const violations = checkLayout([item('a', '침대', box(1.9, 0))], room);
    expect(violations).toEqual([{ itemId: 'a', type: 'outside', severity: 'error', message: '침대: 방 밖으로 나갔습니다' }]);
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

  it('시작점을 주면 거기서부터 (화면 가운데 바닥에 놓을 때)', () => {
    const spot = findFreeSpot({ w: 0.6, d: 0.6 }, [], room, undefined, [1, 0.5]);
    expect([spot.x, spot.z]).toEqual([1, 0.5]);
  });

  it('시작점이 방 밖이면 방 가운데부터', () => {
    expect(findFreeSpot({ w: 0.6, d: 0.6 }, [], room, undefined, [50, 50])).toMatchObject({ x: 0, z: 0 });
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

  it('모델 출처가 있으면 함께 넘긴다', () => {
    const row = { id: 'desk', name_ko: '책상', category: 'desk', width_m: 1.25, depth_m: 0.6, height_m: 0.77, clearance_m: 0.7, license: 'ABO, CC BY 4.0' };
    expect(fromCatalogRow(row, 'https://r2/desk.glb')).toMatchObject({ modelUrl: 'https://r2/desk.glb', license: 'ABO, CC BY 4.0' });
    expect(fromCatalogRow({ ...row, license: null })).not.toHaveProperty('license');
  });

  it('출처 목록: 모델이 있는 가구의 출처만, 겹치지 않게', () => {
    const base = DEFAULT_CATALOG[0];
    expect(
      modelCredits([
        { ...base, id: 'a', modelUrl: 'u1', license: 'ABO' },
        { ...base, id: 'b', modelUrl: 'u2', license: 'ABO' },
        { ...base, id: 'c', modelUrl: 'u3', license: 'Poly Haven' },
        { ...base, id: 'd', license: 'Kenney' }, // 모델 주소가 없으면 화면에 모델이 없으므로 뺀다
        { ...base, id: 'e', modelUrl: 'u4' },
      ]),
    ).toEqual(['ABO', 'Poly Haven']);
  });

  it('기본 카탈로그는 DB 마이그레이션(종류마다 두 모양)과 같은 이름·모양·분류·치수·순서', () => {
    const file = readdirSync('supabase/migrations').find((f) => f.endsWith('_furniture_catalog_variants.sql'));
    const sql = readFileSync(`supabase/migrations/${file}`, 'utf8');
    const rows = [...sql.matchAll(/\('([a-z0-9-]+)', '([^']+)', '([^']+)', '([a-z]+)', ([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+), \d+, '[^']+'\)/g)].map((m) => [
      m[1],
      m[2],
      m[3],
      m[4],
      +m[5],
      +m[6],
      +m[7],
      +m[8],
    ]);
    expect(rows).toEqual(DEFAULT_CATALOG.map((c) => [c.id, c.nameKo, c.styleKo, c.category, c.w, c.d, c.h, c.clearance]));
  });

  it('기본 카탈로그는 18종 × 두 모양, id가 겹치지 않고 두 번째 모양은 -b', () => {
    expect(DEFAULT_CATALOG).toHaveLength(36);
    expect(new Set(DEFAULT_CATALOG.map((c) => c.id)).size).toBe(36);
    for (let i = 0; i < DEFAULT_CATALOG.length; i += 2) {
      const [a, b] = [DEFAULT_CATALOG[i], DEFAULT_CATALOG[i + 1]];
      expect(b.id).toBe(`${a.id}-b`);
      expect(b.nameKo).toBe(a.nameKo);
      expect(b.styleKo).not.toBe(a.styleKo);
    }
  });

  it('목록 이름과 모델 사진: "책상 · 서랍형", 내 가구는 사진 없음', () => {
    expect(catalogLabel({ nameKo: '책상', styleKo: '서랍형' })).toBe('책상 · 서랍형');
    expect(catalogLabel({ nameKo: '수납장' })).toBe('수납장');
    expect(catalogThumbnail({ id: 'desk-b' })).toBe('/furniture/desk-b.webp');
    expect(catalogThumbnail({ id: 'u1', kind: 'user' })).toBeNull();
  });

  it('DB 행의 모양 이름을 넘긴다', () => {
    const row = { id: 'desk-b', name_ko: '책상', style_ko: '철제 다리', category: 'desk', width_m: 1.2, depth_m: 0.6, height_m: 0.75, clearance_m: 0.7 };
    expect(fromCatalogRow(row).styleKo).toBe('철제 다리');
    expect(fromCatalogRow({ ...row, style_ko: null })).not.toHaveProperty('styleKo');
  });

  it('종류별 색, 모르는 종류는 회색', () => {
    expect(categoryColor('bed')).not.toBe(categoryColor('desk'));
    expect(categoryColor('unknown')).toBe(0xb7b7b7);
  });
});

describe('lastInsideAlong', () => {
  it('벽 너머까지 가는 선분은 벽 바로 앞에서 멈춘다', () => {
    const p = lastInsideAlong([0, 0], [4, 0], room);
    expect(p?.[0]).toBeGreaterThan(1.8);
    expect(p?.[0]).toBeLessThanOrEqual(2);
  });

  it('끝까지 방 안이면 끝점, 시작이 방 밖이면 null', () => {
    expect(lastInsideAlong([0, 0], [1, 1], room)).toEqual([1, 1]);
    expect(lastInsideAlong([5, 5], [0, 0], room)).toBeNull();
  });
});
