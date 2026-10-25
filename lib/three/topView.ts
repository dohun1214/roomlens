// 방을 바로 위에서 내려다본 그림(평면도처럼 보인다)을 칸마다 정사각형 JPEG로 캡처한다. 원래 가구 찾기에서 Gemini에 보낸다.
// 카메라를 아주 높이 두고 시야를 좁혀 원근을 거의 없애고, near 평면으로 천장·조명을 잘라 낸다.
// 그림 크기를 기기와 상관없이 맞추려고 캡처하는 동안만 그리는 크기를 정사각형으로 바꾼다 (화면 모양은 그대로).
// 브라우저 전용 (canvas).
import { Vector2 } from 'three';
import { BLANK_BASE64, canvasToJpegBase64, pauseRoomEdits, wait, type CaptureEngine } from './capture';
import { tileAxes, type TopTile } from '@/lib/ai/fixturesDetect';

export type TopViewOptions = {
  /** 그림 한 변 (px) */
  px: number;
  /** 카메라 높이 (바닥에서, m) */
  height: number;
  /** 바닥에서 이 높이 위는 잘라 낸다 (m) */
  cut: number;
  quality?: number;
  /** 카메라를 옮긴 뒤 스플랫이 그 시점에 맞게 다시 그려지기를 기다리는 시간 */
  settleMs?: number;
  onProgress?: (done: number, total: number) => void;
};

/** 고정된 카메라 하나: 자리·본 곳·위쪽·세로 시야각(°)·near·far (방 좌표) */
export type FixedView = {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fovDeg: number;
  near: number;
  far: number;
};

export type FixedViewOptions = {
  /** 그림 한 변 (px, 정사각형) */
  px: number;
  quality?: number;
  /** 카메라를 옮긴 뒤 스플랫이 그 시점에 맞게 다시 그려지기를 기다리는 시간 */
  settleMs?: number;
  onProgress?: (done: number, total: number) => void;
};

/**
 * 정해 둔 카메라마다 정사각형 그림을 찍는다 (위에서 본 그림, 벽 정면 그림).
 * 끝나면 카메라·그리는 크기·숨긴 것들을 되돌린다.
 */
export async function captureFixedViews(engine: CaptureEngine, views: FixedView[], options: FixedViewOptions): Promise<string[]> {
  const { renderer, scene, camera, controls } = engine;
  const saved = {
    position: camera.position.clone(),
    up: camera.up.clone(),
    target: controls.target.clone(),
    enabled: controls.enabled,
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
    aspect: camera.aspect,
    pixelRatio: renderer.getPixelRatio(),
    size: renderer.getSize(new Vector2()),
  };
  const hidden = scene.children.filter((child) => child !== engine.roomGroup && child !== engine.spark && child.visible && !(child as { isLight?: boolean }).isLight);
  const images: string[] = [];
  controls.enabled = false;
  for (const child of hidden) child.visible = false;
  const resumeEdits = pauseRoomEdits(engine.roomGroup);
  renderer.setPixelRatio(1);
  // 화면(CSS) 크기는 두고 그리는 크기만 바꾼다
  renderer.setSize(options.px, options.px, false);
  camera.aspect = 1;
  try {
    for (let i = 0; i < views.length; i += 1) {
      const view = views[i];
      camera.fov = view.fovDeg;
      camera.near = view.near;
      camera.far = view.far;
      camera.updateProjectionMatrix();
      camera.up.set(...view.up);
      camera.position.set(...view.position);
      controls.target.set(...view.target);
      camera.lookAt(controls.target);
      const settle = async (rounds: number) => {
        for (let round = 0; round < rounds; round += 1) {
          renderer.render(scene, camera);
          await wait(150);
        }
      };
      const grab = () => {
        renderer.render(scene, camera);
        return canvasToJpegBase64(renderer.domElement, options.px, options.quality ?? 0.85);
      };
      await settle(Math.max(1, Math.round((options.settleMs ?? 1500) / 150)));
      let image = grab();
      for (let retry = 0; retry < (i === 0 ? 20 : 4) && image.length < BLANK_BASE64; retry += 1) {
        await settle(2);
        image = grab();
      }
      images.push(image);
      options.onProgress?.(i + 1, views.length);
    }
  } finally {
    resumeEdits();
    for (const child of hidden) child.visible = true;
    renderer.setPixelRatio(saved.pixelRatio);
    renderer.setSize(saved.size.x, saved.size.y, false);
    Object.assign(camera, {
      fov: saved.fov,
      near: saved.near,
      far: saved.far,
      aspect: saved.aspect,
    });
    camera.updateProjectionMatrix();
    camera.up.copy(saved.up);
    camera.position.copy(saved.position);
    controls.target.copy(saved.target);
    controls.enabled = saved.enabled;
    controls.update();
  }
  return images;
}

/** 칸마다 위에서 본 그림을 찍는다. 끝나면 카메라·그리는 크기·숨긴 것들을 되돌린다. 그림 위쪽이 칸의 -down 방향 */
export function captureTopViews(engine: CaptureEngine, tiles: TopTile[], options: TopViewOptions): Promise<string[]> {
  const views = tiles.map((tile): FixedView => {
    const { down } = tileAxes(tile.rotationDeg);
    return {
      position: [tile.center[0], options.height, tile.center[1]],
      target: [tile.center[0], 0, tile.center[1]],
      // 그림의 위쪽이 -down이 되게 (오른쪽은 right)
      up: [-down[0], 0, -down[1]],
      fovDeg: (2 * Math.atan(tile.size / 2 / options.height) * 180) / Math.PI,
      near: options.height - options.cut,
      far: options.height + 0.5,
    };
  });
  return captureFixedViews(engine, views, { px: options.px, quality: options.quality, settleMs: options.settleMs, onProgress: options.onProgress });
}
