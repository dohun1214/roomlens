import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { calibrateRoomFromTaps, fitFloorPlane, heightAboveFloor, projectToFloor } from '@/lib/three/floorPlane';
import { applyRoomTransform, RoomTransformError } from '@/lib/three/roomTransform';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** 방 좌표(m, 바닥 y=0)의 점들을 임의의 스캔 좌표계로 보낸다. */
function toScan(points: THREE.Vector3[], scale: number, euler: THREE.Euler, offset: THREE.Vector3) {
  const q = new THREE.Quaternion().setFromEuler(euler);
  return {
    points: points.map((p) => p.clone().multiplyScalar(scale).applyQuaternion(q).add(offset)),
    up: v(0, 1, 0).applyQuaternion(q),
  };
}

describe('fitFloorPlane', () => {
  it('세 점으로 평면을 구하고 법선은 위쪽 힌트 방향이다', () => {
    const points = [v(0, 0, 0), v(2, 0, 0), v(0, 0, 3)];
    expect(fitFloorPlane(points, v(0, 1, 0)).normal.y).toBeCloseTo(1, 9);
    // 점 순서를 바꿔도 같은 방향
    expect(fitFloorPlane([points[0], points[2], points[1]], v(0.2, 1, -0.1)).normal.y).toBeCloseTo(1, 9);
  });

  it('점을 바닥으로 내리면 높이가 0이 되고, 높이는 법선 방향 거리다', () => {
    const plane = fitFloorPlane([v(0, 1, 0), v(2, 1, 0), v(0, 1, 3)], v(0, 1, 0));
    const p = v(0.7, 2.6, -0.4);
    expect(heightAboveFloor(p, plane)).toBeCloseTo(1.6, 9);
    const down = projectToFloor(p, plane);
    expect(down.x).toBeCloseTo(0.7, 9);
    expect(down.y).toBeCloseTo(1, 9);
    expect(down.z).toBeCloseTo(-0.4, 9);
  });

  it('세 점이 한 줄이거나 너무 납작한 삼각형이면 DEGENERATE_FLOOR', () => {
    const code = (points: THREE.Vector3[]) => {
      try {
        fitFloorPlane(points, v(0, 1, 0));
      } catch (err) {
        return err instanceof RoomTransformError ? err.code : 'OTHER';
      }
      return 'NO_ERROR';
    };
    expect(code([v(0, 0, 0), v(1, 0, 0), v(2, 0, 0)])).toBe('DEGENERATE_FLOOR');
    expect(code([v(0, 0, 0), v(3, 0, 0), v(1.5, 0, 0.05)])).toBe('DEGENERATE_FLOOR');
    expect(code([v(1, 0, 1), v(1, 0, 1), v(1, 0, 1)])).toBe('DEGENERATE_FLOOR');
    expect(code([v(0, 0, 0), v(1, 0, 0)])).toBe('CORNER_COUNT');
  });
});

describe('calibrateRoomFromTaps', () => {
  // 3.2 × 4.0m 방. 모서리는 가구 때문에 서로 다른 높이에서 찍었다고 가정한다.
  const floor = [v(0.5, 0, 0.6), v(2.7, 0, 1.0), v(1.2, 0, 3.4)];
  const cornerTaps = [v(0, 0, 0), v(3.2, 1.9, 0), v(3.2, 0.4, 4.0), v(0, 2.3, 4.0)];

  it('모서리를 찍은 높이가 달라도 바닥 기준 벽 길이를 복원한다', () => {
    const cal = calibrateRoomFromTaps(floor, cornerTaps, 3.2, v(0, 1, 0));
    expect(cal.wallLengths[0]).toBeCloseTo(3.2, 9);
    expect(cal.wallLengths[1]).toBeCloseTo(4.0, 9);
    expect(cal.wallLengths[2]).toBeCloseTo(3.2, 9);
    expect(cal.wallLengths[3]).toBeCloseTo(4.0, 9);
    expect(cal.cornerHeights[0]).toBeCloseTo(0, 9);
    expect(cal.cornerHeights[1]).toBeCloseTo(1.9, 9);
    expect(cal.cornerHeights[3]).toBeCloseTo(2.3, 9);
    expect(cal.floorError).toBeLessThan(1e-9);
  });

  it('회전·확대·이동된 스캔에서도 같다', () => {
    const scan = toScan([...floor, ...cornerTaps], 0.42, new THREE.Euler(0.9, -0.4, 2.0), v(3, -8, 1));
    const cal = calibrateRoomFromTaps(scan.points.slice(0, 3), scan.points.slice(3), 3.2, scan.up);
    expect(cal.transform.s).toBeCloseTo(1 / 0.42, 6);
    expect(cal.wallLengths[1]).toBeCloseTo(4.0, 6);
    expect(cal.cornerHeights[1]).toBeCloseTo(1.9, 6);
    // 바닥 점은 y=0, 2.3m 높이에서 찍은 모서리는 y=2.3
    expect(applyRoomTransform(scan.points[0], cal.transform).y).toBeCloseTo(0, 6);
    expect(applyRoomTransform(scan.points[6], cal.transform).y).toBeCloseTo(2.3, 6);
  });

  it('높이가 다른 모서리를 바닥 평면 없이 그대로 쓰면 틀린다 (바닥 평면이 필요한 이유)', () => {
    const tilted = [cornerTaps[0], cornerTaps[1]];
    const direct = tilted[0].distanceTo(tilted[1]); // 3.2m 벽인데 높이 차 1.9m가 섞임
    expect(direct).toBeGreaterThan(3.7);
  });
});
