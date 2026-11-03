// 실측·평가 스크립트가 헤드리스 브라우저를 띄우는 옵션. 운영체제마다 브라우저와 WebGL(ANGLE) 백엔드가 다르다.
// 브라우저: ROOMLENS_BROWSER=<실행 파일 경로>가 있으면 그것, 없으면 설치된 Chrome, 리눅스에 Chrome이 없으면 Brave.
// WebGL: 윈도우 d3d11, 맥 metal, 리눅스 vulkan이 기본. ROOMLENS_ANGLE=d3d11|vulkan|gl|metal|swiftshader 로 바꿀 수 있다.
import { existsSync } from 'node:fs';

const linuxChrome = '/opt/google/chrome/chrome';
const linuxBrave = ['/opt/brave-bin/brave', '/opt/brave.com/brave/brave'];

function pickBrowser() {
  if (process.env.ROOMLENS_BROWSER) return { executablePath: process.env.ROOMLENS_BROWSER };
  if (process.platform === 'linux' && !existsSync(linuxChrome)) {
    const brave = linuxBrave.find((p) => existsSync(p));
    if (brave) return { executablePath: brave };
  }
  return { channel: 'chrome' };
}

/** chromium.launch에 펼쳐 넣는다: `chromium.launch({ ...browserOpts, headless: true, args: gpuArgs })` */
export const browserOpts = pickBrowser();

const angle = process.env.ROOMLENS_ANGLE ?? (process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'vulkan');

export const gpuArgs = [
  `--use-angle=${angle}`,
  ...(angle === 'vulkan' ? ['--enable-features=Vulkan', '--disable-vulkan-surface'] : []),
  '--enable-gpu',
  '--ignore-gpu-blocklist',
];
