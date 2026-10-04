import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fitScale, instantiateModel, makeModelTemplate } from '@/lib/three/furnitureModel';

/** 원점이 한쪽 모서리에 있고(Kenney 모델처럼) 크기가 0.5 × 0.4 × 1.0 인 모델 */
function cornerModel(material: THREE.Material = new THREE.MeshBasicMaterial({ color: 0x336699 })) {
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 1.0), material);
  mesh.position.set(0.25, 0.2, -0.5); // x 0~0.5, y 0~0.4, z -1~0
  scene.add(mesh);
  return scene;
}
const boxOf = (object: THREE.Object3D) => {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  return { min: box.min.toArray().map((v) => +v.toFixed(6) + 0), max: box.max.toArray().map((v) => +v.toFixed(6) + 0) };
};

describe('fitScale', () => {
  it('축마다 따로 맞춘다', () => {
    expect(fitScale([0.5, 0.4, 1.0], 1.0, 0.45, 2.0)).toEqual([2, 1.125, 2]);
  });

  it('두께가 없는 축은 그대로 둔다', () => {
    expect(fitScale([0.5, 0, 1.0], 1.0, 0.45, 2.0)).toEqual([2, 1, 2]);
  });
});

describe('makeModelTemplate', () => {
  it('원래 크기를 재고, 바닥 가운데를 원점으로 옮긴다', () => {
    const template = makeModelTemplate(cornerModel())!;
    expect(template.size.map((v) => +v.toFixed(6))).toEqual([0.5, 0.4, 1]);
    expect(boxOf(template.object)).toEqual({ min: [-0.25, 0, -0.5], max: [0.25, 0.4, 0.5] });
  });

  it('조명을 받지 않는 재질은 음영이 생기는 재질로 바꾸고 색은 유지한다', () => {
    const template = makeModelTemplate(cornerModel())!;
    const mesh = template.object.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const material = mesh.material as THREE.MeshLambertMaterial;
    expect(material.isMeshLambertMaterial).toBe(true);
    expect(material.color.getHex()).toBe(0x336699);
  });

  it('이미 조명을 받는 재질은 그대로 둔다', () => {
    const standard = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const template = makeModelTemplate(cornerModel(standard))!;
    expect((template.object.getObjectByProperty('isMesh', true) as THREE.Mesh).material).toBe(standard);
  });

  it('돌아간 노드가 있어도 겉에서 본 크기로 잰다', () => {
    const scene = cornerModel();
    scene.rotation.y = Math.PI / 2; // 가로와 깊이가 바뀐다
    const template = makeModelTemplate(scene)!;
    expect(template.size.map((v) => +v.toFixed(6))).toEqual([1, 0.4, 0.5]);
    expect(boxOf(template.object)).toEqual({ min: [-0.5, 0, -0.25], max: [0.5, 0.4, 0.25] });
  });

  it('그릴 것이 없으면 null', () => {
    expect(makeModelTemplate(new THREE.Group())).toBeNull();
  });
});

describe('instantiateModel', () => {
  it('가구 치수(가로 × 높이 × 깊이)에 딱 맞고 바닥 가운데가 원점이다', () => {
    const template = makeModelTemplate(cornerModel())!;
    const bed = instantiateModel(template, 1.0, 0.45, 2.0);
    expect(boxOf(bed)).toEqual({ min: [-0.5, 0, -1], max: [0.5, 0.45, 1] });
  });

  it('여러 번 복제해도 틀은 그대로이고 지오메트리를 함께 쓴다', () => {
    const template = makeModelTemplate(cornerModel())!;
    const a = instantiateModel(template, 1.0, 0.45, 2.0);
    const b = instantiateModel(template, 1.2, 0.73, 0.6);
    expect(boxOf(b)).toEqual({ min: [-0.6, 0, -0.3], max: [0.6, 0.73, 0.3] });
    expect(boxOf(template.object)).toEqual({ min: [-0.25, 0, -0.5], max: [0.25, 0.4, 0.5] });
    const geometryOf = (o: THREE.Object3D) => (o.getObjectByProperty('isMesh', true) as THREE.Mesh).geometry;
    expect(geometryOf(a)).toBe(geometryOf(b));
  });
});
