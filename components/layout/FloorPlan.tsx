'use client';

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { doorZone } from '@/lib/layout/access';
import { dragPlacement, gridLines, planViewBox, pointsAttr, wallLabels } from '@/lib/layout/plan';
import type { PlacedItem } from '@/lib/layout/saved';
import { openingSegment, type Opening } from '@/lib/rooms/openings';
import { footprintCorners, type Point2 } from '@/lib/three/floorDrag';
import { furnitureTone } from '@/lib/layout/furnitureLook';

/** 이 거리(px)보다 적게 움직이면 끌기가 아니라 선택으로 본다 */
const TAP_MOVE_PX = 4;
const NO_KEYS: string[] = [];
/** 이보다 짧은 벽에는 평면도에 번호를 적지 않는다 (m) */
const MIN_LABELED_WALL = 0.45;

type Drag = {
  id: string;
  pointerId: number;
  grab: Point2;
  startX: number;
  startY: number;
  moved: boolean;
  x: number;
  z: number;
};

/**
 * 방을 위에서 내려다본 평면도. 가구를 눌러 고르고 끌어서 옮긴다 (3D와 같은 5cm 격자·벽 붙이기).
 * 좌표는 방 좌표(m)를 그대로 쓴다: 오른쪽 +x, 아래쪽 +z.
 */
export default function FloorPlan({
  floorPolygon,
  items,
  openings,
  aiOpeningKeys = NO_KEYS,
  badIds,
  warnIds,
  selectedId,
  onSelect,
  onMove,
}: {
  floorPolygon: Point2[];
  items: PlacedItem[];
  openings: Opening[];
  /** AI가 찾아 아직 확인하지 않은 문·창문 (`벽 번호|시작`). 점선으로 그린다 */
  aiOpeningKeys?: string[];
  /** 문제가 있는 가구 (빨강) */
  badIds: Set<string>;
  /** 경고만 있는 가구 (노랑) */
  warnIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 끌기를 마쳤을 때의 새 위치 */
  onMove: (id: string, x: number, z: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

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
      grab: [item.x - point[0], item.z - point[1]],
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      x: item.x,
      z: item.z,
    });
  };

  const onMovePointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const item = items.find((i) => i.id === drag.id);
    const point = toPlan(e);
    if (!item || !point) return;
    const moved = drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > TAP_MOVE_PX;
    if (!moved) return;
    const placed = dragPlacement(item, drag.grab, point, floorPolygon);
    setDrag({ ...drag, moved, x: placed.x, z: placed.z });
  };

  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    if (drag.moved) onMove(drag.id, drag.x, drag.z);
    setDrag(null);
  };

  const stroke = { vectorEffect: 'non-scaling-stroke' as const };

  return (
    <svg
      ref={svgRef}
      className="h-full w-full touch-none select-none"
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="방 평면도"
      data-testid="floor-plan"
      onPointerDown={() => onSelect(null)}
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

      {/* 가구 */}
      {items.map((item) => {
        const shown = drag && drag.id === item.id ? { ...item, x: drag.x, z: drag.z } : item;
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
              className="cursor-grab"
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
          </g>
        );
      })}
    </svg>
  );
}
