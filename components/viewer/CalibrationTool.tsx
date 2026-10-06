'use client';

import { useEffect, useMemo, useState, type RefObject } from 'react';
import * as THREE from 'three';
import {
  applyRoomTransform,
  IDENTITY_ROOM_TRANSFORM,
  invertRoomTransform,
  RoomTransformError,
  setObjectRoomTransform,
  type RoomTransform,
} from '@/lib/three/roomTransform';
import {
  calibrateRoomFromTaps,
  fitFloorPlane,
  projectToFloor,
  type FloorPlane,
  type TapCalibration,
} from '@/lib/three/floorPlane';
import { pickPoint, pointerToNdc } from '@/lib/three/pickPoint';
import Icon from '@/components/ui/Icon';
import type { Engine } from './engine';
import { PanelBody, PanelFooter, PanelTitle, SaveStatePill, SectionTitle, ToolPanel, type Slots } from './workspace';

/** 이 거리(px)보다 많이 움직이면 탭이 아니라 화면 돌리기로 본다. */
const TAP_MOVE_PX = 6;
const FLOOR_TAPS = 3;
const MIN_CORNERS = 3;
const MAX_CORNERS = 32;
const FLOOR_COLOR = 0x141a2a;
const CORNER_COLORS = [0xff5a5a, 0xffb020, 0x3ecf6e, 0x4c9bff, 0xc77dff, 0x2ec4b6, 0xff8fab, 0xd4e157];
const cornerColor = (i: number) => CORNER_COLORS[i % CORNER_COLORS.length];
const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

type Tap = {
  /** 스플랫 원본 좌표 (roomGroup이 단위 변환일 때의 좌표) */
  p: THREE.Vector3;
  /** 마커 반지름 (원본 좌표 단위) */
  r: number;
  /** 찍을 때의 카메라 위치. 바닥의 위쪽 방향을 정하는 데 쓴다. */
  cam: THREE.Vector3;
};

const describeError = (err: unknown) => (err instanceof RoomTransformError ? err.message : String(err));
const mean = (points: THREE.Vector3[]) =>
  points.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(points.length);

export type AppliedCalibration = { transform: RoomTransform; floorPolygon: [number, number][] };
type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export default function CalibrationTool({
  slots,
  engineRef,
  onApplied,
  initial = null,
  onSave,
}: {
  /** 패널을 그려 넣을 자리. 이 도구를 골랐을 때만 화면을 탭해 점을 찍을 수 있다 */
  slots: Slots;
  engineRef: RefObject<Engine | null>;
  /** 보정을 적용하면 방 평면도([x, z], m)를, 되돌리면 null을 알린다 */
  onApplied?: (floorPolygon: [number, number][] | null) => void;
  /** 방에 저장돼 있던 보정. 뷰어가 이미 적용해 둔 상태로 시작한다 */
  initial?: AppliedCalibration | null;
  /** 주면 적용 후 "저장" 버튼이 생긴다. 저장에 성공하면 true */
  onSave?: (calibration: AppliedCalibration) => Promise<boolean>;
}) {
  const active = slots.active === 'calibration';
  const [taps, setTaps] = useState<Tap[]>([]);
  // 모서리를 다 찍었는지 (모서리 수가 정해져 있지 않으므로 사용자가 알려준다)
  const [cornersDone, setCornersDone] = useState(false);
  // 벽을 직각으로 맞출지
  const [square, setSquare] = useState(true);
  const [length, setLength] = useState('');
  const [applied, setApplied] = useState<RoomTransform | null>(initial?.transform ?? null);
  const [appliedPolygon, setAppliedPolygon] = useState<[number, number][] | null>(initial?.floorPolygon ?? null);
  const [saveState, setSaveState] = useState<SaveState>(initial ? 'saved' : 'dirty');
  const [message, setMessage] = useState<string | null>(null);

  const floorCount = Math.min(taps.length, FLOOR_TAPS);
  const cornerCount = Math.max(0, taps.length - FLOOR_TAPS);
  const picking = active && !applied && (taps.length < FLOOR_TAPS || (!cornersDone && cornerCount < MAX_CORNERS));

  // 탭 → 스플랫 표면의 점 추가
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !picking) return;
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
      setMessage(null);
      const tap: Tap = {
        p: engine.roomGroup.worldToLocal(hit.point.clone()),
        r: hit.distance * 0.012,
        cam: engine.roomGroup.worldToLocal(engine.camera.position.clone()),
      };
      setTaps((prev) => (prev.length >= FLOOR_TAPS + MAX_CORNERS ? prev : [...prev, tap]));
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
    };
  }, [engineRef, picking]);

  // 바닥 평면과 바닥으로 내린 모서리
  const floor = useMemo<{ plane: FloorPlane | null; corners: THREE.Vector3[]; error: string | null }>(() => {
    if (taps.length < FLOOR_TAPS) return { plane: null, corners: [], error: null };
    const floorPoints = taps.slice(0, FLOOR_TAPS).map((t) => t.p);
    // 사용자는 바닥을 위에서 내려다보며 찍으므로 "바닥 점 → 카메라" 방향이 위쪽이다.
    const upHint = mean(taps.slice(0, FLOOR_TAPS).map((t) => t.cam)).sub(mean(floorPoints));
    try {
      const plane = fitFloorPlane(floorPoints, upHint);
      return { plane, corners: taps.slice(FLOOR_TAPS).map((t) => projectToFloor(t.p, plane)), error: null };
    } catch (err) {
      return { plane: null, corners: [], error: describeError(err) };
    }
  }, [taps]);

  const outcome = useMemo<{ cal: TapCalibration | null; error: string | null }>(() => {
    const realLength = Number(length);
    if (!cornersDone || cornerCount < MIN_CORNERS || !floor.plane || !length.trim() || !(realLength > 0)) {
      return { cal: null, error: null };
    }
    try {
      const cal = calibrateRoomFromTaps(
        taps.slice(0, FLOOR_TAPS).map((t) => t.p),
        taps.slice(FLOOR_TAPS).map((t) => t.p),
        realLength,
        floor.plane.normal,
        { square },
      );
      return { cal, error: null };
    } catch (err) {
      return { cal: null, error: describeError(err) };
    }
  }, [taps, length, floor.plane, cornersDone, cornerCount, square]);

  // 찍은 점 표시 (roomGroup의 자식이라 보정을 적용하면 함께 움직인다)
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || taps.length === 0) return;
    const group = new THREE.Group();
    const disposables: { dispose: () => void }[] = [];
    const overlay = { depthTest: false, transparent: true };

    const addLine = (points: THREE.Vector3[], color: number, opacity = 1) => {
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color, opacity, ...overlay });
      const line = new THREE.Line(geometry, material);
      line.renderOrder = 999;
      group.add(line);
      disposables.push(geometry, material);
    };

    taps.forEach((tap, i) => {
      const isFloor = i < FLOOR_TAPS;
      const geometry = new THREE.SphereGeometry(isFloor ? tap.r * 0.7 : tap.r, 16, 12);
      const material = new THREE.MeshBasicMaterial({
        color: isFloor ? FLOOR_COLOR : cornerColor(i - FLOOR_TAPS),
        ...overlay,
      });
      const marker = new THREE.Mesh(geometry, material);
      marker.position.copy(tap.p);
      marker.renderOrder = 1000;
      group.add(marker);
      disposables.push(geometry, material);
    });

    // 모서리 탭 → 바닥으로 내린 점까지의 세로선, 바닥 위의 방 외곽선
    floor.corners.forEach((corner, i) => {
      addLine([taps[FLOOR_TAPS + i].p, corner], cornerColor(i), 0.8);
    });
    if (floor.corners.length >= 2) {
      const outline = [...floor.corners];
      if (cornersDone) outline.push(floor.corners[0]);
      addLine(outline, 0x3350e8);
    }

    engine.roomGroup.add(group);
    return () => {
      engine.roomGroup.remove(group);
      disposables.forEach((d) => d.dispose());
    };
  }, [engineRef, taps, floor.corners, cornersDone]);

  // 보정 적용 후 바닥(y=0)에 1m 격자 표시 (이 도구를 보고 있을 때만)
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !applied || !active) return;
    const grid = new THREE.GridHelper(20, 20, 0x3350e8, 0x6b7588);
    grid.position.y = 0.01;
    const material = grid.material as THREE.Material;
    material.transparent = true;
    material.opacity = 0.6;
    engine.scene.add(grid);
    return () => {
      engine.scene.remove(grid);
      grid.geometry.dispose();
      material.dispose();
    };
  }, [engineRef, applied, active]);

  // 도구가 사라질 때(다른 파일을 열 때 등) 보정을 되돌린다.
  // 저장된 보정으로 시작했다면 다시 적용해 둔다 (개발 모드에서는 이 effect가 두 번 돌면서 한 번 되돌려지기 때문).
  useEffect(() => {
    const engine = engineRef.current;
    if (engine && initial) setObjectRoomTransform(engine.roomGroup, initial.transform);
    return () => {
      if (engine) setObjectRoomTransform(engine.roomGroup, IDENTITY_ROOM_TRANSFORM);
    };
    // 처음 한 번만: initial은 방을 열 때의 값이고 이후에는 바뀌지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineRef]);

  const moveCamera = (engine: Engine, map: (p: THREE.Vector3) => THREE.Vector3) => {
    engine.camera.position.copy(map(engine.camera.position));
    engine.controls.target.copy(map(engine.controls.target));
    engine.controls.update();
  };

  const apply = () => {
    const engine = engineRef.current;
    if (!engine || !outcome.cal) return;
    const tr = outcome.cal.transform;
    // 보는 장면이 그대로 유지되도록 카메라도 같은 변환으로 옮긴다.
    moveCamera(engine, (p) => applyRoomTransform(p, tr));
    setObjectRoomTransform(engine.roomGroup, tr);
    engine.camera.near = 0.05;
    engine.camera.far = 200;
    engine.camera.updateProjectionMatrix();
    setApplied(tr);
    setAppliedPolygon(outcome.cal.floorPolygon);
    setSaveState('dirty');
    onApplied?.(outcome.cal.floorPolygon);
  };

  const reset = () => {
    const engine = engineRef.current;
    if (engine && applied) {
      moveCamera(engine, (p) => invertRoomTransform(p, applied));
      setObjectRoomTransform(engine.roomGroup, IDENTITY_ROOM_TRANSFORM);
    }
    setApplied(null);
    setAppliedPolygon(null);
    setSaveState('dirty');
    onApplied?.(null);
    setTaps([]);
    setCornersDone(false);
    setMessage(null);
  };

  // "파일 단위 그대로": 크기 배율이 1이 되는 벽 1의 길이를 채운다 (직각으로 맞추면 벽 1의 길이가 찍은 두 점 사이와 조금 다르다)
  const keepScale = () => {
    if (!floor.plane || cornerCount < MIN_CORNERS) return;
    try {
      const probe = calibrateRoomFromTaps(
        taps.slice(0, FLOOR_TAPS).map((t) => t.p),
        taps.slice(FLOOR_TAPS).map((t) => t.p),
        1,
        floor.plane.normal,
        { square },
      );
      setLength((probe.wallLengths[0] / probe.transform.s).toFixed(3));
    } catch {
      setLength(floor.corners[0].distanceTo(floor.corners[1]).toFixed(3));
    }
  };

  const save = async () => {
    if (!onSave || !applied || !appliedPolygon || saveState === 'saving') return;
    setSaveState('saving');
    const ok = await onSave({ transform: applied, floorPolygon: appliedPolygon });
    setSaveState(ok ? 'saved' : 'error');
  };

  const cal = outcome.cal;
  const step = taps.length < FLOOR_TAPS ? 1 : !cornersDone ? 2 : cal ? 4 : 3;
  const dot = (filled: boolean, color: number, key: number) => (
    <span key={key} className="inline-block h-3 w-3 rounded-full border border-line-strong" style={{ background: filled ? hex(color) : 'transparent' }} />
  );
  const stepCard = (n: number) => `flex gap-3 rounded-xl p-3 ${step === n ? 'bg-accent-soft' : 'bg-ground'}`;
  const stepNumber = (n: number) => (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-xs font-medium ${
        step > n ? 'bg-ok-soft text-ok' : step === n ? 'bg-accent text-white' : 'bg-surface text-mute'
      }`}
    >
      {step > n ? <Icon name="check" /> : n}
    </span>
  );
  const walls = appliedPolygon
    ? appliedPolygon.map((p, i) => {
        const q = appliedPolygon[(i + 1) % appliedPolygon.length];
        return Math.hypot(q[0] - p[0], q[1] - p[1]);
      })
    : [];

  // 적용한 뒤: 저장과 다시 찍기
  if (applied) {
    return (
      <ToolPanel slots={slots} tool="calibration" data-testid="calibration-panel" data-applied>
        <PanelBody>
          <PanelTitle
            right={
              onSave && (
                <SaveStatePill
                  state={saveState}
                  testId="calibration-save-state"
                  labels={{ saved: '저장됨', dirty: '저장 안 됨', saving: '저장 중…', error: '저장 실패' }}
                />
              )
            }
          >
            크기 보정
          </PanelTitle>
          <p className="flex gap-2.5 rounded-xl bg-ok-soft p-3.5 text-[13px] text-ok">
            <Icon name="check" className="mt-1" />
            <span>보정 적용됨 · 격자 한 칸 1m. 이제 가구를 실제 크기로 놓을 수 있습니다.</span>
          </p>
          {walls.length > 0 && (
            <div className="flex flex-col gap-2.5">
              <SectionTitle right={<span className="font-mono text-[11px] text-mute">m</span>}>
                벽 길이 <span className="font-mono font-medium text-mute">{walls.length}</span>
              </SectionTitle>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-ground p-3 text-[13px]">
                {walls.map((length, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="text-body">벽 {i + 1}</span>
                    <span className="font-mono">{length.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-sub">다시 찍으면 화면의 보정이 풀립니다. 새로 저장하기 전까지는 저장된 값이 그대로 남습니다.</p>
        </PanelBody>
        <PanelFooter>
          <div className="flex gap-2">
            <button className="btn btn-outline h-11 flex-1 text-sm" onClick={reset}>
              다시 찍기
            </button>
            {onSave && saveState !== 'saved' && (
              <button className="btn btn-primary h-11 flex-1 text-sm" disabled={saveState === 'saving'} onClick={save} data-testid="calibration-save">
                {saveState === 'error' ? '다시 저장' : '저장'}
              </button>
            )}
          </div>
        </PanelFooter>
      </ToolPanel>
    );
  }

  return (
    <ToolPanel slots={slots} tool="calibration" data-testid="calibration-panel">
      <PanelBody>
        <div className="flex flex-col gap-1.5">
          <PanelTitle>크기 보정</PanelTitle>
          <p className="text-[13px] text-sub">3D 화면을 탭해서 바닥과 방 모서리를 알려 주세요. 방이 미터 단위가 되면 가구를 실제 크기로 놓을 수 있습니다.</p>
        </div>

        <ol className="flex flex-col gap-2 text-[13px]">
          <li className={stepCard(1)}>
            {stepNumber(1)}
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="font-semibold">
                바닥이 보이는 곳 세 군데를 탭 ({floorCount}/{FLOOR_TAPS})
              </span>
              <span className="text-body">서로 멀리 떨어진 곳일수록 정확합니다.</span>
              <span className="flex gap-1">{Array.from({ length: FLOOR_TAPS }, (_, i) => dot(i < floorCount, FLOOR_COLOR, i))}</span>
            </div>
          </li>
          <li className={stepCard(2)}>
            {stepNumber(2)}
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="font-semibold">
                방 모서리를 벽을 따라 차례로 탭 ({cornerCount}개 찍음, {MIN_CORNERS}개 이상)
              </span>
              <span className="text-body">바닥 모서리가 가구에 가려졌으면 두 벽이 만나는 세로 선 위 아무 높이나 찍으세요.</span>
              <span className="text-body">ㄱ자처럼 꺾인 방은 꺾이는 곳마다 찍습니다. 다 찍었으면 아래 버튼을 누르세요.</span>
              <span className="flex flex-wrap items-center gap-1">
                {Array.from({ length: Math.max(cornerCount, 4) }, (_, i) => dot(i < cornerCount, cornerColor(i), i))}
              </span>
              {!cornersDone && (
                <button
                  type="button"
                  className="btn btn-primary h-10 self-start px-4 text-[13px]"
                  disabled={cornerCount < MIN_CORNERS}
                  onClick={() => setCornersDone(true)}
                  data-testid="calibration-corners-done"
                >
                  모서리 다 찍음
                </button>
              )}
            </div>
          </li>
          <li className={stepCard(3)}>
            {stepNumber(3)}
            <div className="flex min-w-0 flex-col gap-1.5">
              <label className="font-semibold" htmlFor="calibration-length">
                벽 1(첫째→둘째 모서리)의 실제 길이
              </label>
              <span className="flex flex-wrap items-center gap-2">
                <input
                  id="calibration-length"
                  className="field h-10 w-24 rounded-[10px] px-3 font-mono text-sm"
                  inputMode="decimal"
                  placeholder="예: 3.2"
                  value={length}
                  onChange={(e) => setLength(e.target.value)}
                  data-testid="calibration-length"
                />
                <span className="font-mono text-body">m</span>
                {cornersDone && (
                  <button type="button" className="btn btn-outline h-10 px-3 text-[13px]" onClick={keepScale} data-testid="calibration-keep-scale">
                    파일 단위 그대로
                  </button>
                )}
              </span>
              <span className="text-body">줄자로 잴 수 없는 데이터셋 방은, 파일이 이미 미터 단위라면 &ldquo;파일 단위 그대로&rdquo;를 누르세요.</span>
            </div>
          </li>
          <li className={stepCard(4)}>
            {stepNumber(4)}
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="font-semibold">다른 벽 길이가 줄자 값과 맞는지 확인 후 적용</span>
              <label className="flex min-h-9 cursor-pointer items-center gap-2">
                <input type="checkbox" className="h-[18px] w-[18px] accent-accent" checked={square} onChange={(e) => setSquare(e.target.checked)} data-testid="calibration-square" />
                벽을 직각으로 맞추기
              </label>
              <span className="text-body">모서리가 가구에 가려 조금 틀리게 찍혀도 벽이 반듯하게 잡힙니다.</span>
            </div>
          </li>
        </ol>

        {message && <p className="rounded-[10px] bg-warn-tint px-3 py-2 text-[13px] text-warn">{message}</p>}
        {(floor.error ?? outcome.error) && <p className="rounded-[10px] bg-danger-tint px-3 py-2 text-[13px] text-danger">{floor.error ?? outcome.error}</p>}

        {cal && (
          <div
            className="flex flex-col gap-1 rounded-xl bg-ground p-3 font-mono text-[13px]"
            data-testid="calibration-result"
            data-json={JSON.stringify({
              wallLengths: cal.wallLengths,
              cornerHeights: cal.cornerHeights,
              scale: cal.transform.s,
              floorPolygon: cal.floorPolygon,
              floorPoints: taps.slice(0, FLOOR_TAPS).map((t) => t.p.toArray()),
              applied: applied !== null,
              squared: cal.squared,
            })}
          >
            {cal.wallLengths.map((len, i) => (
              <div key={i}>
                <span style={{ color: hex(cornerColor(i)) }}>●</span>
                <span style={{ color: hex(cornerColor((i + 1) % cal.wallLengths.length)) }}>●</span> 벽 {i + 1}: {len.toFixed(2)} m{i === 0 ? ' (입력값)' : ''}
              </div>
            ))}
            <div className="text-sub">배율: ×{cal.transform.s.toFixed(3)}</div>
            {square && !cal.squared && <div className="font-sans text-warn">비스듬한 벽이 있어 직각으로 맞추지 않고 찍은 그대로 씁니다.</div>}
          </div>
        )}
      </PanelBody>

      <PanelFooter>
        <div className="flex flex-wrap gap-2">
          {taps.length > 0 && (
            <button
              className="btn btn-outline h-11 px-3 text-[13px]"
              onClick={() => {
                setTaps((prev) => prev.slice(0, -1));
                setCornersDone(false);
              }}
            >
              마지막 점 취소
            </button>
          )}
          {taps.length > 0 && (
            <button className="btn btn-outline h-11 px-3 text-[13px]" onClick={reset}>
              다시 찍기
            </button>
          )}
          <button className="btn btn-primary h-11 min-w-20 flex-1 text-sm" disabled={!cal} onClick={apply} data-testid="calibration-apply">
            적용
          </button>
        </div>
      </PanelFooter>
    </ToolPanel>
  );
}
