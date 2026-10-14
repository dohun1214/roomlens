// 방에 원래 있는 가구: 배치 검사·빈자리 찾기·솔버·AI 방 요약이 그 자리를 피하는지
import { describe, expect, it } from 'vitest';
import { summarizeRoom } from '@/lib/ai/roomSummary';
import { checkLayout, findFreeSpot, violatingIds, type LayoutItem } from '@/lib/layout/check';
import { footprintsOverlap } from '@/lib/layout/geometry';
import { solveLayout, type SolverItem, type SolverRoom } from '@/lib/layout/solver';
import { fixtureObstacles, type Fixture } from '@/lib/rooms/fixtures';
import type { Opening } from '@/lib/rooms/openings';
import type { Point2 } from '@/lib/three/floorDrag';

// 4 × 3 m 방. x -2~2, z -1.5~1.5. 문은 아래쪽 벽(z = -1.5)의 x -1.8 ~ -0.9
const ROOM: Point2[] = [
  [-2, -1.5],
  [2, -1.5],
  [2, 1.5],
  [-2, 1.5],
];
const DOOR: Opening = { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 };
// 오른쪽 벽(x = 2)에 붙은 원래 침대 1.0 × 2.0
const BED: Fixture = { id: 'x1', label: '침대', x: 1.5, z: 0, w: 1, d: 2, rotationDeg: 0, h: 0.45, remove: false };
const item = (id: string, x: number, z: number, w: number, d: number, extra: Partial<LayoutItem> = {}): LayoutItem => ({ id, name: id, x, z, w, d, rotationDeg: 0, ...extra });

describe('배치 검사', () => {
  it('원래 가구와 겹치면 고쳐야 하는 문제', () => {
    const violations = checkLayout([item('desk', 1.2, 0.5, 1.2, 0.6)], ROOM, [], fixtureObstacles([BED]));
    expect(violations).toEqual([{ itemId: 'desk', type: 'overlap', severity: 'error', otherId: 'fixture:x1', message: 'desk: 원래 있던 침대와(과) 겹칩니다' }]);
    expect([...violatingIds(violations)]).toEqual(['desk']);
  });

  it('치울 가구는 없는 것으로 본다', () => {
    expect(checkLayout([item('desk', 1.2, 0.5, 1.2, 0.6)], ROOM, [], fixtureObstacles([{ ...BED, remove: true }]))).toEqual([]);
  });

  it('원래 가구가 쓰는 쪽을 막으면 경고, 원래 가구 자체는 검사하지 않는다', () => {
    // 옷장의 앞(+z) 60cm 안에 원래 가구
    const wardrobe = item('ward', -1, -1.2, 0.9, 0.6, { category: 'storage', clearance: 0.6 });
    const box: Fixture = { ...BED, id: 'x2', label: '수납장', x: -1, z: -0.55, w: 0.8, d: 0.4 };
    const violations = checkLayout([wardrobe], ROOM, [], fixtureObstacles([box]));
    expect(violations.map((v) => `${v.itemId}:${v.type}`)).toEqual(['ward:access']);
  });

  it('원래 가구도 통로를 막는다', () => {
    // 방을 가로로 막는 원래 가구 (오른쪽 벽과 30cm 틈) 뒤의 의자는 문에서 갈 수 없다
    const wall: Fixture = { ...BED, id: 'x3', label: '책장', x: -0.15, z: 0, w: 3.7, d: 0.4 };
    const chair = item('chair', 0, 1.2, 0.5, 0.5);
    const types = checkLayout([chair], ROOM, [DOOR], fixtureObstacles([wall])).map((v) => `${v.itemId}:${v.type}`);
    expect(types).toEqual(['chair:unreachable']);
    // 치우면 갈 수 있다
    expect(checkLayout([chair], ROOM, [DOOR], fixtureObstacles([{ ...wall, remove: true }]))).toEqual([]);
  });
});

describe('빈자리 찾기', () => {
  it('원래 가구 자리를 피한다', () => {
    // 방 가운데에 원래 식탁이 있으면 새 가구는 그 옆에
    const table: Fixture = { ...BED, id: 'x4', label: '식탁', x: 0, z: 0, w: 1.2, d: 0.8 };
    const spot = findFreeSpot({ w: 1, d: 0.5 }, fixtureObstacles([table]), ROOM);
    expect(footprintsOverlap(spot, table)).toBe(false);
  });
});

describe('솔버', () => {
  const room: SolverRoom = { polygon: ROOM, openings: [DOOR], fixtures: fixtureObstacles([BED]) };
  const DESK: SolverItem = { id: 'desk', name: '책상', category: 'desk', w: 1.2, d: 0.6, h: 0.75, clearance: 0.7 };
  const WARD: SolverItem = { id: 'ward', name: '옷장', category: 'storage', w: 1, d: 0.6, h: 1.96, clearance: 0.6 };

  it('원래 가구와 겹치지 않게 놓고, 배치 검사에도 문제가 없다', () => {
    const result = solveLayout(room, [DESK, WARD], [
      { itemId: 'desk', zone: 'against_wall', wallId: 'W2', nearItemId: '', facing: 'into_room', priority: 1, reason: '' },
      { itemId: 'ward', zone: 'against_wall', wallId: 'W3', nearItemId: '', facing: 'into_room', priority: 2, reason: '' },
    ]);
    expect(result.placed).toHaveLength(2);
    for (const p of result.placed) expect(footprintsOverlap(p, BED)).toBe(false);
    expect(checkLayout(result.placed, ROOM, [DOOR], room.fixtures).filter((v) => v.severity === 'error')).toEqual([]);
  });

  it('요청한 벽이 원래 가구로 꽉 차 있으면 그 이유를 알린다', () => {
    // 오른쪽 벽(W2, 3m)에 원래 가구 2.6m → 1.2m 책상은 들어갈 자리가 없다
    const full: SolverRoom = { ...room, fixtures: fixtureObstacles([{ ...BED, d: 2.6, z: 0.2 }]) };
    const result = solveLayout(full, [DESK], [{ itemId: 'desk', zone: 'against_wall', wallId: 'W2', nearItemId: '', facing: 'into_room', priority: 1, reason: '' }], {
      fallback: false,
    });
    expect(result.failures).toEqual([{ itemId: 'desk', message: '책상: W2의 벽에 자리가 없음 (원래 있던 침대와(과) 겹침)' }]);
  });
});

describe('AI 방 요약', () => {
  it('원래 가구를 붙어 있는 벽과 함께 알리고, 벽 줄에도 적는다', () => {
    const corner: Fixture = { ...BED, id: 'x2', label: '옷장', x: -1.55, z: 1.2, w: 0.9, d: 0.6, h: 2 };
    const middle: Fixture = { ...BED, id: 'x3', label: '식탁', x: 0, z: 0, w: 0.8, d: 0.8, h: 0.75 };
    const lines = summarizeRoom(ROOM, [DOOR], [], '', fixtureObstacles([BED, corner, middle])).split('\n');
    expect(lines).toContain('W2 (3.00m, 동쪽 벽): 벽 / 원래 가구가 붙어 있음: 침대');
    expect(lines).toContain('원래 있는 가구 (옮길 수 없고, 이 자리에는 새 가구를 둘 수 없다):');
    expect(lines).toContain('- 침대: 가로 1.00m x 깊이 2.00m x 높이 0.45m, W2 벽에 붙음');
    expect(lines).toContain('- 옷장: 가로 0.90m x 깊이 0.60m x 높이 2.00m, W3·W4 모서리');
    expect(lines).toContain('- 식탁: 가로 0.80m x 깊이 0.80m x 높이 0.75m, 방 가운데 쪽');
  });

  it('원래 가구가 없으면 그 줄이 없다', () => {
    expect(summarizeRoom(ROOM, [DOOR], [], '')).not.toContain('원래 있는 가구');
  });
});
