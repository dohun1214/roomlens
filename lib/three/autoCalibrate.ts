// 자동 보정: 장면의 표면 점 → 위쪽·바닥·벽 윤곽·크기(lib/rooms/autoLayout.ts) → 기존 보정 계산(calibrateRoom)과 같은 결과 모양.
// 사람이 탭한 보정과 똑같이 저장·적용할 수 있다. 브라우저에서 수백 ms~1초쯤 걸린다.
import * as THREE from 'three';
import type { SplatMesh } from '@sparkjsdev/spark';
import { estimateRoomLayout, type EstimateOptions, type LayoutEstimate } from '@/lib/rooms/autoLayout';
import { calibrateRoom, RoomTransformError, type RoomCalibration } from './roomTransform';
import { sampleScenePoints, type ScenePoints } from './scenePoints';

export type AutoCalibration =
  | (RoomCalibration & {
      ok: true;
      /** 바닥~천장 (m) */
      height: number;
      /** 크기를 천장 높이로 짐작했는지 (파일 단위가 m가 아닌 것 같을 때). 사용자에게 확인을 받는다 */
      scaleGuessed: boolean;
      /** 바닥으로 내린 모서리 (보정 전 좌표 = roomGroup 기준) */
      floorCorners: THREE.Vector3[];
      estimate: LayoutEstimate;
    })
  | { ok: false; message: string };

/**
 * 스플랫을 자동으로 보정한다. 결과는 roomGroup 기준 좌표(스플랫의 X축 뒤집기를 포함한 좌표)에서 계산한다.
 * @param mesh roomGroup의 자식인 스플랫 (roomGroup은 아직 보정 전이어야 한다)
 */
export function autoCalibrate(mesh: SplatMesh, options: EstimateOptions = {}): AutoCalibration {
  const points = cachedPoints(mesh);
  if (!points || points.count < 1000) return { ok: false, message: '장면에서 점을 충분히 읽지 못했습니다.' };
  return calibrateFromPoints(points, mesh.quaternion, options);
}

// 같은 장면에서 "다른 방 고르기"·"위아래 뒤집기"를 다시 할 때 점을 다시 읽지 않는다
let cache: { mesh: SplatMesh; points: ScenePoints | null } | null = null;
function cachedPoints(mesh: SplatMesh): ScenePoints | null {
  if (cache?.mesh !== mesh) cache = { mesh, points: sampleScenePoints(mesh) };
  return cache.points;
}

/** 표면 점(스플랫 원본 좌표)으로 보정한다. local = 스플랫 자신의 회전(원본 → roomGroup 기준) */
export function calibrateFromPoints(points: ScenePoints, local: THREE.Quaternion = new THREE.Quaternion(), options: EstimateOptions = {}): AutoCalibration {
  const estimate = estimateRoomLayout(points, options);
  if (!estimate || estimate.corners.length < 4) return { ok: false, message: '방의 벽을 찾지 못했습니다. 직접 모서리를 찍어 주세요.' };
  const toGroup = (v: [number, number, number]) => new THREE.Vector3(...v).applyQuaternion(local);
  const floorCorners = estimate.corners.map(toGroup);
  const upHint = toGroup(estimate.up);
  const wall1 = floorCorners[0].distanceTo(floorCorners[1]) * estimate.scale;
  try {
    const cal = calibrateRoom(floorCorners, wall1, upHint, undefined, { square: true });
    return { ...cal, ok: true, height: (estimate.ceiling - estimate.floor) * estimate.scale, scaleGuessed: estimate.scaleGuessed, floorCorners, estimate };
  } catch (err) {
    return { ok: false, message: err instanceof RoomTransformError ? err.message : '자동 보정을 계산하지 못했습니다.' };
  }
}
