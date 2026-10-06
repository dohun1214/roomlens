'use client';

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Icon, { type IconName } from '@/components/ui/Icon';

/** 방 화면의 도구. 왼쪽 도구 줄(폰은 아래 탭)에서 하나를 고르면 그 도구의 패널만 보인다 */
export type ToolId = 'furniture' | 'openings' | 'calibration' | 'analysis';

export const TOOLS: { id: ToolId; label: string; icon: IconName; testId: string }[] = [
  { id: 'furniture', label: '가구', icon: 'sofa', testId: 'tool-furniture' },
  { id: 'openings', label: '문·창문', icon: 'door', testId: 'openings-toggle' },
  { id: 'calibration', label: '크기 보정', icon: 'ruler', testId: 'calibration-toggle' },
  { id: 'analysis', label: '방 분석', icon: 'report', testId: 'analysis-toggle' },
];

/**
 * 도구들이 자기 화면을 그려 넣을 자리.
 * panel: 패널 안쪽, stage: 3D 화면 위, active: 지금 고른 도구
 */
export type Slots = { panel: HTMLElement | null; stage: HTMLElement | null; active: ToolId | null };

/** 도구 줄: 넓은 화면에서는 왼쪽에 세로로, 좁은 화면에서는 아래 탭으로 */
export function ToolRail({
  tools,
  active,
  onSelect,
  marks = {},
}: {
  tools: ToolId[];
  active: ToolId | null;
  onSelect: (tool: ToolId) => void;
  /** 도구 이름 옆에 붙일 작은 점 (저장하지 않은 것이 있을 때 등) */
  marks?: Partial<Record<ToolId, 'warn' | 'ok'>>;
}) {
  return (
    <nav
      aria-label="도구"
      className="order-3 flex shrink-0 gap-1 border-t border-line bg-surface px-2 py-1 lg:order-1 lg:w-[72px] lg:flex-col lg:gap-1.5 lg:rounded-2xl lg:border-0 lg:p-2 lg:shadow-panel"
      data-testid="tool-rail"
      data-active={active ?? ''}
    >
      {TOOLS.filter((tool) => tools.includes(tool.id)).map((tool) => {
        const on = tool.id === active;
        return (
          <button
            key={tool.id}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(tool.id)}
            data-testid={tool.testId}
            data-mark={marks[tool.id] ?? ''}
            className={`relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] lg:h-[60px] lg:flex-none lg:gap-1 ${
              on ? 'bg-accent-soft font-bold text-accent-strong' : 'font-medium text-sub hover:bg-soft hover:text-ink'
            }`}
          >
            <Icon name={tool.icon} size={22} />
            {tool.label}
            {marks[tool.id] && (
              <span
                className={`absolute top-2 right-[calc(50%-18px)] h-2 w-2 rounded-full ${marks[tool.id] === 'warn' ? 'bg-warn-dot' : 'bg-ok-dot'}`}
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** 도구의 패널. 고른 도구일 때만 보이고, 아닐 때도 상태를 잃지 않게 그려 둔다 */
export function ToolPanel({
  slots,
  tool,
  children,
  ...rest
}: { slots: Slots; tool: ToolId; children: ReactNode } & Record<`data-${string}`, string | number | boolean | undefined>) {
  if (!slots.panel) return null;
  return createPortal(
    <section hidden={slots.active !== tool} className="flex min-h-0 flex-1 flex-col" aria-label={TOOLS.find((t) => t.id === tool)?.label} {...rest}>
      {children}
    </section>,
    slots.panel,
  );
}

/** 패널의 스크롤되는 몸통 */
export function PanelBody({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 lg:p-5">{children}</div>;
}

/** 패널 아래에 붙어 있는 칸 (AI 추천, 저장 등) */
export function PanelFooter({ children, tone = 'plain', ...rest }: { children: ReactNode; tone?: 'plain' | 'accent' } & Record<`data-${string}`, string | number | boolean | undefined>) {
  return (
    <div className={`mx-3 mb-3 flex shrink-0 flex-col gap-2.5 rounded-[14px] p-3.5 ${tone === 'accent' ? 'bg-accent-soft' : 'bg-ground'}`} {...rest}>
      {children}
    </div>
  );
}

/** 패널 맨 위의 제목 줄 */
export function PanelTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight">{children}</h2>
      {right}
    </div>
  );
}

/** 작은 구역 제목 */
export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <h3 className="text-[13px] font-bold">{children}</h3>
      {right}
    </div>
  );
}

/** "AI" 표시 */
export function AiBadge({ className = '' }: { className?: string }) {
  return <span className={`rounded-md bg-accent px-1.5 py-px font-mono text-[11px] font-medium text-white ${className}`}>AI</span>;
}

/** 저장 상태 표시 (저장됨·저장 안 됨·저장하는 중·실패) */
export function SaveStatePill({ state, labels, testId }: { state: 'saved' | 'dirty' | 'saving' | 'error'; labels: Record<'saved' | 'dirty' | 'saving' | 'error', string>; testId: string }) {
  const look = {
    saved: 'bg-ok-soft text-ok',
    dirty: 'bg-warn-soft text-warn',
    saving: 'bg-chip text-body',
    error: 'bg-danger-soft text-danger',
  }[state];
  return (
    <span className={`pill font-medium ${look}`} data-testid={testId} data-state={state}>
      {state === 'saved' && <Icon name="check" />}
      {state === 'dirty' && <span className="h-1.5 w-1.5 rounded-full bg-warn-dot" aria-hidden="true" />}
      {labels[state]}
    </span>
  );
}

/** 3D 화면 위에 띄우는 것 (보기 전환, 고른 가구의 띠 등) */
export function StageLayer({ slots, children }: { slots: Slots; children: ReactNode }) {
  if (!slots.stage) return null;
  return createPortal(children, slots.stage);
}
