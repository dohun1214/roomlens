// 3D 뷰어의 화질·속도 설정. 기기에 따라 기본값을 고르고, 주소의 값으로 바꿔 볼 수 있다.
//   ?lod=800000  한 화면에 그리는 스플랫 수 (LOD 예산)
//   ?pr=1.25     화면 배율 상한 (devicePixelRatio를 이 값까지만 쓴다)
//   ?lrs=2       LOD 스플랫의 최소 화면 크기(px). 크게 하면 아주 작은 스플랫을 그리지 않는다
//   ?sort=200    정렬 사이의 최소 간격(ms). 화면이 움직일 때 정렬(GPU에서 읽어 오기)을 덜 자주 한다
//   ?fov=off     보는 방향 쪽만 세밀하게 그리는 기능을 끈다. 제자리에서 돌릴 때 LOD가 다시 골라지지 않는다
// 파일은 그대로 두고 그리는 양만 줄이므로, 같은 방을 데스크톱에서는 선명하게 폰에서는 가볍게 볼 수 있다.

export type ViewerQuality = {
  /** 한 화면에 그리는 스플랫 수. undefined면 Spark 기본값(데스크톱 250만) */
  lodSplatCount: number | undefined;
  pixelRatioCap: number;
  lodRenderScale: number;
  /** 정렬 사이의 최소 간격(ms). 0이면 화면이 바뀔 때마다 정렬 */
  minSortIntervalMs: number;
  /** 보는 방향 쪽을 더 세밀하게(뒤쪽은 거칠게) 그릴지 */
  foveation: boolean;
};

export const DESKTOP_QUALITY: ViewerQuality = {
  lodSplatCount: undefined,
  pixelRatioCap: 1.5,
  lodRenderScale: 1,
  minSortIntervalMs: 0,
  foveation: true,
};

// iPhone 15 Pro 실측(10/5): 200만 스플랫 방에서 Spark 기본값(iOS 150만)이면 돌릴 때 20FPS대,
// 100만까지만 그리면 30~40FPS. 폰은 화면이 작아 배율을 조금 낮춰도 티가 덜 난다.
// 시야 집중을 끄거나 50만 개로 줄이면 빨라지지만 화질이 눈에 띄게 나빠져 쓰지 않는다.
export const MOBILE_QUALITY: ViewerQuality = {
  lodSplatCount: 800_000,
  pixelRatioCap: 1.25,
  lodRenderScale: 1,
  // 화면을 돌릴 때마다 정렬하면 30FPS까지 떨어졌다. 0.2초 간격으로 줄이면 60FPS 유지 (iPhone 15 Pro, 10/5)
  minSortIntervalMs: 200,
  foveation: true,
};

export const QUALITY_LIMITS = {
  lod: [100_000, 5_000_000],
  pr: [0.5, 3],
  lrs: [1, 5],
  sort: [0, 1000],
} as const;

/** 범위 안의 숫자면 그 값, 아니면 undefined */
function numberParam(params: URLSearchParams, name: keyof typeof QUALITY_LIMITS): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  const [min, max] = QUALITY_LIMITS[name];
  return Math.min(max, Math.max(min, value));
}

export function resolveViewerQuality(isMobile: boolean, params: URLSearchParams): ViewerQuality {
  const base = isMobile ? MOBILE_QUALITY : DESKTOP_QUALITY;
  const lod = numberParam(params, 'lod');
  const fov = params.get('fov');
  return {
    lodSplatCount: lod === undefined ? base.lodSplatCount : Math.round(lod),
    pixelRatioCap: numberParam(params, 'pr') ?? base.pixelRatioCap,
    lodRenderScale: numberParam(params, 'lrs') ?? base.lodRenderScale,
    minSortIntervalMs: numberParam(params, 'sort') ?? base.minSortIntervalMs,
    foveation: fov === 'off' ? false : fov === 'on' ? true : base.foveation,
  };
}
