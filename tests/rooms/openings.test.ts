import { describe, expect, it } from 'vitest';
import type { Point2 } from '@/lib/three/floorDrag';
import {
  addOpening,
  describeOpening,
  makeOpening,
  MAX_OPENINGS,
  openingFromPoints,
  openingSegment,
  overlapsExisting,
  parseOpenings,
  sameOpenings,
  summarizeOpenings,
  wallsOf,
  type Opening,
} from '@/lib/rooms/openings';

// 4 × 3 m 방. 벽 1: 아래쪽(z=-1.5) 왼→오, 벽 2: 오른쪽(x=2) 아래→위, 벽 3: 위쪽 오→왼, 벽 4: 왼쪽 위→아래
const ROOM: Point2[] = [
  [-2, -1.5],
  [2, -1.5],
  [2, 1.5],
  [-2, 1.5],
];
const door: Opening = { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 };
const opening = (r: ReturnType<typeof makeOpening>) => {
  if (!r.ok) throw new Error(r.message);
  return r.opening;
};
const message = (r: ReturnType<typeof makeOpening>) => (r.ok ? null : r.message);

describe('wallsOf', () => {
  it('꼭짓점 순서대로 벽을 만든다', () => {
    const walls = wallsOf(ROOM);
    expect(walls.map((w) => w.length)).toEqual([4, 3, 4, 3]);
    expect(walls[3]).toMatchObject({ index: 3, a: [-2, 1.5], b: [-2, -1.5] });
  });

  it('꼭짓점이 3개보다 적으면 벽이 없다', () => {
    expect(wallsOf([[0, 0], [1, 0]])).toEqual([]);
  });
});

describe('makeOpening', () => {
  it('벽·시작 위치·폭으로 만든다', () => {
    expect(opening(makeOpening('door', 0, 0.2, 0.9, ROOM))).toEqual(door);
  });

  it('cm 단위로 맞춘다', () => {
    expect(opening(makeOpening('window', 2, 1.004, 1.2049, ROOM))).toEqual({ type: 'window', wallIndex: 2, from: 1, to: 2.2, widthM: 1.2 });
  });

  it('벽 전체를 차지할 수 있고, 1cm 이내로 넘는 것은 벽 끝에 맞춘다', () => {
    expect(opening(makeOpening('window', 1, 0, 3, ROOM))).toMatchObject({ from: 0, to: 3, widthM: 3 });
    expect(opening(makeOpening('window', 1, 2, 1.008, ROOM))).toMatchObject({ from: 2, to: 3, widthM: 1 });
  });

  it('잘못된 값은 이유와 함께 거부한다', () => {
    expect(message(makeOpening('door', 4, 0, 1, ROOM))).toBe('벽을 골라 주세요.');
    expect(message(makeOpening('door', 0.5, 0, 1, ROOM))).toBe('벽을 골라 주세요.');
    expect(message(makeOpening('door', 0, Number.NaN, 1, ROOM))).toBe('시작 위치와 폭을 숫자로 넣어 주세요.');
    expect(message(makeOpening('door', 0, -0.1, 1, ROOM))).toBe('시작 위치는 0 이상이어야 합니다.');
    expect(message(makeOpening('door', 0, 0, 0.2, ROOM))).toBe('폭은 0.3 m 이상이어야 합니다.');
    expect(message(makeOpening('door', 1, 2.5, 1, ROOM))).toBe('벽 2의 길이(3.00 m)를 넘습니다.');
  });
});

describe('openingFromPoints', () => {
  it('두 점을 가장 가까운 벽 위로 내려 양 끝으로 쓴다 (찍는 순서는 상관없다)', () => {
    // 벽 1(z=-1.5) 근처, 시작 꼭짓점(-2)에서 0.2m와 1.1m
    const a: Point2 = [-1.8, -1.46];
    const b: Point2 = [-0.9, -1.53];
    expect(opening(openingFromPoints('door', a, b, ROOM))).toEqual(door);
    expect(opening(openingFromPoints('door', b, a, ROOM))).toEqual(door);
  });

  it('방향이 반대인 벽은 그 벽의 시작 꼭짓점에서 잰다', () => {
    // 벽 3은 (2, 1.5) → (-2, 1.5). x=1.5와 x=0.5는 시작에서 0.5m와 1.5m
    expect(opening(openingFromPoints('window', [0.5, 1.5], [1.5, 1.5], ROOM))).toEqual({ type: 'window', wallIndex: 2, from: 0.5, to: 1.5, widthM: 1 });
  });

  it('모서리 근처에서는 두 점이 함께 가까운 벽을 고른다', () => {
    // 벽 2(x=2) 위의 두 점. 첫 점은 벽 1과의 모서리에 가깝다
    expect(opening(openingFromPoints('door', [1.98, -1.4], [2.02, -0.5], ROOM))).toMatchObject({ wallIndex: 1, from: 0.1, to: 1 });
  });

  it('벽 밖으로 벗어난 점은 벽 끝에 맞춘다', () => {
    expect(opening(openingFromPoints('window', [-2.3, -1.5], [-1, -1.5], ROOM))).toMatchObject({ wallIndex: 0, from: 0, to: 1 });
  });

  it('같은 벽이 아니거나 너무 가까우면 거부한다', () => {
    expect(message(openingFromPoints('door', [0, 0], [0.9, 0], ROOM))).toContain('같은 벽 위에 있지 않습니다');
    expect(message(openingFromPoints('door', [-1, -1.5], [2, 0.5], ROOM))).toContain('같은 벽 위에 있지 않습니다');
    expect(message(openingFromPoints('door', [0, -1.5], [0.1, -1.5], ROOM))).toContain('너무 가깝습니다');
    expect(message(openingFromPoints('door', [0, 0], [1, 0], []))).toBe('먼저 방을 보정해 주세요.');
  });
});

describe('openingSegment', () => {
  it('양 끝점의 방 좌표', () => {
    expect(openingSegment(door, ROOM)).toEqual([
      [-1.8, -1.5],
      [expect.closeTo(-0.9, 9), -1.5],
    ]);
    expect(openingSegment({ ...door, wallIndex: 3, from: 1, to: 2 }, ROOM)).toEqual([
      [-2, 0.5],
      [-2, -0.5],
    ]);
  });

  it('없는 벽이면 null', () => {
    expect(openingSegment({ ...door, wallIndex: 9 }, ROOM)).toBeNull();
  });
});

describe('겹침 · addOpening', () => {
  it('같은 벽에서 구간이 겹치는지', () => {
    expect(overlapsExisting({ ...door, from: 1.0, to: 1.9 }, [door])).toBe(true);
    expect(overlapsExisting({ ...door, from: 1.1, to: 2.0 }, [door])).toBe(false); // 맞닿음
    expect(overlapsExisting({ ...door, wallIndex: 1 }, [door])).toBe(false);
  });

  it('겹치면 넣지 않는다', () => {
    const added = addOpening([door], { ...door, type: 'window', from: 0.5, to: 1.5, widthM: 1 });
    expect(added).toEqual({ ok: false, message: '같은 벽의 다른 문·창문과 겹칩니다.' });
    expect(addOpening([door], { ...door, wallIndex: 2 })).toMatchObject({ ok: true, openings: [door, { ...door, wallIndex: 2 }] });
  });

  it(`${MAX_OPENINGS}개까지`, () => {
    const many = Array.from({ length: MAX_OPENINGS }, () => door);
    expect(addOpening(many, { ...door, wallIndex: 2 })).toMatchObject({ ok: false });
  });
});

describe('parseOpenings', () => {
  it('올바른 값은 그대로 읽는다', () => {
    const win: Opening = { type: 'window', wallIndex: 2, from: 1, to: 2.2, widthM: 1.2 };
    expect(parseOpenings([door, win], ROOM)).toEqual([door, win]);
  });

  it('배열이 아니거나 보정이 없으면 빈 목록', () => {
    expect(parseOpenings(null, ROOM)).toEqual([]);
    expect(parseOpenings({}, ROOM)).toEqual([]);
    expect(parseOpenings([door], null)).toEqual([]);
  });

  it('모양이 틀렸거나 벽을 벗어났거나 겹치는 항목은 버린다', () => {
    const raw = [
      door,
      { ...door, type: 'gate' },
      { ...door, wallIndex: 7 },
      { ...door, wallIndex: 1, from: 2.5, to: 3.5 },
      { ...door, from: 0.5, to: 1.4 },
      { ...door, wallIndex: 1, from: '0', to: 1 },
      { type: 'window', wallIndex: 3, from: 2, to: 1 },
      'door',
      { type: 'window', wallIndex: 3, from: 1, to: 2, widthM: 99 },
    ];
    // 마지막 항목: widthM이 from·to와 맞지 않으면 from·to를 기준으로 고친다
    expect(parseOpenings(raw, ROOM)).toEqual([door, { type: 'window', wallIndex: 3, from: 1, to: 2, widthM: 1 }]);
  });

  it(`${MAX_OPENINGS}개까지만 읽는다`, () => {
    const longRoom: Point2[] = [[0, 0], [100, 0], [100, 3], [0, 3]];
    const many = Array.from({ length: MAX_OPENINGS + 3 }, (_, i) => ({ type: 'window', wallIndex: 0, from: i * 2, to: i * 2 + 1, widthM: 1 }));
    expect(parseOpenings(many, longRoom)).toHaveLength(MAX_OPENINGS);
  });
});

describe('표시 문구 · 비교', () => {
  it('describeOpening', () => {
    expect(describeOpening(door)).toBe('문 · 벽 1 · 0.20~1.10 m (폭 0.90 m)');
  });

  it('summarizeOpenings', () => {
    expect(summarizeOpenings([door, { ...door, type: 'window' }, { ...door, type: 'window' }])).toBe('문 1 · 창문 2');
    expect(summarizeOpenings([{ ...door, type: 'window' }])).toBe('창문 1');
    expect(summarizeOpenings([])).toBe('');
  });

  it('sameOpenings', () => {
    expect(sameOpenings([door], [{ ...door }])).toBe(true);
    expect(sameOpenings([door], [{ ...door, to: 1.2 }])).toBe(false);
    expect(sameOpenings([door], [])).toBe(false);
  });
});
