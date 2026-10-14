// 가구 밑에 까는 부드러운 그림자. 실사 모델이 바닥에서 떠 보이지 않게 한다.
// 실제 그림자 계산(shadow map)은 스플랫 바닥에 드리울 수 없고 폰에서 무거우므로,
// 가구 바닥 크기보다 조금 큰 판에 가장자리가 흐려지는 사각형 그림을 붙인다.
import * as THREE from 'three';

/** 그림자 판이 가구 바닥보다 사방으로 이만큼 크다 (m) */
export const SHADOW_SPREAD = 0.12;
/** 그림자 그림의 한 변 (px) */
const SIZE = 64;
/** 그림 가장자리부터 이만큼은 비운다 (0~0.5, 그림 크기에 대한 비율) */
const INSET = 0.08;
/** 흐려지는 폭 (그림 크기에 대한 비율) */
const SOFT = 0.22;

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * 그림 위 한 점(u, v는 0~1)의 진하기 (0~1). 가운데는 1, 가장자리로 갈수록 부드럽게 0이 된다.
 * 모서리는 둥글게 흐려지도록 사각형까지의 거리로 잰다.
 */
export function shadowAlpha(u: number, v: number): number {
  const inner = 0.5 - INSET - SOFT; // 진하기가 1인 사각형의 반 너비
  const dx = Math.max(0, Math.abs(u - 0.5) - inner);
  const dy = Math.max(0, Math.abs(v - 0.5) - inner);
  return 1 - smoothstep(0, SOFT, Math.hypot(dx, dy));
}

/** 그림자 텍스처 (검은색, 진하기는 알파). 가구마다 함께 쓴다 */
export function makeShadowTexture(): THREE.DataTexture {
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const i = (y * SIZE + x) * 4;
      data[i + 3] = Math.round(255 * shadowAlpha((x + 0.5) / SIZE, (y + 0.5) / SIZE));
    }
  }
  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** 가구 바닥(가로 w, 깊이 d)에 맞춘 그림자 판의 크기 */
export function shadowSize(w: number, d: number): [number, number] {
  return [w + SHADOW_SPREAD * 2, d + SHADOW_SPREAD * 2];
}
