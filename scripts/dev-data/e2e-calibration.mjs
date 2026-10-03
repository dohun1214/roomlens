// 보정 화면 실측: InteriorGS 장면에서 평면도 정답 위치를 실제로 클릭해 벽 길이 오차를 잰다.
// 실행: node scripts/dev-data/e2e-calibration.mjs [장면]   (준비·환경변수는 e2e-common.mjs 참고)
import path from 'node:path';
import { calibrate, moveCamera, openViewer, round, shotDir } from './e2e-common.mjs';

const scene = process.argv[2] ?? '0056_839909';
const { browser, page } = await openViewer(scene);
try {
  const { result, truth, cornerY, jitterPx } = await calibrate(page, scene, { shots: true });
  const errors = result.wallLengths.map((len, i) => (len - truth.wallLengths[i]) / truth.wallLengths[i]);

  await page.getByTestId('calibration-apply').click();
  // 적용 후: 방 좌표(원점 = 모서리 중심, 바닥 y = 0)에서 방 안을 비스듬히 내려다본다
  await moveCamera(page, [1.8, 2.4, 1.8], [0, 0, 0]);
  await page.screenshot({ path: path.join(shotDir, `cal-${scene}-applied.png`) });

  console.log(JSON.stringify({
    scene,
    cornerY,
    jitterPx,
    truth: truth.wallLengths.map((v) => round(v)),
    measured: result.wallLengths.map((v) => round(v)),
    errorPct: errors.map((v) => round(v * 100, 2)),
    maxErrorPct: round(Math.max(...errors.map(Math.abs)) * 100, 2),
    floorTapHeightsCm: result.floorPoints.map((p) => round(p[1] * 100, 1)), // 정답 0
    cornerHeights: result.cornerHeights.map((v) => round(v, 2)), // 정답 cornerY
    scale: round(result.scale, 4), // 정답 1 (이미 m 단위)
  }));
} finally {
  await browser.close();
}
