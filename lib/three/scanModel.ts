// 3D 스캔 가구(GLB)를 브라우저 안에서 다듬는다: 바닥 조각 지우기 → 수평 맞추기 → 위에서 본 상자에 맞게 돌리기 →
// 바닥 가운데를 원점으로 → 텍스처 줄이기 → 다시 GLB로. 원본은 서버로 보내지 않는다.
// 브라우저 전용 (GLTFLoader의 이미지, canvas).
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { cutFloor, findFloorPlane, footprintAngle, levelRotation, type FloorPlane } from '@/lib/scan/floor';

/** 미리보기·올리기에 쓰는 텍스처의 긴 변 (px). 폰에서도 가볍게 */
export const SCAN_TEXTURE_MAX = 2048;
/** 올릴 파일이 너무 크면 텍스처를 이만큼까지 줄여 다시 만든다 */
export const SCAN_TEXTURE_FALLBACK = 1024;

type ScanPart = {
  positions: Float32Array;
  uvs: Float32Array | null;
  index: Uint32Array;
  map: THREE.Texture | null;
  color: THREE.Color;
};

export type LoadedScan = {
  parts: ScanPart[];
  /** 함께 찍힌 바닥. 없으면(이미 잘라 낸 스캔) null */
  plane: FloorPlane | null;
  triangles: number;
};

export type PreparedScan = {
  /** 바닥을 지우고 다듬은 모델 (바닥 가운데가 원점, 단위 m) */
  object: THREE.Group;
  /** 지운 바닥 조각 (미리보기에서 빨갛게 보여 줄 때) */
  removedObject: THREE.Group;
  /** 가로(x) × 높이(y) × 깊이(z) (m) */
  size: { w: number; h: number; d: number };
  keptTriangles: number;
  removedTriangles: number;
};

/** 그림을 긴 변이 max 이하인 canvas로 옮긴다 */
function shrinkImage(image: CanvasImageSource & { width: number; height: number }, max: number): HTMLCanvasElement {
  const scale = Math.min(1, max / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function shrinkTexture(texture: THREE.Texture, max: number): THREE.Texture {
  const image = texture.image as (CanvasImageSource & { width: number; height: number }) | null;
  if (!image || !image.width) return texture;
  const out = new THREE.CanvasTexture(shrinkImage(image, max));
  out.flipY = texture.flipY;
  out.colorSpace = THREE.SRGBColorSpace;
  out.wrapS = texture.wrapS;
  out.wrapT = texture.wrapT;
  // GLB로 내보낼 때 PNG 대신 JPEG로 (스캔 사진은 JPEG가 훨씬 작다)
  out.userData.mimeType = 'image/jpeg';
  return out;
}

/** GLB를 읽어 메시별 위치·UV·면과 텍스처(줄인 것)를 꺼내고, 함께 찍힌 바닥 평면을 찾는다 */
export async function loadScan(buffer: ArrayBuffer): Promise<LoadedScan> {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, '');
  gltf.scene.updateMatrixWorld(true);
  const parts: ScanPart[] = [];
  const shrunk = new Map<THREE.Texture, THREE.Texture>();
  gltf.scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry.getAttribute('position')) return;
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const count = position.count;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) positions.set([position.getX(i), position.getY(i), position.getZ(i)], i * 3);
    const uvs = uv ? new Float32Array(count * 2) : null;
    if (uv && uvs) for (let i = 0; i < count; i += 1) uvs.set([uv.getX(i), uv.getY(i)], i * 2);
    const index = geometry.index ? Uint32Array.from(geometry.index.array) : Uint32Array.from({ length: count }, (_, i) => i);
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    let map: THREE.Texture | null = null;
    if (material?.map) {
      map = shrunk.get(material.map) ?? shrinkTexture(material.map, SCAN_TEXTURE_MAX);
      shrunk.set(material.map, map);
    }
    parts.push({ positions, uvs, index, map, color: material?.color?.clone() ?? new THREE.Color(0xffffff) });
    geometry.dispose();
  });
  // 원본(큰 텍스처)은 더 쓰지 않는다
  gltf.scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
  });

  // 바닥 평면은 모든 메시를 합쳐서 찾는다
  const total = parts.reduce((sum, p) => sum + p.positions.length, 0);
  const allPos = new Float32Array(total);
  const allIdx = new Uint32Array(parts.reduce((sum, p) => sum + p.index.length, 0));
  let vOffset = 0;
  let iOffset = 0;
  for (const p of parts) {
    allPos.set(p.positions, vOffset * 3);
    for (let i = 0; i < p.index.length; i += 1) allIdx[iOffset + i] = p.index[i] + vOffset;
    vOffset += p.positions.length / 3;
    iOffset += p.index.length;
  }
  return { parts, plane: findFloorPlane(allPos, allIdx), triangles: allIdx.length / 3 };
}

/** 쓰는 꼭짓점만 남겨 새 지오메트리를 만든다 */
function buildGeometry(positions: Float32Array, uvs: Float32Array | null, index: Uint32Array): THREE.BufferGeometry {
  const remap = new Map<number, number>();
  const pos: number[] = [];
  const uv: number[] = [];
  const idx = new Uint32Array(index.length);
  for (let i = 0; i < index.length; i += 1) {
    const v = index[i];
    let n = remap.get(v);
    if (n === undefined) {
      n = remap.size;
      remap.set(v, n);
      pos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
      if (uvs) uv.push(uvs[v * 2], uvs[v * 2 + 1]);
    }
    idx[i] = n;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(remap.size > 65535 ? idx : Uint16Array.from(idx), 1));
  return geometry;
}

/**
 * 바닥에서 cut(m)까지의 조각을 지우고, 수평·방향·원점을 맞춘 모델을 만든다.
 * 바닥을 못 찾은 스캔은 지우지 않고 방향·원점만 맞춘다.
 */
export function prepareScan(scan: LoadedScan, cut: number): PreparedScan {
  const { m, floorY } = scan.plane ? levelRotation(scan.plane) : { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], floorY: 0 };
  const cuts = scan.parts.map((p) => (scan.plane ? cutFloor(p.positions, p.index, scan.plane, cut) : { kept: p.index, removed: new Uint32Array(0) }));

  // 수평 맞추기
  const leveled = scan.parts.map((p) => {
    const out = new Float32Array(p.positions.length);
    for (let i = 0; i < out.length; i += 3) {
      const [x, y, z] = [p.positions[i], p.positions[i + 1], p.positions[i + 2]];
      out[i] = m[0] * x + m[1] * y + m[2] * z;
      out[i + 1] = m[3] * x + m[4] * y + m[5] * z - floorY;
      out[i + 2] = m[6] * x + m[7] * y + m[8] * z;
    }
    return out;
  });
  // 남은 면의 꼭짓점으로 방향(위에서 본 상자가 가장 작게)과 경계 상자를 잰다
  const xz: number[] = [];
  scan.parts.forEach((_, k) => {
    const used = new Set(cuts[k].kept);
    for (const v of used) xz.push(leveled[k][v * 3], leveled[k][v * 3 + 2]);
  });
  const angle = footprintAngle(xz);
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const pos of leveled)
    for (let i = 0; i < pos.length; i += 3) {
      const [x, z] = [pos[i], pos[i + 2]];
      pos[i] = x * c + z * s;
      pos[i + 2] = -x * s + z * c;
    }
  scan.parts.forEach((_, k) => {
    for (const v of cuts[k].kept) box.expandByPoint(point.set(leveled[k][v * 3], leveled[k][v * 3 + 1], leveled[k][v * 3 + 2]));
  });
  if (box.isEmpty()) box.set(new THREE.Vector3(), new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  for (const pos of leveled)
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] -= center.x;
      pos[i + 1] -= box.min.y;
      pos[i + 2] -= center.z;
    }

  const object = new THREE.Group();
  const removedObject = new THREE.Group();
  const removedMaterial = new THREE.MeshBasicMaterial({ color: 0xe5484d, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
  scan.parts.forEach((p, k) => {
    if (cuts[k].kept.length) object.add(new THREE.Mesh(buildGeometry(leveled[k], p.uvs, cuts[k].kept), new THREE.MeshBasicMaterial({ map: p.map, color: p.color, side: THREE.DoubleSide })));
    if (cuts[k].removed.length) removedObject.add(new THREE.Mesh(buildGeometry(leveled[k], null, cuts[k].removed), removedMaterial));
  });
  const size = box.getSize(new THREE.Vector3());
  return {
    object,
    removedObject,
    size: { w: size.x, h: size.y, d: size.z },
    keptTriangles: cuts.reduce((sum, x) => sum + x.kept.length / 3, 0),
    removedTriangles: cuts.reduce((sum, x) => sum + x.removed.length / 3, 0),
  };
}

/** 다듬은 모델을 GLB로. textureMax보다 큰 텍스처는 줄인다. 재질은 조명을 받지 않는 것(unlit)으로: 스캔 사진에 빛이 이미 들어 있다 */
export async function exportScan(prepared: PreparedScan, textureMax = SCAN_TEXTURE_MAX): Promise<ArrayBuffer> {
  const object = new THREE.Group();
  const made: THREE.Texture[] = [];
  prepared.object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const source = mesh.material as THREE.MeshBasicMaterial;
    const map = source.map ? shrinkTexture(source.map, textureMax) : null;
    if (map && map !== source.map) made.push(map);
    const material = new THREE.MeshBasicMaterial({ map, color: source.color });
    material.userData.roomlensScan = true;
    object.add(new THREE.Mesh(mesh.geometry, material));
  });
  try {
    const result = await new GLTFExporter().parseAsync(object, { binary: true });
    return result as ArrayBuffer;
  } finally {
    for (const t of made) t.dispose();
  }
}

/** 미리보기에서 만든 것들을 정리한다 */
export function disposePrepared(prepared: PreparedScan): void {
  for (const group of [prepared.object, prepared.removedObject])
    group.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
}

export function disposeScan(scan: LoadedScan): void {
  for (const map of new Set(scan.parts.map((p) => p.map))) map?.dispose();
}
