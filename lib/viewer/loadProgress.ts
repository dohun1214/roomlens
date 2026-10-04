// 3D 파일 로딩 진행 상태. 로딩은 두 단계다:
//   1) 받기(download): 파일을 내려받는다. 진행률(%)을 알 수 있다
//   2) 준비(prepare): 받은 파일을 풀고 LOD를 만든다. 진행률을 알 수 없다 (폰에서는 이 단계가 길다)

export type LoadProgress = {
  phase: 'download' | 'prepare';
  /** 받기 단계의 진행률 0~100. 크기를 모르면 null */
  percent: number | null;
};

/** 내려받기 이벤트(loaded/total)를 진행 상태로 바꾼다 */
export function progressFromBytes(loaded: number, total: number): LoadProgress {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(loaded) || loaded < 0) {
    return { phase: 'download', percent: null };
  }
  const percent = Math.min(100, Math.floor((loaded / total) * 100));
  return percent >= 100 ? { phase: 'prepare', percent: 100 } : { phase: 'download', percent };
}

/** 화면에 보여줄 문구 */
export function loadingLabel(progress: LoadProgress): string {
  if (progress.phase === 'prepare') return '3D 준비 중…';
  return progress.percent === null ? '3D 파일 받는 중…' : `3D 파일 받는 중… ${progress.percent}%`;
}

/** 진행 막대 값(0~100). 준비 단계는 받기를 다 끝낸 것이므로 100 */
export function loadingBarValue(progress: LoadProgress): number | undefined {
  if (progress.phase === 'prepare') return 100;
  return progress.percent ?? undefined;
}
