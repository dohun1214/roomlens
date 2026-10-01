"""InteriorGS 개발용 데이터 도구.

InteriorGS(https://github.com/manycore-research/InteriorGS)는 비상업·교육 목적 전용이며
재배포가 금지되어 있다. 내려받은 파일은 저장소 밖(기본 ../roomlens-data)에만 두고
커밋하거나 공개 서버에 올리지 않는다.

사전 준비: Hugging Face에서 데이터셋 이용 조건 동의 후 `hf auth login`.

사용 예:
  python scripts/dev-data/interiorgs.py pick                 # 원룸 시험용 장면 후보 출력
  python scripts/dev-data/interiorgs.py fetch 0056_839909    # 장면 파일 받기
  python scripts/dev-data/interiorgs.py convert 0056_839909  # three.js(Y-up)용 .sog 변환
"""

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys

from huggingface_hub import HfApi, snapshot_download

REPO = "spatialverse/InteriorGS"
DEFAULT_DATA = os.path.join(os.path.dirname(__file__), "..", "..", "..", "roomlens-data")
SPLAT_TRANSFORM = "@playcanvas/splat-transform@3.8.0"


def polygon_area(poly):
    s = 0.0
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def cmd_pick(args):
    out = os.path.join(args.data, "interiorgs")
    snapshot_download(REPO, repo_type="dataset", allow_patterns=["*/structure.json"],
                      local_dir=out, max_workers=16)
    info = HfApi().dataset_info(REPO, files_metadata=True)
    ply_mb = {s.rfilename.split("/")[0]: s.size / 1e6
              for s in info.siblings if s.rfilename.endswith(".ply")}

    rows = []
    for path in glob.glob(os.path.join(out, "*", "structure.json")):
        scene = os.path.basename(os.path.dirname(path))
        d = json.load(open(path, encoding="utf-8"))
        rooms = d.get("rooms", [])
        if not rooms:
            continue
        holes = d.get("holes", [])
        rows.append({
            "scene": scene,
            "rooms": len(rooms),
            "area_m2": round(sum(polygon_area(r["profile"]) for r in rooms), 1),
            "max_verts": max(len(r["profile"]) for r in rooms),
            "doors": sum(h.get("type") == "DOOR" for h in holes),
            "windows": sum(h.get("type") == "WINDOW" for h in holes),
            "ply_mb": round(ply_mb.get(scene, 0), 1),
        })

    cand = [r for r in rows if r["rooms"] <= args.max_rooms and r["area_m2"] <= args.max_area
            and r["max_verts"] <= args.max_verts and r["doors"] >= 1]
    cand.sort(key=lambda r: (r["rooms"], r["max_verts"], r["area_m2"]))
    print(f"{len(rows)} scenes, {len(cand)} candidates")
    for r in cand[: args.limit]:
        print(r)


def cmd_fetch(args):
    out = os.path.join(args.data, "interiorgs")
    for scene in args.scenes:
        snapshot_download(REPO, repo_type="dataset", allow_patterns=[f"{scene}/*"],
                          local_dir=out, max_workers=8)
        print("fetched", scene)


def cmd_convert(args):
    # InteriorGS는 Z-up. splat-transform의 -r 90,0,0 이 three.js 기준 X축 -90° 회전이 되어
    # 바닥이 y=0 근처, 위쪽이 +Y가 된다 (실제 렌더로 확인).
    # Spark 2.3.0은 SPZ v4(ZSTD)를 읽지 못하므로 기본 출력은 .sog.
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        sys.exit("npx not found")
    os.makedirs(os.path.join(args.data, "converted"), exist_ok=True)
    for scene in args.scenes:
        src = os.path.join(args.data, "interiorgs", scene, "3dgs_compressed.ply")
        dst = os.path.join(args.data, "converted", f"{scene}.{args.format}")
        cmd = [npx, "-y", SPLAT_TRANSFORM, "--no-tty", "-w", src, "-r", "90,0,0"]
        if args.decimate:
            cmd += ["-d", args.decimate]
        cmd.append(dst)
        print(" ".join(cmd))
        subprocess.run(cmd, check=True)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default=os.path.abspath(DEFAULT_DATA), help="데이터 폴더 (저장소 밖)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("pick", help="원룸 시험용 장면 후보 찾기")
    s.add_argument("--max-rooms", type=int, default=2)
    s.add_argument("--max-area", type=float, default=40.0)
    s.add_argument("--max-verts", type=int, default=8)
    s.add_argument("--limit", type=int, default=30)
    s.set_defaults(func=cmd_pick)

    s = sub.add_parser("fetch", help="장면 파일 받기")
    s.add_argument("scenes", nargs="+")
    s.set_defaults(func=cmd_fetch)

    s = sub.add_parser("convert", help="Y-up으로 회전해 Spark용 파일로 변환")
    s.add_argument("scenes", nargs="+")
    s.add_argument("--format", default="sog", choices=["sog", "ply", "compressed.ply", "spz"])
    s.add_argument("--decimate", help="스플랫 수 줄이기 (예: 1000000 또는 50%%)")
    s.set_defaults(func=cmd_convert)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
