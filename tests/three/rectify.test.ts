import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Point2 } from '@/lib/three/floorDrag';
import { calibrateRoomFromTaps } from '@/lib/three/floorPlane';
import { dominantAxisAngle, rectifyPolygon } from '@/lib/three/rectify';
import { applyRoomTransform, calibrateRoom } from '@/lib/three/roomTransform';

const DEG = Math.PI / 180;
const rotate = (points: Point2[], deg: number): Point2[] =>
  points.map(([x, z]) => [x * Math.cos(deg * DEG) - z * Math.sin(deg * DEG), x * Math.sin(deg * DEG) + z * Math.cos(deg * DEG)]);
const round = (points: Point2[] | null, digits = 3) => points?.map((p) => p.map((v) => +v.toFixed(digits) + 0));
const RECT: Point2[] = [
  [0, 0],
  [4, 0],
  [4, 3],
  [0, 3],
];
// ㄱ자: 6 × 4 m에서 오른쪽 위(x > 4, z > 2)가 빠진 모양
const L_SHAPE: Point2[] = [
  [0, 0],
  [6, 0],
  [6, 2],
  [4, 2],
  [4, 4],
  [0, 4],
];

describe('dominantAxisAngle', () => {
  it('축과 나란한 방은 0', () => {
    expect(dominantAxisAngle(RECT)).toBeCloseTo(0);
    expect(dominantAxisAngle(L_SHAPE)).toBeCloseTo(0);
  });

  it('돌아간 방의 각도를 찾는다 (−45° 초과 45° 이하)', () => {
    expect(dominantAxisAngle(rotate(RECT, 10)) / DEG).toBeCloseTo(10);
    expect(dominantAxisAngle(rotate(L_SHAPE, -30)) / DEG).toBeCloseTo(-30);
    // 100° 돌린 것은 10° 돌린 것과 벽 방향이 같다
    expect(dominantAxisAngle(rotate(RECT, 100)) / DEG).toBeCloseTo(10);
  });

  it('모서리 하나가 틀려도 다른 벽들이 방향을 잡아 준다', () => {
    // 3.7 × 5.8 m 방에서 첫 모서리를 9cm 안쪽으로 잘못 찍음 → 벽 1만 보면 1.4° 틀어지지만 전체로는 0.5° 미만
    const taps: Point2[] = [
      [0.02, 0.09],
      [3.7, 0],
      [3.7, 5.8],
      [0, 5.8],
    ];
    const wall1Only = Math.atan2(taps[1][1] - taps[0][1], taps[1][0] - taps[0][0]) / DEG;
    expect(Math.abs(wall1Only)).toBeGreaterThan(1.3);
    expect(Math.abs(dominantAxisAngle(taps) / DEG)).toBeLessThan(0.5);
  });
});

describe('rectifyPolygon', () => {
  it('조금씩 틀린 사각형을 직사각형으로 바로잡는다 (벽의 위치는 양 끝의 평균)', () => {
    const noisy: Point2[] = [
      [0.04, -0.02],
      [3.98, 0.02],
      [4.02, 3.04],
      [-0.04, 2.96],
    ];
    expect(round(rectifyPolygon(noisy))).toEqual([
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]);
  });

  it('ㄱ자 방도 모든 벽이 가로·세로가 된다. 꼭짓점 수와 순서는 그대로', () => {
    const noisy = L_SHAPE.map(([x, z], i): Point2 => [x + (i % 2 ? 0.03 : -0.03), z + (i % 3 ? 0.02 : -0.02)]);
    const fixed = rectifyPolygon(noisy)!;
    expect(fixed).toHaveLength(6);
    fixed.forEach((p, i) => {
      const next = fixed[(i + 1) % 6];
      expect(Math.min(Math.abs(next[0] - p[0]), Math.abs(next[1] - p[1]))).toBeCloseTo(0, 9);
      expect(Math.hypot(p[0] - L_SHAPE[i][0], p[1] - L_SHAPE[i][1])).toBeLessThan(0.06);
    });
  });

  it('한 벽 가운데에 찍은 점은 그 벽의 줄 위에 놓인다', () => {
    const withMiddle: Point2[] = [
      [0, 0.02],
      [2, -0.04],
      [4, 0.02],
      [4, 3],
      [0, 3],
    ];
    const fixed = round(rectifyPolygon(withMiddle))!;
    expect(fixed[0][1]).toBe(fixed[1][1]);
    expect(fixed[1][1]).toBe(fixed[2][1]);
    expect(fixed[1][0]).toBe(2);
    expect(Math.abs(fixed[0][1])).toBeLessThan(0.02);
  });

  it('이미 반듯한 방은 그대로', () => {
    expect(round(rectifyPolygon(L_SHAPE))).toEqual(L_SHAPE);
  });

  it('비스듬한 벽이 있거나 삼각형이면 null', () => {
    expect(rectifyPolygon([[0, 0], [4, 0], [6, 2], [6, 5], [0, 5]])).toBeNull(); // 45° 벽
    expect(rectifyPolygon([[0, 0], [4, 0], [0, 3]])).toBeNull();
    expect(rectifyPolygon([[0, 0], [4, 0], [4, 0], [0, 3]])).toBeNull(); // 길이 0인 벽
  });
});

describe('보정에서 직각으로 맞추기', () => {
  const v = (x: number, z: number) => new THREE.Vector3(x, 0, z);
  const UP = new THREE.Vector3(0, 1, 0);

  it('맞추지 않으면 예전과 같다 (벽 1 기준, 찍은 그대로)', () => {
    const corners = [v(2.78, -2.96), v(6.33, -3.05), v(6.33, 2.75), v(2.63, 2.75)];
    const cal = calibrateRoom(corners, 3.55, UP);
    expect(cal.squared).toBe(false);
    expect(cal.floorPolygon[0][1]).toBeCloseTo(cal.floorPolygon[1][1]); // 벽 1이 +X
    expect(Math.abs(cal.floorPolygon[2][0] - cal.floorPolygon[1][0])).toBeGreaterThan(0.1); // 벽 2가 기운다
  });

  it('Studio 11 거실처럼 모서리 하나가 가려져 틀리게 찍혀도 반듯한 직사각형이 된다', () => {
    // 실제: x 2.63~6.33, z -3.05~2.75. 첫 모서리가 붙박이 선반 때문에 (2.78, -2.96)으로 찍힘
    const corners = [v(2.78, -2.96), v(6.33, -3.05), v(6.33, 2.75), v(2.63, 2.75)];
    // "파일 단위 그대로": 바로잡은 벽 1의 길이(파일 단위)를 실제 길이로 넣으면 배율이 1이 된다
    const probe = calibrateRoom(corners, 1, UP, undefined, { square: true });
    const wall1 = probe.wallLengths[0] / probe.transform.s;
    const cal = calibrateRoom(corners, wall1, UP, undefined, { square: true });
    expect(cal.squared).toBe(true);
    expect(cal.transform.s).toBeCloseTo(1, 9);
    expect(wall1).toBeCloseTo(6.33 - (2.78 + 2.63) / 2, 2); // 왼쪽 벽의 위치는 두 모서리의 평균
    const [a, b, c, d] = cal.floorPolygon;
    // 모든 벽이 가로·세로
    expect(a[1]).toBeCloseTo(b[1], 9);
    expect(b[0]).toBeCloseTo(c[0], 9);
    expect(c[1]).toBeCloseTo(d[1], 9);
    expect(d[0]).toBeCloseTo(a[0], 9);
    // 벽 1은 입력한 길이 그대로, 벽 2는 실제(5.80m)와 6cm 이내
    expect(cal.wallLengths[0]).toBeCloseTo(wall1, 9);
    expect(Math.abs(cal.wallLengths[1] - 5.8)).toBeLessThan(0.06);
    // 꼭짓점의 중심이 원점
    expect(a[0] + b[0] + c[0] + d[0]).toBeCloseTo(0, 9);
    expect(a[1] + b[1] + c[1] + d[1]).toBeCloseTo(0, 9);
    // 찍은 모서리를 변환하면 바로잡은 평면도의 꼭짓점 근처(12cm 이내)에 온다
    corners.forEach((p, i) => {
      const moved = applyRoomTransform(p, cal.transform);
      expect(Math.hypot(moved.x - cal.floorPolygon[i][0], moved.z - cal.floorPolygon[i][1])).toBeLessThan(0.12);
      expect(moved.y).toBeCloseTo(0, 9);
    });
    // 방은 1° 미만으로만 돈다 (벽 1만 보면 1.45°)
    const q = new THREE.Quaternion(...cal.transform.q);
    expect((2 * Math.acos(Math.min(1, Math.abs(q.w)))) / DEG).toBeLessThan(1);
  });

  it('정확히 찍은 방은 맞추든 안 맞추든 같다', () => {
    const corners = [v(0, 0), v(4, 0), v(4, 3), v(0, 3)];
    const plain = calibrateRoom(corners, 4, UP);
    const squared = calibrateRoom(corners, 4, UP, undefined, { square: true });
    expect(squared.squared).toBe(true);
    squared.floorPolygon.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(plain.floorPolygon[i][0], 9);
      expect(p[1]).toBeCloseTo(plain.floorPolygon[i][1], 9);
    });
    expect(squared.transform.s).toBeCloseTo(plain.transform.s, 9);
  });

  it('ㄱ자 방(모서리 6개)도 보정된다: 크기 2배 스캔, 벽 1의 실제 길이 6m', () => {
    const scan = L_SHAPE.map(([x, z]) => v(x * 0.5 + 10, z * 0.5 - 3)); // 0.5배로 줄고 옮겨진 스캔
    const cal = calibrateRoom(scan, 6, UP, undefined, { square: true });
    expect(cal.squared).toBe(true);
    expect(cal.transform.s).toBeCloseTo(2);
    expect(cal.wallLengths.map((l) => +l.toFixed(6))).toEqual([6, 2, 2, 2, 4, 4]);
  });

  it('비스듬한 벽이 있으면 맞추지 않고 찍은 그대로 쓴다', () => {
    const corners = [v(0, 0), v(4, 0), v(6, 2), v(6, 5), v(0, 5)];
    const cal = calibrateRoom(corners, 4, UP, undefined, { square: true });
    expect(cal.squared).toBe(false);
    expect(cal.wallLengths[1]).toBeCloseTo(Math.hypot(2, 2));
  });

  it('탭 보정(바닥 3점 + 모서리)에서도 쓸 수 있다', () => {
    const floor = [new THREE.Vector3(1, 0, 1), new THREE.Vector3(5, 0, 1), new THREE.Vector3(1, 0, 3)];
    // 모서리는 벽 모서리 선의 아무 높이나 찍는다
    const taps = L_SHAPE.map(([x, z], i) => new THREE.Vector3(x + (i === 2 ? 0.05 : 0), 1 + i * 0.2, z));
    const cal = calibrateRoomFromTaps(floor, taps, 6, UP, { square: true });
    expect(cal.squared).toBe(true);
    expect(cal.floorPolygon).toHaveLength(6);
    expect(cal.wallLengths[0]).toBeCloseTo(6, 9);
    // 높이도 같은 배율로 나온다 (모서리 하나를 5cm 틀리게 찍어 배율이 1에서 조금 벗어난다)
    cal.cornerHeights.forEach((h, i) => expect(h / cal.transform.s).toBeCloseTo(1 + i * 0.2, 6));
    expect(Math.abs(cal.transform.s - 1)).toBeLessThan(0.01);
  });
});
