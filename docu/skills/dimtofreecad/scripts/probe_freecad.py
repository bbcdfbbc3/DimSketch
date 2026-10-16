"""Find FreeCAD executable candidates without launching or installing anything."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil


def discover(explicit: str | None = None) -> dict:
    paths = []
    for candidate in (explicit, os.environ.get("FREECAD_EXECUTABLE")):
        if candidate:
            paths.append((Path(candidate).expanduser(), "explicit" if candidate == explicit else "environment"))
    for name in ("FreeCADCmd", "freecadcmd", "FreeCAD", "freecad", "FreeCADCmd.exe", "FreeCAD.exe"):
        candidate = shutil.which(name)
        if candidate:
            paths.append((Path(candidate), "PATH"))
    roots = []
    if os.name == "nt":
        for variable in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            if os.environ.get(variable):
                roots.append(Path(os.environ[variable]))
        if os.environ.get("LOCALAPPDATA"):
            roots.append(Path(os.environ["LOCALAPPDATA"]) / "Programs")
        for root in roots:
            for pattern in ("FreeCAD*/bin/FreeCAD*.exe", "FreeCAD*/bin/freecad*.exe"):
                paths.extend((p, "standard_location") for p in root.glob(pattern))
    else:
        for root in (Path("/Applications"), Path.home() / "Applications"):
            for pattern in ("FreeCAD*.app/Contents/MacOS/FreeCAD*", "FreeCAD*.app/Contents/Resources/bin/FreeCAD*"):
                paths.extend((p, "standard_location") for p in root.glob(pattern))
        for path in ("/usr/bin/freecad", "/usr/bin/freecadcmd", "/usr/local/bin/freecad", "/usr/local/bin/freecadcmd"):
            paths.append((Path(path), "standard_location"))
    seen, candidates = set(), []
    for path, source in paths:
        if not path.is_file():
            continue
        path = path.resolve()
        key = os.path.normcase(str(path))
        if key in seen:
            continue
        seen.add(key)
        candidates.append({"path": str(path), "source": source,
                           "mode_hint": "console" if "cmd" in path.stem.lower() else "gui"})
    return {"candidates": candidates, "runtime_verified": False,
            "explicit_path_exists": Path(explicit).expanduser().is_file() if explicit else None,
            "note": "후보 경로만 검색합니다. 버전·모듈·실행 가능 여부는 실제 실행으로 확인하세요. portable/AppImage/custom 경로는 --executable로 지정하세요."}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", help="사용자가 지정한 FreeCAD 또는 FreeCADCmd 실행 파일 경로")
    print(json.dumps(discover(parser.parse_args().executable), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
