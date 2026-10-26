// 옮긴 원래 가구의 빈자리 채우기 (브라우저): 바닥은 위에서·벽은 정면에서 좁은 시야로 찍고 구멍을 자홍색으로 칠해 보낸 뒤,
// AI가 이어 그린 그림의 색으로 구멍 자리에 납작한 스플랫을 깔아 SPZ로 만든다 (원래 가구 좌표로 저장).
import * as THREE from 'three';
import { PackedSplats, writeSpz } from '@sparkjsdev/spark';
import type { CaptureEngine } from './capture';
import { captureFixedViews, type FixedView } from './topView';
import { blendFill } from '@/lib/rooms/fillBlend';
import { FILL_IMAGE, holeRect, planePixel, planePoint, planeSurfaceAt, toPieceFrame, type FillPlane } from '@/lib/rooms/fixturePiece';
import type { Point2 } from './floorDrag';
import type { Fixture } from '@/lib/rooms/fixtures';

/** 평면에서 카메라까지 (m). 멀리서 좁은 시야로 찍어 원근을 거의 없앤다 */
const DISTANCE = 20;
/** 깔 스플랫의 간격 (m) */
const STEP = 0.008;
/** 구멍 둘레로 더 깐다 (m). 원래 스플랫과 이어지게 */
const SPREAD = 0.02;
/** 바닥·벽에서 띄우는 거리 (m, 깜빡이지 않게) */
const LIFT = { floor: 0.002, wall: 0.004 };
/** 칠하는 색: 그림 모델에게 "이 색만 채우라"고 한다 */
const MASK_COLOR = '#ff00ff';

/** 평면을 정면에서 찍는 카메라 (near·far로 평면 앞뒤만 남긴다: 바닥 위 가구·벽 앞 물건이 잘린다) */
export function planeView(plane: FillPlane): FixedView {
  const fovDeg = (2 * Math.atan(plane.Hm / 2 / DISTANCE) * 180) / Math.PI;
  const [cx, cy, cz] = plane.c;
  if (plane.kind === 'floor') {
    return { position: [cx, DISTANCE, cz], target: [cx, 0, cz], up: [0, 0, -1], fovDeg, near: DISTANCE - 0.12, far: DISTANCE + 0.3 };
  }
  const n = plane.n ?? [1, 0, 0];
  return { position: [cx + n[0] * DISTANCE, cy, cz + n[2] * DISTANCE], target: [cx, cy, cz], up: [0, 1, 0], fovDeg, near: DISTANCE - 0.25, far: DISTANCE + 0.3 };
}

async function toBitmap(mimeType: string, base64: string): Promise<ImageBitmap> {
  const blob = await (await fetch(`data:${mimeType};base64,${base64}`)).blob();
  return createImageBitmap(blob);
}

/** 그림을 FILL_IMAGE 크기 캔버스에 그린다 */
function canvasOf(bitmap: ImageBitmap): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = FILL_IMAGE.width;
  canvas.height = FILL_IMAGE.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('그림을 만들 수 없습니다.');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return { canvas, context };
}

/**
 * 평면마다 그림을 찍고 구멍을 칠해 JPEG base64로 돌려준다.
 * 방 스플랫의 편집(옮긴 원래 가구 숨기기)은 켠 채로 찍고, 가상 가구·조각·표시는 숨긴다.
 */
export async function captureFillPlanes(engine: CaptureEngine, planes: FillPlane[]): Promise<string[]> {
  const shots = await captureFixedViews(engine, planes.map(planeView), { px: FILL_IMAGE.width, pxHeight: FILL_IMAGE.height, keepEdits: true, quality: 0.92, settleMs: 1500 });
  const out: string[] = [];
  for (let i = 0; i < shots.length; i += 1) {
    const bitmap = await toBitmap('image/jpeg', shots[i]);
    const { canvas, context } = canvasOf(bitmap);
    bitmap.close();
    context.fillStyle = MASK_COLOR;
    context.fillRect(...holeRect(planes[i]));
    out.push(canvas.toDataURL('image/jpeg', 0.9).replace(/^data:image\/jpeg;base64,/, ''));
  }
  return out;
}

/** base64 그림 → FILL_IMAGE 크기의 RGBA 픽셀 */
async function pixelsOf(mimeType: string, base64: string): Promise<Uint8ClampedArray> {
  const bitmap = await toBitmap(mimeType, base64);
  const { context } = canvasOf(bitmap);
  bitmap.close();
  return context.getImageData(0, 0, FILL_IMAGE.width, FILL_IMAGE.height).data;
}

/**
 * AI가 채운 그림들로 구멍 자리에 납작한 스플랫을 깔아 SPZ로 묶는다. 좌표는 원래 가구 좌표(가운데 원점, 회전 0°).
 * 채운 부분은 둘레의 원래 그림과 밝기·색이 이어지게 고치고(blendFill), 구멍 둘레에 더 까는 부분은 원래 그림 색을 쓴다.
 * @param images planes와 같은 순서의 AI 그림
 * @param originals planes와 같은 순서의 칠한 그림 (captureFillPlanes, 구멍 밖은 찍은 그대로)
 */
export async function buildFillPiece(
  planes: FillPlane[],
  images: { mimeType: string; data: string }[],
  originals: string[],
  f: Fixture,
  polygon: Point2[],
): Promise<{ bytes: Uint8Array; count: number }> {
  const out = new PackedSplats();
  const frame = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (-f.rotationDeg * Math.PI) / 180);
  const color = new THREE.Color();
  const center = new THREE.Vector3();
  for (let i = 0; i < planes.length; i += 1) {
    const plane = planes[i];
    const [ai, original] = await Promise.all([pixelsOf(images[i].mimeType, images[i].data), pixelsOf('image/jpeg', originals[i])]);
    const pixels = blendFill(ai, original, FILL_IMAGE.width, FILL_IMAGE.height, holeRect(plane), (px, py) => planeSurfaceAt(plane, px, py, polygon));
    const n = new THREE.Vector3(...(plane.n ?? [0, 1, 0]));
    const roomQuaternion = plane.kind === 'floor' ? new THREE.Quaternion() : new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), n);
    const quaternion = roomQuaternion.clone().premultiply(frame);
    const flat = STEP * 0.75;
    const scales = plane.kind === 'floor' ? new THREE.Vector3(flat, 0.0006, flat) : new THREE.Vector3(0.0006, flat, flat);
    const { u0, u1, v0, v1 } = plane.hole;
    // 벽은 바닥 아래로는 깔지 않는다
    for (let u = u0 - SPREAD; u <= u1 + SPREAD; u += STEP) {
      for (let v = v0 - (plane.kind === 'floor' ? SPREAD : 0); v <= v1 + SPREAD; v += STEP) {
        const [px, py] = planePixel(plane, u, v);
        // 방 밖·벽 끝 너머에는 깔지 않는다 (그림에는 옆 벽·빈 곳이 찍혀 있다)
        if (!planeSurfaceAt(plane, px, py, polygon, 0)) continue;
        const k = (Math.min(FILL_IMAGE.height - 1, Math.max(0, Math.round(py))) * FILL_IMAGE.width + Math.min(FILL_IMAGE.width - 1, Math.max(0, Math.round(px)))) * 4;
        color.setRGB(pixels[k] / 255, pixels[k + 1] / 255, pixels[k + 2] / 255);
        const [x, y, z] = planePoint(plane, u, v);
        const lift = plane.kind === 'floor' ? LIFT.floor : LIFT.wall;
        const room = plane.kind === 'floor' ? [x, lift, z] : [x + n.x * lift, y, z + n.z * lift];
        const [lx, lz] = toPieceFrame(f, room[0], room[2]);
        center.set(lx, room[1], lz);
        out.pushSplat(center, scales, quaternion, 1, color);
      }
    }
  }
  const { fileBytes } = await writeSpz(out);
  const count = out.numSplats;
  out.dispose();
  return { bytes: fileBytes, count };
}

export type FillOutcome = { ok: true; images: { mimeType: string; data: string }[]; remaining: number } | { ok: false; message: string };

/** 칠한 그림들을 보내 AI가 채운 그림을 받는다 */
export async function requestFill(roomId: string, fixtureId: string, planes: FillPlane[], masked: string[]): Promise<FillOutcome> {
  try {
    const res = await fetch(`/api/rooms/${roomId}/fixture-fill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixtureId, images: planes.map((p, i) => ({ kind: p.kind, data: masked[i] })) }),
    });
    const body = (await res.json().catch(() => null)) as { images?: { mimeType: string; data: string }[]; remaining?: number; error?: { message?: string } } | null;
    if (!res.ok || !body?.images || body.images.length !== planes.length) return { ok: false, message: body?.error?.message ?? 'AI가 빈자리를 채우지 못했습니다. 잠시 뒤에 다시 해 주세요.' };
    return { ok: true, images: body.images, remaining: body.remaining ?? 0 };
  } catch {
    return { ok: false, message: 'AI가 빈자리를 채우지 못했습니다. 잠시 뒤에 다시 해 주세요.' };
  }
}
