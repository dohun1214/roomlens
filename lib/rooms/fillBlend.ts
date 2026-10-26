// 빈자리 채우기 그림 이어 붙이기 (브라우저·시험 공용, DOM을 쓰지 않는다).
// 그림 AI가 채운 부분은 밝기·색이 둘레와 조금씩 달라 경계선이 보인다. 둘레에서 잰 차이(원래 그림 - AI 그림)를
// 구멍 안쪽으로 부드럽게 퍼뜨려 더한다 (라플라스 방정식, seamless cloning과 같은 생각). 구멍 밖은 원래 그림을 쓴다.

/** 차이를 퍼뜨리는 칸 크기 (px). 작을수록 정확하고 느리다 */
export const BLEND_CELL = 4;
/** 둘레에서 차이를 재는 두께 (칸) */
const RING = 3;
/** 구멍에서 이 거리(px) 안의 픽셀은 둘레로 쓰지 않는다 (JPEG로 칠한 색이 번진다) */
const BLEED = 4;
/** 반복 횟수와 과완화 계수 */
const ITERATIONS = 600;
const OMEGA = 1.9;

export type Rect = [number, number, number, number];

/**
 * @param ai 그림 AI가 채운 그림 (RGBA, width × height)
 * @param original 칠하기 전 찍은 그림 (같은 크기, 구멍 자리는 칠해져 있어도 된다)
 * @param hole 채운 구멍 [x, y, w, h] px
 * @param valid 이 픽셀에 실제 평면이 있는지 (방 밖·벽 끝 너머·바닥 아래는 false → 그쪽 둘레는 쓰지 않는다)
 * @returns 구멍 안은 AI 그림 + 퍼뜨린 차이, 밖은 원래 그림인 새 RGBA
 */
export function blendFill(ai: Uint8ClampedArray, original: Uint8ClampedArray, width: number, height: number, hole: Rect, valid: (px: number, py: number) => boolean = () => true): Uint8ClampedArray {
  const out = new Uint8ClampedArray(original);
  const x0 = Math.max(0, Math.floor(hole[0]));
  const y0 = Math.max(0, Math.floor(hole[1]));
  const x1 = Math.min(width, Math.ceil(hole[0] + hole[2]));
  const y1 = Math.min(height, Math.ceil(hole[1] + hole[3]));
  if (x1 <= x0 || y1 <= y0) return out;

  // 구멍 + 둘레 RING칸을 BLEND_CELL 칸으로 나눈다
  const gx0 = Math.floor(x0 / BLEND_CELL) - RING;
  const gy0 = Math.floor(y0 / BLEND_CELL) - RING;
  const gx1 = Math.ceil(x1 / BLEND_CELL) + RING;
  const gy1 = Math.ceil(y1 / BLEND_CELL) + RING;
  const gw = gx1 - gx0;
  const gh = gy1 - gy0;
  const cells = gw * gh;
  // 0: 쓰지 않음(평면 밖), 1: 둘레(값을 앎), 2: 구멍(풀 값)
  const kind = new Uint8Array(cells);
  const value = new Float32Array(cells * 3);
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      const c = gy * gw + gx;
      const px0 = (gx + gx0) * BLEND_CELL;
      const py0 = (gy + gy0) * BLEND_CELL;
      const cx = px0 + BLEND_CELL / 2;
      const cy = py0 + BLEND_CELL / 2;
      if (cx < 0 || cy < 0 || cx >= width || cy >= height || !valid(cx, cy)) continue;
      const inHole = cx >= x0 && cx < x1 && cy >= y0 && cy < y1;
      if (inHole) {
        kind[c] = 2;
        continue;
      }
      // 둘레: 칸 안의 구멍 밖 픽셀로 차이의 평균
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let py = Math.max(0, py0); py < Math.min(height, py0 + BLEND_CELL); py += 1) {
        for (let px = Math.max(0, px0); px < Math.min(width, px0 + BLEND_CELL); px += 1) {
          if (px >= x0 - BLEED && px < x1 + BLEED && py >= y0 - BLEED && py < y1 + BLEED) continue;
          const k = (py * width + px) * 4;
          r += original[k] - ai[k];
          g += original[k + 1] - ai[k + 1];
          b += original[k + 2] - ai[k + 2];
          count += 1;
        }
      }
      if (count === 0) {
        // 번진 띠 안의 칸: 값을 모르는 칸으로 두고 함께 푼다 (구멍과 둘레를 잇는다)
        kind[c] = 2;
        continue;
      }
      kind[c] = 1;
      value[c * 3] = r / count;
      value[c * 3 + 1] = g / count;
      value[c * 3 + 2] = b / count;
    }
  }
  // 둘레 평균으로 시작해 구멍 칸을 이웃 평균으로 (쓰지 않는 칸 쪽은 경계가 없는 것으로 본다)
  const mean = [0, 0, 0];
  let known = 0;
  for (let c = 0; c < cells; c += 1) {
    if (kind[c] !== 1) continue;
    for (let ch = 0; ch < 3; ch += 1) mean[ch] += value[c * 3 + ch];
    known += 1;
  }
  if (known === 0) {
    // 둘레가 없으면 고칠 기준이 없다: AI 그림을 그대로
    copyHole(out, ai, width, x0, y0, x1, y1);
    return out;
  }
  for (let c = 0; c < cells; c += 1) if (kind[c] === 2) for (let ch = 0; ch < 3; ch += 1) value[c * 3 + ch] = mean[ch] / known;
  const near = [-1, 1, -gw, gw];
  for (let it = 0; it < ITERATIONS; it += 1) {
    for (let c = 0; c < cells; c += 1) {
      if (kind[c] !== 2) continue;
      const gx = c % gw;
      let sum0 = 0;
      let sum1 = 0;
      let sum2 = 0;
      let count = 0;
      for (let k = 0; k < 4; k += 1) {
        if ((k === 0 && gx === 0) || (k === 1 && gx === gw - 1)) continue;
        const o = c + near[k];
        if (o < 0 || o >= cells || kind[o] === 0) continue;
        sum0 += value[o * 3];
        sum1 += value[o * 3 + 1];
        sum2 += value[o * 3 + 2];
        count += 1;
      }
      if (count === 0) continue;
      value[c * 3] += OMEGA * (sum0 / count - value[c * 3]);
      value[c * 3 + 1] += OMEGA * (sum1 / count - value[c * 3 + 1]);
      value[c * 3 + 2] += OMEGA * (sum2 / count - value[c * 3 + 2]);
    }
  }
  // 구멍 픽셀: AI 그림 + 칸 값(이웃 칸과 겹선형으로)
  const sample = (fx: number, fy: number, ch: number) => {
    const gx = Math.min(gw - 1, Math.max(0, fx));
    const gy = Math.min(gh - 1, Math.max(0, fy));
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const tx = gx - ix;
    const ty = gy - iy;
    const at = (x: number, y: number) => {
      const c = Math.min(gh - 1, y) * gw + Math.min(gw - 1, x);
      // 쓰지 않는 칸은 이 칸 값으로 대신한다
      return kind[c] === 0 ? NaN : value[c * 3 + ch];
    };
    const v00 = at(ix, iy);
    const v10 = at(ix + 1, iy);
    const v01 = at(ix, iy + 1);
    const v11 = at(ix + 1, iy + 1);
    const vals = [
      [v00, (1 - tx) * (1 - ty)],
      [v10, tx * (1 - ty)],
      [v01, (1 - tx) * ty],
      [v11, tx * ty],
    ];
    let s = 0;
    let w = 0;
    for (const [v, k] of vals) {
      if (Number.isNaN(v)) continue;
      s += v * k;
      w += k;
    }
    return w > 0 ? s / w : 0;
  };
  for (let py = y0; py < y1; py += 1) {
    const fy = (py + 0.5) / BLEND_CELL - gy0 - 0.5;
    for (let px = x0; px < x1; px += 1) {
      const fx = (px + 0.5) / BLEND_CELL - gx0 - 0.5;
      const k = (py * width + px) * 4;
      for (let ch = 0; ch < 3; ch += 1) out[k + ch] = ai[k + ch] + sample(fx, fy, ch);
      out[k + 3] = 255;
    }
  }
  return out;
}

function copyHole(out: Uint8ClampedArray, ai: Uint8ClampedArray, width: number, x0: number, y0: number, x1: number, y1: number) {
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const k = (py * width + px) * 4;
      out[k] = ai[k];
      out[k + 1] = ai[k + 1];
      out[k + 2] = ai[k + 2];
      out[k + 3] = 255;
    }
  }
}
