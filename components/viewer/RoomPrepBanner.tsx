'use client';

import Icon from '@/components/ui/Icon';
import type { RoomPrep } from './roomPrep';
import { AiBadge, type ToolId } from './workspace';

/**
 * "AI로 방 준비하기"의 진행과 확인 단계. 패널 맨 위에 붙는다.
 * 찾는 동안에는 진행 상황을, 끝나면 "문·창문 확인 → 원래 가구 확인"을 보여 주고 각 도구로 바로 보낸다.
 */
export default function RoomPrepBanner({
  prep,
  active,
  saved,
  hidden = false,
  onSelect,
  onFinish,
  onClose,
}: {
  prep: RoomPrep;
  active: ToolId | null;
  /** 각 도구의 결과를 저장했는지 */
  saved: { openings: boolean; fixtures: boolean };
  /** 폰에서 패널을 접었을 때 */
  hidden?: boolean;
  onSelect: (tool: ToolId) => void;
  /** 다 저장한 뒤 "가구 놓으러 가기": 안내를 닫고 가구 도구로 */
  onFinish?: () => void;
  onClose: () => void;
}) {
  const busy = prep.step !== 'review';
  const steps = [
    { tool: 'openings' as const, label: '문·창문', unit: '개', result: prep.openings },
    { tool: 'fixtures' as const, label: '원래 가구', unit: '개', result: prep.fixtures },
  ];
  const allSaved = saved.openings && saved.fixtures;

  return (
    <div
      className={`mx-3 mt-3 flex shrink-0 flex-col gap-2 rounded-[14px] bg-accent-soft p-3 text-[13px] ${hidden ? 'max-lg:hidden' : ''}`}
      data-testid="prep-banner"
      data-step={prep.step}
    >
      <div className="flex items-center gap-2">
        <AiBadge />
        <span className="min-w-0 flex-1 font-semibold text-accent-strong">
          {prep.step === 'openings' && 'AI가 문·창문을 찾는 중… (1/2)'}
          {prep.step === 'fixtures' && 'AI가 원래 가구를 찾는 중… (2/2)'}
          {prep.step === 'review' && (allSaved ? '방 준비 끝! 이제 가구를 놓아 보세요.' : 'AI가 찾은 것을 확인하고 저장하세요')}
        </span>
        {!busy && (
          <button type="button" className="btn h-7 w-7 shrink-0 rounded-full text-sub hover:bg-surface" onClick={onClose} aria-label="방 준비 닫기" data-testid="prep-close">
            <Icon name="close" />
          </button>
        )}
      </div>
      {busy && <span className="text-body">화면이 잠깐씩 바뀝니다. 끝날 때까지 기다려 주세요 (보통 30초~1분).</span>}
      <div className="flex gap-2">
        {steps.map((step, i) => {
          const done = step.result !== undefined;
          const failed = done && !step.result!.ok;
          const isSaved = done && !failed && saved[step.tool];
          const running = prep.step === step.tool;
          return (
            <button
              key={step.tool}
              type="button"
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-2 text-left ${
                active === step.tool && !busy ? 'bg-surface ring-1 ring-accent-line' : 'bg-surface/60 hover:bg-surface'
              } disabled:cursor-default`}
              disabled={busy || !done}
              onClick={() => onSelect(step.tool)}
              data-testid={`prep-${step.tool}`}
              data-state={running ? 'running' : !done ? 'waiting' : failed ? 'failed' : isSaved ? 'saved' : 'review'}
              data-found={step.result?.found ?? ''}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-xs font-medium ${
                  isSaved ? 'bg-ok-soft text-ok' : failed ? 'bg-warn-soft text-warn' : running ? 'bg-accent text-white' : 'bg-ground text-mute'
                }`}
              >
                {isSaved ? <Icon name="check" /> : i + 1}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-semibold">{step.label}</span>
                <span className="truncate text-xs text-sub">
                  {running ? '찾는 중…' : !done ? '기다리는 중' : failed ? '못 찾음 · 다시 해 보세요' : isSaved ? '저장됨' : `${step.result!.found}${step.unit} · 확인 후 저장`}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {!busy && allSaved && onFinish && (
        <button type="button" className="btn btn-primary h-10 text-[13px]" onClick={onFinish} data-testid="prep-finish">
          가구 놓으러 가기
        </button>
      )}
      {!busy && steps.some((s) => s.result && !s.result.ok && s.result.message) && (
        <span className="text-warn" data-testid="prep-error">
          {steps
            .filter((s) => s.result && !s.result.ok && s.result.message)
            .map((s) => `${s.label}: ${s.result!.message}`)
            .join(' ')}
        </span>
      )}
    </div>
  );
}
