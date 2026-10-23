'use client';

import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/SiteHeader';
import Icon from '@/components/ui/Icon';
import { loginUrlFor } from '@/lib/auth/paths';
import { deleteComment, loadComments, MAX_COMMENT_LENGTH, parseCommentBody, postComment, relativeTime, type RoomComment } from '@/lib/rooms/comments';
import { createClient } from '@/lib/supabase/client';
import { PanelBody, PanelFooter, PanelTitle, ToolPanel, type Slots } from './workspace';

/** 연달아 쓸 때 기다리는 시간 (ms). 같은 글을 실수로 두 번 보내지 않게 */
const COOLDOWN_MS = 3000;

/**
 * 방 코멘트. 방을 볼 수 있는 사람은 읽고, 로그인한 사람은 쓰고, 쓴 사람과 방 주인은 지울 수 있다.
 * 비공개 방은 방 주인만 보므로 혼자 쓰는 메모가 된다.
 */
export default function CommentsPanel({
  slots,
  roomId,
  ownerId,
  viewer,
  isPublic,
}: {
  slots: Slots;
  roomId: string;
  /** 방 주인 (코멘트에 "방 주인" 표시, 남의 코멘트를 지울 수 있음) */
  ownerId: string | null;
  /** 로그인한 사람. 없으면 읽기만 */
  viewer: { id: string; name: string } | null;
  isPublic: boolean;
}) {
  const [comments, setComments] = useState<RoomComment[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState(0);
  const listEnd = useRef<HTMLLIElement>(null);
  const open = slots.active === 'comments';
  const isOwner = Boolean(viewer && ownerId && viewer.id === ownerId);

  const refresh = async () => {
    const loaded = await loadComments(createClient(), roomId);
    setFailed(loaded === null);
    if (loaded) setComments(loaded);
  };

  // 처음 열 때 읽는다 (패널은 늘 떠 있지만 코멘트는 필요할 때만)
  const loadedOnce = useRef(false);
  useEffect(() => {
    if (!open || loadedOnce.current) return;
    loadedOnce.current = true;
    void loadComments(createClient(), roomId).then((loaded) => {
      setFailed(loaded === null);
      if (loaded) setComments(loaded);
    });
  }, [open, roomId]);

  // 새 코멘트가 생기면 맨 아래로
  const count = comments?.length ?? 0;
  useEffect(() => {
    if (open && count > 0) listEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [open, count]);

  const send = async () => {
    if (!viewer || busy) return;
    const parsed = parseCommentBody(text);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    if (Date.now() - lastSent < COOLDOWN_MS) {
      setMessage('잠시 뒤에 다시 남겨 주세요.');
      return;
    }
    setBusy(true);
    setMessage(null);
    const created = await postComment(createClient(), roomId, parsed.body);
    setBusy(false);
    if (!created) {
      setMessage('코멘트를 남기지 못했습니다. 잠시 뒤에 다시 해 주세요.');
      return;
    }
    setLastSent(Date.now());
    setText('');
    setComments((prev) => [...(prev ?? []), { ...created, authorName: viewer.name }]);
  };

  const remove = async (id: string) => {
    if (busy) return;
    setBusy(true);
    const ok = await deleteComment(createClient(), id);
    setBusy(false);
    setConfirmId(null);
    if (!ok) {
      setMessage('지우지 못했습니다. 잠시 뒤에 다시 해 주세요.');
      return;
    }
    setComments((prev) => (prev ?? []).filter((c) => c.id !== id));
  };

  const now = new Date();
  return (
    <ToolPanel slots={slots} tool="comments" data-testid="comments-panel" data-count={comments?.length ?? ''}>
      <PanelBody>
        <PanelTitle
          right={
            <button type="button" className="btn h-8 rounded-lg px-2.5 text-xs text-sub hover:bg-soft" onClick={() => void refresh()} data-testid="comments-refresh">
              새로 고침
            </button>
          }
        >
          코멘트 <span className="font-mono text-base font-medium text-mute" data-testid="comments-count">{comments?.length ?? ''}</span>
        </PanelTitle>
        {!isPublic && isOwner && <p className="rounded-xl bg-ground px-3.5 py-2.5 text-[13px] text-sub">비공개 방이라 코멘트는 나만 봅니다. 방을 공개하면 다른 사람도 읽고 남길 수 있습니다.</p>}
        {failed && (
          <p className="rounded-xl bg-warn-tint px-3.5 py-2.5 text-[13px] text-warn" role="alert">
            코멘트를 불러오지 못했습니다. 새로 고침을 눌러 주세요.
          </p>
        )}
        {comments === null && !failed && <p className="text-[13px] text-sub">불러오는 중…</p>}
        {comments?.length === 0 && <p className="text-[13px] text-sub" data-testid="comments-empty">아직 코멘트가 없습니다. 방이나 가구 배치에 대한 생각을 남겨 보세요.</p>}
        {comments && comments.length > 0 && (
          <ul className="flex flex-col gap-3" data-testid="comments-list">
            {comments.map((c) => {
              const mine = viewer?.id === c.authorId;
              const canDelete = mine || isOwner;
              return (
                <li key={c.id} className="flex gap-2.5" data-testid="comment-item" data-id={c.id} data-mine={mine}>
                  <Avatar name={c.authorName} size={30} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="truncate font-semibold text-ink">{c.authorName}</span>
                      {c.authorId === ownerId && <span className="shrink-0 rounded-md bg-accent-soft px-1.5 py-px text-[11px] font-medium text-accent-strong">방 주인</span>}
                      <time className="shrink-0 text-mute" dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString('ko-KR')}>
                        {relativeTime(c.createdAt, now)}
                      </time>
                      {canDelete && confirmId !== c.id && (
                        <button
                          type="button"
                          className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-mute hover:bg-danger-soft hover:text-danger"
                          onClick={() => setConfirmId(c.id)}
                          aria-label="코멘트 지우기"
                          data-testid="comment-delete"
                        >
                          <Icon name="close" size={10} />
                        </button>
                      )}
                    </div>
                    <p className="rounded-[4px_14px_14px_14px] bg-ground px-3 py-2 text-[13px] break-words whitespace-pre-wrap text-body">{c.body}</p>
                    {confirmId === c.id && (
                      <div className="flex items-center gap-2 text-[13px] text-warn">
                        <span className="mr-auto">{mine ? '내 코멘트를 지울까요?' : '이 코멘트를 지울까요? (방 주인)'}</span>
                        <button type="button" className="btn btn-danger h-8 bg-danger px-3 text-xs text-white hover:bg-[#8f231b]" disabled={busy} onClick={() => void remove(c.id)} data-testid="comment-delete-yes">
                          지우기
                        </button>
                        <button type="button" className="btn btn-outline h-8 px-3 text-xs" onClick={() => setConfirmId(null)}>
                          취소
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
            <li ref={listEnd} aria-hidden="true" />
          </ul>
        )}
      </PanelBody>
      <PanelFooter>
        {viewer ? (
          <div className="flex flex-col gap-2">
            <textarea
              className="field h-[72px] resize-none rounded-[10px] px-3 py-2 text-sm"
              placeholder="코멘트를 남겨 주세요 (Ctrl+Enter로 보내기)"
              aria-label="코멘트"
              maxLength={MAX_COMMENT_LENGTH}
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
              data-testid="comments-input"
            />
            <div className="flex items-center gap-2">
              <span className="mr-auto font-mono text-[11px] text-mute">
                {text.length}/{MAX_COMMENT_LENGTH}
              </span>
              <button type="button" className="btn btn-primary h-10 px-5 text-[13px]" disabled={busy || !text.trim()} onClick={() => void send()} data-testid="comments-send">
                남기기
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-body" data-testid="comments-login-hint">
            <a className="font-semibold text-accent underline" href={loginUrlFor(`/rooms/${roomId}`)}>
              로그인
            </a>
            하면 코멘트를 남길 수 있습니다.
          </p>
        )}
        {message && (
          <p className="rounded-[10px] bg-warn-tint px-3 py-2 text-[13px] text-warn" data-testid="comments-message">
            {message}
          </p>
        )}
      </PanelFooter>
    </ToolPanel>
  );
}
