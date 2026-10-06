import { CONFIDENCE_LABEL, LIGHT_LABEL, OPTION_STATUS_LABEL, STORAGE_LABEL } from '@/lib/ai/analysis';
import type { RoomReport } from '@/lib/ai/schemas';

/** 저장된 방 분석 리포트와 그것을 만든 때·모델 */
export type SavedReport = { id: string; model: string; createdAt: string; report: RoomReport };

const STATUS_ORDER = ['present', 'absent', 'unknown'] as const;
const STATUS_CLASS = { present: 'text-emerald-300', absent: 'text-neutral-300', unknown: 'text-neutral-400' } as const;

/** 방 분석 리포트를 보여준다: 요약, 옵션(있음·없음·확인 안 됨), 수납, 채광, 눈에 띄는 문제 */
export default function RoomReportView({ saved }: { saved: SavedReport }) {
  const { report } = saved;
  const when = new Date(saved.createdAt);
  return (
    <div className="space-y-2" data-testid="analysis-report" data-report-id={saved.id} data-json={JSON.stringify(report)}>
      <p data-testid="analysis-summary">{report.summary}</p>

      <div>
        <p className="font-semibold">옵션</p>
        {STATUS_ORDER.map((status) => {
          const list = report.options.filter((o) => o.status === status);
          if (list.length === 0) return null;
          return (
            <p key={status} className={STATUS_CLASS[status]} data-testid={`analysis-options-${status}`}>
              {OPTION_STATUS_LABEL[status]}:{' '}
              {list.map((o, index) => (
                <span key={o.name} title={o.evidence}>
                  {index > 0 ? ', ' : ''}
                  {o.name}
                </span>
              ))}
            </p>
          );
        })}
      </div>

      <p data-testid="analysis-storage" data-level={report.storage.level}>
        <span className="font-semibold">수납</span> {STORAGE_LABEL[report.storage.level]}
        {report.storage.notes ? ` — ${report.storage.notes}` : ''}
      </p>
      <p data-testid="analysis-light" data-level={report.naturalLight.level}>
        <span className="font-semibold">채광</span> {LIGHT_LABEL[report.naturalLight.level]}
        {report.naturalLight.notes ? ` — ${report.naturalLight.notes}` : ''}
      </p>

      <div data-testid="analysis-issues" data-count={report.issues.length}>
        <p className="font-semibold">눈에 띄는 문제 (AI 참고용, 직접 확인 필요)</p>
        {report.issues.length === 0 ? (
          <p className="opacity-80">그림에서 찾은 문제가 없습니다. 작은 곰팡이나 긁힘은 놓칠 수 있습니다.</p>
        ) : (
          <ul className="list-disc space-y-0.5 pl-4 text-amber-300">
            {report.issues.map((issue, index) => (
              <li key={index}>
                {issue.type} (그림 {issue.photoIndex}, 확신 {CONFIDENCE_LABEL[issue.confidence]}): {issue.description}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="opacity-60" data-testid="analysis-meta">
        {Number.isNaN(when.getTime()) ? '' : `${when.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })} · `}
        {saved.model} · 치수는 AI가 추정하지 않습니다 (보정한 값만 씁니다)
      </p>
    </div>
  );
}
