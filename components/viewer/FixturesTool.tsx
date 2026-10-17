'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import type { Point2 } from '@/lib/three/floorDrag';
import { pickPoint, pointerToNdc } from '@/lib/three/pickPoint';
import {
  DEFAULT_FIXTURE_HEIGHT,
  describeFixture,
  FIXTURE_LABELS,
  fixtureFromCorners,
  fixtureViewpoint,
  heightFromTaps,
  MAX_FIXTURE_HEIGHT,
  sameFixtures,
  updateFixture,
  type Fixture,
} from '@/lib/rooms/fixtures';
import { addCandidates } from '@/lib/ai/fixturesDetect';
import { requestFixturesDetection } from '@/lib/ai/fixturesClient';
import Icon from '@/components/ui/Icon';
import type { Engine } from './engine';
import type { AutoDetect, AutoDetectResult } from './roomPrep';
import { AiBadge, PanelBody, PanelFooter, PanelTitle, SaveStatePill, SectionTitle, ToolPanel, type Slots } from './workspace';

/** 이 거리(px)보다 많이 움직이면 탭이 아니라 화면 돌리기로 본다 */
const TAP_MOVE_PX = 6;
const FIXTURE_COLOR = 0x5b6478;
const REMOVE_COLOR = 0xe0603a;
const SELECTED_COLOR = 0xffe14d;
const MARKER_COLOR = 0x3350e8;

type Mode = 'tap' | 'draw' | null;

const AI_MESSAGE = 'AI가 원래 가구';

/**
 * 방에 원래 있는 가구(스캔에 찍힌 침대·옷장 등)를 표시한다. 새 가구는 이 자리를 피하고, 겹치면 배치 검사가 알려 준다.
 * 넣는 방법: 3D 화면에서 가구 윗면의 마주 보는 두 모서리를 탭하거나(높이도 함께 잰다), 평면도에서 사각형을 그리거나,
 * AI가 위에서 내려다본 그림에서 찾은 후보를 받아 확인한다.
 * 좌표는 방 좌표(바닥 y=0, m)이고 보정 후에는 월드 좌표와 같다.
 */
export default function FixturesTool({
  slots,
  engineRef,
  floorPolygon,
  initial,
  editable,
  locked = false,
  onSave,
  onChange,
  onLook,
  onPlanDraw,
  detect,
  auto,
  shown = true,
}: {
  slots: Slots;
  engineRef: RefObject<Engine | null>;
  floorPolygon: Point2[];
  /** 저장돼 있던 원래 가구. 처음 한 번만 읽는다 */
  initial: Fixture[];
  /** 넣고 고칠 수 있는지 (방 주인) */
  editable: boolean;
  /** 보정을 아직 저장하지 않아 넣을 수 없는 상태 */
  locked?: boolean;
  /** 저장한다. 성공하면 true */
  onSave?: (fixtures: Fixture[]) => Promise<boolean>;
  /** 넣거나 고칠 때마다 알린다 (저장 전이라도 가구 검사에 바로 반영하려고) */
  onChange?: (fixtures: Fixture[]) => void;
  /** 3D로 보게 했음을 알린다 (평면도를 보고 있었다면 3D로) */
  onLook?: () => void;
  /** 평면도에서 사각형 그리기를 켜고 끈다 (handler가 null이면 끔). 켜면 평면도를 연다 */
  onPlanDraw?: (handler: ((a: Point2, b: Point2) => void) | null) => void;
  /** AI로 원래 가구 후보 찾기 (주면 버튼이 생긴다). remaining은 오늘 남은 AI 횟수 */
  detect?: { roomId: string; remaining: number | null; onRemaining: (remaining: number) => void };
  /** "AI로 방 준비하기": 이 신호가 오면 스스로 한 번 AI로 찾고 결과를 알린다 (bundleOf: 같은 1회로 셀 문·창문 찾기 호출) */
  auto?: AutoDetect;
  /** 3D에 원래 가구 상자를 보일지 (사용자가 끌 수 있다). 이 도구를 쓰는 중에는 꺼 두었어도 보인다 */
  shown?: boolean;
}) {
  const [fixtures, setFixtures] = useState<Fixture[]>(initial);
  const [saved, setSaved] = useState<Fixture[]>(initial);
  const [savePhase, setSavePhase] = useState<'idle' | 'saving' | 'error'>('idle');
  const [mode, setMode] = useState<Mode>(null);
  const [firstPoint, setFirstPoint] = useState<[number, number, number] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // AI로 찾는 중이면 캡처 진행 상황, 그리고 AI가 넣은 것들의 id (저장하거나 지울 때까지 "AI" 표시)
  const [detecting, setDetecting] = useState<{ done: number; total: number } | null>(null);
  const [aiIds, setAiIds] = useState<string[]>([]);
  const open = slots.active === 'fixtures';
  const editing = editable && open && !locked;
  const dirty = !sameFixtures(fixtures, saved);
  const saveState = savePhase === 'saving' ? 'saving' : !dirty ? 'saved' : savePhase === 'error' ? 'error' : 'dirty';

  // 화면 탭·평면도 그리기 처리에서 최신 값을 쓰기 위한 참조
  const fixturesRef = useRef(fixtures);
  const onChangeRef = useRef(onChange);
  const onPlanDrawRef = useRef(onPlanDraw);
  useEffect(() => {
    fixturesRef.current = fixtures;
    onChangeRef.current = onChange;
    onPlanDrawRef.current = onPlanDraw;
  });

  /** 목록을 바꾸고 바깥(가구 검사)에 알린다 */
  const commit = (next: Fixture[]) => {
    fixturesRef.current = next;
    setFixtures(next);
    onChangeRef.current?.(next);
  };

  /** 새 원래 가구를 넣는다 (화면 탭·평면도 그리기 공통) */
  const addFrom = (a: Point2, b: Point2, h: number, how: string) => {
    const made = fixtureFromCorners(a, b, h, floorPolygon, fixturesRef.current);
    if (!made.ok) {
      setMessage(made.message);
      return;
    }
    commit([...fixturesRef.current, made.fixture]);
    setSelectedId(made.fixture.id);
    const f = made.fixture;
    setMessage(`${how} 원래 가구를 넣었습니다 (${Math.round(f.w * 100)}×${Math.round(f.d * 100)} cm, 높이 ${f.h.toFixed(2)} m). 아래 목록에서 이름과 높이를 확인하세요.`);
  };

  // 도구를 떠나면 찍기·그리기를 멈춘다 (돌아와도 다시 켜지지 않게, 이전 렌더와 비교해 바로 바꾼다)
  const [wasEditing, setWasEditing] = useState(editing);
  if (wasEditing !== editing) {
    setWasEditing(editing);
    if (!editing) {
      setMode(null);
      setFirstPoint(null);
    }
  }
  const activeMode: Mode = editing ? mode : null;

  // 평면도 그리기를 켜고 끈다
  useEffect(() => {
    if (activeMode !== 'draw') return;
    onPlanDrawRef.current?.((a, b) => addFrom(a, b, DEFAULT_FIXTURE_HEIGHT, '평면도에 그린'));
    return () => onPlanDrawRef.current?.(null);
    // addFrom은 참조(ref)로 최신 값을 읽으므로 모드가 바뀔 때만 다시 건다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMode]);

  // 원래 가구를 3D에 상자 테두리로 표시 (치울 가구는 주황, 고른 것은 노랑). 스플랫에 가려지지 않게 앞에 그린다
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const group = new THREE.Group();
    const disposables: { dispose: () => void }[] = [];
    const overlay = { depthTest: false, transparent: true };
    for (const f of fixtures) {
      const color = f.id === selectedId && open ? SELECTED_COLOR : f.remove ? REMOVE_COLOR : FIXTURE_COLOR;
      const box = new THREE.BoxGeometry(f.w, f.h, f.d);
      const fillMaterial = new THREE.MeshBasicMaterial({ color, opacity: f.remove ? 0.08 : 0.16, depthWrite: false, ...overlay });
      const fill = new THREE.Mesh(box, fillMaterial);
      const edgeGeometry = new THREE.EdgesGeometry(box);
      const edgeMaterial = new THREE.LineBasicMaterial({ color, opacity: 0.95, ...overlay });
      const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      for (const part of [fill, edges]) {
        part.position.set(f.x, f.h / 2, f.z);
        part.rotation.y = THREE.MathUtils.degToRad(f.rotationDeg);
        part.renderOrder = 980;
        group.add(part);
      }
      disposables.push(box, fillMaterial, edgeGeometry, edgeMaterial);
    }
    if (firstPoint && activeMode === 'tap') {
      const markerGeometry = new THREE.SphereGeometry(0.04, 16, 12);
      const markerMaterial = new THREE.MeshBasicMaterial({ color: MARKER_COLOR, ...overlay });
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.set(...firstPoint);
      marker.renderOrder = 981;
      group.add(marker);
      disposables.push(markerGeometry, markerMaterial);
    }
    group.userData.fixtures = true;
    group.visible = shown || open;
    engine.scene.add(group);
    return () => {
      engine.scene.remove(group);
      disposables.forEach((d) => d.dispose());
    };
  }, [engineRef, fixtures, selectedId, open, firstPoint, activeMode, shown]);

  // 3D 화면에서 가구 윗면의 마주 보는 두 모서리 찍기
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || activeMode !== 'tap') return;
    const el = engine.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > TAP_MOVE_PX || !engine.splat) return;
      const hit = pickPoint(engine.camera, pointerToNdc(e, el), engine.splat);
      if (!hit) {
        setMessage('여기서는 표면을 찾지 못했어요. 가구 윗면의 모서리를 다시 탭해 주세요.');
        return;
      }
      const { x, y, z } = hit.point;
      if (!firstPoint) {
        setFirstPoint([x, y, z]);
        setMessage(null);
        return;
      }
      setFirstPoint(null);
      addFrom([firstPoint[0], firstPoint[2]], [x, z], heightFromTaps(firstPoint[1], y), '찍은');
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
    };
    // addFrom은 참조로 최신 값을 읽는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineRef, activeMode, firstPoint, floorPolygon]);

  const switchMode = (next: Exclude<Mode, null>) => {
    const stop = mode === next;
    setMode(stop ? null : next);
    setFirstPoint(null);
    setMessage(null);
    if (!stop && next === 'tap') onLook?.();
  };

  const change = (id: string, patch: Partial<Pick<Fixture, 'label' | 'h' | 'remove'>>) => {
    commit(updateFixture(fixtures, id, patch));
    setMessage(null);
  };

  const remove = (id: string) => {
    commit(fixtures.filter((f) => f.id !== id));
    if (selectedId === id) setSelectedId(null);
    setAiIds((ids) => ids.filter((i) => i !== id));
    setMessage(null);
  };

  /** AI가 찾은 후보를 목록에 넣는다. 이미 있는 것과 겹치는 후보는 뺀다. 저장은 사용자가 확인한 뒤 직접 한다 */
  const detectFixtures = async (bundleOf?: string): Promise<AutoDetectResult> => {
    const engine = engineRef.current;
    if (!engine || !detect || detecting) return { ok: false, found: 0 };
    setMessage(null);
    setMode(null);
    setFirstPoint(null);
    setDetecting({ done: 0, total: 0 });
    const outcome = await requestFixturesDetection(engine, detect.roomId, floorPolygon, (done, total) => setDetecting({ done, total }), bundleOf);
    setDetecting(null);
    if (!outcome.ok) {
      if (outcome.code === 'AI_LIMIT') detect.onRemaining(0);
      setMessage(outcome.message);
      return { ok: false, found: 0, message: outcome.message };
    }
    if (outcome.remaining !== null) detect.onRemaining(outcome.remaining);
    const { fixtures: next, added, skipped } = addCandidates(fixturesRef.current, outcome.candidates);
    if (added.length === 0) {
      setMessage(skipped > 0 ? 'AI가 찾은 것은 모두 이미 넣은 원래 가구와 겹칩니다.' : 'AI가 원래 가구를 찾지 못했습니다. 직접 넣어 주세요.');
      return { ok: true, found: 0 };
    }
    commit(next);
    setAiIds((ids) => [...ids, ...added.map((f) => f.id)]);
    setSelectedId(null);
    setMessage(
      `${AI_MESSAGE} ${added.length}개를 찾아 넣었습니다${skipped > 0 ? ` (이미 있는 것과 겹치거나 넘치는 ${skipped}개는 뺌)` : ''}. 3D 화면과 평면도에서 자리·이름·높이를 확인하고, 틀린 것은 고치거나 지운 뒤 저장하세요.`,
    );
    return { ok: true, found: added.length };
  };

  // "AI로 방 준비하기": 신호마다 한 번만 (개발 모드에서 effect가 두 번 돌아도)
  const autoRan = useRef<string | null>(null);
  const runDetect = useRef(detectFixtures);
  useEffect(() => {
    runDetect.current = detectFixtures;
  });
  const canDetect = editable && !locked && Boolean(detect);
  useEffect(() => {
    if (!auto || !canDetect || autoRan.current === auto.token) return;
    autoRan.current = auto.token;
    const { token, bundleOf, onDone } = auto;
    let started = false;
    const timer = setTimeout(() => {
      started = true;
      void runDetect.current(bundleOf).then(onDone);
    }, 0);
    return () => {
      clearTimeout(timer);
      if (!started && autoRan.current === token) autoRan.current = null;
    };
  }, [auto, canDetect]);

  const lookAt = (f: Fixture) => {
    const engine = engineRef.current;
    if (!engine) return;
    const view = fixtureViewpoint(f, floorPolygon);
    engine.camera.position.set(...view.position);
    engine.controls.target.set(...view.target);
    engine.controls.update();
    setSelectedId(f.id);
    onLook?.();
  };

  const save = async () => {
    if (!onSave || savePhase === 'saving') return;
    const snapshot = fixtures;
    setSavePhase('saving');
    const ok = await onSave(snapshot);
    if (ok) {
      setSaved(snapshot);
      setAiIds([]);
    }
    setSavePhase(ok ? 'idle' : 'error');
  };

  const active = fixtures.filter((f) => !f.remove).length;
  const fieldClass = 'h-9 rounded-[10px] border border-field bg-surface px-2 text-[13px]';

  return (
    <ToolPanel slots={slots} tool="fixtures" data-testid="fixtures" data-count={fixtures.length} data-json={JSON.stringify(fixtures)} data-mode={activeMode ?? ''}>
      <PanelBody>
        <div className="flex flex-col gap-1.5">
          <PanelTitle
            right={
              editable &&
              onSave &&
              !locked && (
                <SaveStatePill
                  state={saveState}
                  testId="fixtures-save-state"
                  labels={{ saved: '저장됨', dirty: '저장 안 됨', saving: '저장하는 중…', error: '저장하지 못했습니다' }}
                />
              )
            }
          >
            원래 가구 <span className="font-mono font-medium text-mute">{fixtures.length}</span>
          </PanelTitle>
          <p className="text-[13px] text-sub">
            {fixtures.length === 0
              ? editable
                ? '방에 원래 있는 가구(침대·옷장·냉장고 등)를 표시하면, 새 가구를 놓을 때와 AI 추천이 그 자리를 피합니다.'
                : '이 방에는 표시된 원래 가구가 없습니다.'
              : `${active}개는 새 가구가 피해 가고${fixtures.length > active ? `, ${fixtures.length - active}개는 치울 가구로 보고 없는 것처럼 배치합니다` : '고, 겹치면 배치 검사가 알려 줍니다'}.`}
          </p>
        </div>

        {locked && editable && (
          <p className="rounded-xl bg-warn-soft px-3.5 py-3 text-[13px] text-warn" data-testid="fixtures-locked">
            보정을 저장한 뒤에 원래 가구를 넣을 수 있습니다.
          </p>
        )}

        {message && editable && !locked && (
          <p
            className={`flex gap-2.5 rounded-[14px] p-3.5 text-[13px] text-pretty ${message.startsWith(AI_MESSAGE) ? 'bg-accent-soft text-[#1a2140]' : 'bg-warn-tint text-warn'}`}
            data-testid="fixtures-message"
          >
            {message.startsWith(AI_MESSAGE) && <AiBadge className="mt-0.5 self-start" />}
            <span>{message}</span>
          </p>
        )}

        {editable && !locked && (
          <div className="flex flex-col gap-2.5">
            <SectionTitle>넣기</SectionTitle>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['tap', 'target', '3D에서 두 모서리 찍기', 'fixtures-tap'],
                  ['draw', 'plus', '평면도에 그리기', 'fixtures-draw'],
                ] as const
              ).map(([m, icon, label, testId]) => {
                const on = mode === m;
                return (
                  <button
                    key={m}
                    className={`flex h-[42px] items-center justify-center gap-1.5 rounded-xl px-2 text-[13px] font-medium ${on ? 'bg-warn-soft font-semibold text-warn' : 'border border-dashed border-field text-body hover:bg-soft'}`}
                    onClick={() => switchMode(m)}
                    data-testid={testId}
                    aria-pressed={on}
                  >
                    <Icon name={on ? 'close' : icon} />
                    {on ? '그만' : label}
                  </button>
                );
              })}
            </div>
            {mode === 'tap' && (
              <p className="rounded-[10px] bg-warn-tint px-3 py-2 text-[13px] text-warn" data-testid="fixtures-tap-hint">
                {firstPoint ? '같은 가구 윗면의 반대쪽(대각선) 모서리를 탭하세요.' : '가구 윗면의 한쪽 모서리를 탭하세요. 높이도 함께 잽니다.'}
              </p>
            )}
            {mode === 'draw' && (
              <p className="rounded-[10px] bg-warn-tint px-3 py-2 text-[13px] text-warn" data-testid="fixtures-draw-hint">
                평면도에서 가구가 있는 자리를 끌어 사각형을 그리세요. 여러 개를 이어서 그릴 수 있습니다.
              </p>
            )}
          </div>
        )}

        {!(locked && editable) && fixtures.length > 0 && (
          <ul className="flex flex-col gap-1.5" data-testid="fixtures-list">
            {fixtures.map((f) => {
              const fromAi = aiIds.includes(f.id);
              return (
                <li
                  key={f.id}
                  className={`flex flex-col gap-1.5 rounded-xl border p-2 ${f.id === selectedId || fromAi ? 'border-accent-line bg-accent-tint' : 'border-line'}`}
                  data-id={f.id}
                  data-remove={f.remove}
                  data-ai={fromAi}
                  onClick={() => setSelectedId(f.id)}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] ${f.remove ? 'bg-[#fde4dc] text-[#c4471f]' : 'bg-chip text-body'}`}
                      aria-hidden="true"
                    >
                      <Icon name="cube" size={18} />
                    </span>
                    {editable && !locked ? (
                      <select className={`${fieldClass} min-w-0 flex-1`} value={f.label} onChange={(e) => change(f.id, { label: e.target.value })} aria-label={`${f.id} 이름`} data-testid="fixture-label">
                        {[...new Set([f.label, ...FIXTURE_LABELS])].map((label) => (
                          <option key={label} value={label}>
                            {label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{f.label}</span>
                    )}
                    {fromAi && (
                      <span className="shrink-0 rounded-md bg-accent px-1.5 py-px font-mono text-[10px] font-medium text-white" data-testid="fixtures-ai-tag">
                        AI
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-[11px] text-mute">
                      {Math.round(f.w * 100)}×{Math.round(f.d * 100)}
                    </span>
                    <button className="btn btn-soft h-9 w-9 text-sub" onClick={() => lookAt(f)} aria-label={`${describeFixture(f)} 3D에서 보기`} title="3D에서 보기">
                      <Icon name="target" />
                    </button>
                    {editable && !locked && (
                      <button className="btn btn-danger h-9 w-9" onClick={() => remove(f.id)} aria-label={`${describeFixture(f)} 삭제`} title="삭제">
                        <Icon name="close" size={11} />
                      </button>
                    )}
                  </div>
                  {editable && !locked ? (
                    <div className="flex items-center gap-2 pl-10">
                      <label className="flex items-center gap-1.5 text-xs font-semibold text-body">
                        높이
                        <input
                          className="field h-8 w-[72px] rounded-lg px-2 font-mono text-[13px] font-normal"
                          type="number"
                          min={0.05}
                          max={MAX_FIXTURE_HEIGHT}
                          step={0.05}
                          value={f.h}
                          onChange={(e) => change(f.id, { h: Number(e.target.value) })}
                          data-testid="fixture-height"
                        />
                        m
                      </label>
                      <label className="ml-auto flex items-center gap-1.5 text-xs font-semibold text-body">
                        <input type="checkbox" checked={f.remove} onChange={(e) => change(f.id, { remove: e.target.checked })} data-testid="fixture-remove" />
                        치울 가구
                      </label>
                    </div>
                  ) : (
                    <span className="pl-10 text-xs text-sub">
                      높이 {f.h.toFixed(2)} m{f.remove ? ' · 치울 가구' : ''}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </PanelBody>

      {editable && !locked && (detect || (onSave && saveState !== 'saved')) && (
        <PanelFooter>
          {detect && (
            <div className="flex flex-col gap-2.5" data-testid="fixtures-detect" data-remaining={detect.remaining ?? ''} data-busy={detecting !== null}>
              <p className="text-xs text-pretty text-sub">
                방을 위에서 내려다본 그림을 Google Gemini로 보내 원래 가구 후보를 찾습니다. 틀리거나 빠뜨릴 수 있으니 꼭 확인하세요.
                {detect.remaining !== null ? ` 오늘 ${detect.remaining}회 남음.` : ''}
              </p>
            </div>
          )}
          <div className="flex gap-2">
            {detect && (
              <button
                className="btn h-11 min-w-0 flex-1 border border-accent-line bg-surface px-2 text-sm text-accent-strong hover:bg-accent-tint"
                disabled={detecting !== null || detect.remaining === 0}
                onClick={() => void detectFixtures()}
                data-testid="fixtures-detect-run"
              >
                {detecting === null && 'AI로 찾기'}
                {detecting !== null && detecting.done < detecting.total && `위에서 캡처 중 (${detecting.done}/${detecting.total})`}
                {detecting !== null && detecting.done >= detecting.total && (detecting.total === 0 ? '준비 중…' : 'AI가 찾는 중… (10~30초)')}
              </button>
            )}
            {onSave && saveState !== 'saved' && (
              <button className="btn btn-primary h-11 flex-1 text-sm" disabled={saveState === 'saving'} onClick={save} data-testid="fixtures-save">
                {saveState === 'error' ? '다시 저장' : '저장'}
              </button>
            )}
          </div>
        </PanelFooter>
      )}
    </ToolPanel>
  );
}
