'use client';

import { useEffect, useMemo, useState, type RefObject } from 'react';
import * as THREE from 'three';
import type { Point2 } from '@/lib/three/floorDrag';
import { pickPoint, pointerToNdc } from '@/lib/three/pickPoint';
import {
  addOpening,
  DEFAULT_OPENING_WIDTH,
  describeOpening,
  makeOpening,
  OPENING_HEIGHTS,
  OPENING_LABEL,
  OPENING_TYPES,
  openingFromPoints,
  openingSegment,
  sameOpenings,
  summarizeOpenings,
  wallsOf,
  type Opening,
  type OpeningType,
} from '@/lib/rooms/openings';
import type { Engine } from './engine';

/** 이 거리(px)보다 많이 움직이면 탭이 아니라 화면 돌리기로 본다. */
const TAP_MOVE_PX = 6;
const OPENING_COLORS: Record<OpeningType, number> = { door: 0xffa63d, window: 0x4cc9ff };
const WALL_HIGHLIGHT_COLOR = 0xffe14d;
const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

/**
 * 보정된 방의 문·창문을 3D에 표시하고, 방 주인이면 넣고 지우고 저장할 수 있게 한다.
 * 넣는 방법: 화면에서 양 끝 두 점을 찍거나, 벽·시작 위치·폭을 숫자로 넣는다.
 * 좌표는 방 좌표(바닥 y=0, m)이고 보정 후에는 월드 좌표와 같다.
 */
export default function OpeningsTool({
  engineRef,
  floorPolygon,
  initial,
  editable,
  locked = false,
  onSave,
  onChange,
}: {
  engineRef: RefObject<Engine | null>;
  floorPolygon: Point2[];
  /** 저장돼 있던 문·창문. 처음 한 번만 읽는다 */
  initial: Opening[];
  /** 넣고 지울 수 있는지 (방 주인) */
  editable: boolean;
  /** 보정을 아직 저장하지 않아 문·창문을 넣을 수 없는 상태 */
  locked?: boolean;
  /** 저장한다. 성공하면 true */
  onSave?: (openings: Opening[]) => Promise<boolean>;
  /** 넣거나 지울 때마다 알린다 (저장 전이라도 가구 검사에 바로 반영하려고) */
  onChange?: (openings: Opening[]) => void;
}) {
  const [openings, setOpenings] = useState<Opening[]>(initial);
  const [savedOpenings, setSavedOpenings] = useState<Opening[]>(initial);
  const [savePhase, setSavePhase] = useState<'idle' | 'saving' | 'error'>('idle');
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<OpeningType>('door');
  const [wallIndex, setWallIndex] = useState(0);
  const [from, setFrom] = useState('');
  const [width, setWidth] = useState(DEFAULT_OPENING_WIDTH.door.toFixed(2));
  const [picking, setPicking] = useState(false);
  const [firstPoint, setFirstPoint] = useState<[number, number, number] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const walls = useMemo(() => wallsOf(floorPolygon), [floorPolygon]);
  const dirty = !sameOpenings(openings, savedOpenings);
  const saveState = savePhase === 'saving' ? 'saving' : !dirty ? 'saved' : savePhase === 'error' ? 'error' : 'dirty';
  const editing = editable && open && !locked;

  // 문·창문을 벽 위의 반투명 판으로 표시
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const group = new THREE.Group();
    const disposables: { dispose: () => void }[] = [];
    const overlay = { depthTest: false, transparent: true };

    for (const opening of openings) {
      const segment = openingSegment(opening, floorPolygon);
      if (!segment) continue;
      const [[x1, z1], [x2, z2]] = segment;
      const [low, high] = OPENING_HEIGHTS[opening.type];
      const corners = [
        new THREE.Vector3(x1, low, z1),
        new THREE.Vector3(x2, low, z2),
        new THREE.Vector3(x2, high, z2),
        new THREE.Vector3(x1, high, z1),
      ];
      const fillGeometry = new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
      const fillMaterial = new THREE.MeshBasicMaterial({ color: OPENING_COLORS[opening.type], opacity: 0.3, side: THREE.DoubleSide, ...overlay });
      const fill = new THREE.Mesh(fillGeometry, fillMaterial);
      fill.renderOrder = 990;
      const edgeGeometry = new THREE.BufferGeometry().setFromPoints(corners);
      const edgeMaterial = new THREE.LineBasicMaterial({ color: OPENING_COLORS[opening.type], ...overlay });
      const edge = new THREE.LineLoop(edgeGeometry, edgeMaterial);
      edge.renderOrder = 991;
      group.add(fill, edge);
      disposables.push(fillGeometry, fillMaterial, edgeGeometry, edgeMaterial);
    }

    // 넣는 중에는 고른 벽을 바닥 선으로 강조하고, 거리를 재는 시작 꼭짓점에 기둥을 세운다
    const wall = editing ? walls[wallIndex] : undefined;
    if (wall) {
      const lineGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(wall.a[0], 2.0, wall.a[1]),
        new THREE.Vector3(wall.a[0], 0.03, wall.a[1]),
        new THREE.Vector3(wall.b[0], 0.03, wall.b[1]),
      ]);
      const lineMaterial = new THREE.LineBasicMaterial({ color: WALL_HIGHLIGHT_COLOR, ...overlay });
      const line = new THREE.Line(lineGeometry, lineMaterial);
      line.renderOrder = 992;
      group.add(line);
      disposables.push(lineGeometry, lineMaterial);
    }

    if (firstPoint) {
      const markerGeometry = new THREE.SphereGeometry(0.04, 16, 12);
      const markerMaterial = new THREE.MeshBasicMaterial({ color: OPENING_COLORS[type], ...overlay });
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.set(...firstPoint);
      marker.renderOrder = 993;
      group.add(marker);
      disposables.push(markerGeometry, markerMaterial);
    }

    engine.scene.add(group);
    return () => {
      engine.scene.remove(group);
      disposables.forEach((d) => d.dispose());
    };
  }, [engineRef, openings, floorPolygon, editing, walls, wallIndex, firstPoint, type]);

  // 화면에서 양 끝 두 점 찍기
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !editing || !picking) return;
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
        setMessage('여기서는 표면을 찾지 못했어요. 다른 곳을 탭해 주세요.');
        return;
      }
      const { x, y, z } = hit.point;
      if (!firstPoint) {
        setFirstPoint([x, y, z]);
        setMessage(null);
        return;
      }
      const made = openingFromPoints(type, [firstPoint[0], firstPoint[2]], [x, z], floorPolygon);
      setFirstPoint(null);
      if (!made.ok) {
        setMessage(made.message);
        return;
      }
      setWallIndex(made.opening.wallIndex);
      setFrom(made.opening.from.toFixed(2));
      setWidth(made.opening.widthM.toFixed(2));
      setPicking(false);
      setMessage('찍은 위치를 채웠습니다. 값을 확인하고 "추가"를 누르세요.');
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
    };
  }, [engineRef, editing, picking, firstPoint, type, floorPolygon]);

  const changeType = (next: OpeningType) => {
    setType(next);
    setWidth(DEFAULT_OPENING_WIDTH[next].toFixed(2));
  };

  const togglePicking = () => {
    setPicking((prev) => !prev);
    setFirstPoint(null);
    setMessage(null);
  };

  const add = () => {
    if (!from.trim() || !width.trim()) {
      setMessage('시작 위치와 폭을 숫자로 넣어 주세요.');
      return;
    }
    const made = makeOpening(type, wallIndex, Number(from), Number(width), floorPolygon);
    if (!made.ok) {
      setMessage(made.message);
      return;
    }
    const added = addOpening(openings, made.opening);
    if (!added.ok) {
      setMessage(added.message);
      return;
    }
    setOpenings(added.openings);
    onChange?.(added.openings);
    setFrom('');
    setMessage(null);
  };

  const remove = (index: number) => {
    const next = openings.filter((_, i) => i !== index);
    setOpenings(next);
    onChange?.(next);
    setMessage(null);
  };

  const save = async () => {
    if (!onSave || savePhase === 'saving') return;
    const snapshot = openings;
    setSavePhase('saving');
    const ok = await onSave(snapshot);
    if (ok) setSavedOpenings(snapshot);
    setSavePhase(ok ? 'idle' : 'error');
  };

  const close = () => {
    setOpen(false);
    setPicking(false);
    setFirstPoint(null);
    setMessage(null);
  };

  const summary = summarizeOpenings(openings);
  const data = { 'data-testid': 'openings', 'data-count': openings.length, 'data-json': JSON.stringify(openings) };

  // 보는 사람: 문·창문이 있으면 개수만 알려준다
  if (!editable) {
    return (
      <div {...data} className="pointer-events-none absolute bottom-3 left-16 rounded bg-black/70 px-3 py-2 text-xs text-white" hidden={openings.length === 0}>
        {summary}
      </div>
    );
  }

  if (!open) {
    return (
      <div {...data} className="absolute bottom-3 left-16">
        <button className="rounded bg-black/70 px-3 py-2 text-xs text-white" onClick={() => setOpen(true)} data-testid="openings-toggle">
          문·창문 ({openings.length}){dirty ? ' · 저장 안 됨' : ''}
        </button>
      </div>
    );
  }

  return (
    <div {...data} className="absolute bottom-3 left-16 w-80 max-w-[calc(100%-5rem)] space-y-2 rounded bg-black/75 p-3 text-xs text-white">
      <div className="flex items-center justify-between">
        <strong>문·창문</strong>
        <button className="rounded bg-white/20 px-2 py-0.5" onClick={close}>
          닫기
        </button>
      </div>

      {locked ? (
        <p className="text-amber-300" data-testid="openings-locked">
          보정을 저장한 뒤에 문·창문을 넣을 수 있습니다.
        </p>
      ) : (
        <>
          {openings.length === 0 ? (
            <p className="opacity-80">아직 없습니다. 문과 창문을 넣으면 가구가 문 앞이나 통로를 막는지 검사할 수 있습니다.</p>
          ) : (
            <ul className="space-y-1" data-testid="openings-list">
              {openings.map((o, i) => (
                <li key={`${o.wallIndex}|${o.from}`} className="flex items-center justify-between gap-2">
                  <span>
                    <span style={{ color: hex(OPENING_COLORS[o.type]) }}>■</span> {describeOpening(o)}
                  </span>
                  <button className="shrink-0 rounded bg-white/20 px-2 py-0.5" onClick={() => remove(i)} aria-label={`${describeOpening(o)} 삭제`}>
                    삭제
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-1.5 border-t border-white/20 pt-2">
            <div className="flex flex-wrap items-center gap-1">
              <select className="rounded bg-white/10 px-1 py-1" value={type} onChange={(e) => changeType(e.target.value as OpeningType)} data-testid="openings-type" aria-label="종류">
                {OPENING_TYPES.map((t) => (
                  <option key={t} value={t} className="text-black">
                    {OPENING_LABEL[t]}
                  </option>
                ))}
              </select>
              <select className="rounded bg-white/10 px-1 py-1" value={wallIndex} onChange={(e) => setWallIndex(Number(e.target.value))} data-testid="openings-wall" aria-label="벽">
                {walls.map((w) => (
                  <option key={w.index} value={w.index} className="text-black">
                    벽 {w.index + 1} ({w.length.toFixed(2)} m)
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <label className="flex items-center gap-1">
                시작
                <input className="w-16 rounded bg-white/10 px-2 py-1" inputMode="decimal" placeholder="0.20" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="openings-from" />
              </label>
              <label className="flex items-center gap-1">
                폭
                <input className="w-16 rounded bg-white/10 px-2 py-1" inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)} data-testid="openings-width" />
              </label>
              <span>m</span>
              <button className="rounded bg-emerald-600 px-2 py-1" onClick={add} data-testid="openings-add">
                추가
              </button>
            </div>
            <p className="opacity-80">
              &ldquo;시작&rdquo;은 노란 기둥이 선 모서리에서 노란 선을 따라 잰 거리입니다.
            </p>
            <button className={`rounded px-2 py-1 ${picking ? 'bg-amber-500 text-black' : 'bg-white/20'}`} onClick={togglePicking} data-testid="openings-pick" aria-pressed={picking}>
              {picking ? '찍기 그만' : '화면에서 양 끝 찍기'}
            </button>
            {picking && (
              <p className="text-amber-300" data-testid="openings-pick-hint">
                {firstPoint ? `${OPENING_LABEL[type]}의 반대쪽 끝을 탭하세요.` : `${OPENING_LABEL[type]}의 한쪽 끝을 탭하세요.`}
              </p>
            )}
          </div>

          {message && (
            <p className="text-amber-300" data-testid="openings-message">
              {message}
            </p>
          )}

          {onSave && (
            <div className="flex items-center justify-between gap-2 border-t border-white/20 pt-2">
              <span data-testid="openings-save-state" data-state={saveState}>
                {saveState === 'saved' && '저장됨'}
                {saveState === 'dirty' && '저장 안 됨'}
                {saveState === 'saving' && '저장하는 중…'}
                {saveState === 'error' && '저장하지 못했습니다'}
              </span>
              {saveState !== 'saved' && (
                <button className="rounded bg-emerald-600 px-2 py-1 disabled:opacity-50" disabled={saveState === 'saving'} onClick={save} data-testid="openings-save">
                  {saveState === 'error' ? '다시 저장' : '저장'}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
