// 가구 3D 모델(GLB)을 가구 치수에 맞춰 놓기 위한 계산.
// 모델마다 크기·원점이 제각각이라, 경계 상자를 재서 "바닥 가운데가 원점"이 되게 옮겨 두고(틀),
// 놓을 때 가구의 가로·높이·깊이에 맞게 축별로 늘이거나 줄인다.
import * as THREE from 'three';

export type ModelTemplate = {
  /** 바닥 가운데가 원점이 되도록 옮겨 둔 모델. 가구마다 clone해서 쓴다 */
  object: THREE.Group;
  /** 원래 크기 [가로 x, 높이 y, 깊이 z] */
  size: [number, number, number];
};

/** 이보다 얇은 축은 늘이지 않는다 (0으로 나누기 방지) */
const MIN_SIZE = 1e-6;

/** 모델을 가구 치수에 맞추는 축별 배율 [x, y, z] */
export function fitScale(size: [number, number, number], w: number, h: number, d: number): [number, number, number] {
  const ratio = (target: number, source: number) => (source > MIN_SIZE ? target / source : 1);
  return [ratio(w, size[0]), ratio(h, size[1]), ratio(d, size[2])];
}

/**
 * 불러온 모델로 틀을 만든다: 경계 상자의 바닥 가운데를 원점으로 옮기고,
 * 조명을 받지 않는 재질(unlit)은 음영이 생기는 재질로 바꾼다. 그릴 것이 없으면 null.
 */
export function makeModelTemplate(scene: THREE.Object3D): ModelTemplate | null {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const convert = (material: THREE.Material) => {
      const basic = material as THREE.MeshBasicMaterial;
      if (!basic.isMeshBasicMaterial) return material;
      const lit = new THREE.MeshLambertMaterial({ color: basic.color, map: basic.map, transparent: basic.transparent, opacity: basic.opacity, side: basic.side });
      basic.dispose();
      return lit;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  });

  const object = new THREE.Group();
  scene.position.set(scene.position.x - center.x, scene.position.y - box.min.y, scene.position.z - center.z);
  object.add(scene);
  return { object, size: [size.x, size.y, size.z] };
}

/**
 * 틀을 복제해 가구 치수에 맞춘다. 돌려주는 물체는 "바닥 가운데가 원점"이고 크기가 w × h × d 다.
 * 지오메트리와 재질은 틀과 함께 쓰므로 따로 dispose하지 않는다.
 */
export function instantiateModel(template: ModelTemplate, w: number, h: number, d: number): THREE.Object3D {
  const object = template.object.clone(true);
  object.scale.set(...fitScale(template.size, w, h, d));
  return object;
}

/** 틀이 쓰는 지오메트리·재질을 정리한다 */
export function disposeModelTemplate(template: ModelTemplate): void {
  template.object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
  });
}
