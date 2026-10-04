import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyRoomTransform,
  calibrateRoom,
  computeRoomTransform,
  FLOOR_ERROR_LIMIT,
  invertRoomTransform,
  RoomTransformError,
  setObjectRoomTransform,
} from '@/lib/three/roomTransform';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** 가로 w(벽 1) × 세로 d 직사각형 방의 바닥 모서리 (y=0, m 단위). 위에서 볼 때 +Z 쪽으로 돈다. */
function rectangle(w: number, d: number): THREE.Vector3[] {
  return [v(0, 0, 0), v(w, 0, 0), v(w, 0, d), v(0, 0, d)];
}

/** 방 좌표의 점들을 임의의 "스캔 좌표계"로 보낸다 (크기·회전·이동). */
function toScanSpace(points: THREE.Vector3[], scale: number, euler: THREE.Euler, offset: THREE.Vector3) {
  const q = new THREE.Quaternion().setFromEuler(euler);
  return {
    points: points.map((p) => p.clone().multiplyScalar(scale).applyQuaternion(q).add(offset)),
    up: v(0, 1, 0).applyQuaternion(q),
  };
}

/** 시드 고정 난수 (테스트 재현용) */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('computeRoomTransform', () => {
  it('이미 정렬된 방은 회전·크기 없이 중심만 원점으로 옮긴다', () => {
    const corners = rectangle(3.2, 4.0);
    const tr = computeRoomTransform(corners, [corners[0], corners[1]], 3.2, v(0, 1, 0));
    expect(tr.s).toBeCloseTo(1, 9);
    expect(tr.q[3]).toBeCloseTo(1, 9);
    expect(tr.t[0]).toBeCloseTo(-1.6, 9);
    expect(tr.t[1]).toBeCloseTo(0, 9);
    expect(tr.t[2]).toBeCloseTo(-2.0, 9);
  });

  it('임의로 회전·확대·이동된 스캔에서 실제 치수를 복원한다', () => {
    const scan = toScanSpace(rectangle(3.2, 4.0), 0.37, new THREE.Euler(0.4, -1.1, 2.3), v(5, -2, 7));
    const cal = calibrateRoom(scan.points, 3.2, scan.up);

    expect(cal.transform.s).toBeCloseTo(1 / 0.37, 6);
    expect(cal.floorError).toBeLessThan(1e-9);
    expect(cal.wallLengths[0]).toBeCloseTo(3.2, 6);
    expect(cal.wallLengths[1]).toBeCloseTo(4.0, 6);
    expect(cal.wallLengths[2]).toBeCloseTo(3.2, 6);
    expect(cal.wallLengths[3]).toBeCloseTo(4.0, 6);
  });

  it('벽 1이 +X 방향이고 모서리 중심이 원점이다', () => {
    const scan = toScanSpace(rectangle(3.2, 4.0), 2.5, new THREE.Euler(-0.7, 0.3, 1.9), v(-3, 1, 2));
    const { floorPolygon } = calibrateRoom(scan.points, 3.2, scan.up);
    const [a, b] = floorPolygon;

    expect(b[0] - a[0]).toBeCloseTo(3.2, 6); // +X로 3.2m
    expect(b[1] - a[1]).toBeCloseTo(0, 6); // z 변화 없음
    const cx = floorPolygon.reduce((sum, p) => sum + p[0], 0) / 4;
    const cz = floorPolygon.reduce((sum, p) => sum + p[1], 0) / 4;
    expect(cx).toBeCloseTo(0, 6);
    expect(cz).toBeCloseTo(0, 6);
  });

  it('위쪽 힌트가 대략적이어도, 반대 순서로 찍어도 바닥이 뒤집히지 않는다', () => {
    const scan = toScanSpace(rectangle(3.2, 4.0), 1.3, new THREE.Euler(1.0, 0.5, -0.4), v(1, 1, 1));
    const roughUp = scan.up.clone().add(v(0.3, -0.2, 0.25)); // 정확한 법선이 아닌 카메라 up
    const above = scan.points[0].clone().addScaledVector(scan.up, 1.3 * 2.0); // 바닥 위 2m 지점

    for (const corners of [scan.points, [...scan.points].reverse()]) {
      const tr = computeRoomTransform(corners, [corners[0], corners[1]], 3.2, roughUp);
      expect(applyRoomTransform(above, tr).y).toBeCloseTo(2.0, 6);
    }
  });

  it('찍는 순서(시계/반시계)에 따라 방이 +Z 또는 -Z 쪽에 놓인다', () => {
    const cw = calibrateRoom(rectangle(3.2, 4.0), 3.2, v(0, 1, 0));
    expect(cw.floorPolygon[2][1]).toBeGreaterThan(cw.floorPolygon[1][1]);

    const flipped = [v(0, 0, 0), v(3.2, 0, 0), v(3.2, 0, -4), v(0, 0, -4)];
    const ccw = calibrateRoom(flipped, 3.2, v(0, 1, 0));
    expect(ccw.floorPolygon[2][1]).toBeLessThan(ccw.floorPolygon[1][1]);
  });

  it('벽 1이 아닌 다른 두 점으로 길이를 줄 수 있다', () => {
    const scan = toScanSpace(rectangle(3.2, 4.0), 0.5, new THREE.Euler(0.2, 0.9, -0.3), v(0, 0, 0));
    const diagonal = Math.hypot(3.2, 4.0);
    const cal = calibrateRoom(scan.points, diagonal, scan.up, [scan.points[0], scan.points[2]]);
    expect(cal.wallLengths[0]).toBeCloseTo(3.2, 6);
    expect(cal.wallLengths[1]).toBeCloseTo(4.0, 6);
  });

  it('apply와 invert는 서로 역변환이다', () => {
    const scan = toScanSpace(rectangle(3.2, 4.0), 0.8, new THREE.Euler(0.3, 0.3, 0.3), v(2, 3, 4));
    const { transform } = calibrateRoom(scan.points, 3.2, scan.up);
    const p = v(0.4, -1.2, 2.2);
    const back = invertRoomTransform(applyRoomTransform(p, transform), transform);
    expect(back.distanceTo(p)).toBeLessThan(1e-9);
  });

  it('Object3D에 넣은 변환이 수식 p′ = s·R·p + t 와 같다', () => {
    const scan = toScanSpace(rectangle(3.2, 4.0), 1.7, new THREE.Euler(-0.5, 1.2, 0.8), v(-1, 4, 2));
    const { transform } = calibrateRoom(scan.points, 3.2, scan.up);
    const group = new THREE.Group();
    setObjectRoomTransform(group, transform);
    const p = v(0.9, 0.1, -2.4);
    const viaObject = p.clone().applyMatrix4(group.matrixWorld);
    expect(viaObject.distanceTo(applyRoomTransform(p, transform))).toBeLessThan(1e-9);
  });
});

describe('탭 오차', () => {
  it('모서리마다 ±3cm 오차가 있어도 벽 길이 오차는 10% 이내다 (200회)', () => {
    const rand = mulberry32(20261002);
    const jitter = () => (rand() * 2 - 1) * 0.03;
    let worst = 0;
    for (let i = 0; i < 200; i += 1) {
      const euler = new THREE.Euler(rand() * 6, rand() * 6, rand() * 6);
      const scale = 0.2 + rand() * 3;
      const noisy = rectangle(3.2, 4.0).map((p) => p.clone().add(v(jitter(), jitter(), jitter())));
      const scan = toScanSpace(noisy, scale, euler, v(rand() * 10, rand() * 10, rand() * 10));
      const cal = calibrateRoom(scan.points, 3.2, scan.up);
      const expected = [3.2, 4.0, 3.2, 4.0];
      cal.wallLengths.forEach((len, k) => {
        worst = Math.max(worst, Math.abs(len - expected[k]) / expected[k]);
      });
      expect(cal.floorError).toBeLessThan(FLOOR_ERROR_LIMIT);
    }
    expect(worst).toBeLessThan(0.1);
  });

  it('한 모서리만 높이 h만큼 잘못 찍으면 floorError는 약 h/4로 나타난다', () => {
    // 바닥 평면을 두 대각선으로 정하기 때문에 오차가 네 모서리에 ±h/4씩 나뉜다.
    // 따라서 한도 5cm는 "한 모서리가 20cm 넘게 뜬 경우"에 해당한다.
    const errorFor = (h: number) => {
      const corners = rectangle(3.2, 4.0);
      corners[2] = v(3.2, h, 4.0);
      return calibrateRoom(corners, 3.2, v(0, 1, 0)).floorError;
    };
    expect(errorFor(0.1)).toBeCloseTo(0.025, 3);
    expect(errorFor(0.1)).toBeLessThan(FLOOR_ERROR_LIMIT);
    expect(errorFor(0.3)).toBeCloseTo(0.075, 2);
    expect(errorFor(0.3)).toBeGreaterThan(FLOOR_ERROR_LIMIT);
  });
});

describe('InteriorGS 0056_839909 평면도 정답값', () => {
  // structure.json rooms[0].profile 의 네 모서리 (원본은 Z-up, m 단위)
  const profile: [number, number][] = [
    [3.88, -4.371],
    [3.88, 1.322],
    [-1.12, 1.322],
    [-1.12, -4.371],
  ];

  it('Z-up 원본 좌표에서 5.693m × 5.000m 방을 복원한다', () => {
    const corners = profile.map(([x, y]) => v(x, y, 0));
    const cal = calibrateRoom(corners, 5.693, v(0, 0, 1));
    expect(cal.transform.s).toBeCloseTo(1, 6); // 이미 m 단위
    expect(cal.floorError).toBeLessThan(1e-9);
    expect(cal.wallLengths[0]).toBeCloseTo(5.693, 3);
    expect(cal.wallLengths[1]).toBeCloseTo(5.0, 3);
    // Z-up의 위쪽(0,0,1)이 방 좌표의 +Y가 된다
    expect(applyRoomTransform(v(0, 0, 2.8), cal.transform).y).toBeCloseTo(2.8, 6);
  });

  it('뷰어 좌표(Y-up 변환본: x, 0, -y)에서도 같은 치수가 나온다', () => {
    const corners = profile.map(([x, y]) => v(x, 0, -y));
    const cal = calibrateRoom(corners, 5.693, v(0, 1, 0));
    expect(cal.wallLengths[1]).toBeCloseTo(5.0, 3);
    expect(cal.wallLengths[2]).toBeCloseTo(5.693, 3);
  });
});

describe('잘못된 입력', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return err instanceof RoomTransformError ? err.code : 'OTHER';
    }
    return 'NO_ERROR';
  };

  it('모서리가 셋보다 적으면 CORNER_COUNT', () => {
    const c = rectangle(3, 4).slice(0, 2);
    expect(code(() => computeRoomTransform(c, [c[0], c[1]], 3, v(0, 1, 0)))).toBe('CORNER_COUNT');
  });

  it('모서리 셋(삼각형 방)이나 다섯 이상도 된다', () => {
    const triangle = rectangle(3, 4).slice(0, 3);
    const tr = computeRoomTransform(triangle, [triangle[0], triangle[1]], 3, v(0, 1, 0));
    expect(tr.s).toBeCloseTo(1);
    const five = [v(0, 0, 0), v(4, 0, 0), v(4, 0, 2), v(2, 0, 3), v(0, 0, 2)];
    const cal = calibrateRoom(five, 8, v(0, 1, 0));
    expect(cal.transform.s).toBeCloseTo(2);
    expect(cal.floorPolygon).toHaveLength(5);
    expect(cal.floorError).toBeCloseTo(0);
  });

  it('모서리가 한 직선 위에 있으면 DEGENERATE_FLOOR', () => {
    const c = [v(0, 0, 0), v(1, 0, 0), v(2, 0, 0), v(3, 0, 0)];
    expect(code(() => computeRoomTransform(c, [c[0], c[1]], 1, v(0, 1, 0)))).toBe('DEGENERATE_FLOOR');
  });

  it('길이를 잰 두 점이 같으면 ZERO_REFERENCE', () => {
    const c = rectangle(3, 4);
    expect(code(() => computeRoomTransform(c, [c[0], c[0]], 3, v(0, 1, 0)))).toBe('ZERO_REFERENCE');
  });

  it('실제 길이가 0 이하이거나 숫자가 아니면 BAD_LENGTH', () => {
    const c = rectangle(3, 4);
    expect(code(() => computeRoomTransform(c, [c[0], c[1]], 0, v(0, 1, 0)))).toBe('BAD_LENGTH');
    expect(code(() => computeRoomTransform(c, [c[0], c[1]], Number.NaN, v(0, 1, 0)))).toBe('BAD_LENGTH');
  });
});
