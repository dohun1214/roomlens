// 원래 가구 후보의 높이를 스플랫에서 잰다: 가구 자리(가장자리를 조금 덜어 낸 사각형) 위에 있는 스플랫들의 높이로
// "바닥 위에서 위로 이어진 층의 꼭대기"를 구한다 (lib/ai/fixturesDetect.ts의 topHeight).
// 지금 그리고 있는 스플랫 전체를 한 번 훑는다 (100만 개에 수백 ms). 브라우저 전용.
import type { SplatMesh } from '@sparkjsdev/spark';
import { HEIGHT_INSET, SURFACE_LABELS, topHeight } from '@/lib/ai/fixturesDetect';
import { fixtureAxes, type Fixture } from '@/lib/rooms/fixtures';
import { visitRenderedSplats } from './pickPoint';

/** 이보다 흐린 스플랫은 높이를 잴 때 쓰지 않는다 */
const MIN_OPACITY = 0.3;

/**
 * 원래 가구마다 잰 높이 (방 좌표 = 월드 좌표, 바닥 y = 0). 재지 못한 것은 null.
 * 스플랫을 아직 그리지 않았으면 모두 null.
 */
export function measureFixtureHeights(mesh: SplatMesh, fixtures: Fixture[]): (number | null)[] {
  const forEachSplat = visitRenderedSplats(mesh);
  if (!forEachSplat || fixtures.length === 0) return fixtures.map(() => null);
  mesh.updateMatrixWorld();
  const m = mesh.matrixWorld.elements;
  const areas = fixtures.map((f) => {
    const [ux, uz] = fixtureAxes(f.rotationDeg);
    const inset = (size: number) => Math.max(0.03, Math.min(HEIGHT_INSET * size, size / 2 - 0.03));
    return {
      f,
      ux,
      uz,
      ha: f.w / 2 - inset(f.w),
      hb: f.d / 2 - inset(f.d),
      heights: [] as number[],
    };
  });
  // 가구들을 감싸는 범위 밖의 스플랫은 바로 건너뛴다
  const reach = Math.max(...fixtures.map((f) => Math.hypot(f.w, f.d) / 2));
  const minX = Math.min(...fixtures.map((f) => f.x)) - reach;
  const maxX = Math.max(...fixtures.map((f) => f.x)) + reach;
  const minZ = Math.min(...fixtures.map((f) => f.z)) - reach;
  const maxZ = Math.max(...fixtures.map((f) => f.z)) + reach;
  forEachSplat((c, _s, _q, opacity) => {
    if (opacity < MIN_OPACITY) return;
    const x = m[0] * c.x + m[4] * c.y + m[8] * c.z + m[12];
    const z = m[2] * c.x + m[6] * c.y + m[10] * c.z + m[14];
    if (x < minX || x > maxX || z < minZ || z > maxZ) return;
    const y = m[1] * c.x + m[5] * c.y + m[9] * c.z + m[13];
    for (const area of areas) {
      const dx = x - area.f.x;
      const dz = z - area.f.z;
      if (Math.abs(dx * area.ux[0] + dz * area.ux[1]) > area.ha || Math.abs(dx * area.uz[0] + dz * area.uz[1]) > area.hb) continue;
      area.heights.push(y);
    }
  });
  return areas.map((area) => topHeight(area.heights, SURFACE_LABELS.has(area.f.label)));
}
