'use client';

import Link from 'next/link';
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { CreateRoomInput, firstIssueMessage, ROOM_CREDIT_MAX, ROOM_DESCRIPTION_MAX, ROOM_TITLE_MAX, type RoomSource } from '@/lib/rooms/schemas';
import { checkSplatFile, type SplatFormat } from '@/lib/upload/splatFile';
import Icon from '@/components/ui/Icon';
import { readFileHead, STAGE_LABEL, uploadRoom, UploadError, type UploadStage } from '@/lib/upload/uploadRoom';

type Picked = { file: File; format: SplatFormat };
type Done = { roomId: string };

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/** 방 만들기 폼: 이름·설명, 3D 파일, 개인정보 동의 → 업로드(진행률) → 완료 */
export default function RoomUploadForm() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [consent, setConsent] = useState(false);
  const [source, setSource] = useState<RoomSource>('scaniverse');
  const [credit, setCredit] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [stage, setStage] = useState<UploadStage | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  // 올리다 실패한 방. 다시 시도할 때 같은 방에 이어서 올린다
  const [pendingRoomId, setPendingRoomId] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const busy = stage !== null;

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setPicked(null);
    setFileError(null);
    setError(null);
    if (!file) return;
    // 고르는 즉시 확인해서, 안 되는 파일을 끝까지 올린 뒤에야 알게 되는 일을 막는다
    const check = checkSplatFile(file.size, await readFileHead(file));
    if (check.ok) setPicked({ file, format: check.format });
    else setFileError(check.message);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);

    const parsed = CreateRoomInput.safeParse({ title, description, consent, source, credit });
    if (!parsed.success) {
      setError(firstIssueMessage(parsed.error));
      return;
    }
    if (!picked) {
      setError(fileError ?? '3D 파일을 골라 주세요.');
      return;
    }

    const controller = new AbortController();
    abort.current = controller;
    setProgress(0);
    try {
      const { roomId } = await uploadRoom({
        file: picked.file,
        title: parsed.data.title,
        description: parsed.data.description,
        consent: true,
        source: parsed.data.source,
        credit: parsed.data.credit,
        roomId: pendingRoomId,
        onStage: setStage,
        onProgress: setProgress,
        signal: controller.signal,
      });
      setPendingRoomId(null);
      setDone({ roomId });
    } catch (err) {
      if (err instanceof UploadError) {
        setPendingRoomId(err.roomId);
        setError(err.message);
      } else {
        setError('요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
    } finally {
      abort.current = null;
      setStage(null);
    }
  };

  const reset = () => {
    setTitle('');
    setDescription('');
    setConsent(false);
    setSource('scaniverse');
    setCredit('');
    setPicked(null);
    setFileError(null);
    setError(null);
    setDone(null);
    setProgress(0);
    setPendingRoomId(null);
  };

  if (done) {
    return (
      <section className="flex flex-col items-start gap-4" data-testid="upload-done" data-room-id={done.roomId}>
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ok-soft text-ok">
          <Icon name="check" size={20} />
        </span>
        <div className="space-y-1">
          <p className="text-xl font-bold">방을 만들었습니다.</p>
          <p className="text-sub">지금은 나만 볼 수 있습니다.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href={`/rooms/${done.roomId}`} className="btn btn-primary h-[52px] rounded-[14px] px-6 text-base shadow-accent" data-testid="upload-view">
            3D로 보기
          </Link>
          <button type="button" onClick={reset} className="btn btn-soft h-[52px] rounded-[14px] px-5 text-base">
            방 하나 더 만들기
          </button>
        </div>
      </section>
    );
  }

  const percent = Math.round(progress * 100);
  const labelClass = 'flex flex-col gap-2 text-sm font-bold';
  const sourceCard = (active: boolean) =>
    `flex cursor-pointer items-center gap-3.5 rounded-2xl ${active ? 'border-2 border-accent bg-[#f5f7ff] p-[15px]' : 'border border-line-strong bg-surface p-4'}`;

  return (
    <form onSubmit={submit} className="flex flex-col gap-[30px]" noValidate data-testid="room-form">
      <div className="flex flex-col gap-[18px]">
        <label className={labelClass}>
          <span>방 이름</span>
          <input
            className="field h-[50px] text-[15px] font-normal"
            name="title"
            value={title}
            maxLength={ROOM_TITLE_MAX}
            onChange={(e) => {
              setTitle(e.target.value);
              setError(null);
            }}
            disabled={busy}
            placeholder="예: 학교 앞 원룸"
            data-testid="room-title"
          />
        </label>

        <label className={labelClass}>
          <span>
            설명 <span className="font-normal text-sub">(선택)</span>
          </span>
          <textarea
            className="field py-3 text-[15px] leading-normal font-normal"
            name="description"
            rows={2}
            value={description}
            maxLength={ROOM_DESCRIPTION_MAX}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
            data-testid="room-description"
          />
        </label>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2.5 text-sm font-bold">어떤 방인가요?</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={sourceCard(source === 'scaniverse')}>
            <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] ${source === 'scaniverse' ? 'bg-[#dfe5ff] text-accent-strong' : 'bg-soft text-body'}`}>
              <Icon name="phone" />
            </span>
            <span className="flex flex-1 flex-col">
              <span className="font-bold">직접 찍은 방</span>
              <span className="text-[13px] text-body">Scaniverse 등으로 내가 찍은 방</span>
            </span>
            <input
              type="radio"
              name="source"
              className="h-5 w-5 accent-accent"
              checked={source === 'scaniverse'}
              onChange={() => setSource('scaniverse')}
              disabled={busy}
              data-testid="room-source-own"
            />
          </label>
          <label className={sourceCard(source === 'dataset')}>
            <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] ${source === 'dataset' ? 'bg-[#dfe5ff] text-accent-strong' : 'bg-soft text-body'}`}>
              <Icon name="cube" />
            </span>
            <span className="flex flex-1 flex-col">
              <span className="font-bold">다른 사람이 만든 3D</span>
              <span className="text-[13px] text-body">공개 데이터셋 등. 출처와 라이선스 필요</span>
            </span>
            <input
              type="radio"
              name="source"
              className="h-5 w-5 accent-accent"
              checked={source === 'dataset'}
              onChange={() => setSource('dataset')}
              disabled={busy}
              data-testid="room-source-dataset"
            />
          </label>
        </div>
        {source === 'dataset' && (
          <label className={labelClass}>
            <span>출처와 라이선스</span>
            <input
              className="field h-[50px] text-[15px] font-normal"
              name="credit"
              value={credit}
              maxLength={ROOM_CREDIT_MAX}
              onChange={(e) => {
                setCredit(e.target.value);
                setError(null);
              }}
              disabled={busy}
              placeholder="예: Studio 11 by milanoski (SuperSplat), CC BY 4.0"
              data-testid="room-credit-input"
            />
            <span className="text-xs font-normal text-sub">
              방 화면에 그대로 표시됩니다. 공개하려면 다시 배포해도 되는 라이선스(CC BY 등)인지 먼저 확인하세요.
            </span>
          </label>
        )}
      </fieldset>

      <div className="flex flex-col gap-2 text-sm">
        <span className="font-bold" id="room-file-label">
          3D 파일
        </span>
        <label
          className={`flex cursor-pointer flex-col items-center gap-2.5 rounded-[18px] border-2 border-dashed px-4 py-9 text-center has-focus-visible:outline-2 has-focus-visible:outline-accent ${
            picked ? 'border-accent bg-[#f5f7ff]' : 'border-accent-line bg-accent-tint'
          } ${busy ? 'cursor-not-allowed opacity-60' : ''}`}
        >
          <span className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-surface text-accent shadow-[0_2px_8px_rgb(51_80_232/0.16)]">
            <Icon name={picked ? 'check' : 'upload'} size={24} />
          </span>
          {picked ? (
            <>
              <span className="text-base font-bold break-all" data-testid="room-file-info">
                {picked.file.name} · {picked.format.toUpperCase()} · {megabytes(picked.file.size)}
              </span>
              <span className="text-[13px] text-sub">다른 파일로 바꾸려면 눌러서 다시 고르세요</span>
            </>
          ) : (
            <>
              <span className="text-base font-bold">눌러서 3D 파일 고르기</span>
              <span className="font-mono text-[13px] text-sub">.spz · .ply · 100MB 이하</span>
            </>
          )}
          <input
            className="sr-only"
            type="file"
            name="file"
            accept=".spz,.ply,.sog,.rad"
            onChange={onFile}
            disabled={busy}
            aria-labelledby="room-file-label"
            data-testid="room-file"
          />
        </label>
        {fileError && (
          <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger" role="alert" data-testid="room-file-error">
            {fileError}
          </p>
        )}
      </div>

      <fieldset className="flex flex-col gap-3.5 rounded-[18px] bg-ground p-[22px] text-sm">
        <legend className="float-left mb-3.5 w-full text-[15px] font-bold">개인정보 수집·이용 동의</legend>
        <dl className="clear-both flex flex-col gap-2.5">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <dt className="w-24 shrink-0 font-semibold text-body">수집하는 것</dt>
            <dd className="min-w-[240px] flex-1 text-ink-2">올린 방 3D 파일과 방 사진 (직접 찍은 방은 집 안 모습이 담겨 개인정보로 다룹니다)</dd>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <dt className="w-24 shrink-0 font-semibold text-body">쓰는 곳</dt>
            <dd className="min-w-[240px] flex-1 text-ink-2">3D로 보여주기, 가구 배치, AI 방 분석</dd>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <dt className="w-24 shrink-0 font-semibold text-body">AI로 보내는 것</dt>
            <dd className="min-w-[240px] flex-1 text-ink-2">
              AI 방 분석을 요청하면 방 사진 또는 3D 화면을 캡처한 그림이, AI 배치 추천을 요청하면 방의 치수·문과 창문의 위치·가구 목록·적은 요청 글이 Google Gemini API로
              전송됩니다. 학습에 쓰이지 않는 유료 API를 씁니다
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <dt className="w-24 shrink-0 font-semibold text-body">보관 기간</dt>
            <dd className="min-w-[240px] flex-1 text-ink-2">방을 지울 때까지. 방을 지우면 파일도 함께 지웁니다</dd>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <dt className="w-24 shrink-0 font-semibold text-body">공개 범위</dt>
            <dd className="min-w-[240px] flex-1 text-ink-2">공개로 바꾸기 전에는 나만 볼 수 있습니다</dd>
          </div>
        </dl>
        <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl bg-surface px-4 font-semibold">
          <input
            type="checkbox"
            name="consent"
            className="h-5 w-5 accent-accent"
            checked={consent}
            onChange={(e) => {
              setConsent(e.target.checked);
              setError(null);
            }}
            disabled={busy}
            data-testid="room-consent"
          />
          <span>위 내용을 확인했고 동의합니다.</span>
        </label>
      </fieldset>

      {stage && (
        <div className="flex flex-col gap-2 rounded-2xl bg-accent-soft p-4 text-sm" data-testid="upload-progress" data-stage={stage} data-percent={percent}>
          <p className="font-semibold text-accent-deep" data-testid="upload-status">
            {STAGE_LABEL[stage]}
            {stage === 'uploading' ? ` ${percent}%` : ''}
          </p>
          <progress className="h-2 w-full accent-accent" max={100} value={stage === 'uploading' ? percent : stage === 'verifying' ? 100 : 0} />
        </div>
      )}

      {error && (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger" role="alert" data-testid="upload-error">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className="btn btn-primary h-[52px] rounded-[14px] px-8 text-base shadow-accent" data-testid="room-submit">
          {busy ? '올리는 중…' : error && pendingRoomId ? '다시 시도' : '방 만들기'}
        </button>
        {busy && (
          <button type="button" onClick={() => abort.current?.abort()} className="btn btn-soft h-[52px] rounded-[14px] px-5 text-[15px]" data-testid="upload-cancel">
            취소
          </button>
        )}
      </div>
    </form>
  );
}
