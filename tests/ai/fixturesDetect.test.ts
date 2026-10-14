import { describe, expect, it } from 'vitest';
import { addCandidates, locateFixtures, MAX_TILES, TILE_METERS, TILE_OVERLAP, tileAxes, topHeight, topViewPlan, type FixtureDetection } from '@/lib/ai/fixturesDetect';
import { MAX_FIXTURES, type Fixture } from '@/lib/rooms/fixtures';
import type { Point2 } from '@/lib/three/floorDrag';

const rect = (w: number, d: number, cx = 0, cz = 0): Point2[] => [
  [cx - w / 2, cz - d / 2],
  [cx + w / 2, cz - d / 2],
  [cx + w / 2, cz + d / 2],
  [cx - w / 2, cz + d / 2],
];
// 3.7 × 3.7 m 방: 여백(0.15)을 더하면 한 칸이 4 m → 그림의 1000이 4 m
const ROOM = rect(3.7, 3.7);
const det = (box: [number, number, number, number], extra: Partial<FixtureDetection> = {}): FixtureDetection => ({ imageIndex: 1, label: '침대', box_2d: box, confidence: 'high', ...extra });
const fixture = (over: Partial<Fixture> = {}): Fixture => ({ id: 'x1', label: '침대', x: 0, z: 0, w: 1, d: 2, rotationDeg: 0, h: 0.5, remove: false, ...over });

const expectNear = (f: Fixture, want: Partial<Record<'x' | 'z' | 'w' | 'd', number>>) => {
  for (const [k, v] of Object.entries(want)) expect(Math.abs(f[k as keyof typeof want] - v)).toBeLessThanOrEqual(0.02);
};

describe('topViewPlan', () => {
  it('작은 방은 방 전체를 덮는 한 칸 (벽과 나란하게)', () => {
    expect(topViewPlan(ROOM)).toEqual([{ center: [0, 0], size: 4, rotationDeg: 0 }]);
    expect(topViewPlan(rect(4, 3))).toEqual([{ center: [0, 0], size: 4.3, rotationDeg: 0 }]);
  });

  it('긴 방은 겹치게 나눈 칸들이 방 끝까지 덮는다', () => {
    const tiles = topViewPlan(rect(20, 8));
    expect(tiles).toHaveLength(3);
    expect(tiles.every((t) => t.size === TILE_METERS)).toBe(true);
    expect(tiles.map((t) => t.center[0])).toEqual([-5.65, 0, 5.65]);
    // 첫 칸은 왼쪽 끝(여백 포함)부터, 마지막 칸은 오른쪽 끝까지
    expect(tiles[0].center[0] - TILE_METERS / 2).toBeCloseTo(-10.15);
    expect(tiles[2].center[0] + TILE_METERS / 2).toBeCloseTo(10.15);
    // 이웃한 칸은 TILE_OVERLAP 이상 겹친다
    expect(TILE_METERS - (tiles[1].center[0] - tiles[0].center[0])).toBeGreaterThanOrEqual(TILE_OVERLAP);
  });

  it('아주 넓으면 칸을 키워서 MAX_TILES칸 안에 담는다', () => {
    const tiles = topViewPlan(rect(30, 30));
    expect(tiles).toHaveLength(MAX_TILES);
    expect(tiles[0].size).toBe(16);
  });

  it('비스듬한 방은 첫 번째 벽 방향으로 찍는다', () => {
    const r = (30 * Math.PI) / 180;
    const turned = ROOM.map(([x, z]): Point2 => [x * Math.cos(r) + z * Math.sin(r), -x * Math.sin(r) + z * Math.cos(r)]);
    const [tile] = topViewPlan(turned);
    expect(tile.rotationDeg).toBe(30);
    expect(tile.size).toBeCloseTo(4);
    expect(tileAxes(30).right[0]).toBeCloseTo(Math.cos(r));
  });

  it('평면도가 없으면 빈 목록', () => {
    expect(topViewPlan([])).toEqual([]);
  });
});

describe('locateFixtures', () => {
  const tiles = topViewPlan(ROOM);

  it('그림 위의 상자 → 방 좌표의 사각형 (오른쪽 = +x, 아래 = +z), 높이는 이름별 흔한 값', () => {
    // 가로 500~750 → x 0~1, 세로 250~500 → z -1~0
    expect(locateFixtures([det([250, 500, 500, 750])], tiles, ROOM)).toEqual([{ id: 'x1', label: '침대', x: 0.5, z: -0.5, w: 1, d: 1, rotationDeg: 0, h: 0.5, remove: false }]);
  });

  it('방 밖, 너무 작은 것, 잘못된 상자, 없는 그림 번호는 버린다', () => {
    const out = locateFixtures(
      [
        det([0, 0, 20, 20]), // 가운데가 여백(방 밖)
        det([500, 500, 520, 520]), // 8cm
        det([500, 500, 400, 600]), // 위아래가 뒤바뀜
        det([250, 500, 500, 750], { imageIndex: 2 }),
      ],
      tiles,
      ROOM,
    );
    expect(out).toEqual([]);
  });

  it('벽 밖으로 나간 부분은 방의 범위까지 자른다', () => {
    // 가로 0~100 → x -2~-1.6 (벽은 -1.85) → -1.85~-1.6
    const [f] = locateFixtures([det([250, 0, 500, 100])], tiles, ROOM);
    expect([f.x, f.w]).toEqual([-1.725, 0.25]);
  });

  it('확실한 것, 큰 것부터 번호를 붙인다', () => {
    const out = locateFixtures(
      [det([500, 500, 600, 600], { label: '의자', confidence: 'low' }), det([500, 500, 600, 600], { label: '의자' }), det([250, 250, 750, 500], { label: '소파' })],
      tiles,
      ROOM,
    );
    expect(out.map((f) => [f.id, f.label, f.h])).toEqual([
      ['x1', '소파', 0.8],
      ['x2', '의자', 0.9],
      ['x3', '의자', 0.9],
    ]);
  });

  it('비스듬한 방에서도 상자의 가운데가 방 좌표로 맞게 돌아간다', () => {
    const r = (30 * Math.PI) / 180;
    const turned = ROOM.map(([x, z]): Point2 => [x * Math.cos(r) + z * Math.sin(r), -x * Math.sin(r) + z * Math.cos(r)]);
    const turnedTiles = topViewPlan(turned);
    const [f] = locateFixtures([det([250, 500, 500, 750])], turnedTiles, turned);
    // 그림의 (0.5, -0.5) = right × 0.5 + down × -0.5
    const { right, down } = tileAxes(30);
    expect(f.x).toBeCloseTo(right[0] * 0.5 - down[0] * 0.5, 2);
    expect(f.z).toBeCloseTo(right[1] * 0.5 - down[1] * 0.5, 2);
    expect([f.w, f.d, f.rotationDeg]).toEqual([1, 1, 30]);
  });

  describe('여러 칸', () => {
    // 16 × 4 m 방 → 9 m 칸 2개: 왼쪽 칸은 x -8.15~0.85, 오른쪽 칸은 x -0.85~8.15
    const LONG = rect(16, 4);
    const longTiles = topViewPlan(LONG);
    /** 칸 i(0부터) 위에서 방 좌표 x0~x1, z0~z1을 덮는 상자 */
    const boxIn = (i: number, x0: number, x1: number, z0: number, z1: number): [number, number, number, number] => {
      const t = longTiles[i];
      const px = (x: number) => Math.round(((x - t.center[0]) / t.size + 0.5) * 1000);
      const pz = (z: number) => Math.round(((z - t.center[1]) / t.size + 0.5) * 1000);
      return [pz(z0), px(x0), pz(z1), px(x1)];
    };

    it('겹친 곳에서 두 칸이 모두 찾은 가구는 하나로 합친다', () => {
      expect(longTiles.map((t) => t.center[0])).toEqual([-3.65, 3.65]);
      const out = locateFixtures([det(boxIn(0, -0.5, 0.5, -1, 0), { imageIndex: 1 }), det(boxIn(1, -0.5, 0.5, -1, 0), { imageIndex: 2 })], longTiles, LONG);
      expect(out).toHaveLength(1);
      // 그림 1px(1000분의 1)이 9 mm라 반올림만큼 어긋난다
      expectNear(out[0], { x: 0, z: -0.5, w: 1, d: 1 });
    });

    it('한 칸 가장자리에서 잘린 가구는 다른 칸에서 본 온전한 상자와 합친다', () => {
      const out = locateFixtures([det(boxIn(0, 0.4, 0.85, 0, 1), { imageIndex: 1 }), det(boxIn(1, 0.4, 1.6, 0, 1), { imageIndex: 2 })], longTiles, LONG);
      expect(out).toHaveLength(1);
      expectNear(out[0], { x: 1, w: 1.2 });
    });

    it('같은 그림 안의 겹친 상자(책상 밑 의자)는 합치지 않는다', () => {
      const out = locateFixtures([det(boxIn(0, -4, -2.6, 0, 0.7), { label: '책상' }), det(boxIn(0, -3.5, -3, 0.2, 0.6), { label: '의자' })], longTiles, LONG);
      expect(out.map((f) => f.label)).toEqual(['책상', '의자']);
    });

    it('다른 칸의 다른 가구(겹침이 적은 것)는 따로 둔다', () => {
      const out = locateFixtures([det(boxIn(0, -0.8, 0, 0, 1), { imageIndex: 1 }), det(boxIn(1, -0.2, 0.6, 0, 1), { imageIndex: 2 })], longTiles, LONG);
      expect(out).toHaveLength(2);
    });
  });
});

describe('addCandidates', () => {
  it('이미 있는 원래 가구와 많이 겹치는 후보는 빼고, 나머지는 새 id로 더한다', () => {
    const existing = [fixture({ id: 'x1', x: -1, z: 0 }), fixture({ id: 'x2', x: 1, z: 0, remove: true })];
    const candidates = [fixture({ id: 'x1', x: -0.95, z: 0.05 }), fixture({ id: 'x2', x: 0, z: 1, w: 0.5, d: 0.5, label: '의자' })];
    const { fixtures, added, skipped } = addCandidates(existing, candidates);
    expect(skipped).toBe(1);
    expect(added).toEqual([{ ...candidates[1], id: 'x3' }]);
    expect(fixtures.map((f) => f.id)).toEqual(['x1', 'x2', 'x3']);
  });

  it('돌아간 원래 가구와도 겹침을 본다', () => {
    const existing = [fixture({ rotationDeg: 90 })]; // 가로 2 m(x) × 깊이 1 m(z)
    expect(addCandidates(existing, [fixture({ id: 'x9', w: 2, d: 1 })]).skipped).toBe(1);
    expect(addCandidates(existing, [fixture({ id: 'x9', x: 0, z: 1.2, w: 2, d: 1 })]).skipped).toBe(0);
  });

  it(`모두 ${MAX_FIXTURES}개까지만`, () => {
    const existing = Array.from({ length: MAX_FIXTURES - 1 }, (_, i) => fixture({ id: `x${i + 1}`, x: i * 3 }));
    const { added, skipped } = addCandidates(existing, [fixture({ id: 'x1', z: 5 }), fixture({ id: 'x2', z: 9 })]);
    expect([added.length, skipped]).toEqual([1, 1]);
  });
});

describe('topHeight', () => {
  const layer = (from: number, to: number, n: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / Math.max(1, n - 1));

  it('바닥은 빼고, 위로 이어진 층의 꼭대기', () => {
    // 옷장: 바닥부터 2 m까지 이어진다
    expect(topHeight([...layer(0, 0.02, 300), ...layer(0.1, 2, 400)])).toBeCloseTo(2, 1);
    // 침대: 0.15~0.5
    expect(topHeight([...layer(0, 0.02, 300), ...layer(0.15, 0.5, 200)])).toBeCloseTo(0.5, 1);
  });

  it('30cm 넘게 빈 위쪽(매달린 조명)은 보지 않는다', () => {
    // 식탁 윗판 0.72~0.76, 다리 몇 개, 위에 조명 1.4~1.9
    const heights = [...layer(0, 0.02, 500), ...layer(0.1, 0.7, 20), ...layer(0.72, 0.76, 300), ...layer(1.4, 1.9, 200)];
    expect(topHeight(heights)).toBeCloseTo(0.75, 1);
  });

  it('식탁 밑 바닥 가까이의 부스러기는 건너뛰고 윗판을 본다', () => {
    const heights = [...layer(0, 0.02, 500), ...layer(0.1, 0.16, 60), ...layer(0.7, 0.75, 400), ...layer(1.5, 2, 150)];
    expect(topHeight(heights)).toBeCloseTo(0.75, 1);
  });

  it('바닥만 있거나 표본이 적으면 잴 수 없다', () => {
    expect(topHeight(layer(0, 0.05, 500))).toBeNull();
    expect(topHeight(layer(0.3, 0.6, 10))).toBeNull();
    expect(topHeight([])).toBeNull();
  });
});
