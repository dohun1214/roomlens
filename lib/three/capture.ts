// 3D 화면을 여러 시점에서 그림(JPEG)으로 캡처한다. 방 분석에서 사진 대신 Gemini에 보낸다.
// 브라우저 전용 (canvas).
import type * as THREE from 'three';
import type { CaptureView } from '@/lib/ai/analysis';

/** 뷰어의 three.js 객체 가운데 캡처에 필요한 것 */
export type CaptureEngine = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: { target: THREE.Vector3; enabled: boolean; update: () => void };
  /** 스플랫이 들어 있는 그룹과 스플랫 렌더러. 이 둘만 그림에 남긴다 */
  roomGroup: THREE.Object3D;
  spark: THREE.Object3D;
};

/**
 * ms만큼 기다린다. 탭이 뒤에 있으면 브라우저가 setTimeout을 1초~1분에 한 번으로 늦추므로
 * (그대로 두면 캡처 한 장에 몇 분이 걸린다), 그때는 늦춰지지 않는 MessageChannel로 시간을 잰다.
 */
function wait(ms: number): Promise<void> {
  if (typeof document === 'undefined' || !document.hidden) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve) => {
    const until = performance.now() + ms;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      if (performance.now() >= until) {
        channel.port1.close();
        resolve();
      } else {
        channel.port2.postMessage(null);
      }
    };
    channel.port2.postMessage(null);
  });
}

/** 캡처한 JPEG의 base64가 이보다 짧으면 "거의 빈 그림"으로 본다 (한 가지 색뿐인 1024px 그림이 약 4~8KB) */
const BLANK_BASE64 = 12_000;

/** canvas를 긴 변 longSide 이하의 JPEG로 줄여 base64(머리말 없이)로 돌려준다 */
export function canvasToJpegBase64(source: HTMLCanvasElement | ImageBitmap, longSide: number, quality: number): string {
  const scale = Math.min(1, longSide / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('그림을 만들 수 없습니다.');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality).replace(/^data:image\/jpeg;base64,/, '');
}

/**
 * 시점마다 카메라를 옮겨 캡처한다. 끝나면 카메라와 숨긴 것들을 되돌린다.
 * 가상 가구·문·창문 표시·격자 같은 것은 숨기고 방(스플랫)만 남긴다.
 * @param settleMs 카메라를 옮긴 뒤 스플랫이 그 시점에 맞게 다시 그려지기를 기다리는 시간
 */
export async function captureViews(
  engine: CaptureEngine,
  views: CaptureView[],
  options: { longSide: number; quality?: number; settleMs?: number; onProgress?: (done: number, total: number) => void },
): Promise<string[]> {
  const { renderer, scene, camera, controls } = engine;
  const saved = { position: camera.position.clone(), target: controls.target.clone(), enabled: controls.enabled };
  const hidden = scene.children.filter((child) => child !== engine.roomGroup && child !== engine.spark && child.visible && !(child as THREE.Light).isLight);
  const images: string[] = [];
  controls.enabled = false;
  for (const child of hidden) child.visible = false;
  try {
    for (let i = 0; i < views.length; i += 1) {
      camera.position.set(...views[i].position);
      controls.target.set(...views[i].target);
      controls.update();
      // 스플랫의 세밀도·정렬은 그릴 때마다 조금씩 맞춰지므로, 기다리는 동안 몇 번 그린다
      // (탭이 뒤에 있어 화면 갱신이 멈춘 경우에도 캡처되게 직접 그린다)
      const settle = async (rounds: number) => {
        for (let round = 0; round < rounds; round += 1) {
          renderer.render(scene, camera);
          await wait(150);
        }
      };
      const grab = () => {
        // 그린 직후 같은 흐름에서 읽어야 내용이 남아 있다
        renderer.render(scene, camera);
        return canvasToJpegBase64(renderer.domElement, options.longSide, options.quality ?? 0.78);
      };
      await settle(Math.max(1, Math.round((options.settleMs ?? 900) / 150)));
      let image = grab();
      // 거의 빈 그림이면 스플랫이 아직 그려지지 않은 것이다 (탭이 뒤에 있다가 처음 그릴 때 몇 초 걸린다).
      // 조금 더 기다렸다가 다시 찍는다. 첫 장은 최대 6초, 그다음부터는 1.2초까지
      for (let retry = 0; retry < (i === 0 ? 20 : 4) && image.length < BLANK_BASE64; retry += 1) {
        await settle(2);
        image = grab();
      }
      images.push(image);
      options.onProgress?.(i + 1, views.length);
    }
  } finally {
    for (const child of hidden) child.visible = true;
    camera.position.copy(saved.position);
    controls.target.copy(saved.target);
    controls.enabled = saved.enabled;
    controls.update();
  }
  return images;
}

/** 사용자가 고른 사진 파일을 줄여 JPEG base64로 만든다. 그림이 아니면 null */
export async function photoToJpegBase64(file: File, longSide: number, maxLength: number): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    for (const quality of [0.8, 0.65, 0.5]) {
      const data = canvasToJpegBase64(bitmap, longSide, quality);
      if (data.length <= maxLength) return data;
    }
    return canvasToJpegBase64(bitmap, Math.round(longSide * 0.6), 0.5);
  } finally {
    bitmap.close();
  }
}
