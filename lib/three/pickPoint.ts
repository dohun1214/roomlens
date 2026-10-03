import * as THREE from 'three';
import { utils, type PackedSplats, type SplatMesh } from '@sparkjsdev/spark';
import { pickSurfaceAlongRay, type SplatVisitor } from './splatPick';

export type PickResult = {
  /** 표면 위의 점 (월드 좌표) */
  point: THREE.Vector3;
  /** 카메라에서 그 점까지의 거리 (월드 단위) */
  distance: number;
  coverage: number;
  profile?: [number, number][];
};

/** 포인터 이벤트 위치를 캔버스 기준 NDC(-1~1)로 바꾼다. */
export function pointerToNdc(event: { clientX: number; clientY: number }, element: HTMLElement): THREE.Vector2 {
  const rect = element.getBoundingClientRect();
  return new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

/**
 * 메시가 지금 화면에 그리고 있는 스플랫을 차례로 넘겨준다.
 * - lod 없이 열었으면 원본 전체
 * - lod: true 로 열었으면 원본 배열은 비어 있고, LOD 트리(lodSplats) 중 현재 선택된 인덱스만 쓴다
 *   (트리 전체를 쓰면 같은 표면이 여러 단계로 중복된다)
 */
function visitRenderedSplats(mesh: SplatMesh): ((visit: SplatVisitor) => void) | null {
  const packed: PackedSplats | undefined = mesh.packedSplats;
  if (!packed) return null;

  if (packed.numSplats > 0 && packed.packedArray) {
    const { packedArray, splatEncoding, numSplats } = packed;
    return (visit) => {
      for (let i = 0; i < numSplats; i += 1) {
        const s = utils.unpackSplat(packedArray, i, splatEncoding);
        visit(s.center, s.scales, s.quaternion, s.opacity);
      }
    };
  }

  const lod = packed.lodSplats;
  if (!lod?.packedArray) return null;
  const { packedArray, splatEncoding } = lod;
  const context = mesh.context;
  const count = context.numSplats.value;
  const indices = context.enableLod.value ? (context.lodIndices.value.image.data as Uint32Array | null) : null;
  if (!indices || count === 0) return null; // 아직 한 번도 그려지지 않음
  return (visit) => {
    for (let i = 0; i < count; i += 1) {
      const s = utils.unpackSplat(packedArray, indices[i], splatEncoding);
      visit(s.center, s.scales, s.quaternion, s.opacity);
    }
  };
}

/**
 * 화면의 한 점에서 광선을 쏴 스플랫 표면의 점(월드 좌표)을 구한다.
 * 그려진 스플랫 전체를 훑으므로(100만 개에 수백 ms) 탭할 때만 호출한다.
 */
export function pickPoint(
  camera: THREE.PerspectiveCamera,
  ndc: THREE.Vector2,
  mesh: SplatMesh,
  options: { profile?: boolean } = {},
): PickResult | null {
  const forEachSplat = visitRenderedSplats(mesh);
  if (!forEachSplat) return null;

  camera.updateMatrixWorld();
  mesh.updateMatrixWorld();
  const originWorld = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const directionWorld = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(camera).sub(originWorld).normalize();

  // 광선을 메시 좌표계로 옮겨 계산한다 (메시는 균일 크기 변환만 가진다고 가정)
  const toLocal = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const origin = originWorld.clone().applyMatrix4(toLocal);
  const direction = directionWorld.clone().transformDirection(toLocal);
  const worldPerLocal = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld).x;

  const pick = pickSurfaceAlongRay(forEachSplat, origin, direction, {
    near: camera.near / worldPerLocal,
    far: camera.far / worldPerLocal,
    profile: options.profile,
  });
  if (!pick) return null;

  const point = origin.addScaledVector(direction, pick.distance).applyMatrix4(mesh.matrixWorld);
  return { point, distance: point.distanceTo(originWorld), coverage: pick.coverage, profile: pick.profile };
}
