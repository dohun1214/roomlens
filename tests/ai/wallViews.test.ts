import { describe, expect, it } from 'vitest';
import { locateWallDetections, MAX_WALL_VIEWS, straightWalls, wallViewPlan, WALL_TILE, type WallDetection } from '@/lib/ai/wallViews';
import type { Point2 } from '@/lib/three/floorDrag';

const ROOM: Point2[] = [
  [0, 0],
  [4, 0],
  [4, 3],
  [0, 3],
];
const det = (imageIndex: number, box: [number, number, number, number], extra: Partial<WallDetection> = {}): WallDetection => ({ imageIndex, type: 'door', box_2d: box, confidence: 'high', ...extra });

describe('wallViewPlan', () => {
  it('벽마다 방 안쪽에서 벽을 정면으로 본다', () => {
    const plan = wallViewPlan(ROOM, 2.5);
    expect(plan).toHaveLength(4);
    const first = plan[0];
    expect(first.wallIndex).toBe(0);
    expect(first.along).toBe(2);
    // 벽 0(z=0)은 방 안쪽(+z) 멀리서 -z 방향으로 본다
    expect(first.position[0]).toBe(2);
    expect(first.position[2]).toBeGreaterThan(50);
    expect(first.target).toEqual([2, first.centerY, 0]);
    expect(first.rightIsForward).toBe(true);
    // 바닥부터 천장까지 들어간다
    expect(first.size).toBeGreaterThanOrEqual(2.5);
  });

  it('꼭짓점을 반대로 돌아도 안쪽에서 본다', () => {
    const reversed = [...ROOM].reverse();
    const plan = wallViewPlan(reversed, 2.5);
    // reversed 벽 0 = (0,3)→(4,3), 안쪽은 -z
    expect(plan[0].position[2]).toBeLessThan(-50);
    // +z를 보면 화면 오른쪽은 -x: 벽 방향(+x)과 반대
    expect(plan[0].rightIsForward).toBe(false);
  });

  it('긴 벽은 겹치게 나누고, 너무 많으면 긴 벽부터 고른다', () => {
    const long: Point2[] = [
      [0, 0],
      [12, 0],
      [12, 3],
      [0, 3],
    ];
    const plan = wallViewPlan(long, 2.5).filter((v) => v.wallIndex === 0);
    expect(plan.length).toBe(3);
    expect(plan[0].along - WALL_TILE / 2).toBeCloseTo(0);
    expect(plan[2].along + WALL_TILE / 2).toBeCloseTo(12);
    // 꼭짓점이 많아도 MAX_WALL_VIEWS장까지
    const zigzag: Point2[] = [];
    for (let i = 0; i < 12; i += 1) zigzag.push([i, i % 2 ? 1 : 0], [i + 1, i % 2 ? 1 : 0]);
    expect(wallViewPlan([...zigzag, [12, 5], [0, 5]], 2.5).length).toBeLessThanOrEqual(MAX_WALL_VIEWS);
  });
});

describe('locateWallDetections', () => {
  const plan = wallViewPlan(ROOM, 2.5);
  const size = plan[0].size;
  /** 벽 0 그림에서 벽 위치 a~b (m), 높이 lo~hi (m) 를 덮는 상자 */
  const box = (i: number, a: number, b: number, lo: number, hi: number): [number, number, number, number] => {
    const v = plan[i];
    const x = (t: number) => Math.round(((t - v.along) / size + 0.5) * 1000);
    const y = (h: number) => Math.round((0.5 - (h - v.centerY) / size) * 1000);
    return [y(hi), x(a), y(lo), x(b)];
  };

  it('그림의 가로 위치가 벽 위의 위치가 된다', () => {
    const out = locateWallDetections([det(1, box(0, 1.0, 1.9, 0, 2.05)), det(1, box(0, 2.5, 3.6, 0.9, 2.1), { type: 'window' })], plan, ROOM);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'door', wallIndex: 0 });
    expect(out[0].from).toBeCloseTo(1.0, 1);
    expect(out[0].to).toBeCloseTo(1.9, 1);
    expect(out[1]).toMatchObject({ type: 'window', wallIndex: 0 });
  });

  it('반대쪽 벽은 그림의 오른쪽이 벽 방향과 반대일 수 있다', () => {
    // 벽 2 = (4,3)→(0,3). 시작 꼭짓점에서 0.5~1.3 m
    const out = locateWallDetections([det(3, box(2, 0.5, 1.3, 0, 2))], plan, ROOM);
    expect(out[0].wallIndex).toBe(2);
    expect(out[0].from).toBeCloseTo(0.5, 1);
    expect(out[0].to).toBeCloseTo(1.3, 1);
  });

  it('너무 좁거나 낮은 것, 겹치는 것은 버린다', () => {
    const out = locateWallDetections([det(1, box(0, 1, 1.1, 0, 2)), det(1, box(0, 2, 3, 1, 1.1)), det(2, box(1, 0.5, 1.5, 0, 2)), det(2, box(1, 0.8, 1.6, 0, 2), { confidence: 'low' })], plan, ROOM);
    expect(out).toHaveLength(1);
    expect(out[0].wallIndex).toBe(1);
  });
});

describe('한 줄로 이어진 벽 조각', () => {
  // 위쪽 벽이 (4,3)→(3,3)→(1,3)→(0,3) 세 조각 (창문 끝에서 꼭짓점이 나뉜 방)
  const SPLIT: Point2[] = [
    [0, 0],
    [4, 0],
    [4, 3],
    [3, 3],
    [1, 3],
    [0, 3],
  ];

  it('같은 방향으로 이어진 조각은 곧은 벽 하나로 찍는다', () => {
    const walls = straightWalls(SPLIT);
    expect(walls.map((w) => w.index)).toEqual([0, 1, 2, 5]);
    expect(walls[2].length).toBeCloseTo(4);
    expect(walls[2].parts.map((p) => [p.index, p.start])).toEqual([
      [2, 0],
      [3, 1],
      [4, 3],
    ]);
    expect(wallViewPlan(SPLIT, 2.5)).toHaveLength(4);
  });

  it('찾은 구간은 가장 많이 겹치는 조각으로 옮기고 그 조각 안으로 자른다', () => {
    const plan = wallViewPlan(SPLIT, 2.5);
    const i = plan.findIndex((v) => v.wallIndex === 2);
    const v = plan[i];
    const x = (t: number) => Math.round(((v.rightIsForward ? t - v.along : v.along - t) / v.size + 0.5) * 1000);
    // 곧은 벽 위 0.95~3.05 m (조각 3 = 1~3 m 에 거의 들어맞는 창문)
    const [a, b] = [x(0.95), x(3.05)].sort((p, q) => p - q);
    const out = locateWallDetections([det(i + 1, [300, a, 600, b], { type: 'window' })], plan, SPLIT);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'window', wallIndex: 3 });
    expect(out[0].from).toBeCloseTo(0, 1);
    expect(out[0].to).toBeCloseTo(2, 1);
  });

  it('처음과 끝 벽이 이어져 있어도 묶는다', () => {
    // 벽 3 (0,3)→(0,1.5) 과 벽 0 (0,1.5)→(0,0) 이 한 줄
    const wrap: Point2[] = [
      [0, 1.5],
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ];
    const walls = straightWalls(wrap);
    expect(walls).toHaveLength(4);
    expect(walls.find((w) => w.parts.length === 2)?.parts.map((p) => p.index)).toEqual([4, 0]);
  });
});
