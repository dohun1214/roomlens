// 원래 가구 옮기기 (브라우저): 방 3D 파일의 원본 스플랫에서 원래 가구 조각을 떼어 내 SPZ로 만들고, 방 화면에서 숨기고 그린다.
// 방 화면은 LOD로 열어 원본 배열이 비어 있으므로, 조각을 만들 때만 같은 파일을 LOD 없이 한 번 더 읽는다.
import * as THREE from 'three';
import { PackedSplats, SplatEdit, type SplatMesh, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType, writeSpz } from '@sparkjsdev/spark';
import type { Point2 } from './floorDrag';
import { cleanPieceMask, fillPlanes, hiddenBox, inFootprint, keptBox, MAX_PIECE_TOP, PIECE_FLOOR_CUT, pickBox, pieceTop, planePoint, toPieceFrame, wallSides, type PieceSplat } from '@/lib/rooms/fixturePiece';
import type { Fixture, PieceBox } from '@/lib/rooms/fixtures';

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

export type ExtractedPiece = { bytes: Uint8Array; count: number; top: number; box: PieceBox | null };

/**
 * 원래 가구 하나를 떼어 낸다: 바닥 사각형(조금 넓히고 벽에서 조금 떨어지게 줄인 것) 안, 바닥 바로 위부터
 * 위에 얹힌 물건까지의 스플랫을 원래 가구 좌표(가운데 원점, 바닥 y=0, 회전 0°)로 옮겨 SPZ로 묶는다.
 * @param toRoom 파일 좌표 → 방 좌표 (방 화면의 스플랫 메시의 matrixWorld)
 * @param others 방의 다른 원래 가구 (그 자리의 스플랫은 고르지 않는다)
 * @returns 고를 스플랫이 없으면 null
 */
export async function extractFixturePiece(source: PackedSplats, toRoom: THREE.Matrix4, f: Fixture, polygon: Point2[], others: Fixture[] = []): Promise<ExtractedPiece | null> {
  const box = pickBox(f, polygon);
  // 넓혀 고른 곳이 다른 원래 가구 자리에 걸치면 그 가구 것은 가져오지 않는다 (이 가구 자리와 겹치는 곳은 이 가구 것으로 본다)
  const near = others.filter((o) => o.id !== f.id && Math.hypot(o.x - f.x, o.z - f.z) < (o.w + o.d + f.w + f.d) / 2 + 0.3);
  const otherFixture = (x: number, z: number) => near.some((o) => inFootprint(o, x, z)) && !inFootprint(f, x, z);
  const walls = wallSides(f, polygon);
  const p = new THREE.Vector3();
  const scaleOf = new THREE.Vector3().setFromMatrixScale(toRoom).x;
  const picked: number[] = [];
  const found: PieceSplat[] = [];
  source.forEachSplat((i, center, scales, _quaternion, opacity) => {
    if (opacity < MIN_OPACITY) return;
    p.copy(center).applyMatrix4(toRoom);
    if (p.y < PIECE_FLOOR_CUT || p.y > MAX_PIECE_TOP || !inFootprint(box, p.x, p.z) || otherFixture(p.x, p.z)) return;
    picked.push(i);
    found.push({ x: p.x, y: p.y, z: p.z, scale: Math.max(scales.x, scales.y, scales.z) * scaleOf, opacity });
  });
  if (picked.length === 0) return null;
  // 옆 물건·떠다니는 조각·흐린 배경을 뺀 뒤 높이를 잰다
  const keep = cleanPieceMask(found, box, walls, f.h);
  const heights: number[] = [];
  for (let k = 0; k < found.length; k += 1) if (keep[k]) heights.push(found[k].y);
  if (heights.length === 0) return null;
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
  const footprint: [number, number][] = [];
  for (let k = 0; k < picked.length; k += 1) {
    if (!keep[k] || found[k].y > top + TOP_MARGIN) continue;
    footprint.push([found[k].x, found[k].z]);
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
  return { bytes: fileBytes, count, top, box: keptBox(f, footprint, box, walls) };
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
    const box = hiddenBox(fixture, polygon);
    const top = (fixture.piece?.top ?? fixture.h) + TOP_MARGIN;
    addBox([box.x, (PIECE_FLOOR_CUT + top) / 2, box.z], THREE.MathUtils.degToRad(box.rotationDeg), [box.w / 2, (top - PIECE_FLOOR_CUT) / 2, box.d / 2]);
    if (!filled) continue;
    for (const plane of fillPlanes(box, fixture.piece?.top ?? fixture.h, polygon)) {
      const { u0, u1, v0, v1 } = plane.hole;
      if (plane.kind === 'floor') {
        addBox([plane.c[0] + (u0 + u1) / 2, -0.0125, plane.c[2] + (v0 + v1) / 2], 0, [(u1 - u0) / 2, 0.0475, (v1 - v0) / 2]);
      } else {
        const n = plane.n ?? [1, 0, 0];
        const [x, y, z] = planePoint(plane, (u0 + u1) / 2, (v0 + v1) / 2);
        // 벽 뒤 6cm ~ 벽 앞 4.5cm (벽 스플랫과 벽에 붙은 얼룩). 더 앞(옆 침대 머리판 등)은 남긴다
        addBox([x - n[0] * 0.0075, y, z - n[2] * 0.0075], Math.atan2(n[0], n[2]), [(u1 - u0) / 2, (v1 - v0) / 2, 0.0525]);
      }
    }
  }
  return edit;
}

/** 방 스플랫 메시에 숨기기 편집을 건다 (null이면 모두 거둔다) */
export function setHiddenFixtures(splat: SplatMesh, edit: SplatEdit | null): void {
  splat.edits = edit ? [edit] : [];
}
