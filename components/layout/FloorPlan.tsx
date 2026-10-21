'use client';

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { doorZone } from '@/lib/layout/access';
import { dragPlacement, gridLines, planViewBox, pointsAttr, wallLabels } from '@/lib/layout/plan';
import type { PlacedItem } from '@/lib/layout/saved';
import { openingSegment, type Opening } from '@/lib/rooms/openings';
import { MIN_FIXTURE_SIZE, type Fixture } from '@/lib/rooms/fixtures';
import { footprintCorners, snapToGrid, type Footprint, type Point2 } from '@/lib/three/floorDrag';
import { ROTATE_STEP, rotationTowards, snapRotation } from '@/lib/layout/rotation';
import { furnitureTone } from '@/lib/layout/furnitureLook';

/** 이 거리(px)보다 적게 움직이면 끌기가 아니라 선택으로 본다 */
const TAP_MOVE_PX = 4;
const NO_KEYS: string[] = [];
const NO_FIXTURES: Fixture[] = [];
/** 이보다 짧은 벽에는 평면도에 번호를 적지 않는다 (m) */
const MIN_LABELED_WALL = 0.45;

type Drag = {
  id: string;
  pointerId: number;
  /** move: 끌어 옮기기, rotate: 회전 손잡이를 끌어 돌리기 */
  mode: 'move' | 'rotate';
  grab: Point2;
  startX: number;
  startY: number;
  moved: boolean;
  x: number;
  z: number;
  rotationDeg: number;
};

/** 회전 손잡이: 가구 뒤쪽 가장자리에서 이만큼 떨어진 곳 (m)과 크기 */
const HANDLE_GAP = 0.32;
const HANDLE_RADIUS = 0.11;

/** 원래 가구 사각형을 그리는 중: 누른 점과 지금 점 (5cm 격자) */
type Sketch = { pointerId: number; a: Point2; b: Point2 };

/**
 * 방을 위에서 내려다본 평면도. 가구를 눌러 고르고 끌어서 옮긴다 (3D와 같은 5cm 격자·벽 붙이기).
 * 방에 원래 있는 가구는 빗금 사각형으로 그리고, onDrawFixture를 주면 끌어서 새 사각형을 그린다 (그동안 가구는 잡히지 않는다).
 * 좌표는 방 좌표(m)를 그대로 쓴다: 오른쪽 +x, 아래쪽 +z.
 */
export default function FloorPlan({
  floorPolygon,
  items,
  openings,
  aiOpeningKeys = NO_KEYS,
  fixtures = NO_FIXTURES,
  onDrawFixture,
  badIds,
  warnIds,
  selectedId,
  onSelect,
  onMove,
  onRotate,
  onPreview,
}: {
  floorPolygon: Point2[];
  items: PlacedItem[];
  openings: Opening[];
  /** AI가 찾아 아직 확인하지 않은 문·창문 (`벽 번호|시작`). 점선으로 그린다 */
  aiOpeningKeys?: string[];
  /** 방에 원래 있는 가구 */
  fixtures?: Fixture[];
  /** 원래 가구 사각형을 그리는 중이면 그린 두 모서리를 받는다 */
  onDrawFixture?: (a: Point2, b: Point2) => void;
  /** 문제가 있는 가구 (빨강) */
  badIds: Set<string>;
  /** 경고만 있는 가구 (노랑) */
  warnIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 끌기를 마쳤을 때의 새 위치 */
  onMove: (id: string, x: number, z: number) => void;
  /** 회전 손잡이를 놓았을 때의 새 각도 */
  onRotate?: (id: string, rotationDeg: number) => void;
  /** 끄는 동안의 자리 (바로 검사해 보여 주려고). 끝나면 null */
  onPreview?: (id: string | null, pose: Footprint | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [sketch, setSketch] = useState<Sketch | null>(null);
  const drawing = Boolean(onDrawFixture);
  const snap = (p: Point2): Point2 => [snapToGrid(p[0]), snapToGrid(p[1])];

  const viewBox = useMemo(() => planViewBox(floorPolygon), [floorPolygon]);
  const grid = useMemo(() => gridLines(viewBox), [viewBox]);
  const labels = useMemo(() => wallLabels(floorPolygon), [floorPolygon]);

  /** 화면 위치(px) → 방 좌표 */
  const toPlan = (e: { clientX: number; clientY: number }): Point2 | null => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    return [p.x, p.y];
  };

  const onItemDown = (e: ReactPointerEvent<SVGPolygonElement>, item: PlacedItem) => {
    if (e.button !== 0) return;
    const point = toPlan(e);
    if (!point) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    onSelect(item.id);
    setDrag({
      id: item.id,
      pointerId: e.pointerId,
      mode: 'move',
      grab: [item.x - point[0], item.z - point[1]],
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      x: item.x,
      z: item.z,
      rotationDeg: item.rotationDeg,
    });
  };

  const onHandleDown = (e: ReactPointerEvent<SVGElement>, item: PlacedItem) => {
    if (e.button !== 0 || !onRotate) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    setDrag({ id: item.id, pointerId: e.pointerId, mode: 'rotate', grab: [0, 0], startX: e.clientX, startY: e.clientY, moved: false, x: item.x, z: item.z, rotationDeg: item.rotationDeg });
  };

  const onBackgroundDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!onDrawFixture) {
      onSelect(null);
      return;
    }
    if (e.button !== 0) return;
    const point = toPlan(e);
    if (!point) return;
    svgRef.current?.setPointerCapture(e.pointerId);
    const a = snap(point);
    setSketch({ pointerId: e.pointerId, a, b: a });
  };

  const onMovePointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (sketch && e.pointerId === sketch.pointerId) {
      const point = toPlan(e);
      if (point) setSketch({ ...sketch, b: snap(point) });
      return;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    const item = items.find((i) => i.id === drag.id);
    const point = toPlan(e);
    if (!item || !point) return;
    const moved = drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > TAP_MOVE_PX;
    if (!moved) return;
    if (drag.mode === 'rotate') {
      // Shift를 누르면 15°씩
      const rotationDeg = snapRotation(rotationTowards(point[0] - item.x, point[1] - item.z), e.shiftKey ? ROTATE_STEP : undefined);
      setDrag({ ...drag, moved, rotationDeg });
      onPreview?.(item.id, { x: item.x, z: item.z, w: item.w, d: item.d, rotationDeg });
      return;
    }
    const placed = dragPlacement(item, drag.grab, point, floorPolygon);
    setDrag({ ...drag, moved, x: placed.x, z: placed.z });
    onPreview?.(item.id, { x: placed.x, z: placed.z, w: item.w, d: item.d, rotationDeg: item.rotationDeg });
  };

  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (sketch && e.pointerId === sketch.pointerId) {
      if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
      const { a, b } = sketch;
      setSketch(null);
      // 너무 작으면(그냥 누른 것) 넣지 않는다
      if (Math.abs(b[0] - a[0]) >= MIN_FIXTURE_SIZE && Math.abs(b[1] - a[1]) >= MIN_FIXTURE_SIZE) onDrawFixture?.(a, b);
      return;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    if (drag.moved && drag.mode === 'move') onMove(drag.id, drag.x, drag.z);
    if (drag.moved && drag.mode === 'rotate') onRotate?.(drag.id, drag.rotationDeg);
    if (drag.moved) onPreview?.(null, null);
    setDrag(null);
  };

  const stroke = { vectorEffect: 'non-scaling-stroke' as const };

  return (
    <svg
      ref={svgRef}
      className={`h-full w-full touch-none select-none ${drawing ? 'cursor-crosshair' : ''}`}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="방 평면도"
      data-testid="floor-plan"
      data-drawing={drawing}
      onPointerDown={onBackgroundDown}
      onPointerMove={onMovePointer}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {/* 1m 격자 */}
      <g stroke="#e4e8ef" strokeWidth={1}>
        {grid.xs.map((x) => (
          <line key={`x${x}`} x1={x} y1={viewBox.y} x2={x} y2={viewBox.y + viewBox.height} {...stroke} />
        ))}
        {grid.zs.map((z) => (
          <line key={`z${z}`} x1={viewBox.x} y1={z} x2={viewBox.x + viewBox.width} y2={z} {...stroke} />
        ))}
      </g>

      {/* 방 바닥과 벽 */}
      <polygon
        points={pointsAttr(floorPolygon)}
        fill="#f7f8fb"
        stroke="#141a2a"
        strokeWidth={5}
        strokeLinejoin="round"
        {...stroke}
        data-testid="plan-room"
      />
      {/* 아주 짧은 벽(벽기둥의 옆면 등)은 번호가 서로 겹치므로 적지 않는다 */}
      {labels
        .filter((label) => {
          const a = floorPolygon[label.index];
          const b = floorPolygon[(label.index + 1) % floorPolygon.length];
          return Math.hypot(b[0] - a[0], b[1] - a[1]) >= MIN_LABELED_WALL;
        })
        .map((label) => (
          <text key={label.index} x={label.at[0]} y={label.at[1]} fontSize={0.16} fill="#6b7588" textAnchor="middle" dominantBaseline="central">
            벽 {label.index + 1}
          </text>
        ))}

      {/* 문 앞 구역(점선)과 문·창문 */}
      {openings.map((opening) => {
        const segment = openingSegment(opening, floorPolygon);
        if (!segment) return null;
        const zone = opening.type === 'door' ? doorZone(opening, floorPolygon) : null;
        const color = opening.type === 'door' ? '#f08a24' : '#2ba3e0';
        const fromAi = aiOpeningKeys.includes(`${opening.wallIndex}|${opening.from}`);
        const middle: Point2 = [(segment[0][0] + segment[1][0]) / 2, (segment[0][1] + segment[1][1]) / 2];
        return (
          <g key={`${opening.wallIndex}|${opening.from}`} data-testid="plan-opening" data-type={opening.type} data-ai={fromAi}>
            {zone && (
              <polygon
                points={pointsAttr(footprintCorners(zone))}
                fill="#f08a24"
                fillOpacity={0.12}
                stroke="#d9761a"
                strokeWidth={1.5}
                strokeDasharray="5 4"
                {...stroke}
              />
            )}
            {/* 벽을 끊어 보이게 바탕색을 먼저 깔고 그 위에 문·창문을 그린다 */}
            <line x1={segment[0][0]} y1={segment[0][1]} x2={segment[1][0]} y2={segment[1][1]} stroke="#f7f8fb" strokeWidth={8} {...stroke} />
            <line
              x1={segment[0][0]}
              y1={segment[0][1]}
              x2={segment[1][0]}
              y2={segment[1][1]}
              stroke={color}
              strokeWidth={7}
              strokeLinecap="butt"
              strokeDasharray={fromAi ? '7 4' : undefined}
              {...stroke}
            />
            {fromAi && (
              <g pointerEvents="none">
                <circle cx={middle[0]} cy={middle[1]} r={0.14} fill="#3350e8" />
                <text x={middle[0]} y={middle[1]} fontSize={0.13} fontWeight={600} fill="#ffffff" textAnchor="middle" dominantBaseline="central">
                  AI
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* 방에 원래 있는 가구: 빗금 사각형. 치울 가구는 주황 점선 테두리만 */}
      <defs>
        <pattern id="fixture-hatch" width={0.12} height={0.12} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={0.12} stroke="#8a94a6" strokeWidth={0.03} />
        </pattern>
      </defs>
      {fixtures.map((f) => {
        const corners = footprintCorners(f);
        return (
          <g key={f.id} pointerEvents="none" data-testid="plan-fixture" data-id={f.id} data-remove={f.remove}>
            <polygon
              points={pointsAttr(corners)}
              fill={f.remove ? 'none' : 'url(#fixture-hatch)'}
              stroke={f.remove ? '#e0603a' : '#5b6478'}
              strokeWidth={2}
              strokeDasharray={f.remove ? '6 4' : undefined}
              strokeLinejoin="round"
              {...stroke}
            />
            <text x={f.x} y={f.z} fontSize={0.14} fontWeight={600} fill={f.remove ? '#c4471f' : '#3b4356'} textAnchor="middle" dominantBaseline="central">
              {f.remove ? `${f.label} (치움)` : f.label}
            </text>
          </g>
        );
      })}
      {sketch && (
        <rect
          x={Math.min(sketch.a[0], sketch.b[0])}
          y={Math.min(sketch.a[1], sketch.b[1])}
          width={Math.abs(sketch.b[0] - sketch.a[0])}
          height={Math.abs(sketch.b[1] - sketch.a[1])}
          fill="#3350e8"
          fillOpacity={0.12}
          stroke="#3350e8"
          strokeWidth={2}
          strokeDasharray="6 4"
          pointerEvents="none"
          {...stroke}
          data-testid="plan-fixture-sketch"
        />
      )}

      {/* 가구 */}
      {items.map((item) => {
        const shown = drag && drag.id === item.id ? { ...item, x: drag.x, z: drag.z, rotationDeg: drag.rotationDeg } : item;
        const state = badIds.has(item.id) ? 'error' : warnIds.has(item.id) ? 'warning' : 'ok';
        const selected = item.id === selectedId;
        const corners = footprintCorners(shown);
        const tone = furnitureTone(item.category);
        return (
          <g key={item.id}>
            <polygon
              points={pointsAttr(corners)}
              fill={tone.fill}
              stroke={state === 'error' ? '#d93a2e' : state === 'warning' ? '#d99a0b' : selected ? '#3350e8' : tone.stroke}
              strokeWidth={state !== 'ok' || selected ? 3.5 : 2}
              strokeLinejoin="round"
              className={drawing ? undefined : 'cursor-grab'}
              pointerEvents={drawing ? 'none' : undefined}
              {...stroke}
              data-testid="plan-item"
              data-id={item.id}
              data-state={state}
              data-selected={selected}
              onPointerDown={(e) => onItemDown(e, item)}
            />
            {/* 앞면(3D 모델의 문·서랍이 있는 쪽, 회전 0°일 때 아래쪽)을 굵은 선으로 */}
            <line
              x1={corners[3][0]}
              y1={corners[3][1]}
              x2={corners[2][0]}
              y2={corners[2][1]}
              stroke={tone.stroke}
              strokeWidth={6}
              strokeLinecap="round"
              pointerEvents="none"
              {...stroke}
              data-testid="plan-front"
            />
            <text x={shown.x} y={shown.z} fontSize={0.15} fontWeight={600} fill="#141a2a" textAnchor="middle" dominantBaseline="central" pointerEvents="none">
              {item.name}
            </text>
            {/* 고른 가구의 회전 손잡이 (뒤쪽): 끌면 그 방향으로 돌아간다 */}
            {selected && onRotate && !drawing && (() => {
              const r = (shown.rotationDeg * Math.PI) / 180;
              const back: Point2 = [-Math.sin(r), -Math.cos(r)];
              const edge: Point2 = [shown.x + (back[0] * shown.d) / 2, shown.z + (back[1] * shown.d) / 2];
              const knob: Point2 = [edge[0] + back[0] * HANDLE_GAP, edge[1] + back[1] * HANDLE_GAP];
              return (
                <g data-testid="plan-rotate-handle" data-deg={shown.rotationDeg} data-x={knob[0]} data-z={knob[1]}>
                  <line x1={edge[0]} y1={edge[1]} x2={knob[0]} y2={knob[1]} stroke="#3350e8" strokeWidth={2} pointerEvents="none" {...stroke} />
                  <circle
                    cx={knob[0]}
                    cy={knob[1]}
                    r={HANDLE_RADIUS}
                    fill="#ffffff"
                    stroke="#3350e8"
                    strokeWidth={2.5}
                    className="cursor-grab"
                    {...stroke}
                    onPointerDown={(e) => onHandleDown(e, item)}
                  >
                    <title>끌어서 돌리기 (Shift: 15°씩)</title>
                  </circle>
                  {drag?.mode === 'rotate' && drag.id === item.id && (
                    <text x={knob[0]} y={knob[1] - HANDLE_RADIUS * 2.2} fontSize={0.16} fontWeight={700} fill="#3350e8" textAnchor="middle" pointerEvents="none">
                      {shown.rotationDeg}°
                    </text>
                  )}
                </g>
              );
            })()}
          </g>
        );
      })}
    </svg>
  );
}
