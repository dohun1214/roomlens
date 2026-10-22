import { describe, expect, it } from 'vitest';
import { cutFloor, DEFAULT_FLOOR_CUT, findFloorPlane, footprintAngle, heightAbove, levelRotation } from '@/lib/scan/floor';

/** 격자 바닥(n×n칸) + 그 위의 상자. 바닥은 y = a·x + b·z + c 로 살짝 기울일 수 있다 */
function scene({ a = 0, b = 0, c = 0.03, half = 0.25, box = 0.1, boxH = 0.4 } = {}) {
  const pos: number[] = [];
  const idx: number[] = [];
  const floorY = (x: number, z: number) => a * x + b * z + c;
  const n = 10;
  for (let i = 0; i <= n; i += 1)
    for (let j = 0; j <= n; j += 1) {
      const x = -half + (2 * half * i) / n;
      const z = -half + (2 * half * j) / n;
      pos.push(x, floorY(x, z), z);
    }
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j < n; j += 1) {
      const p = i * (n + 1) + j;
      // 위를 향하게 (x→z 순서의 오른손 법칙에서 y가 +가 되도록)
      idx.push(p, p + 1, p + n + 2, p, p + n + 2, p + n + 1);
    }
  const floorCount = idx.length / 3;
  // 상자: 바닥 위에 세운 네 옆면 + 윗면 (밑면 없음, 스캔처럼)
  const base = pos.length / 3;
  const y0 = floorY(0, 0);
  const corners = [
    [-box, -box],
    [box, -box],
    [box, box],
    [-box, box],
  ];
  for (const [x, z] of corners) pos.push(x, y0, z);
  for (const [x, z] of corners) pos.push(x, y0 + boxH, z);
  for (let k = 0; k < 4; k += 1) {
    const k2 = (k + 1) % 4;
    idx.push(base + k, base + k2, base + 4 + k2, base + k, base + 4 + k2, base + 4 + k);
  }
  idx.push(base + 4, base + 6, base + 5, base + 4, base + 7, base + 6);
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx), floorCount, boxCount: idx.length / 3 - floorCount };
}

describe('findFloorPlane', () => {
  it('함께 찍힌 바닥 평면을 찾는다 (기울기·높이)', () => {
    const { pos, idx } = scene({ a: 0.01, b: -0.02, c: 0.035 });
    const plane = findFloorPlane(pos, idx)!;
    expect(plane.a).toBeCloseTo(0.01, 3);
    expect(plane.b).toBeCloseTo(-0.02, 3);
    expect(plane.c).toBeCloseTo(0.035, 3);
  });

  it('받침의 넓은 윗면이 바닥보다 넓어도 그 아래의 바닥을 고른다', () => {
    const { pos, idx } = scene({ c: 0.03, half: 0.25 });
    // 바닥 위 3cm에 넓은 받침 윗면 (가장자리만 바닥이 보이는 둥근 받침 선풍기처럼)
    const p = Array.from(pos);
    const t = Array.from(idx);
    const base = p.length / 3;
    const n = 12;
    for (let i = 0; i <= n; i += 1)
      for (let j = 0; j <= n; j += 1) p.push(-0.24 + (0.48 * i) / n, 0.06, -0.24 + (0.48 * j) / n);
    for (let i = 0; i < n; i += 1)
      for (let j = 0; j < n; j += 1) {
        const q = base + i * (n + 1) + j;
        t.push(q, q + 1, q + n + 2, q, q + n + 2, q + n + 1);
      }
    const plane = findFloorPlane(Float32Array.from(p), Uint32Array.from(t))!;
    expect(plane.c).toBeCloseTo(0.03, 3);
  });

  it('바닥이 없으면(이미 잘라 낸 스캔) null', () => {
    const { pos, idx, floorCount } = scene();
    const noFloor = idx.slice(floorCount * 3);
    expect(findFloorPlane(pos, noFloor)).toBeNull();
  });
});

describe('cutFloor', () => {
  it('바닥 면은 모두 지우고 상자의 옆면·윗면은 남긴다', () => {
    const { pos, idx, floorCount, boxCount } = scene({ a: 0.01, c: 0.035 });
    const plane = findFloorPlane(pos, idx)!;
    const { kept, removed } = cutFloor(pos, idx, plane, DEFAULT_FLOOR_CUT);
    expect(removed.length / 3).toBe(floorCount);
    expect(kept.length / 3).toBe(boxCount);
  });

  it('잘라 내는 높이를 높이면 낮은 물체도 지워진다', () => {
    const { pos, idx, floorCount } = scene({ boxH: 0.03 });
    const plane = findFloorPlane(pos, idx)!;
    expect(cutFloor(pos, idx, plane, 0.015).removed.length / 3).toBe(floorCount);
    expect(cutFloor(pos, idx, plane, 0.04).kept.length).toBe(0);
  });
});

describe('levelRotation', () => {
  it('기운 바닥을 수평으로: 돌린 뒤 바닥 위의 점은 높이가 같다', () => {
    const plane = { a: 0.05, b: -0.03, c: 0.02 };
    const { m, floorY } = levelRotation(plane);
    const apply = (x: number, z: number) => {
      const y = plane.a * x + plane.b * z + plane.c;
      return m[3] * x + m[4] * y + m[5] * z;
    };
    for (const [x, z] of [
      [0, 0],
      [0.3, -0.2],
      [-0.4, 0.5],
    ])
      expect(apply(x, z)).toBeCloseTo(floorY, 6);
    expect(heightAbove(plane, 0, plane.c + 0.1, 0)).toBeCloseTo(0.1 / Math.sqrt(1 + 0.05 ** 2 + 0.03 ** 2), 6);
  });

  it('이미 수평이면 그대로', () => {
    const { m, floorY } = levelRotation({ a: 0, b: 0, c: 0.04 });
    expect(m).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(floorY).toBeCloseTo(0.04);
  });
});

describe('footprintAngle', () => {
  const rect = (angleDeg: number) => {
    const r = (angleDeg * Math.PI) / 180;
    const out: number[] = [];
    for (let i = 0; i <= 20; i += 1)
      for (let j = 0; j <= 10; j += 1) {
        const u = -0.4 + (0.8 * i) / 20;
        const v = -0.15 + (0.3 * j) / 10;
        out.push(u * Math.cos(r) - v * Math.sin(r), u * Math.sin(r) + v * Math.cos(r));
      }
    return out;
  };
  it('비스듬히 놓인 직사각형의 각을 찾는다', () => {
    expect((footprintAngle(rect(30)) * 180) / Math.PI).toBeCloseTo(30, 0);
    expect((footprintAngle(rect(72)) * 180) / Math.PI % 90).toBeCloseTo(72, 0);
  });
  it('축에 나란하면 0', () => {
    expect(footprintAngle(rect(0))).toBe(0);
  });
});
