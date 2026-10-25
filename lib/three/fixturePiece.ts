// 원래 가구 옮기기 (브라우저): 방 3D 파일의 원본 스플랫에서 원래 가구 조각을 떼어 내 SPZ로 만들고, 방 화면에서 숨기고 그린다.
// 방 화면은 LOD로 열어 원본 배열이 비어 있으므로, 조각을 만들 때만 같은 파일을 LOD 없이 한 번 더 읽는다.
import * as THREE from 'three';
import { PackedSplats, SplatEdit, type SplatMesh, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType, writeSpz } from '@sparkjsdev/spark';
import type { Point2 } from './floorDrag';
import { fillPlanes, inFootprint, MAX_PIECE_TOP, PIECE_FLOOR_CUT, pieceBox, pieceTop, planePoint, toPieceFrame } from '@/lib/rooms/fixturePiece';
import type { Fixture } from '@/lib/rooms/fixtures';

/** 거의 투명한 스플랫은 조각에 넣지 않는다 */
const MIN_OPACITY = 0.02;
/** 조각 높이보다 이만큼 위까지 넣는다 (스플랫은 크기가 있어 경계에 걸친다) */
const TOP_MARGIN = 0.03;

/** 방 3D 파일의 원본 스플랫 (LOD 없이). 원래 가구 여러 개를 떼어 낼 때 한 번만 읽는다 */
export async function loadSourceSplats(url: string, onProgress?: (fraction: number) => void): Promise<PackedSplats> {
  const packed = new PackedSplats({
    url,
    onProgress: (e: ProgressEvent) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    },
  });
  await packed.initialized;
  return packed;
}

export type ExtractedPiece = { bytes: Uint8Array; count: number; top: number };

/**
 * 원래 가구 하나를 떼어 낸다: 바닥 사각형(벽에서 조금 떨어지게 줄인 것) 안, 바닥 바로 위부터
 * 위에 얹힌 물건까지의 스플랫을 원래 가구 좌표(가운데 원점, 바닥 y=0, 회전 0°)로 옮겨 SPZ로 묶는다.
 * @param toRoom 파일 좌표 → 방 좌표 (방 화면의 스플랫 메시의 matrixWorld)
 * @returns 고를 스플랫이 없으면 null
 */
export async function extractFixturePiece(source: PackedSplats, toRoom: THREE.Matrix4, f: Fixture, polygon: Point2[]): Promise<ExtractedPiece | null> {
  const box = pieceBox(f, polygon);
  const p = new THREE.Vector3();
  const picked: number[] = [];
  const heights: number[] = [];
  source.forEachSplat((i, center, _scales, _quaternion, opacity) => {
    if (opacity < MIN_OPACITY) return;
    p.copy(center).applyMatrix4(toRoom);
    if (p.y < PIECE_FLOOR_CUT || p.y > MAX_PIECE_TOP || !inFootprint(box, p.x, p.z)) return;
    picked.push(i);
    heights.push(p.y);
  });
  if (picked.length === 0) return null;
  const top = pieceTop(heights, f.h);

  // 파일 좌표의 스플랫을 원래 가구 좌표로: 자리 = R(-θ)·(방 - 가운데), 방향 = R(-θ)·(보정 회전)·원래 방향, 크기 = 배율배
  const t = new THREE.Vector3();
  const roomRotation = new THREE.Quaternion();
  const roomScale = new THREE.Vector3();
  toRoom.decompose(t, roomRotation, roomScale);
  const scale = roomScale.x;
  const frame = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (-f.rotationDeg * Math.PI) / 180);
  const out = new PackedSplats();
  const center = new THREE.Vector3();
  const scales = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  for (let k = 0; k < picked.length; k += 1) {
    if (heights[k] > top + TOP_MARGIN) continue;
    const s = source.getSplat(picked[k]);
    center.copy(s.center).applyMatrix4(toRoom);
    const [lx, lz] = toPieceFrame(f, center.x, center.z);
    center.set(lx, center.y, lz);
    scales.copy(s.scales).multiplyScalar(scale);
    quaternion.copy(roomRotation).multiply(s.quaternion).premultiply(frame);
    out.pushSplat(center, scales, quaternion, s.opacity, s.color);
  }
  const { fileBytes } = await writeSpz(out);
  const count = out.numSplats;
  out.dispose();
  return { bytes: fileBytes, count, top };
}

/**
 * 옮긴 원래 가구의 원래 자리를 숨기는 편집 (방 스플랫 메시의 edits에 넣는다).
 * 떼어 낸 조각과 같은 곳(줄인 바닥 사각형, 바닥 바로 위 ~ 조각 높이)을 투명하게 한다.
 * filled: 빈자리를 채운 조각이 있으면 채운 곳(바닥 구멍의 그림자·다리 자국, 벽의 얼룩)도 숨긴다 (채운 스플랫이 덮는다)
 */
export function hideFixtureEdit(moved: { fixture: Fixture; filled: boolean }[], polygon: Point2[]): SplatEdit | null {
  if (moved.length === 0) return null;
  const edit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY });
  const addBox = (center: [number, number, number], rotationY: number, half: [number, number, number]) => {
    const sdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: 0 });
    sdf.position.set(...center);
    sdf.rotation.y = rotationY;
    // 상자 SDF의 크기는 scale(반 길이)로 준다
    sdf.scale.set(...half);
    edit.addSdf(sdf);
  };
  for (const { fixture, filled } of moved) {
    const box = pieceBox(fixture, polygon);
    const top = (fixture.piece?.top ?? fixture.h) + TOP_MARGIN;
    addBox([box.x, (PIECE_FLOOR_CUT + top) / 2, box.z], THREE.MathUtils.degToRad(box.rotationDeg), [box.w / 2, (top - PIECE_FLOOR_CUT) / 2, box.d / 2]);
    if (!filled) continue;
    for (const plane of fillPlanes(fixture, fixture.piece?.top ?? fixture.h, polygon)) {
      const { u0, u1, v0, v1 } = plane.hole;
      if (plane.kind === 'floor') {
        addBox([plane.c[0] + (u0 + u1) / 2, -0.0125, plane.c[2] + (v0 + v1) / 2], 0, [(u1 - u0) / 2, 0.0475, (v1 - v0) / 2]);
      } else {
        const n = plane.n ?? [1, 0, 0];
        const [x, y, z] = planePoint(plane, (u0 + u1) / 2, (v0 + v1) / 2);
        // 벽 앞 -6cm ~ +14cm (벽 스플랫과 벽에 붙은 얼룩)
        addBox([x + n[0] * 0.04, y, z + n[2] * 0.04], Math.atan2(n[0], n[2]), [(u1 - u0) / 2, (v1 - v0) / 2, 0.1]);
      }
    }
  }
  return edit;
}

/** 방 스플랫 메시에 숨기기 편집을 건다 (null이면 모두 거둔다) */
export function setHiddenFixtures(splat: SplatMesh, edit: SplatEdit | null): void {
  splat.edits = edit ? [edit] : [];
}
