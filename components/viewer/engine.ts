import type * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

/** 뷰어가 만든 three.js 객체 묶음. 보정·가구 배치 도구가 함께 쓴다. */
export type Engine = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  spark: SparkRenderer;
  /** 보정 변환(회전·크기·이동)을 적용하는 그룹. 스플랫은 이 그룹의 자식이다. */
  roomGroup: THREE.Group;
  splat: SplatMesh | null;
  /** 실측용: true면 카메라를 방 안에 가두지 않는다 (개발 서버에서 window.__roomlens로만 바꾼다) */
  freeCamera?: boolean;
};
