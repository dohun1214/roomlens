'use client';

import { useState, type RefObject } from 'react';
import RoomReportView, { type SavedReport } from '@/components/rooms/RoomReportView';
import { CAPTURE_LONG_SIDE, capturePlan, capturePlanAround, MAX_ANALYSIS_IMAGES, MAX_IMAGE_BASE64, MAX_TOTAL_BASE64, parseReport, PHOTO_LONG_SIDE, totalBase64 } from '@/lib/ai/analysis';
import type { Point2 } from '@/lib/three/floorDrag';
import { captureViews, photoToJpegBase64 } from '@/lib/three/capture';
import type { Engine } from './engine';

type Phase = { kind: 'idle' } | { kind: 'capturing'; done: number; total: number } | { kind: 'sending' };
type Photo = { name: string; data: string };

/**
 * 방 분석: 3D 화면을 여러 방향에서 캡처한 그림(과 사용자가 넣은 사진)을 Gemini에 보내 리포트를 받는다.
 * 리포트는 방을 볼 수 있는 사람 모두에게 보이고, 분석은 방 주인만 시작할 수 있다.
 */
export default function AnalysisPanel({
  engineRef,
  roomId,
  floorPolygon,
  canAnalyze,
  initialReport,
  aiRemaining,
  onRemaining,
}: {
  engineRef: RefObject<Engine | null>;
  roomId: string;
  /** 보정된 방의 평면도. 있으면 방 안의 자리에서, 없으면 지금 서 있는 자리에서 둘러보며 캡처한다 */
  floorPolygon: Point2[] | null;
  /** 방 주인인지 */
  canAnalyze: boolean;
  initialReport: SavedReport | null;
  /** 오늘 남은 AI 횟수 (모르면 null) */
  aiRemaining: number | null;
  onRemaining: (remaining: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<SavedReport | null>(initialReport);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [message, setMessage] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  // 마지막으로 보낸 그림들 (무엇을 보냈는지 확인할 수 있게 작게 보여준다)
  const [sent, setSent] = useState<string[]>([]);
  const busy = phase.kind !== 'idle';

  const addPhotos = async (files: FileList | null) => {
    if (!files) return;
    setMessage(null);
    const next = [...photos];
    for (const file of Array.from(files)) {
      if (next.length >= MAX_ANALYSIS_IMAGES - 1) {
        setMessage(`사진은 ${MAX_ANALYSIS_IMAGES - 1}장까지 넣을 수 있습니다.`);
        break;
      }
      const data = await photoToJpegBase64(file, PHOTO_LONG_SIDE, MAX_IMAGE_BASE64);
      if (data) next.push({ name: file.name, data });
      else setMessage(`${file.name}: 그림 파일이 아니라서 넣지 않았습니다.`);
    }
    setPhotos(next);
  };

  const run = async () => {
    const engine = engineRef.current;
    if (!engine || busy) return;
    setMessage(null);
    try {
      // 사진을 넣은 만큼 캡처 수를 줄여 합쳐서 10장을 넘지 않게 한다
      const plan = floorPolygon ? capturePlan(floorPolygon) : capturePlanAround(engine.camera.position.toArray());
      const views = plan.slice(0, Math.max(1, MAX_ANALYSIS_IMAGES - photos.length));
      setPhase({ kind: 'capturing', done: 0, total: views.length });
      const captures = await captureViews(engine, views, {
        longSide: CAPTURE_LONG_SIDE,
        onProgress: (done, total) => setPhase({ kind: 'capturing', done, total }),
      });
      let images = [...captures.map((data) => ({ data, source: 'capture' as const })), ...photos.map((p) => ({ data: p.data, source: 'photo' as const }))];
      // 요청 크기 한도를 넘으면 캡처부터 뺀다
      while (images.length > 1 && totalBase64(images) > MAX_TOTAL_BASE64) images = images.slice(1);
      setSent(images.map((image) => image.data));

      setPhase({ kind: 'sending' });
      const res = await fetch(`/api/rooms/${roomId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
      });
      const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string }; report?: { id?: string; model?: string; createdAt?: string; report?: unknown }; remaining?: number } | null;
      if (!res.ok) {
        if (json?.error?.code === 'AI_LIMIT') onRemaining(0);
        setMessage(json?.error?.message ?? '분석하지 못했습니다. 잠시 뒤에 다시 해 주세요.');
        return;
      }
      const parsed = parseReport(json?.report?.report);
      if (!parsed || !json?.report?.id) {
        setMessage('분석 결과를 읽지 못했습니다. 잠시 뒤에 다시 해 주세요.');
        return;
      }
      setReport({ id: json.report.id, model: json.report.model ?? '', createdAt: json.report.createdAt ?? '', report: parsed });
      if (typeof json.remaining === 'number') onRemaining(json.remaining);
    } catch (err) {
      console.error(err);
      setMessage('분석하지 못했습니다. 인터넷 연결을 확인하고 다시 해 주세요.');
    } finally {
      setPhase({ kind: 'idle' });
    }
  };

  const noQuota = aiRemaining === 0;
  return (
    <>
      <button
        className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-black/75 px-3 py-2 text-xs text-white"
        onClick={() => setOpen((prev) => !prev)}
        data-testid="analysis-toggle"
        aria-pressed={open}
      >
        방 분석{report ? ' ✓' : ''}
      </button>
      {open && (
        <div
          className="absolute bottom-14 left-1/2 max-h-[60%] w-80 max-w-[calc(100%-1rem)] -translate-x-1/2 space-y-2 overflow-y-auto rounded bg-black/85 p-3 text-xs text-white"
          data-testid="analysis-panel"
          data-phase={phase.kind}
        >
          <div className="flex items-center justify-between">
            <strong>AI 방 분석</strong>
            <button className="rounded bg-white/20 px-2 py-0.5" onClick={() => setOpen(false)}>
              닫기
            </button>
          </div>
          {report ? (
            <RoomReportView saved={report} />
          ) : (
            <p className="opacity-80" data-testid="analysis-empty">
              아직 분석한 적이 없습니다.{canAnalyze ? '' : ' 방 주인이 분석하면 여기에 보입니다.'}
            </p>
          )}
          {canAnalyze && (
            <div className="space-y-1 border-t border-white/20 pt-2" data-testid="analysis-controls" data-remaining={aiRemaining ?? ''}>
              <p className="opacity-80">
                3D 화면을 여러 방향에서 캡처한 그림{photos.length > 0 ? `과 넣은 사진 ${photos.length}장` : ''}을 Google Gemini로 보내 옵션·수납·채광·상태를 살펴봅니다. 놓아 둔 가상 가구는 그림에 넣지
                않고, 그림은 저장하지 않습니다.{aiRemaining !== null ? ` 오늘 ${aiRemaining}회 남음.` : ''}
              </p>
              <label className="inline-block cursor-pointer rounded bg-white/20 px-2 py-1">
                사진 넣기 (선택)
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  disabled={busy}
                  data-testid="analysis-photos"
                  onChange={(e) => {
                    void addPhotos(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
              {photos.length > 0 && (
                <p data-testid="analysis-photo-list" data-count={photos.length}>
                  사진 {photos.length}장: {photos.map((p) => p.name).join(', ')}{' '}
                  <button className="underline" disabled={busy} onClick={() => setPhotos([])}>
                    빼기
                  </button>
                </p>
              )}
              <div>
                <button className="rounded bg-violet-600 px-2 py-1 disabled:opacity-50" disabled={busy || noQuota} onClick={run} data-testid="analysis-run">
                  {phase.kind === 'capturing' && `화면 캡처 중 (${phase.done}/${phase.total})`}
                  {phase.kind === 'sending' && 'AI가 분석하는 중… (10~40초)'}
                  {phase.kind === 'idle' && (report ? '다시 분석' : '분석 시작')}
                </button>
              </div>
              {noQuota && <p className="opacity-80">오늘 쓸 수 있는 AI 횟수를 모두 썼습니다. 내일 다시 해 주세요.</p>}
            </div>
          )}
          {message && (
            <p className="text-amber-300" data-testid="analysis-message">
              {message}
            </p>
          )}
          {sent.length > 0 && (
            <div data-testid="analysis-sent" data-count={sent.length}>
              <p className="opacity-70">보낸 그림 {sent.length}장</p>
              <div className="flex flex-wrap gap-1">
                {sent.map((data, index) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={index} className="h-10 rounded" alt={`그림 ${index + 1}`} title={`그림 ${index + 1}`} src={`data:image/jpeg;base64,${data}`} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
