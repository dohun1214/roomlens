import { describe, expect, it } from 'vitest';
import { fixturePieceKey, inFootprint, MAX_PIECE_TOP, pieceBox, pieceTop, PIECE_WALL_GAP, toPieceFrame } from '@/lib/rooms/fixturePiece';
import { fixtureObstacles, parseFixtures, type Fixture } from '@/lib/rooms/fixtures';
import { movedFixtureIds, placeFixtureItem, restoreItems, toSavedItems } from '@/lib/layout/saved';
import { remapFixtures, roomRemap } from '@/lib/rooms/recalibrate';
import type { Point2 } from '@/lib/three/floorDrag';

// 4 × 3 m 방 (x -2~2, z -1.5~1.5)
const ROOM: Point2[] = [
  [-2, -1.5],
  [2, -1.5],
  [2, 1.5],
  [-2, 1.5],
];
const fixture = (over: Partial<Fixture> = {}): Fixture => ({ id: 'x1', label: '의자', x: 0, z: 0, w: 0.8, d: 0.6, rotationDeg: 0, h: 0.9, remove: false, ...over });

describe('pieceBox', () => {
  it('벽에서 떨어진 가구는 그대로', () => {
    expect(pieceBox(fixture(), ROOM)).toEqual({ x: 0, z: 0, w: 0.8, d: 0.6, rotationDeg: 0 });
  });

  it('서쪽 벽에 붙은(넘어간) 가구는 벽에서 4cm 떨어지게 그 변만 줄인다', () => {
    // x -2.05 ~ -1.25 (벽 x=-2 너머까지 찍힘) → x -1.96 ~ -1.25
    const box = pieceBox(fixture({ x: -1.65 }), ROOM);
    expect(box.x - box.w / 2).toBeCloseTo(-2 + PIECE_WALL_GAP, 6);
    expect(box.x + box.w / 2).toBeCloseTo(-1.25, 6);
    expect(box.d).toBeCloseTo(0.6, 6);
  });

  it('모서리에 놓인 가구는 두 변을 줄이고, 90° 돈 가구도 맞는 변을 줄인다', () => {
    const corner = pieceBox(fixture({ x: 1.65, z: 1.25 }), ROOM);
    expect(corner.x + corner.w / 2).toBeCloseTo(2 - PIECE_WALL_GAP, 6);
    expect(corner.z + corner.d / 2).toBeCloseTo(1.5 - PIECE_WALL_GAP, 6);
    // 90°: 가로(0.8)가 z 방향. z 1.1 ~ 1.9 → 1.1 ~ 1.46
    const turned = pieceBox(fixture({ z: 1.5, rotationDeg: 90 }), ROOM);
    expect(turned.w).toBeCloseTo(0.8 - 0.4 - PIECE_WALL_GAP, 6);
    expect(turned.d).toBeCloseTo(0.6, 6);
    expect(inFootprint(turned, 0, 1.5 - PIECE_WALL_GAP - 0.005)).toBe(true);
    expect(inFootprint(turned, 0, 1.5 - PIECE_WALL_GAP + 0.005)).toBe(false);
  });

  it('지나치게 줄어들면 원래 사각형을 쓴다', () => {
    const thin = pieceBox(fixture({ x: -2, w: 0.1 }), ROOM);
    expect(thin.w).toBe(0.1);
  });
});

describe('inFootprint', () => {
  it('회전을 따른다 (가로 방향 = [cos, -sin])', () => {
    const box = { x: 0, z: 0, w: 2, d: 0.2, rotationDeg: 90 };
    expect(inFootprint(box, 0, 0.9)).toBe(true);
    expect(inFootprint(box, 0.9, 0)).toBe(false);
  });
});

describe('pieceTop', () => {
  const fill = (from: number, to: number, n: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));

  it('위에 얹힌 물건(스탠드)까지 올라간다', () => {
    // 협탁 0~0.6 m, 스탠드 0.6~1.25 m, 천장 2.3 m
    const heights = [...fill(0.03, 0.6, 600), ...fill(0.6, 1.25, 200), ...fill(2.28, 2.32, 100)];
    expect(pieceTop(heights, 0.6)).toBeCloseTo(1.25, 1);
  });

  it('위가 비어 있으면 원래 가구 높이, 높이를 조금 낮게 찍었으면 실제 꼭대기까지', () => {
    expect(pieceTop(fill(0.03, 0.8, 500), 0.9)).toBe(0.9);
    expect(pieceTop(fill(0.03, 0.97, 500), 0.9)).toBeCloseTo(1, 1);
  });

  it('천장 가까이는 올라가지 않는다', () => {
    expect(pieceTop(fill(0.03, 3, 3000), 1.8)).toBeLessThanOrEqual(MAX_PIECE_TOP);
  });
});

describe('toPieceFrame', () => {
  it('가운데를 원점으로, 원래 가구의 회전을 0°로 (가구 메시의 rotation.y와 반대)', () => {
    const f = fixture({ x: 1, z: 1, rotationDeg: 90 });
    // 회전 90°의 가로 방향은 [0, -1]: 방 좌표 (1, 0)은 가로 +1
    const [lx, lz] = toPieceFrame(f, 1, 0);
    expect(lx).toBeCloseTo(1, 6);
    expect(lz).toBeCloseTo(0, 6);
  });
});

describe('fixturePieceKey', () => {
  it('방 폴더 아래에 버전을 넣는다', () => {
    expect(fixturePieceKey('r1', 'x2', 'piece', 123)).toBe('rooms/r1/fixtures/x2-piece-123.spz');
    expect(fixturePieceKey('r1', 'x2', 'fill', 9)).toBe('rooms/r1/fixtures/x2-fill-9.spz');
  });
});

describe('원래 가구의 조각 정보', () => {
  it('parseFixtures가 조각 정보를 남기고, 모양이 틀린 조각 정보는 원래 가구째 버린다', () => {
    const ok = { ...fixture(), piece: { v: 5, top: 1.2 }, fill: { v: 6 } };
    const bad = { ...fixture({ id: 'x2' }), piece: { v: -1, top: 1 } };
    expect(parseFixtures([ok, bad], ROOM)).toEqual([ok]);
  });

  it('옮긴 원래 가구는 원래 자리 장애물에서 빠진다', () => {
    const list = [fixture(), fixture({ id: 'x2', x: 1 })];
    expect(fixtureObstacles(list, new Set(['x1'])).map((o) => o.id)).toEqual(['fixture:x2']);
  });

  it('다시 보정: 돌리고 옮기기만 하면 조각을 지키고, 배율이 바뀌면 지운다', () => {
    const f = { ...fixture(), piece: { v: 5, top: 1.2 }, fill: { v: 6 } };
    const cal = (s: number, q: [number, number, number, number], t: [number, number, number]) => ({ transform: { s, q, t }, flipX: false, floorPolygon: ROOM });
    const turn = roomRemap(cal(1, [0, 0, 0, 1], [0, 0, 0]), cal(1, [0, Math.SQRT1_2, 0, Math.SQRT1_2], [0.5, 0, 0]));
    const grow = roomRemap(cal(1, [0, 0, 0, 1], [0, 0, 0]), cal(1.1, [0, 0, 0, 1], [0, 0, 0]));
    expect(remapFixtures([f], turn)[0]).toMatchObject({ piece: { v: 5, top: 1.2 }, fill: { v: 6 } });
    expect(remapFixtures([f], grow)[0]).not.toHaveProperty('piece');
    expect(remapFixtures([f], grow)[0]).not.toHaveProperty('fill');
  });
});

describe('배치의 옮긴 원래 가구', () => {
  const ready = { ...fixture({ label: '침대' }), piece: { v: 5, top: 1.1 } };

  it('원래 가구로 놓으면 높이는 조각 높이, 저장하면 kind fixture', () => {
    const item = placeFixtureItem(ready, 'f3', { x: 1, z: 0.5, rotationDeg: 90 });
    expect(item).toMatchObject({ kind: 'fixture', furnitureRef: 'x1', name: '침대', h: 1.1, category: 'bed', clearance: 0 });
    expect(toSavedItems([item])).toEqual([{ id: 'f3', furnitureRef: 'x1', kind: 'fixture', x: 1, z: 0.5, rotationDeg: 90 }]);
    expect([...movedFixtureIds(toSavedItems([item]))]).toEqual(['x1']);
  });

  it('되살릴 때 조각이 없거나 방에 없는 원래 가구, 두 번째 같은 원래 가구는 빠진다', () => {
    const saved = [
      { id: 'f1', furnitureRef: 'x1', kind: 'fixture' as const, x: 1, z: 0, rotationDeg: 0 },
      { id: 'f2', furnitureRef: 'x1', kind: 'fixture' as const, x: 0, z: 0, rotationDeg: 0 },
      { id: 'f3', furnitureRef: 'x9', kind: 'fixture' as const, x: 0, z: 0, rotationDeg: 0 },
      { id: 'f4', furnitureRef: 'x2', kind: 'fixture' as const, x: 0, z: 0, rotationDeg: 0 },
    ];
    const { items, missing } = restoreItems(saved, [], [], [ready, fixture({ id: 'x2' })], { x1: 'https://piece' });
    expect(items.map((i) => [i.id, i.pieceUrl])).toEqual([['f1', 'https://piece']]);
    expect(missing).toBe(3);
  });
});
