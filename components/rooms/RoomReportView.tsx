import Icon from '@/components/ui/Icon';
import { CONFIDENCE_LABEL, LIGHT_LABEL, OPTION_STATUS_LABEL, STORAGE_LABEL } from '@/lib/ai/analysis';
import type { RoomReport } from '@/lib/ai/schemas';

/** 저장된 방 분석 리포트와 그것을 만든 때·모델 */
export type SavedReport = { id: string; model: string; createdAt: string; report: RoomReport };

type Level = 'low' | 'medium' | 'high' | 'unknown';
const LEVEL_BARS: Record<Level, number> = { low: 1, medium: 2, high: 3, unknown: 0 };

/** 채광·수납: 세 칸 막대와 한 줄 설명 */
function LevelTile({
  testId,
  title,
  icon,
  level,
  label,
  notes,
  tone,
}: {
  testId: string;
  title: string;
  icon: 'sun' | 'drawer';
  level: Level;
  label: string;
  notes: string;
  tone: { tile: string; title: string; value: string; bar: string; rest: string; note: string };
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[14px] p-3.5" style={{ background: tone.tile }} data-testid={testId} data-level={level}>
      <div className="flex items-center justify-between" style={{ color: tone.title }}>
        <span className="text-xs font-semibold">{title}</span>
        <Icon name={icon} />
      </div>
      <span className="text-[22px] leading-tight font-bold" style={{ color: tone.value }}>
        {label}
      </span>
      <div className="flex gap-1" aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <span key={n} className="h-[5px] flex-1 rounded-full" style={{ background: n <= LEVEL_BARS[level] ? tone.bar : tone.rest }} />
        ))}
      </div>
      {notes && (
        <span className="text-xs" style={{ color: tone.note }}>
          {notes}
        </span>
      )}
    </div>
  );
}

/** 방 분석 리포트를 보여준다: 요약, 채광·수납, 옵션(있음·없음·확인 안 됨), 눈에 띄는 문제 */
export default function RoomReportView({ saved }: { saved: SavedReport }) {
  const { report } = saved;
  const when = new Date(saved.createdAt);
  const present = report.options.filter((o) => o.status === 'present');
  const absent = report.options.filter((o) => o.status === 'absent');
  const unknown = report.options.filter((o) => o.status === 'unknown');

  return (
    <div className="flex flex-col gap-5" data-testid="analysis-report" data-report-id={saved.id} data-json={JSON.stringify(report)}>
      <p className="rounded-[14px] bg-accent-soft p-3.5 text-sm text-pretty text-[#1a2140]" data-testid="analysis-summary">
        {report.summary}
      </p>

      <div className="grid grid-cols-2 gap-2.5">
        <LevelTile
          testId="analysis-light"
          title="채광"
          icon="sun"
          level={report.naturalLight.level}
          label={LIGHT_LABEL[report.naturalLight.level]}
          notes={report.naturalLight.notes}
          tone={{ tile: '#fff6df', title: '#7a4f00', value: '#4a3000', bar: '#d99a0b', rest: '#f3dfae', note: '#5c3d00' }}
        />
        <LevelTile
          testId="analysis-storage"
          title="수납"
          icon="drawer"
          level={report.storage.level}
          label={STORAGE_LABEL[report.storage.level]}
          notes={report.storage.notes}
          tone={{ tile: '#e8f4e5', title: '#2f6b27', value: '#1e4a18', bar: '#4e9443', rest: '#c4debf', note: '#2a5a23' }}
        />
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-bold">옵션</h3>
          <span className="text-xs text-sub">
            {OPTION_STATUS_LABEL.present} {present.length} · {OPTION_STATUS_LABEL.absent} {absent.length} · {OPTION_STATUS_LABEL.unknown} {unknown.length}
          </span>
        </div>
        {present.length > 0 && (
          <ul className="flex flex-col gap-1.5" data-testid="analysis-options-present">
            {present.map((o) => (
              <li key={o.name} className="flex gap-2.5 rounded-xl border border-line p-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
                  <Icon name="check" />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-bold">{o.name}</span>
                  {o.evidence && <span className="text-xs text-body">{o.evidence}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {absent.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="analysis-options-absent">
            <span className="text-xs text-sub">{OPTION_STATUS_LABEL.absent}</span>
            <div className="flex flex-wrap gap-1.5">
              {absent.map((o) => (
                <span key={o.name} className="pill bg-danger-tint py-1 text-danger" title={o.evidence}>
                  {o.name}
                </span>
              ))}
            </div>
          </div>
        )}
        {unknown.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="analysis-options-unknown">
            <span className="text-xs text-sub">그림만으로는 알 수 없는 것 ({OPTION_STATUS_LABEL.unknown})</span>
            <div className="flex flex-wrap gap-1.5">
              {unknown.map((o) => (
                <span key={o.name} className="pill bg-chip py-1 text-body" title={o.evidence}>
                  {o.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2.5" data-testid="analysis-issues" data-count={report.issues.length}>
        <h3 className="text-[13px] font-bold">
          눈에 띄는 문제 <span className="font-normal text-sub">(AI 참고용, 직접 확인 필요)</span>
        </h3>
        {report.issues.length === 0 ? (
          <p className="flex gap-2.5 rounded-xl bg-ground p-3 text-[13px] text-body">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
              <Icon name="check" />
            </span>
            <span className="text-pretty">그림에서 찾은 문제가 없습니다. 작은 곰팡이나 긁힘은 놓칠 수 있습니다.</span>
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {report.issues.map((issue, index) => (
              <li key={index} className="rounded-xl bg-warn-tint p-3 text-warn">
                <span className="font-bold">{issue.type}</span>{' '}
                <span className="text-xs">
                  (그림 {issue.photoIndex}, 확신 {CONFIDENCE_LABEL[issue.confidence]})
                </span>
                : {issue.description}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-mute" data-testid="analysis-meta">
        {Number.isNaN(when.getTime()) ? '' : `${when.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })} · `}
        {saved.model} · 치수는 AI가 추정하지 않습니다 (보정한 값만 씁니다)
      </p>
    </div>
  );
}
