/**
 * 가우시안 스플랫에서 "광선이 처음 닿는 표면"의 깊이를 구한다.
 *
 * Spark의 SplatMesh.raycast는 스플랫을 작은 타원체로 보고 교차만 검사해서, 얇고 넓은 스플랫으로
 * 이루어진 바닥·벽에서는 빗나가거나 수십 cm 어긋난다(실측). 여기서는 렌더링과 같은 방식으로
 * 광선 위에서 각 가우시안의 기여도를 앞에서부터 합성해, 누적 불투명도가 절반을 넘는 깊이를 고른다.
 */

export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

/** 스플랫 하나를 방문할 때마다 부르는 함수. 인자로 받은 객체는 호출이 끝나면 재사용될 수 있다. */
export type SplatVisitor = (center: Vec3, scales: Vec3, quaternion: Quat, opacity: number) => void;

export type SurfacePickOptions = {
  /** 이 거리보다 가까운 스플랫은 무시 (카메라 바로 앞의 떠다니는 조각 제외) */
  near?: number;
  far?: number;
  /** 누적 불투명도가 이 값보다 작으면 표면이 없다고 본다 */
  minCoverage?: number;
  /** 축 길이의 하한 (0에 가까운 납작한 스플랫의 나눗셈 보호) */
  minScale?: number;
  profile?: boolean;
};

export type SurfacePick = {
  /** 광선 원점에서 표면까지의 거리 (direction이 단위 벡터일 때) */
  distance: number;
  /** 광선 전체에서 누적된 불투명도 (0~1) */
  coverage: number;
  /** 계산에 쓰인 스플랫 수 */
  contributors: number;
  /** options.profile 일 때만: 깊이순 [깊이, 가중치] 목록 (분석용) */
  profile?: [number, number][];
};

/**
 * LOD로 그릴 때 "지금 그리는 스플랫"의 번호 목록에서 쓸 수 있는 번호인지.
 * Spark가 목록을 바꾸는 사이에는 그리는 수(count)만 먼저 늘고 목록 끝이 0으로 남아 있을 때가 있다(실측: 그리는 수가
 * 상한에 닿은 큰 장면에서 화면을 돌린 직후 몇 초). 0번은 LOD 트리의 뿌리, 곧 장면 전체를 뭉친 아주 큰 스플랫이라
 * 이것을 표면으로 보면 탭한 점이 방 한가운데 허공에 찍힌다. 뿌리 하나만 그리는 경우가 아니면 0번은 건너뛴다.
 */
export function isRenderedLodIndex(index: number, count: number): boolean {
  return index !== 0 || count === 1;
}

const CUTOFF_SIGMA = 3;
const MIN_WEIGHT = 1 / 255;
const MAX_ALPHA = 0.99;
/** 한 층으로 묶는 깊이 범위 (깊이 대비 비율) */
const LAYER_REL = 0.02;
/** 층으로 인정하는 최소 기여도와, 가장 강한 층 대비 최소 비율 */
const MIN_LAYER_SHARE = 0.05;
const LAYER_RATIO = 0.15;

/**
 * @param forEachSplat 스플랫을 차례로 넘겨주는 함수 (광선과 같은 좌표계)
 * @param origin 광선 원점
 * @param direction 광선 방향 (단위 벡터)
 */
export function pickSurfaceAlongRay(
  forEachSplat: (visit: SplatVisitor) => void,
  origin: Vec3,
  direction: Vec3,
  options: SurfacePickOptions = {},
): SurfacePick | null {
  const near = options.near ?? 0;
  const far = options.far ?? Infinity;
  const minCoverage = options.minCoverage ?? 0.2;
  const minScale = options.minScale ?? 1e-6;
  const { x: ox, y: oy, z: oz } = origin;
  const { x: dx, y: dy, z: dz } = direction;

  const depths: number[] = [];
  const weights: number[] = [];

  forEachSplat((c, s, q, opacity) => {
    if (opacity < MIN_WEIGHT) return;
    const vx = c.x - ox;
    const vy = c.y - oy;
    const vz = c.z - oz;

    // 1) 빠른 걸러내기: 광선에서 3σ(가장 긴 축 기준)보다 멀면 제외
    const along = vx * dx + vy * dy + vz * dz;
    const maxScale = Math.max(s.x, s.y, s.z);
    const reach = CUTOFF_SIGMA * maxScale;
    if (along < near - reach || along > far + reach) return;
    const perp2 = vx * vx + vy * vy + vz * vz - along * along;
    if (perp2 > reach * reach) return;

    // 2) 스플랫 좌표계로 회전(q의 역회전)한 뒤 축 길이로 나눈다 → 단위 구 가우시안
    const { x: qx, y: qy, z: qz, w: qw } = q;
    const ax = rotInvX(vx, vy, vz, qx, qy, qz, qw) / Math.max(s.x, minScale);
    const ay = rotInvY(vx, vy, vz, qx, qy, qz, qw) / Math.max(s.y, minScale);
    const az = rotInvZ(vx, vy, vz, qx, qy, qz, qw) / Math.max(s.z, minScale);
    const bx = rotInvX(dx, dy, dz, qx, qy, qz, qw) / Math.max(s.x, minScale);
    const by = rotInvY(dx, dy, dz, qx, qy, qz, qw) / Math.max(s.y, minScale);
    const bz = rotInvZ(dx, dy, dz, qx, qy, qz, qw) / Math.max(s.z, minScale);

    // 3) 광선 위에서 밀도가 최대인 지점 t와 그때의 지수
    const bb = bx * bx + by * by + bz * bz;
    if (bb === 0) return;
    const ab = ax * bx + ay * by + az * bz;
    const t = ab / bb;
    if (t < near || t > far) return;
    const power = -0.5 * (ax * ax + ay * ay + az * az - (ab * ab) / bb);
    if (power < -0.5 * CUTOFF_SIGMA * CUTOFF_SIGMA) return;
    const weight = Math.min(opacity, 1) * Math.exp(power);
    if (weight < MIN_WEIGHT) return;

    depths.push(t);
    weights.push(weight);
  });

  if (depths.length === 0) return null;

  // 4) 앞에서부터 알파 합성: 각 스플랫이 화면 색에 기여하는 몫(T·α)
  const order = depths.map((_, i) => i).sort((i, j) => depths[i] - depths[j]);
  const depth: number[] = [];
  const share: number[] = [];
  let transmittance = 1;
  let coverage = 0;
  for (const i of order) {
    const alpha = Math.min(weights[i], MAX_ALPHA);
    depth.push(depths[i]);
    share.push(transmittance * alpha);
    coverage += transmittance * alpha;
    transmittance *= 1 - alpha;
    if (transmittance < 1e-3) break;
  }
  if (coverage < minCoverage) return null;

  // 5) 깊이가 비슷한(±LAYER_REL) 기여를 한 "층"으로 묶어, 앞에서부터 처음 나오는 뚜렷한 층을 고른다.
  //    누적 불투명도 50% 지점(중앙값 깊이)을 쓰면 광택 있는 바닥에서 바닥 아래에 맺힌
  //    반사 스플랫 쪽으로 수십 cm~1m씩 밀린다(실측). 반대로 맨 앞의 기여를 그대로 쓰면
  //    옅은 부유 조각에 걸린다. 그래서 "가장 강한 층의 일정 비율 이상"인 첫 층을 쓴다.
  const layerSum: number[] = new Array(depth.length).fill(0);
  let end = 0;
  let running = 0;
  for (let start = 0; start < depth.length; start += 1) {
    while (end < depth.length && depth[end] <= depth[start] * (1 + LAYER_REL)) {
      running += share[end];
      end += 1;
    }
    layerSum[start] = running;
    running -= share[start];
  }
  const strongest = Math.max(...layerSum);
  const threshold = Math.max(MIN_LAYER_SHARE, LAYER_RATIO * strongest);
  const first = layerSum.findIndex((v) => v >= threshold);
  if (first < 0) return null;

  // 그 층 안에서 기여도로 가중 평균한 깊이
  let sum = 0;
  let weighted = 0;
  for (let i = first; i < depth.length && depth[i] <= depth[first] * (1 + LAYER_REL); i += 1) {
    sum += share[i];
    weighted += share[i] * depth[i];
  }
  const profile = options.profile ? depth.map((d, i): [number, number] => [d, share[i]]) : undefined;
  return { distance: weighted / sum, coverage, contributors: depths.length, profile };
}

// 벡터 v를 쿼터니언 q의 역회전으로 돌린 결과의 각 성분 (q는 단위 쿼터니언)
function rotInvX(vx: number, vy: number, vz: number, qx: number, qy: number, qz: number, qw: number) {
  return (
    (1 - 2 * (qy * qy + qz * qz)) * vx + 2 * (qx * qy + qw * qz) * vy + 2 * (qx * qz - qw * qy) * vz
  );
}
function rotInvY(vx: number, vy: number, vz: number, qx: number, qy: number, qz: number, qw: number) {
  return (
    2 * (qx * qy - qw * qz) * vx + (1 - 2 * (qx * qx + qz * qz)) * vy + 2 * (qy * qz + qw * qx) * vz
  );
}
function rotInvZ(vx: number, vy: number, vz: number, qx: number, qy: number, qz: number, qw: number) {
  return (
    2 * (qx * qz + qw * qy) * vx + 2 * (qy * qz - qw * qx) * vy + (1 - 2 * (qx * qx + qy * qy)) * vz
  );
}
