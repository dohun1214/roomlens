import { describe, expect, it } from 'vitest';
import { blendFill } from '@/lib/rooms/fillBlend';
import { boxFootprint, cleanPieceMask, hiddenBox, keptBox, pickBox, pixelPlane, planeSurfaceAt, PIECE_GROW, wallSides, FILL_IMAGE, FILL_MARGIN, fillPlanes, fixturePieceKey, holeRect, pieceAccess, inFootprint, type PieceSplat, MAX_PIECE_TOP, pieceBox, pieceTop, PIECE_WALL_GAP, planePixel, planePoint, toPieceFrame } from '@/lib/rooms/fixturePiece';
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

describe('fillPlanes', () => {
  it('벽에서 떨어진 가구는 바닥 하나만, 구멍 둘레가 그림에 함께 담긴다', () => {
    const planes = fillPlanes(fixture(), 0.9, ROOM);
    expect(planes.map((p) => p.kind)).toEqual(['floor']);
    const [floor] = planes;
    expect(floor.hole.u1 - floor.hole.u0).toBeCloseTo(0.8 + 2 * FILL_MARGIN, 6);
    expect(floor.Wm / floor.Hm).toBeCloseTo(FILL_IMAGE.width / FILL_IMAGE.height, 6);
    const [x, y, w, h] = holeRect(floor);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(x + w).toBeLessThan(FILL_IMAGE.width);
    expect(y + h).toBeLessThan(FILL_IMAGE.height);
    // 그림 가운데가 구멍 가운데
    expect(planePixel(floor, 0, 0)).toEqual([FILL_IMAGE.width / 2, FILL_IMAGE.height / 2]);
  });

  it('서쪽 벽에 붙은 가구는 그 벽도: 안쪽 방향 +x, 바닥부터 조각 높이 + 30cm까지', () => {
    const planes = fillPlanes(fixture({ x: -1.65 }), 1.2, ROOM);
    expect(planes.map((p) => p.kind)).toEqual(['floor', 'wall']);
    const wall = planes[1];
    expect(wall.n).toEqual([1, 0, 0]);
    expect(wall.c[0]).toBeCloseTo(-2, 6);
    expect(wall.c[1] + wall.hole.v0).toBeCloseTo(0, 6);
    expect(wall.c[1] + wall.hole.v1).toBeCloseTo(1.5, 6);
    // 구간 가운데의 벽 위 점은 벽 위에 있고, 그림에서 가운데
    const [px, py] = planePixel(wall, 0, 0);
    expect(px).toBeCloseTo(FILL_IMAGE.width / 2, 6);
    expect(py).toBeCloseTo(FILL_IMAGE.height / 2, 6);
    expect(planePoint(wall, 0, 0)[0]).toBeCloseTo(-2, 6);
    // 그림에서 위로 가면 높이가 올라간다
    expect(planePixel(wall, 0, 0.5)[1]).toBeLessThan(py);
  });

  it('모서리 가구는 벽 둘', () => {
    expect(fillPlanes(fixture({ x: 1.65, z: 1.25 }), 0.9, ROOM).filter((p) => p.kind === 'wall')).toHaveLength(2);
  });
});

describe('pieceAccess', () => {
  it('누구나 처음은 만들고, 다시 만드는 것은 방 주인만, 채우기는 떼어 낸 뒤에', () => {
    expect(pieceAccess({}, 'piece', false)).toBe('ok');
    expect(pieceAccess({ piece: { v: 1, top: 1 } }, 'piece', false)).toBe('taken');
    expect(pieceAccess({ piece: { v: 1, top: 1 } }, 'piece', true)).toBe('ok');
    expect(pieceAccess({}, 'fill', true)).toBe('need-piece');
    expect(pieceAccess({ piece: { v: 1, top: 1 } }, 'fill', false)).toBe('ok');
    expect(pieceAccess({ piece: { v: 1, top: 1 }, fill: { v: 2 } }, 'fill', false)).toBe('taken');
    expect(pieceAccess({ piece: { v: 1, top: 1 }, fill: { v: 2 } }, 'fill', true)).toBe('ok');
  });
});

describe('cleanPieceMask', () => {
  const box = { x: 0, z: 0, w: 1, d: 1, rotationDeg: 0 };
  const grid = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, step = 0.02, extra: Partial<PieceSplat> = {}): PieceSplat[] => {
    const out: PieceSplat[] = [];
    for (let x = x0; x <= x1 + 1e-9; x += step) for (let y = y0; y <= y1 + 1e-9; y += step) for (let z = z0; z <= z1 + 1e-9; z += step) out.push({ x, y, z, scale: 0.01, opacity: 0.9, ...extra });
    return out;
  };
  it('가구 몸통과 위에 얹힌 물건은 남기고, 옆 물건·떠다니는 조각·흐린 큰 스플랫은 뺀다', () => {
    const body = grid(-0.3, 0.3, 0.05, 0.5, -0.3, 0.3);
    const vase = grid(-0.05, 0.05, 0.6, 0.8, -0.05, 0.05); // 몸통과 10cm 떨어져 위에 얹힘 (따로 떨어진 덩어리)
    const lampBase = grid(0.44, 0.5, 0.03, 0.1, -0.1, 0.1); // 상자 옆면에 걸친 옆 물건
    const floater = [{ x: 0, y: 1.2, z: 0, scale: 0.01, opacity: 0.9 }];
    const haze = [{ x: 0.1, y: 0.3, z: 0.1, scale: 0.3, opacity: 0.9 }, { x: -0.1, y: 0.3, z: 0.1, scale: 0.08, opacity: 0.1 }];
    const all = [...body, ...vase, ...lampBase, ...floater, ...haze];
    const keep = cleanPieceMask(all, box);
    const kept = (from: number, count: number) => Array.from(keep.slice(from, from + count)).filter(Boolean).length;
    let at = 0;
    expect(kept(at, body.length)).toBe(body.length);
    at += body.length;
    expect(kept(at, vase.length)).toBe(vase.length);
    at += vase.length;
    expect(kept(at, lampBase.length)).toBe(0);
    at += lampBase.length;
    expect(kept(at, 1)).toBe(0);
    at += 1;
    expect(kept(at, 2)).toBe(0);
  });
  it('빈 목록과 돌린 상자', () => {
    expect(cleanPieceMask([], box).length).toBe(0);
    const turned = { ...box, rotationDeg: 45 };
    const body = grid(-0.2, 0.2, 0.05, 0.3, -0.2, 0.2);
    expect(Array.from(cleanPieceMask(body, turned)).every(Boolean)).toBe(true);
  });
});

describe('blendFill', () => {
  const W = 64;
  const H = 40;
  const image = (fn: (x: number, y: number) => number) => {
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) out.set([fn(x, y), fn(x, y), fn(x, y), 255], (y * W + x) * 4);
    return out;
  };
  const at = (img: Uint8ClampedArray, x: number, y: number) => img[(y * W + x) * 4];
  it('AI 그림이 둘레보다 어두우면 구멍 안을 둘레 밝기에 맞추고, 구멍 밖은 원래 그림', () => {
    const out = blendFill(image(() => 100), image(() => 140), W, H, [20, 12, 24, 16]);
    expect(at(out, 32, 20)).toBeGreaterThan(136);
    expect(at(out, 32, 20)).toBeLessThan(144);
    expect(at(out, 2, 2)).toBe(140);
  });
  it('둘레가 왼쪽 어둡고 오른쪽 밝으면 구멍 안도 그 사이로 이어진다', () => {
    const out = blendFill(image(() => 120), image((x) => (x < 32 ? 80 : 200)), W, H, [16, 8, 32, 24]);
    expect(at(out, 18, 20)).toBeLessThan(at(out, 32, 20));
    expect(at(out, 32, 20)).toBeLessThan(at(out, 46, 20));
  });
  it('평면이 아닌 곳의 둘레(검은 바깥)는 쓰지 않는다', () => {
    const out = blendFill(image(() => 100), image((x) => (x >= 44 ? 0 : 140)), W, H, [20, 12, 24, 16], (px) => px < 44);
    expect(at(out, 40, 20)).toBeGreaterThan(130);
  });
});

describe('pickBox · keptBox · hiddenBox', () => {
  it('고르는 사각형은 넓히되 벽 쪽은 벽에서 띄운다', () => {
    // 왼쪽 벽(x=-2)에 붙은 의자
    const f = fixture({ x: -1.6, z: 0, w: 0.8, d: 0.6 });
    const box = pickBox(f, ROOM);
    expect(box.x - box.w / 2).toBeCloseTo(-2 + PIECE_WALL_GAP, 3);
    expect(box.x + box.w / 2).toBeCloseTo(-1.2 + PIECE_GROW, 3);
    expect(box.d).toBeCloseTo(0.6 + 2 * PIECE_GROW, 3);
  });
  it('떼어 낸 점들이 차지한 사각형 (원래 가구 좌표, 튀는 점 제외, 고른 사각형 안으로)', () => {
    const f = fixture({ x: 1, z: 0.5, rotationDeg: 90 });
    const within = pickBox(f, ROOM);
    const pts: Point2[] = [];
    // 방 좌표 x 0.8~1.2, z 0.2~0.8 (90° 돌린 가구: 가로 u = (0,-1), 깊이 v = (1,0))
    for (let i = 0; i <= 40; i += 1) for (let j = 0; j <= 60; j += 1) pts.push([0.8 + i * 0.01, 0.2 + j * 0.01]);
    pts.push([5, 5]); // 튀는 점 하나
    const kept = keptBox(f, pts, within)!;
    expect(kept.w).toBeCloseTo(0.6 + 0.03, 2);
    expect(kept.d).toBeCloseTo(0.4 + 0.03, 2);
    const back = boxFootprint(f, kept);
    expect(back.x).toBeCloseTo(1, 2);
    expect(back.z).toBeCloseTo(0.5, 2);
    expect(keptBox(f, [], within)).toBeNull();
  });
  it('숨길 사각형: 떼어 낸 사각형이 있으면 그것, 없으면(예전 조각) pieceBox', () => {
    const f = fixture({ x: 0.5, z: 0.2, piece: { v: 1, top: 1, box: { cu: 0.05, cv: -0.02, w: 0.7, d: 0.5 } } });
    expect(hiddenBox(f, ROOM)).toEqual({ x: 0.55, z: 0.18, w: 0.7, d: 0.5, rotationDeg: 0 });
    const old = fixture({ x: 0.5, z: 0.2, piece: { v: 1, top: 1 } });
    expect(hiddenBox(old, ROOM)).toEqual(pieceBox(old, ROOM));
  });
  it('조각 정보의 사각형은 원래 가구 형식 검사를 통과한다', () => {
    const raw = [{ ...fixture({ x: 0.5 }), piece: { v: 1, top: 1, box: { cu: 0, cv: 0, w: 0.9, d: 0.7 } } }];
    expect(parseFixtures(raw, ROOM)[0].piece?.box).toEqual({ cu: 0, cv: 0, w: 0.9, d: 0.7 });
  });
});

describe('planeSurfaceAt', () => {
  it('바닥은 방 안, 벽은 그 벽 구간 안·바닥 위만', () => {
    const [floor, wall] = fillPlanes(fixture({ x: -1.65, z: 0, w: 0.6, d: 0.6 }), 1, ROOM);
    expect(wall.kind).toBe('wall');
    const [fx, fy] = planePixel(floor, 0, 0);
    expect(planeSurfaceAt(floor, fx, fy, ROOM)).toBe(true);
    // 바닥 그림에서 왼쪽 벽 너머 (x < -2)
    const [ox, oy] = planePixel(floor, -0.6, 0);
    expect(planeSurfaceAt(floor, ox, oy, ROOM)).toBe(false);
    const [wx, wy] = planePixel(wall, 0, 0.5 - wall.c[1]);
    expect(planeSurfaceAt(wall, wx, wy, ROOM)).toBe(true);
    const [bx, by] = planePixel(wall, 0, -wall.c[1] - 0.05);
    expect(planeSurfaceAt(wall, bx, by, ROOM)).toBe(false);
    const [px, py] = planePixel(floor, 0.1, -0.2);
    expect(pixelPlane(floor, px, py)[0]).toBeCloseTo(0.1, 6);
    expect(pixelPlane(floor, px, py)[1]).toBeCloseTo(-0.2, 6);
  });
});

describe('벽 쪽 변', () => {
  // 왼쪽 벽(x=-2)에 붙은 의자: 가로 u = +x 이므로 uMin 쪽이 벽
  const f = fixture({ x: -1.6, z: 0, w: 0.8, d: 0.6 });
  it('wallSides: 벽 때문에 줄인 변만', () => {
    expect(wallSides(f, ROOM)).toEqual({ uMin: true, uMax: false, vMin: false, vMax: false });
    expect(wallSides(fixture({ x: 0, z: 0 }), ROOM)).toEqual({ uMin: false, uMax: false, vMin: false, vMax: false });
  });
  it('keptBox: 벽 쪽 변은 고른 사각형 끝까지 늘린다', () => {
    const within = pickBox(f, ROOM);
    const pts: Point2[] = [];
    for (let i = 0; i <= 20; i += 1) for (let j = 0; j <= 20; j += 1) pts.push([-1.8 + i * 0.03, -0.3 + j * 0.03]);
    const kept = keptBox(f, pts, within, wallSides(f, ROOM))!;
    const fp = boxFootprint(f, kept);
    expect(fp.x - fp.w / 2).toBeCloseTo(-2 + PIECE_WALL_GAP, 2);
    expect(fp.x + fp.w / 2).toBeCloseTo(-1.2 + 0.015, 2);
  });
  it('cleanPieceMask: 벽 쪽 띠의 크거나 옅은 스플랫만 뺀다', () => {
    const box = pickBox(f, ROOM);
    const walls = wallSides(f, ROOM);
    const body: PieceSplat[] = [];
    for (let x = -1.92; x <= -1.3; x += 0.02) for (let y = 0.05; y <= 0.6; y += 0.02) body.push({ x, y, z: 0, scale: 0.01, opacity: 0.9 });
    const blur = { x: -1.94, y: 0.5, z: 0, scale: 0.05, opacity: 0.8 };
    const faint = { x: -1.93, y: 0.4, z: 0.05, scale: 0.01, opacity: 0.1 };
    const solid = { x: -1.93, y: 0.3, z: 0, scale: 0.01, opacity: 0.9 };
    const keep = cleanPieceMask([...body, blur, faint, solid], box, walls);
    expect(Array.from(keep.slice(body.length))).toEqual([0, 0, 1]);
    // 벽 정보가 없으면 그대로 둔다
    expect(cleanPieceMask([...body, blur], box)[body.length]).toBe(1);
  });
});

describe('blendFill 번짐', () => {
  it('칠한 자홍색이 JPEG로 둘레에 번져도 채운 곳이 분홍으로 물들지 않는다', () => {
    const W = 64;
    const H = 40;
    const hole: [number, number, number, number] = [20, 12, 24, 16];
    const ai = new Uint8ClampedArray(W * H * 4);
    const original = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const k = (y * W + x) * 4;
        ai.set([200, 200, 200, 255], k);
        const inHole = x >= 20 && x < 44 && y >= 12 && y < 28;
        const bleed = !inHole && x >= 18 && x < 46 && y >= 10 && y < 30;
        original.set(inHole ? [255, 0, 255, 255] : bleed ? [230, 120, 230, 255] : [200, 200, 200, 255], k);
      }
    }
    const out = blendFill(ai, original, W, H, hole);
    const k = (20 * W + 32) * 4;
    expect(Math.abs(out[k] - out[k + 1])).toBeLessThan(4);
    expect(out[k]).toBeGreaterThan(195);
  });
});

describe('바닥 바로 위', () => {
  it('바닥 위 8cm 안의 크거나 옅은 스플랫은 빼고, 가늘고 진한 다리는 남긴다', () => {
    const box = { x: 0, z: 0, w: 1, d: 1, rotationDeg: 0 };
    const body: PieceSplat[] = [];
    for (let y = 0.03; y <= 0.6; y += 0.02) body.push({ x: 0, y, z: 0, scale: 0.01, opacity: 0.9 });
    const keep = cleanPieceMask([...body, { x: 0.02, y: 0.04, z: 0, scale: 0.05, opacity: 0.9 }, { x: 0, y: 0.05, z: 0.02, scale: 0.01, opacity: 0.1 }], box);
    expect(keep[0]).toBe(1);
    expect(Array.from(keep.slice(body.length))).toEqual([0, 0]);
  });
});

describe('따로 선 물건·벽에 달린 것', () => {
  const grid = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): PieceSplat[] => {
    const out: PieceSplat[] = [];
    for (let x = x0; x <= x1 + 1e-9; x += 0.02) for (let y = y0; y <= y1 + 1e-9; y += 0.02) for (let z = z0; z <= z1 + 1e-9; z += 0.02) out.push({ x, y, z, scale: 0.01, opacity: 0.9 });
    return out;
  };
  it('몸통과 떨어져 바닥에 선 스탠드는 빼고, 크게 나뉜 부분은 남긴다', () => {
    const box = { x: 0, z: 0, w: 1.2, d: 1.2, rotationDeg: 0 };
    const chair = grid(-0.3, 0.2, 0.05, 0.6, -0.3, 0.3);
    const lamp = grid(0.32, 0.36, 0.03, 1.4, 0.0, 0.04); // 의자 옆 바닥에 선 가는 스탠드 (상자 안쪽)
    const keep = cleanPieceMask([...chair, ...lamp], box);
    expect(Array.from(keep.slice(chair.length)).every((k) => k === 0)).toBe(true);
    // 크게 나뉜 소파 (몸통의 30% 넘음)는 바닥까지 내려와도 남긴다
    const other = grid(0.3, 0.55, 0.05, 0.5, -0.3, 0.3);
    const keep2 = cleanPieceMask([...chair, ...other], box);
    expect(Array.from(keep2.slice(chair.length)).every((k) => k === 1)).toBe(true);
  });
  it('가구 높이 위에서 벽 쪽 변에 붙은 것(벽등 전선)은 뺀다', () => {
    const f = fixture({ x: -1.65, z: 0, w: 0.6, d: 0.5, h: 0.6 });
    const box = pickBox(f, ROOM);
    const walls = wallSides(f, ROOM);
    const stand = grid(-1.9, -1.4, 0.05, 0.6, -0.2, 0.2);
    const cord = grid(-1.94, -1.92, 0.62, 1.6, 0, 0.02);
    const vase = grid(-1.7, -1.6, 0.62, 0.9, -0.05, 0.05);
    const keep = cleanPieceMask([...stand, ...cord, ...vase], box, walls, 0.6);
    expect(cord.every((p, i) => p.y <= 0.65 || keep[stand.length + i] === 0)).toBe(true);
    expect(Array.from(keep.slice(stand.length + cord.length)).every((k) => k === 1)).toBe(true);
  });
});


describe('잎이 넓게 퍼진 화분', () => {
  it('수납장 위 화분(좁은 화분 + 위로 넓게 퍼진 잎)은 남긴다', () => {
    const grid = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): PieceSplat[] => {
      const out: PieceSplat[] = [];
      for (let x = x0; x <= x1 + 1e-9; x += 0.02) for (let y = y0; y <= y1 + 1e-9; y += 0.02) for (let z = z0; z <= z1 + 1e-9; z += 0.02) out.push({ x, y, z, scale: 0.01, opacity: 0.9 });
      return out;
    };
    const box = { x: 0, z: 0, w: 0.8, d: 0.7, rotationDeg: 0 };
    const cabinet = grid(-0.3, 0.3, 0.05, 0.63, -0.25, 0.25);
    const pot = grid(-0.05, 0.05, 0.65, 0.9, -0.05, 0.05);
    const leaves = grid(-0.25, 0.25, 0.92, 1.2, -0.2, 0.2);
    const keep = cleanPieceMask([...cabinet, ...pot, ...leaves], box, undefined, 0.63);
    expect(Array.from(keep.slice(cabinet.length)).every((k) => k === 1)).toBe(true);
  });
});

describe('윗면을 다 덮는 물건', () => {
  it('협탁 윗면을 거의 다 덮는 쟁반도 얹힌 것으로 남긴다', () => {
    const grid = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): PieceSplat[] => {
      const out: PieceSplat[] = [];
      for (let x = x0; x <= x1 + 1e-9; x += 0.02) for (let y = y0; y <= y1 + 1e-9; y += 0.02) for (let z = z0; z <= z1 + 1e-9; z += 0.02) out.push({ x, y, z, scale: 0.01, opacity: 0.9 });
      return out;
    };
    const box = { x: 0, z: 0, w: 0.7, d: 0.6, rotationDeg: 0 };
    const stand = grid(-0.25, 0.25, 0.05, 0.6, -0.2, 0.2);
    const tray = grid(-0.22, 0.22, 0.66, 0.72, -0.17, 0.17);
    const keep = cleanPieceMask([...stand, ...tray], box, undefined, 0.6);
    expect(Array.from(keep.slice(stand.length)).every((k) => k === 1)).toBe(true);
  });
});
