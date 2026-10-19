'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Icon from '@/components/ui/Icon';
import { ROOM_DESCRIPTION_MAX, ROOM_TITLE_MAX, RoomInfoInput } from '@/lib/rooms/schemas';
import { createClient } from '@/lib/supabase/client';

/** 방 주인이 방 화면 머리말에서 방 이름·설명을 고친다 (연필 버튼 → 아래로 펼치는 칸) */
export default function RoomInfoEditor({ roomId, title, description }: { roomId: string; title: string; description: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title, description });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setForm({ title, description });
    setError(null);
    setOpen(true);
  };

  const save = async () => {
    const parsed = RoomInfoInput.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '입력을 확인해 주세요.');
      return;
    }
    setBusy(true);
    setError(null);
    // 이름·설명은 방 주인이 직접 바꿀 수 있는 컬럼이다 (RLS + 컬럼 권한)
    const { data, error: updateError } = await createClient().from('rooms').update(parsed.data).eq('id', roomId).select('id').maybeSingle();
    setBusy(false);
    if (updateError || !data) {
      setError('저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    setOpen(false);
    router.refresh();
  };

  return (
    <>
      <button
        type="button"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sub hover:bg-soft hover:text-ink"
        onClick={() => (open ? setOpen(false) : start())}
        aria-label="방 이름·설명 고치기"
        aria-expanded={open}
        data-testid="room-info-edit"
      >
        <Icon name="edit" size={15} />
      </button>
      {open && (
        <form
          className="absolute top-full left-3 z-30 mt-2 flex w-[min(26rem,calc(100vw-1.5rem))] flex-col gap-3 rounded-2xl bg-surface p-4 shadow-float"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          data-testid="room-info-form"
        >
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
            방 이름
            <input
              className="field h-11 rounded-[10px] px-3 text-sm font-normal"
              value={form.title}
              maxLength={ROOM_TITLE_MAX}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              autoFocus
              data-testid="room-info-title"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
            <span>
              설명 <span className="font-normal text-mute">(선택)</span>
            </span>
            <textarea
              className="field h-24 resize-none rounded-[10px] px-3 py-2 text-sm font-normal"
              value={form.description}
              maxLength={ROOM_DESCRIPTION_MAX}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              data-testid="room-info-description"
            />
          </label>
          {error && (
            <p className="rounded-[10px] bg-warn-tint px-3 py-2 text-[13px] text-warn" role="alert" data-testid="room-info-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-outline h-10 px-4 text-[13px]" disabled={busy} onClick={() => setOpen(false)}>
              취소
            </button>
            <button type="submit" className="btn btn-primary h-10 px-4 text-[13px]" disabled={busy} data-testid="room-info-save">
              {busy ? '저장하는 중…' : '저장'}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
