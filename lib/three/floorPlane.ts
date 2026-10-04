import * as THREE from 'three';
import { calibrateRoom, RoomTransformError, type RoomCalibration } from './roomTransform';

/**
 * 가구가 있는 방에서는 바닥 모서리가 가려져 직접 찍을 수 없는 경우가 많다(실측: 4곳 중 3곳).
 * 그래서 바닥 평면을 따로 정하고(바닥이 보이는 세 곳), 모서리는 "두 벽이 만나는 세로 선"의
 * 아무 높이나 찍게 한 뒤 바닥 평면으로 수직으로 내려 바닥 모서리를 구한다.
 */
export type FloorPlane = {
  /** 바닥의 위쪽을 가리키는 단위 법선 */
  normal: THREE.Vector3;
  /** 평면 위의 한 점 (세 점의 중심) */
  point: THREE.Vector3;
};

/** 세 점이 이루는 삼각형이 이 비율보다 납작하면(가장 긴 변 대비 높이) 평면이 불안정하다고 본다. */
const MIN_TRIANGLE_ASPECT = 0.05;

/**
 * 바닥 위의 세 점으로 바닥 평면을 구한다.
 * @param upHint 대략 위쪽을 가리키는 벡터 (법선의 부호를 정하는 데만 쓴다)
 */
export function fitFloorPlane(points: THREE.Vector3[], upHint: THREE.Vector3): FloorPlane {
  if (points.length !== 3) {
    throw new RoomTransformError('CORNER_COUNT', '바닥 점은 세 개여야 합니다.');
  }
  const [a, b, c] = points;
  const ab = new THREE.Vector3().subVectors(b, a);
  const ac = new THREE.Vector3().subVectors(c, a);
  const bc = new THREE.Vector3().subVectors(c, b);
  const normal = new THREE.Vector3().crossVectors(ab, ac);
  const longest = Math.max(ab.length(), ac.length(), bc.length());
  // 외적 크기 = 삼각형 넓이의 두 배 = 가장 긴 변 × 그 변에 대한 높이
  if (longest === 0 || normal.length() / longest < MIN_TRIANGLE_ASPECT * longest) {
    throw new RoomTransformError(
      'DEGENERATE_FLOOR',
      '바닥 점 세 개가 너무 가깝거나 한 줄에 있습니다. 서로 멀리 떨어진 곳을 찍어 주세요.',
    );
  }
  normal.normalize();
  if (normal.dot(upHint) < 0) normal.negate();
  const point = new THREE.Vector3().add(a).add(b).add(c).divideScalar(3);
  return { normal, point };
}

/** 점을 바닥 평면으로 수직으로 내린다 (새 벡터 반환). */
export function projectToFloor(p: THREE.Vector3, plane: FloorPlane): THREE.Vector3 {
  return p.clone().addScaledVector(plane.normal, -heightAboveFloor(p, plane));
}

/** 바닥 평면에서 점까지의 높이 (원본 좌표 단위, 위쪽이 +) */
export function heightAboveFloor(p: THREE.Vector3, plane: FloorPlane): number {
  return new THREE.Vector3().subVectors(p, plane.point).dot(plane.normal);
}

export type TapCalibration = RoomCalibration & {
  /** 모서리 탭을 바닥으로 내린 점 (원본 좌표) */
  floorCorners: THREE.Vector3[];
  /** 각 모서리 탭의 바닥으로부터 높이 (m) */
  cornerHeights: number[];
};

/**
 * 바닥 세 점 + 모서리 셋 이상(높이 무관) + 실제 길이 하나로 방을 보정한다.
 * 실제 길이는 기본적으로 벽 1(첫째→둘째 모서리)의 바닥 길이다.
 */
export function calibrateRoomFromTaps(
  floorPoints: THREE.Vector3[],
  cornerTaps: THREE.Vector3[],
  realLength: number,
  upHint: THREE.Vector3,
  options: { square?: boolean } = {},
): TapCalibration {
  const plane = fitFloorPlane(floorPoints, upHint);
  const floorCorners = cornerTaps.map((p) => projectToFloor(p, plane));
  const cal = calibrateRoom(floorCorners, realLength, plane.normal, undefined, options);
  const cornerHeights = cornerTaps.map((p) => heightAboveFloor(p, plane) * cal.transform.s);
  return { ...cal, floorCorners, cornerHeights };
}
