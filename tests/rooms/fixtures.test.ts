import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIXTURE_HEIGHT,
  describeFixture,
  fixtureFromCorners,
  fixtureObstacles,
  fixtureRotation,
  fixtureViewpoint,
  heightFromTaps,
  MAX_FIXTURES,
  nextFixtureId,
  parseFixtures,
  sameFixtures,
  updateFixture,
  type Fixture,
} from '@/lib/rooms/fixtures';
import { footprintCorners, pointInPolygon, type Point2 } from '@/lib/three/floorDrag';

// 4 × 3 m 방. x -2~2, z -1.5~1.5
const ROOM: Point2[] = [
  [-2, -1.5],
  [2, -1.5],
  [2, 1.5],
  [-2, 1.5],
];
const fixture = (extra: Partial<Fixture> = {}): Fixture => ({ id: 'x1', label: '침대', x: 1.2, z: 0, w: 1, d: 2, rotationDeg: 0, h: 0.45, remove: false, ...extra });

describe('fixtureFromCorners', () => {
  it('마주 보는 두 모서리로 바닥 사각형을 만든다 (어느 모서리부터 찍어도 같다)', () => {
    const made = fixtureFromCorners([0.7, 1.0], [1.7, -1.0], 0.45, ROOM, []);
    expect(made).toEqual({ ok: true, fixture: { id: 'x1', label: '가구', x: 1.2, z: 0, w: 1, d: 2, rotationDeg: 0, h: 0.45, remove: false } });
    const swapped = fixtureFromCorners([1.7, -1.0], [0.7, 1.0], 0.45, ROOM, []);
    expect(swapped.ok && swapped.fixture).toMatchObject({ x: 1.2, z: 0, w: 1, d: 2 });
  });

  it('id는 비어 있는 다음 번호', () => {
    const made = fixtureFromCorners([0, 0], [0.5, 0.5], 1, ROOM, [fixture({ id: 'x1' }), fixture({ id: 'x3' })]);
    expect(made.ok && made.fixture.id).toBe('x2');
    expect(nextFixtureId([])).toBe('x1');
  });

  it('너무 작거나, 방 밖이거나, 개수를 넘으면 이유와 함께 실패', () => {
    expect(fixtureFromCorners([0, 0], [0.1, 1], 1, ROOM, [])).toMatchObject({ ok: false, message: expect.stringContaining('15cm') });
    expect(fixtureFromCorners([3, 3], [4, 4], 1, ROOM, [])).toMatchObject({ ok: false, message: expect.stringContaining('방 밖') });
    const full = Array.from({ length: MAX_FIXTURES }, (_, i) => fixture({ id: `x${i + 1}` }));
    expect(fixtureFromCorners([0, 0], [1, 1], 1, ROOM, full)).toMatchObject({ ok: false, message: expect.stringContaining(`${MAX_FIXTURES}개`) });
    expect(fixtureFromCorners([Number.NaN, 0], [1, 1], 1, ROOM, [])).toMatchObject({ ok: false });
  });

  it('비스듬한 방이면 첫 번째 벽과 나란하게 맞춘다', () => {
    // 30° 돌아간 정사각형 방
    const r = Math.PI / 6;
    const turn = ([x, z]: Point2): Point2 => [x * Math.cos(r) + z * Math.sin(r), -x * Math.sin(r) + z * Math.cos(r)];
    const room = ([[-2, -2], [2, -2], [2, 2], [-2, 2]] as Point2[]).map(turn);
    expect(fixtureRotation(room)).toBeCloseTo(30, 6);
    const made = fixtureFromCorners(turn([-0.5, -0.25]), turn([0.5, 0.25]), 1, room, []);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.fixture.w).toBeCloseTo(1, 2);
    expect(made.fixture.d).toBeCloseTo(0.5, 2);
    // 사각형의 꼭짓점이 찍은 두 점을 지난다
    const corners = footprintCorners(made.fixture);
    const hits = [turn([-0.5, -0.25]), turn([0.5, 0.25])].every((p) => corners.some((c) => Math.hypot(c[0] - p[0], c[1] - p[1]) < 0.01));
    expect(hits).toBe(true);
  });

  it('보정된 방(벽이 가로·세로)은 어느 벽부터 돌아도 0°', () => {
    expect(fixtureRotation(ROOM)).toBe(0);
    expect(fixtureRotation([[2, 1.5], [2, -1.5], [-2, -1.5], [-2, 1.5]])).toBe(0);
  });
});

describe('높이', () => {
  it('찍은 두 점 가운데 높은 쪽, 바닥을 찍었으면 기본 높이', () => {
    expect(heightFromTaps(0.43, 0.47)).toBe(0.47);
    expect(heightFromTaps(0.02, 0.05)).toBe(DEFAULT_FIXTURE_HEIGHT);
  });
});

describe('parseFixtures', () => {
  it('DB 값을 검증한다: 모양이 틀리거나, 방 밖이거나, id가 겹치면 버린다', () => {
    const raw = [fixture(), fixture({ id: 'x1', x: 0 }), fixture({ id: 'x2', x: 9 }), { ...fixture({ id: 'x3' }), w: 'big' }, fixture({ id: 'bad' }), fixture({ id: 'x4', label: '' }), fixture({ id: 'x5', remove: true })];
    expect(parseFixtures(raw, ROOM).map((f) => f.id)).toEqual(['x1', 'x5']);
    expect(parseFixtures('nope', ROOM)).toEqual([]);
    expect(parseFixtures([fixture()], null)).toEqual([]);
  });

  it('개수 제한', () => {
    const raw = Array.from({ length: MAX_FIXTURES + 5 }, (_, i) => fixture({ id: `x${i + 1}`, x: 0, z: 0, w: 0.2, d: 0.2 }));
    expect(parseFixtures(raw, ROOM)).toHaveLength(MAX_FIXTURES);
  });
});

describe('고치기·장애물', () => {
  it('이름·높이·치울지를 고친다. 빈 이름과 이상한 높이는 받지 않는다', () => {
    const list = [fixture(), fixture({ id: 'x2' })];
    expect(updateFixture(list, 'x1', { label: '옷장', h: 2.04 })[0]).toMatchObject({ label: '옷장', h: 2.04 });
    expect(updateFixture(list, 'x1', { label: '   ' })[0].label).toBe('침대');
    expect(updateFixture(list, 'x1', { h: Number.NaN })[0].h).toBe(0.45);
    expect(updateFixture(list, 'x1', { h: 9 })[0].h).toBe(3);
    expect(updateFixture(list, 'x1', { remove: true })[1]).toEqual(list[1]);
  });

  it('치울 가구는 장애물에서 빠지고, 이름에 "원래 있던"이 붙는다', () => {
    const obstacles = fixtureObstacles([fixture(), fixture({ id: 'x2', label: '옷장', remove: true })]);
    expect(obstacles).toEqual([{ id: 'fixture:x1', name: '원래 있던 침대', x: 1.2, z: 0, w: 1, d: 2, rotationDeg: 0, h: 0.45 }]);
  });

  it('설명·비교', () => {
    expect(describeFixture(fixture({ remove: true }))).toBe('침대 · 100×200 · 높이 0.45 m · 치울 가구');
    expect(sameFixtures([fixture()], [fixture()])).toBe(true);
    expect(sameFixtures([fixture()], [fixture({ h: 0.5 })])).toBe(false);
  });

  it('3D에서 볼 자리는 방 안이고 가구를 내려다본다', () => {
    const view = fixtureViewpoint(fixture(), ROOM);
    expect(pointInPolygon([view.position[0], view.position[2]], ROOM)).toBe(true);
    expect(view.target).toEqual([1.2, 0.225, 0]);
    expect(view.position[1]).toBeGreaterThan(view.target[1]);
  });
});
