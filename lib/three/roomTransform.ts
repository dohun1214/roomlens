import * as THREE from 'three';
import { dominantAxisAngle, rectifyPolygon } from './rectify';

/**
 * 방 보정 변환. 스플랫 원본 좌표 p를 방 좌표 p' = s·R·p + t 로 옮긴다.
 * 방 좌표계: 바닥이 y=0, 단위 m, 벽 1(첫 모서리→둘째 모서리)이 +X 방향, 모서리들의 중심이 원점.
 * DB에는 이 값만 저장하고 원본 스플랫은 고치지 않는다.
 */
export type RoomTransform = {
  s: number;
  /** 회전 쿼터니언 [x, y, z, w] */
  q: [number, number, number, number];
  t: [number, number, number];
};

export const IDENTITY_ROOM_TRANSFORM: RoomTransform = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0] };

export class RoomTransformError extends Error {
  constructor(
    public readonly code: 'CORNER_COUNT' | 'DEGENERATE_FLOOR' | 'ZERO_REFERENCE' | 'BAD_LENGTH',
    message: string,
  ) {
    super(message);
    this.name = 'RoomTransformError';
  }
}

const EPS = 1e-9;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * @param corners 바닥 모서리 셋 이상 (스플랫 원본 좌표 = roomGroup이 단위 변환일 때의 좌표, 탭한 순서대로)
 * @param ref 실제 길이를 잰 두 점 (기본: corners[0], corners[1] = 벽 1)
 * @param realLength 두 점 사이의 실제 길이 (m)
 * @param upHint 대략 위쪽을 가리키는 벡터 (보통 카메라의 up). 바닥 법선의 부호를 정하는 데만 쓴다.
 */
export function computeRoomTransform(
  corners: THREE.Vector3[],
  ref: [THREE.Vector3, THREE.Vector3],
  realLength: number,
  upHint: THREE.Vector3,
): RoomTransform {
  if (corners.length < 3) {
    throw new RoomTransformError('CORNER_COUNT', '바닥 모서리는 세 개 이상이어야 합니다.');
  }
  if (!(realLength > 0) || !Number.isFinite(realLength)) {
    throw new RoomTransformError('BAD_LENGTH', '실제 길이는 0보다 큰 값이어야 합니다.');
  }
  const [p1, p2] = corners;

  // 바닥 법선. 모서리가 넷이면 두 대각선의 외적, 그 밖에는 이웃한 꼭짓점들의 외적을 모두 더한 것(Newell)
  const n = new THREE.Vector3();
  let span = EPS;
  if (corners.length === 4) {
    const d1 = new THREE.Vector3().subVectors(corners[2], corners[0]);
    const d2 = new THREE.Vector3().subVectors(corners[3], corners[1]);
    n.crossVectors(d1, d2);
    span = Math.max(d1.lengthSq(), d2.lengthSq(), EPS);
  } else {
    corners.forEach((p, i) => {
      const next = corners[(i + 1) % corners.length];
      n.add(new THREE.Vector3().subVectors(p, corners[0]).cross(new THREE.Vector3().subVectors(next, corners[0])));
      span = Math.max(span, p.distanceToSquared(corners[0]));
    });
  }
  // 외적 크기 = 넓이의 두 배. 크기에 비해 너무 작으면 한 직선 위의 점들이다.
  if (n.length() <= 1e-6 * span) {
    throw new RoomTransformError('DEGENERATE_FLOOR', '모서리들이 한 직선 위에 있습니다. 다시 찍어 주세요.');
  }
  n.normalize();
  if (n.dot(upHint) < 0) n.negate();

  const c = new THREE.Vector3();
  for (const p of corners) c.add(p);
  c.divideScalar(corners.length);

  // 1) 법선을 +Y로 (tilt)  2) 벽 1을 +X로 (yaw)
  const tilt = new THREE.Quaternion().setFromUnitVectors(n, UP);
  const wall = new THREE.Vector3().subVectors(p2, p1).applyQuaternion(tilt);
  if (Math.hypot(wall.x, wall.z) < EPS) {
    throw new RoomTransformError('DEGENERATE_FLOOR', '첫 두 모서리가 같은 위치입니다.');
  }
  const yaw = new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(wall.z, wall.x));
  const R = yaw.multiply(tilt); // tilt 먼저, 그다음 yaw

  const refDistance = ref[0].distanceTo(ref[1]);
  if (refDistance < EPS) {
    throw new RoomTransformError('ZERO_REFERENCE', '길이를 잴 두 점이 같은 위치입니다.');
  }
  const s = realLength / refDistance;
  const t = c.clone().applyQuaternion(R).multiplyScalar(-s);

  return { s, q: [R.x, R.y, R.z, R.w], t: [t.x, t.y, t.z] };
}

/** 원본 좌표의 점을 방 좌표로 옮긴다 (새 벡터 반환). */
export function applyRoomTransform(p: THREE.Vector3, tr: RoomTransform): THREE.Vector3 {
  const q = new THREE.Quaternion(tr.q[0], tr.q[1], tr.q[2], tr.q[3]);
  return p.clone().applyQuaternion(q).multiplyScalar(tr.s).add(new THREE.Vector3(...tr.t));
}

/** 방 좌표의 점을 원본 좌표로 되돌린다. */
export function invertRoomTransform(p: THREE.Vector3, tr: RoomTransform): THREE.Vector3 {
  const q = new THREE.Quaternion(tr.q[0], tr.q[1], tr.q[2], tr.q[3]).invert();
  return p.clone().sub(new THREE.Vector3(...tr.t)).divideScalar(tr.s).applyQuaternion(q);
}

/**
 * three.js 객체(roomGroup)에 변환을 넣는다.
 * Object3D는 크기 → 회전 → 이동 순서로 적용하고 크기가 균일하므로 p' = s·R·p + t 와 같다.
 */
export function setObjectRoomTransform(object: THREE.Object3D, tr: RoomTransform): void {
  object.scale.setScalar(tr.s);
  object.quaternion.set(tr.q[0], tr.q[1], tr.q[2], tr.q[3]);
  object.position.set(tr.t[0], tr.t[1], tr.t[2]);
  object.updateMatrixWorld(true);
}

export type RoomCalibration = {
  transform: RoomTransform;
  /** 방 평면도 [[x, z], …] (m), 탭한 순서 */
  floorPolygon: [number, number][];
  /** 벽 길이 (m). i번째 = 모서리 i → i+1 */
  wallLengths: number[];
  /** 변환 후 모서리의 |y| 최댓값 (m). 0.05를 넘으면 바닥을 다시 찍게 한다. */
  floorError: number;
  /** 벽을 직각으로 맞췄는지. 맞춰 달라고 했어도 비스듬한 벽이 있으면 false (찍은 그대로) */
  squared: boolean;
};

/**
 * floorError 한도 (m). 한 모서리만 높이 h만큼 틀리면 floorError ≈ h/4 이므로,
 * 0.05는 "한 모서리가 바닥에서 20cm 넘게 뜬 경우"에 해당한다.
 */
export const FLOOR_ERROR_LIMIT = 0.05;

const wallLengthsOf = (polygon: [number, number][]) =>
  polygon.map((p, i) => {
    const next = polygon[(i + 1) % polygon.length];
    return Math.hypot(next[0] - p[0], next[1] - p[1]);
  });

/**
 * 보정 한 번에 필요한 값(변환 + 평면도 + 벽 길이 + 평탄도)을 모두 계산한다.
 * options.square 를 주면 벽을 직각으로 맞춘다: 벽 하나(벽 1)가 아니라 벽 전체의 주된 방향으로 방 좌표축을 잡고,
 * 각 벽을 정확히 가로·세로로 바로잡는다. 벽 1의 길이는 입력한 실제 길이 그대로 유지한다.
 */
export function calibrateRoom(
  corners: THREE.Vector3[],
  realLength: number,
  upHint: THREE.Vector3,
  ref?: [THREE.Vector3, THREE.Vector3],
  options: { square?: boolean } = {},
): RoomCalibration {
  const base = computeRoomTransform(corners, ref ?? [corners[0], corners[1]], realLength, upHint);
  const moved = corners.map((p) => applyRoomTransform(p, base));
  const floorPolygon = moved.map((p) => [p.x, p.z] as [number, number]);
  const floorError = Math.max(...moved.map((p) => Math.abs(p.y)));
  const plain: RoomCalibration = { transform: base, floorPolygon, wallLengths: wallLengthsOf(floorPolygon), floorError, squared: false };
  if (!options.square) return plain;

  // 1) 벽들의 주된 방향이 +X가 되도록 방을 더 돌린다 (Y축 회전은 computeRoomTransform의 yaw와 같은 방향)
  const turn = new THREE.Quaternion().setFromAxisAngle(UP, dominantAxisAngle(floorPolygon));
  const q = turn.clone().multiply(new THREE.Quaternion(...base.q));
  const t = new THREE.Vector3(...base.t).applyQuaternion(turn);
  const turned: RoomTransform = { s: base.s, q: [q.x, q.y, q.z, q.w], t: [t.x, t.y, t.z] };
  // 2) 그 좌표에서 벽을 가로·세로로 바로잡는다
  const rectified = rectifyPolygon(corners.map((p) => applyRoomTransform(p, turned)).map((p) => [p.x, p.z]));
  if (!rectified) return plain;
  // 3) 벽 1의 길이가 입력값과 같아지게 크기를 맞추고(기준을 따로 준 경우는 그대로), 꼭짓점의 중심을 원점으로 옮긴다
  const wall1 = Math.hypot(rectified[1][0] - rectified[0][0], rectified[1][1] - rectified[0][1]);
  const k = ref || wall1 < EPS ? 1 : realLength / wall1;
  const cx = rectified.reduce((sum, p) => sum + p[0], 0) / rectified.length;
  const cz = rectified.reduce((sum, p) => sum + p[1], 0) / rectified.length;
  const polygon = rectified.map((p) => [(p[0] - cx) * k + 0, (p[1] - cz) * k + 0] as [number, number]);
  const transform: RoomTransform = { s: turned.s * k, q: turned.q, t: [(t.x - cx) * k, t.y * k, (t.z - cz) * k] };
  return { transform, floorPolygon: polygon, wallLengths: wallLengthsOf(polygon), floorError: floorError * k, squared: true };
}