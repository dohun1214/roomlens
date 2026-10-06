'use client';

import Link from 'next/link';
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { CreateRoomInput, firstIssueMessage, ROOM_CREDIT_MAX, ROOM_DESCRIPTION_MAX, ROOM_TITLE_MAX, type RoomSource } from '@/lib/rooms/schemas';
import { checkSplatFile, type SplatFormat } from '@/lib/upload/splatFile';
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
      <section className="space-y-3 rounded border border-neutral-300 p-4 text-sm dark:border-neutral-700" data-testid="upload-done" data-room-id={done.roomId}>
        <p className="font-semibold">방을 만들었습니다.</p>
        <p className="text-neutral-500">지금은 나만 볼 수 있습니다.</p>
        <div className="flex gap-3">
            <Link href={`/rooms/${done.roomId}`} className="rounded bg-neutral-900 px-3 py-2 text-white dark:bg-white dark:text-neutral-900" data-testid="upload-view">
              3D로 보기
            </Link>
          <button type="button" onClick={reset} className="rounded border border-neutral-300 px-3 py-2 dark:border-neutral-700">
            방 하나 더 만들기
          </button>
        </div>
      </section>
    );
  }

  const inputClass = 'w-full rounded border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700';
  const percent = Math.round(progress * 100);

  return (
    <form onSubmit={submit} className="space-y-5" noValidate data-testid="room-form">
      <label className="block space-y-1 text-sm">
        <span>방 이름</span>
        <input
          className={inputClass}
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

      <label className="block space-y-1 text-sm">
        <span>설명 (선택)</span>
        <textarea
          className={inputClass}
          name="description"
          rows={3}
          value={description}
          maxLength={ROOM_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
          data-testid="room-description"
        />
      </label>

      <fieldset className="space-y-2 text-sm">
        <legend className="mb-1">어떤 방인가요?</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="source" checked={source === 'scaniverse'} onChange={() => setSource('scaniverse')} disabled={busy} data-testid="room-source-own" />
          <span>직접 찍은 방</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="source" checked={source === 'dataset'} onChange={() => setSource('dataset')} disabled={busy} data-testid="room-source-dataset" />
          <span>공개 데이터셋 등 다른 사람이 만든 3D</span>
        </label>
        {source === 'dataset' && (
          <label className="block space-y-1">
            <span>출처와 라이선스</span>
            <input
              className={inputClass}
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
            <span className="block text-xs text-neutral-500">
              방 화면에 그대로 표시됩니다. 공개하려면 다시 배포해도 되는 라이선스(CC BY 등)인지 먼저 확인하세요.
            </span>
          </label>
        )}
      </fieldset>

      <div className="space-y-1 text-sm">
        <label className="block space-y-1">
          <span>3D 파일 (.spz, .ply · 100MB 이하)</span>
          <input
            className="block w-full text-sm"
            type="file"
            name="file"
            accept=".spz,.ply,.sog,.rad"
            onChange={onFile}
            disabled={busy}
            data-testid="room-file"
          />
        </label>
        {picked && (
          <p className="text-neutral-500" data-testid="room-file-info">
            {picked.file.name} · {picked.format.toUpperCase()} · {megabytes(picked.file.size)}
          </p>
        )}
        {fileError && (
          <p className="text-red-600" role="alert" data-testid="room-file-error">
            {fileError}
          </p>
        )}
      </div>

      <fieldset className="space-y-2 rounded border border-neutral-300 p-3 text-sm dark:border-neutral-700">
        <legend className="px-1 font-semibold">개인정보 수집·이용 동의</legend>
        <ul className="list-disc space-y-1 pl-5 text-neutral-600 dark:text-neutral-300">
          <li>수집하는 것: 올린 방 3D 파일과 방 사진 (직접 찍은 방은 집 안 모습이 담겨 개인정보로 다룹니다)</li>
          <li>쓰는 곳: 3D로 보여주기, 가구 배치, AI 방 분석</li>
          <li>
            AI 방 분석을 요청하면 방 사진 또는 3D 화면을 캡처한 그림이, AI 배치 추천을 요청하면 방의 치수·문과 창문의 위치·가구 목록·적은 요청 글이 Google Gemini API로
            전송됩니다. 학습에 쓰이지 않는 유료 API를 씁니다
          </li>
          <li>보관 기간: 방을 지울 때까지. 방을 지우면 파일도 함께 지웁니다</li>
          <li>공개로 바꾸기 전에는 나만 볼 수 있습니다</li>
        </ul>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            name="consent"
            className="mt-1"
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
        <div className="space-y-1 text-sm" data-testid="upload-progress" data-stage={stage} data-percent={percent}>
          <p data-testid="upload-status">
            {STAGE_LABEL[stage]}
            {stage === 'uploading' ? ` ${percent}%` : ''}
          </p>
          <progress className="w-full" max={100} value={stage === 'uploading' ? percent : stage === 'verifying' ? 100 : 0} />
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600" role="alert" data-testid="upload-error">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          data-testid="room-submit"
        >
          {busy ? '올리는 중…' : error && pendingRoomId ? '다시 시도' : '방 만들기'}
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => abort.current?.abort()}
            className="rounded border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
            data-testid="upload-cancel"
          >
            취소
          </button>
        )}
      </div>
    </form>
  );
}
