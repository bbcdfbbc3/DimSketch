"""Inspect a DimSketch v1 ZIP; optionally unpack declared evidence into a new folder."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

MIB = 1024 * 1024
ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
KINDS = {"length", "width", "height", "thickness", "diameter", "pitch", "gap", "offset"}
VIEWS = {"overall", "front", "side", "top", "bottom", "oblique", "other"}
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def number(value: object, name: str) -> float:
    require(type(value) in (int, float) and math.isfinite(value) and value >= 0,
            f"{name}: 유한한 0 이상 숫자가 필요합니다.")
    return float(value)


def records(items: object, name: str) -> dict:
    require(isinstance(items, list) and len(items) <= 10000, f"{name}: 목록 형식/크기 오류")
    result = {}
    for item in items:
        require(isinstance(item, dict), f"{name}: 항목이 객체가 아닙니다.")
        key = item.get("id")
        require(isinstance(key, str) and ID.fullmatch(key) is not None, f"{name}: 잘못된 ID")
        require(key not in result, f"{name}: 중복 ID {key}")
        result[key] = item
    return result


def unique_json(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        require(key not in result, f"JSON 중복 키: {key}")
        result[key] = value
    return result


def reject_constant(value: str) -> None:
    raise ValueError(f"JSON에서 지원하지 않는 숫자: {value}")


def archive_entries(archive: zipfile.ZipFile) -> dict:
    entries = archive.infolist()
    require(len(entries) <= 1000 and sum(i.file_size for i in entries) <= 1024 * MIB,
            "ZIP 파일 수 또는 해제 크기 제한 초과")
    files, names = {}, set()
    for info in entries:
        # ZipInfo normalizes Windows separators and truncates NULs. Check the raw name first.
        name = info.orig_filename
        parts = name.rstrip("/").split("/")
        require(name == info.filename and name and not any(c in name for c in "\\:\x00") and not PurePosixPath(name).is_absolute(),
                f"안전하지 않은 ZIP 경로: {name!r}")
        require(all(p not in ("", ".", "..") and not p.endswith((".", " "))
                    and p.split(".")[0].upper() not in RESERVED for p in parts),
                f"지원하지 않는 ZIP 경로: {name!r}")
        key = name.rstrip("/").casefold()
        require(key not in names, f"중복 ZIP 경로: {name!r}")
        names.add(key)
        mode = info.external_attr >> 16
        require(not stat.S_ISLNK(mode) and stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR),
                f"일반 파일이 아닌 ZIP 항목: {name!r}")
        require(not info.flag_bits & 1, "암호화된 ZIP은 지원하지 않습니다.")
        if not info.is_dir():
            files[name] = info
    folded_files = {name.casefold() for name in files}
    for name in files:
        require(not any(str(p).casefold() in folded_files
                        for p in PurePosixPath(name).parents if str(p) != "."),
                f"파일/폴더 경로 충돌: {name!r}")
    require("project.json" in files and files["project.json"].file_size <= 32 * MIB,
            "루트에 32 MiB 이하의 project.json이 필요합니다.")
    return files


def inspect_project(project: dict, files: dict) -> tuple[dict, set]:
    require(isinstance(project, dict) and type(project.get("schema_version")) is int
            and project["schema_version"] == 1, "지원하는 schema_version은 정수 1입니다.")
    require(isinstance(project.get("id"), str) and ID.fullmatch(project["id"]) is not None,
            "프로젝트 ID 오류")
    require(isinstance(project.get("name"), str) and project["name"].strip(), "프로젝트 이름 오류")
    require(type(project.get("revision")) is int and project["revision"] >= 0, "revision 오류")
    photos, objects, features, measurements, annotations = (
        records(project.get(key), key) for key in ("photos", "objects", "features", "measurements", "annotations")
    )
    require(len(photos) <= 100, "사진 개수 제한 초과")
    selected_files, issues = {"project.json"}, []

    def issue(code: str, target: str, message: str) -> None:
        issues.append({"code": code, "target": target, "message": message})

    for photo in photos.values():
        require(all(type(photo.get(k)) is int and photo[k] > 0 for k in ("width", "height"))
                and photo["width"] * photo["height"] <= 40_000_000, "사진 크기 오류")
        require(photo.get("view") in VIEWS, "사진 방향 오류")
        for field, folder, limit in (("original_path", "originals", 30 * MIB), ("image_path", "images", 170 * MIB)):
            path = photo.get(field)
            require(isinstance(path, str) and re.fullmatch(rf"{folder}/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)", path)
                    is not None, f"사진 경로 오류: {field}")
            require(path in files and 0 < files[path].file_size <= limit, f"사진 누락/크기 오류: {path}")
            selected_files.add(path)
        marked = f"annotated/{photo['id']}.png"
        if marked in files:
            require(0 < files[marked].file_size <= 170 * MIB, f"표시 이미지 크기 오류: {marked}")
            selected_files.add(marked)
        else:
            issue("missing_annotated", photo["id"], "표시 사진이 없습니다. 원본 JSON의 연결을 확인하세요.")
    for feature in features.values():
        require(feature.get("object_id") in objects and feature.get("kind") in {"hole", "point", "plane"},
                f"기준 요소 참조/종류 오류: {feature['id']}")

    def check_ref(ref: object) -> None:
        require(isinstance(ref, dict), "치수 시작·끝 기준이 객체가 아닙니다.")
        obj, feature = ref.get("object_id"), ref.get("feature_id")
        require(obj is None or obj in objects, "기준이 참조하는 물체가 없습니다.")
        require(feature is None or (feature in features and features[feature]["object_id"] == obj),
                "기준 요소와 소속 물체가 일치하지 않습니다.")
        require(isinstance(ref.get("text", ""), str), "기준 설명은 문자열이어야 합니다.")
        require(obj is not None or feature is not None or ref.get("text", "").strip(), "치수 기준이 비어 있습니다.")

    targets = {"object": objects, "feature": features, "measurement": measurements}
    links = {key: set() for key in measurements}
    for annotation in annotations.values():
        kind, target, photo_id = annotation.get("target_type"), annotation.get("target_id"), annotation.get("photo_id")
        require(photo_id in photos and kind in targets and target in targets[kind], "사진 표시 참조 오류")
        shape, points = annotation.get("shape"), annotation.get("points")
        allowed = {"object": {"rect", "polygon"}, "feature": {"point", "line"}, "measurement": {"line"}}
        require(shape in allowed[kind] and isinstance(points, list), "사진 표시 형식 오류")
        expected = {"rect": 2, "line": 2, "point": 1}.get(shape)
        require(len(points) == expected if expected is not None else 3 <= len(points) <= 1000, "표시점 개수 오류")
        for point in points:
            require(isinstance(point, list) and len(point) == 2, "표시점 형식 오류")
            require(number(point[0], "pixel x") <= photos[photo_id]["width"]
                    and number(point[1], "pixel y") <= photos[photo_id]["height"], "표시점이 사진 범위를 벗어납니다.")
        if kind == "measurement":
            links[target].add(photo_id)

    dimensions = []
    for measurement in measurements.values():
        key = measurement["id"]
        kind, direction = measurement.get("kind"), measurement.get("direction")
        require(kind in KINDS and direction in {"none", "up", "down"}, f"치수 종류/방향 오류: {key}")
        require(kind != "offset" or direction in {"up", "down"}, f"offset 부호 누락: {key}")
        check_ref(measurement.get("from_ref"))
        check_ref(measurement.get("to_ref"))
        readings = records(measurement.get("readings"), f"{key}.readings")
        normalized = {}
        for rid, reading in readings.items():
            unit, status = reading.get("unit"), reading.get("status")
            require(unit in {"mm", "cm"} and status in {"measured", "approximate", "unknown"}, f"측정 단위/상태 오류: {rid}")
            multiplier = 10 if unit == "cm" else 1
            value = None if status == "unknown" else number(number(reading.get("value"), rid) * multiplier, rid)
            require(value is None or value > 0 or kind in {"gap", "offset"}, f"0 치수 오류: {rid}")
            error = reading.get("error")
            error = None if error is None else number(number(error, rid) * multiplier, rid)
            for field, computed in (("value_mm", value), ("error_mm", error)):
                if field in reading:
                    stored = reading[field]
                    require((computed is None and stored is None) or
                            (computed is not None and stored is not None and
                             math.isclose(number(stored, field), computed, rel_tol=1e-12, abs_tol=1e-9)),
                            f"저장된 {field}와 원래 단위 환산 결과가 다릅니다: {rid}")
            normalized[rid] = {**reading, "value_mm": value, "error_mm": error}
        adopted = measurement.get("selected_reading_id")
        require(adopted is None or adopted in normalized, f"존재하지 않는 채택 측정: {key}")
        reading = normalized.get(adopted)
        value = reading["value_mm"] if reading else None
        if value is None:
            issue("missing_value", key, "채택된 측정값이 없습니다. 사용자 확인이 필요합니다.")
        elif reading["status"] == "approximate":
            issue("approximate", key, "대략 측정값입니다. 용도에 충분한지 확인하세요.")
        if not links[key]:
            issue("no_photo_annotation", key, "치수의 사진 표시가 없습니다. 기준 설명으로 대상을 확인하세요.")
        dimensions.append({k: measurement.get(k) for k in ("id", "label", "name", "kind", "direction", "from_ref", "to_ref", "selected_reading_id")}
                          | {"selected_reading": reading, "signed_value_mm": -value if value is not None and kind == "offset" and direction == "down" else value,
                             "photo_ids": sorted(links[key])})
    if not photos:
        issue("no_photos", project["id"], "사진이 없습니다. 형상을 확인할 자료가 필요합니다.")
    if not objects:
        issue("no_objects", project["id"], "등록된 물체가 없습니다.")
    if not measurements:
        issue("no_measurements", project["id"], "치수 기록이 없습니다.")
    if "docu/summary.md" in files:
        require(files["docu/summary.md"].file_size <= 32 * MIB, "요약 문서 크기 제한 초과")
        selected_files.add("docu/summary.md")
    report = {"report_version": 1, "project": {k: project.get(k) for k in ("id", "name", "schema_version", "revision", "description")},
              "photos": list(photos.values()), "objects": list(objects.values()), "features": list(features.values()),
              "measurements": dimensions, "issues": issues, "ignored_files": sorted(set(files) - selected_files),
              "limitations": ["형식 검사 성공은 CAD 치수의 완전성을 보장하지 않습니다.", "사진 픽셀 내용과 형상은 에이전트가 직접 확인해야 합니다."]}
    return report, selected_files


def inspect_bundle(zip_path: Path, output: Path | None = None) -> dict:
    zip_path = zip_path.resolve(strict=True)
    require(zip_path.is_file() and zip_path.stat().st_size <= 512 * MIB, "입력은 512 MiB 이하 ZIP 파일이어야 합니다.")
    digest = hashlib.sha256()
    with zip_path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(MIB), b""):
            digest.update(chunk)
        stream.seek(0)
        with zipfile.ZipFile(stream) as archive:
            files = archive_entries(archive)
            project = json.loads(archive.read("project.json").decode("utf-8-sig"),
                                 object_pairs_hook=unique_json, parse_constant=reject_constant)
            report, evidence = inspect_project(project, files)
            report["source"] = {"zip_path": str(zip_path), "sha256": digest.hexdigest()}
            if output is not None:
                output = output.resolve()
                require(not output.exists(), "출력 폴더가 이미 존재합니다. 새 폴더를 지정하세요.")
                output.mkdir(parents=True, exist_ok=False)
                for name in sorted(evidence):
                    destination = output / "input" / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with destination.open("xb") as target:
                        target.write(archive.read(name))
                report["output_directory"] = str(output)
                with (output / "analysis.json").open("x", encoding="utf-8") as target:
                    json.dump(report, target, ensure_ascii=False, indent=2, allow_nan=False)
                    target.write("\n")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip_path", type=Path, help="DimSketch에서 내보낸 ZIP 경로")
    parser.add_argument("--output", type=Path, help="새 결과 폴더. 생략하면 파일을 쓰지 않고 JSON만 출력")
    args = parser.parse_args()
    try:
        report = inspect_bundle(args.zip_path, args.output)
    except (OSError, ValueError, TypeError, KeyError, OverflowError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
