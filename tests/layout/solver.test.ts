import { describe, expect, it } from 'vitest';
import { frontDirection } from '@/lib/layout/accessSide';
import { checkLayout } from '@/lib/layout/check';
import { interiorPoint, overlapDepth } from '@/lib/layout/geometry';
import { solveLayout, type Placement, type SolveResult, type SolverItem, type SolverRoom } from '@/lib/layout/solver';
import type { Opening } from '@/lib/rooms/openings';
import { footprintCorners, type Point2 } from '@/lib/three/floorDrag';

// 3.2 × 4.0 m 원룸. W1: z=-2 (북쪽, 문), W2: x=1.6 (동쪽), W3: z=2 (남쪽, 창문), W4: x=-1.6 (서쪽)
const POLYGON: Point2[] = [
  [-1.6, -2],
  [1.6, -2],
  [1.6, 2],
  [-1.6, 2],
];
// 문: x -1.4 ~ -0.5, 창문: x -0.8 ~ 0.8
const DOOR: Opening = { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 };
const WINDOW: Opening = { type: 'window', wallIndex: 2, from: 0.8, to: 2.4, widthM: 1.6 };
const ROOM: SolverRoom = { polygon: POLYGON, openings: [DOOR, WINDOW] };

const BED: SolverItem = { id: 'bed', name: '슈퍼싱글 침대', category: 'bed', w: 1.1, d: 2.0, h: 0.45, clearance: 0.6 };
const DESK: SolverItem = { id: 'desk', name: '책상', category: 'desk', w: 1.2, d: 0.6, h: 0.73, clearance: 0.7 };
const WARDROBE: SolverItem = { id: 'ward', name: '옷장', category: 'storage', w: 0.9, d: 0.6, h: 2.0, clearance: 0.6 };
const CHAIR: SolverItem = { id: 'chair', name: '의자', category: 'chair', w: 0.5, d: 0.5, h: 0.8, clearance: 0 };
const DRAWER: SolverItem = { id: 'drawer', name: '서랍장', category: 'storage', w: 0.8, d: 0.45, h: 0.8, clearance: 0.6 };
const BOOKCASE: SolverItem = { id: 'book', name: '책장', category: 'storage', w: 0.8, d: 0.3, h: 1.8, clearance: 0.6 };

const place = (itemId: string, zone: Placement['zone'], extra: Partial<Placement> = {}): Placement => ({
  itemId,
  zone,
  wallId: '',
  nearItemId: '',
  facing: 'into_room',
  priority: 5,
  reason: `${itemId} 이유`,
  ...extra,
});

const errorsOf = (result: SolveResult, room: SolverRoom) => checkLayout(result.placed, room.polygon, room.openings).filter((v) => v.severity === 'error');
const find = (result: SolveResult, id: string) => {
  const item = result.placed.find((p) => p.id === id);
  if (!item) throw new Error(`${id}가 놓이지 않음`);
  return item;
};
const extent = (result: SolveResult, id: string) => {
  const corners = footprintCorners(find(result, id));
  const xs = corners.map((c) => c[0]);
  const zs = corners.map((c) => c[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
};

describe('배치 솔버: 원룸', () => {
  const result = solveLayout(ROOM, [BED, DESK, WARDROBE, CHAIR], [
    place('bed', 'against_wall', { wallId: 'W2', priority: 1 }),
    place('desk', 'under_window', { wallId: 'W3', priority: 2 }),
    place('ward', 'against_wall', { wallId: 'W4', priority: 3 }),
    place('chair', 'beside_item', { nearItemId: 'desk', priority: 4 }),
  ]);

  it('모든 가구를 놓고, 겹침·방 밖·문 앞·통로 문제가 없다', () => {
    expect(result.failures).toEqual([]);
    expect(result.placed.map((p) => p.id)).toEqual(['bed', 'desk', 'ward', 'chair']);
    expect(errorsOf(result, ROOM)).toEqual([]);
    expect(result.unmet).toEqual([]);
  });

  it('요청한 벽에 붙인다', () => {
    expect(extent(result, 'bed').maxX).toBeCloseTo(1.6, 2);
    expect(extent(result, 'desk').maxZ).toBeCloseTo(2, 2);
    expect(extent(result, 'ward').minX).toBeCloseTo(-1.6, 2);
  });

  it('책상은 창문 가운데 아래에, 벽을 등지고 놓는다', () => {
    const desk = find(result, 'desk');
    expect(desk.x).toBeCloseTo(0, 1);
    expect(desk.z).toBeCloseTo(1.7, 2);
    expect(desk.rotationDeg).toBe(180);
  });

  it('벽에 붙인 가구의 앞은 방 안쪽을 본다', () => {
    const middle = interiorPoint(POLYGON);
    for (const id of ['desk', 'ward']) {
      const item = find(result, id);
      const [fx, fz] = frontDirection(item.rotationDeg);
      expect(fx * (middle[0] - item.x) + fz * (middle[1] - item.z)).toBeGreaterThan(0);
    }
    expect(find(result, 'ward').rotationDeg).toBe(90);
  });

  it('의자는 책상 앞에 책상을 보고 놓는다', () => {
    const desk = find(result, 'desk');
    const chair = find(result, 'chair');
    expect(chair.x).toBeCloseTo(desk.x, 2);
    expect(chair.z).toBeCloseTo(1.7 - 0.3 - 0.25 - 0.05, 2);
    expect(chair.rotationDeg).toBe(0);
  });

  it('Gemini가 적은 이유를 가구에 붙여 돌려준다', () => {
    expect(find(result, 'bed').reason).toBe('bed 이유');
  });

  it('같은 입력이면 같은 결과', () => {
    const again = solveLayout(ROOM, [BED, DESK, WARDROBE, CHAIR], [
      place('bed', 'against_wall', { wallId: 'W2', priority: 1 }),
      place('desk', 'under_window', { wallId: 'W3', priority: 2 }),
      place('ward', 'against_wall', { wallId: 'W4', priority: 3 }),
      place('chair', 'beside_item', { nearItemId: 'desk', priority: 4 }),
    ]);
    expect(again).toEqual(result);
  });
});

describe('배치 솔버: 구역', () => {
  it('모서리: 두 벽에 붙는다', () => {
    const result = solveLayout(ROOM, [BED], [place('bed', 'corner', { wallId: 'W3' })]);
    const e = extent(result, 'bed');
    expect(e.maxZ).toBeCloseTo(2, 2);
    expect(Math.min(Math.abs(e.minX + 1.6), Math.abs(e.maxX - 1.6))).toBeLessThan(0.03);
    expect(errorsOf(result, ROOM)).toEqual([]);
  });

  it('문이 있는 벽에 붙여도 문 앞은 비운다', () => {
    const result = solveLayout(ROOM, [DESK], [place('desk', 'against_wall', { wallId: 'W1' })]);
    const e = extent(result, 'desk');
    expect(e.minZ).toBeCloseTo(-2, 2);
    expect(e.minX).toBeGreaterThanOrEqual(-0.5 - 0.021);
    expect(errorsOf(result, ROOM)).toEqual([]);
  });

  it('키 큰 가구는 창문을 피한다', () => {
    const result = solveLayout(ROOM, [BOOKCASE], [place('book', 'against_wall', { wallId: 'W3' })]);
    expect(extent(result, 'book').maxZ).toBeCloseTo(2, 2);
    expect(result.unmet).toEqual([]);
    const e = extent(result, 'book');
    expect(e.maxX <= -0.78 || e.minX >= 0.78).toBe(true);
  });

  it('다른 가구 옆: 기준 가구에 붙여 놓는다 (기준 가구의 우선순위가 낮아도 먼저 놓는다)', () => {
    const result = solveLayout(ROOM, [DRAWER, BED], [
      place('drawer', 'beside_item', { nearItemId: 'bed', priority: 1 }),
      place('bed', 'against_wall', { wallId: 'W2', priority: 9 }),
    ]);
    expect(result.failures).toEqual([]);
    const gap = -overlapDepth(find(result, 'drawer'), find(result, 'bed'));
    expect(gap).toBeLessThan(0.03);
    // 침대 머리맡에 붙으므로 침대에 들어갈 자리를 막지 않는다
    expect(result.unmet).toEqual([]);
    expect(errorsOf(result, ROOM)).toEqual([]);
  });

  it('서로를 기준으로 삼아도 멈추지 않는다', () => {
    const result = solveLayout(ROOM, [DRAWER, DESK], [
      place('drawer', 'beside_item', { nearItemId: 'desk' }),
      place('desk', 'beside_item', { nearItemId: 'drawer' }),
    ]);
    expect(result.placed).toHaveLength(2);
    expect(errorsOf(result, ROOM)).toEqual([]);
  });

  it('방 가운데: 벽에서 떨어져 방 가운데 가까이', () => {
    const table: SolverItem = { id: 'table', name: '2인 식탁', category: 'table', w: 0.8, d: 0.6, h: 0.72, clearance: 0.6 };
    const result = solveLayout(ROOM, [table], [place('table', 'center')]);
    const item = find(result, 'table');
    expect(Math.hypot(item.x, item.z)).toBeLessThan(0.3);
    expect(result.unmet).toEqual([]);
  });

  it('창문을 보게: 가구의 앞이 창문 쪽을 향한다', () => {
    const result = solveLayout(ROOM, [CHAIR], [place('chair', 'center', { facing: 'toward_window' })]);
    // CHAIR는 앞뒤 구분 없이 0°·90°만 시도한다 → 창문(+z)을 보는 0°
    expect(find(result, 'chair').rotationDeg).toBe(0);
  });
});

describe('배치 솔버: 자리가 없을 때', () => {
  const LONG: SolverItem = { id: 'long', name: '긴 수납장', category: 'storage', w: 3.0, d: 0.5, h: 0.8, clearance: 0.6 };
  const intent = [place('long', 'against_wall', { wallId: 'W3', priority: 1 }), place('desk', 'against_wall', { wallId: 'W3', priority: 2 })];

  it('다른 곳에라도 놓고, 요청한 벽이 아니라고 알린다 (기본)', () => {
    const result = solveLayout(ROOM, [LONG, DESK], intent);
    expect(result.failures).toEqual([]);
    expect(result.placed).toHaveLength(2);
    expect(extent(result, 'desk').maxZ).toBeLessThan(1.9);
    expect(result.unmet.map((n) => n.itemId)).toContain('desk');
    expect(result.unmet.find((n) => n.itemId === 'desk')?.message).toMatch(/^책상: W3의 벽에 자리가 없어 W\d 벽에 놓았습니다$/);
    expect(errorsOf(result, ROOM)).toEqual([]);
  });

  it('fallback을 끄면 놓지 않고 이유를 돌려준다', () => {
    const result = solveLayout(ROOM, [LONG, DESK], intent, { fallback: false });
    expect(result.placed.map((p) => p.id)).toEqual(['long']);
    expect(result.failures).toEqual([{ itemId: 'desk', message: '책상: W3의 벽에 자리가 없음 (긴 수납장와(과) 겹침)' }]);
  });

  it('벽이 가구보다 짧으면 그 이유를 알린다', () => {
    const wide: SolverItem = { ...LONG, id: 'wide', name: '아주 긴 장', w: 3.5 };
    const result = solveLayout(ROOM, [wide], [place('wide', 'against_wall', { wallId: 'W1' })], { fallback: false });
    expect(result.failures).toEqual([{ itemId: 'wide', message: '아주 긴 장: W1의 벽에 놓을 수 없음 (가구가 들어갈 길이가 안 됨)' }]);
  });

  it('창문이 없는 벽의 창문 아래를 요청하면', () => {
    const strict = solveLayout(ROOM, [DESK], [place('desk', 'under_window', { wallId: 'W2' })], { fallback: false });
    expect(strict.failures).toEqual([{ itemId: 'desk', message: '책상: W2의 창문 아래: 창문이 없음' }]);
    // 기본: 다른 벽의 창문 아래에 놓고 알린다
    const loose = solveLayout(ROOM, [DESK], [place('desk', 'under_window', { wallId: 'W2' })]);
    expect(extent(loose, 'desk').maxZ).toBeCloseTo(2, 2);
    expect(loose.unmet).toEqual([{ itemId: 'desk', message: '책상: W2의 창문 아래에 자리가 없어 W3 벽에 놓았습니다' }]);
  });

  it('기준 가구가 없으면 옆에 둘 수 없다', () => {
    const result = solveLayout(ROOM, [CHAIR], [place('chair', 'beside_item', { nearItemId: 'nothing' })], { fallback: false });
    expect(result.failures).toEqual([{ itemId: 'chair', message: '의자: 기준 가구(nothing)가 놓이지 않아 옆에 둘 수 없음' }]);
  });

  it('방이 꽉 차면 못 놓은 가구를 알리고, 놓은 가구끼리는 겹치지 않는다', () => {
    const beds = Array.from({ length: 8 }, (_, i) => ({ ...BED, id: `bed${i}`, name: `침대${i}` }));
    const result = solveLayout(ROOM, beds, beds.map((b) => place(b.id, 'against_wall')));
    expect(result.placed.length).toBeGreaterThanOrEqual(3);
    expect(result.failures.length).toBeGreaterThanOrEqual(1);
    expect(result.placed.length + result.failures.length).toBe(8);
    expect(errorsOf(result, ROOM).filter((v) => v.type !== 'unreachable')).toEqual([]);
  });
});

describe('배치 솔버: 의도가 이상할 때', () => {
  it('없는 가구 id는 무시하고, 의도에서 빠진 가구는 아무 벽에나 붙인다', () => {
    const result = solveLayout(ROOM, [DESK, WARDROBE], [place('ghost', 'center'), place('desk', 'against_wall', { wallId: 'W2' })]);
    expect(result.placed.map((p) => p.id)).toEqual(['desk', 'ward']);
    expect(result.failures).toEqual([]);
    expect(find(result, 'ward').reason).toBe('');
    expect(errorsOf(result, ROOM)).toEqual([]);
  });

  it('같은 가구가 두 번 나오면 처음 것만 쓴다', () => {
    const result = solveLayout(ROOM, [DESK], [place('desk', 'against_wall', { wallId: 'W2' }), place('desk', 'against_wall', { wallId: 'W4' })]);
    expect(result.placed).toHaveLength(1);
    expect(extent(result, 'desk').maxX).toBeCloseTo(1.6, 2);
  });

  it('없는 벽 이름은 "아무 벽"으로 본다', () => {
    const result = solveLayout(ROOM, [DESK], [place('desk', 'against_wall', { wallId: 'W99' })]);
    expect(result.placed).toHaveLength(1);
    expect(result.unmet).toEqual([]);
  });

  it('가구가 없으면 빈 결과', () => {
    expect(solveLayout(ROOM, [], [place('desk', 'center')])).toEqual({ placed: [], failures: [], unmet: [] });
  });
});

describe('배치 솔버: 사각형이 아닌 방', () => {
  // ㄱ자 방: 4 × 3.5 에서 오른쪽 아래 2 × 1.5 를 뺀 모양
  const L_ROOM: SolverRoom = {
    polygon: [
      [0, 0],
      [4, 0],
      [4, 2],
      [2, 2],
      [2, 3.5],
      [0, 3.5],
    ],
    // W6 (x=0, 아래→위로 3.5m): 문은 z 2.9~2.0
    openings: [
      { type: 'door', wallIndex: 5, from: 0.6, to: 1.5, widthM: 0.9 },
      { type: 'window', wallIndex: 0, from: 1, to: 2.5, widthM: 1.5 },
    ],
  };

  it('오목한 방에서도 방 안에, 겹치지 않게 놓는다', () => {
    const result = solveLayout(L_ROOM, [BED, DESK, WARDROBE, DRAWER, CHAIR], [
      place('bed', 'corner', { wallId: 'W2', priority: 1 }),
      place('desk', 'under_window', { priority: 2 }),
      place('ward', 'against_wall', { wallId: 'W5', priority: 3 }),
      place('drawer', 'beside_item', { nearItemId: 'bed', priority: 4 }),
      place('chair', 'beside_item', { nearItemId: 'desk', priority: 5 }),
    ]);
    expect(result.failures).toEqual([]);
    expect(result.placed).toHaveLength(5);
    expect(errorsOf(result, L_ROOM)).toEqual([]);
  });

  it('집 전체(꼭짓점 26개)도 1초 안에 푼다', () => {
    const file: Point2[] = [
      [2.78, -3.05], [6.33, -3.05], [6.33, 2.75], [2.63, 2.75], [2.63, 1.75], [2.42, 1.75], [2.42, 2.68], [-0.75, 2.68], [-0.75, 0.87],
      [-1.75, 0.87], [-1.75, 2.2], [-3.62, 2.2], [-3.62, 1.2], [-4.22, 1.2], [-4.22, 0], [-2.25, 0], [-2.25, -0.4], [-1.22, -0.4],
      [-1.22, -0.15], [1.3, -0.15], [1.3, -0.47], [2.42, -0.47], [2.42, 0.22], [2.63, 0.22], [2.63, -1.87], [2.78, -1.87],
    ];
    const home: SolverRoom = {
      polygon: file.map(([x, z]) => [x - 0.515, z - 0.441] as Point2),
      openings: [
        { type: 'door', wallIndex: 20, from: 0.15, to: 1, widthM: 0.85 },
        { type: 'door', wallIndex: 16, from: 0.08, to: 1.03, widthM: 0.95 },
        { type: 'door', wallIndex: 23, from: 0.79, to: 1.64, widthM: 0.85 },
        { type: 'door', wallIndex: 13, from: 0.03, to: 0.78, widthM: 0.75 },
        { type: 'window', wallIndex: 1, from: 1.23, to: 4.73, widthM: 3.5 },
        { type: 'window', wallIndex: 6, from: 0.88, to: 2.42, widthM: 1.54 },
      ],
    };
    const started = performance.now();
    const result = solveLayout(home, [BED, DESK, WARDROBE, DRAWER, CHAIR, BOOKCASE], [
      place('bed', 'corner', { wallId: 'W1', priority: 1 }),
      place('desk', 'under_window', { wallId: 'W2', priority: 2 }),
      place('ward', 'against_wall', { wallId: 'W3', priority: 3 }),
      place('drawer', 'beside_item', { nearItemId: 'bed', priority: 4 }),
      place('chair', 'beside_item', { nearItemId: 'desk', priority: 5 }),
      place('book', 'against_wall', { priority: 6 }),
    ]);
    const elapsed = performance.now() - started;
    expect(result.failures).toEqual([]);
    expect(result.placed).toHaveLength(6);
    expect(errorsOf(result, home)).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });
});
