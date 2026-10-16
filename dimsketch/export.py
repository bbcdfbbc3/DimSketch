"""사진·표시·실측 근거의 ZIP 묶음 생성과 안전한 복원."""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import stat
import zipfile
from pathlib import PurePosixPath

from PIL import Image, UnidentifiedImageError

try:
    from .model import AppError, MAX_ARCHIVE_BYTES, MAX_IMAGE_BYTES, MAX_REQUEST_BYTES, normalize_project
    from .storage import ProjectStore, decode_photo, json_bytes
except ImportError:
    from model import AppError, MAX_ARCHIVE_BYTES, MAX_IMAGE_BYTES, MAX_REQUEST_BYTES, normalize_project
    from storage import ProjectStore, decode_photo, json_bytes

MAX_RENDER_BYTES = 170 * 1024 * 1024


def markdown_text(value: str) -> str:
    """목적: 설명을 한 줄 Markdown으로 변환. 입력: 글자. 출력: 이스케이프된 글자."""
    return value.replace("\\", "\\\\").replace("\n", " / ").replace("\r", "").replace("`", "\\`").replace("[", "\\[").replace("]", "\\]").replace("<", "&lt;").replace(">", "&gt;")


def reference_text(ref: dict, objects: dict, features: dict) -> str:
    """목적: 기준 설명 생성. 입력: 참조·물체·기준 요소. 출력: 사람이 읽는 설명."""
    parts = []
    if ref.get("feature_id"):
        feature = features[ref["feature_id"]]
        parts.append(feature["label"] + (" " + feature["name"] if feature.get("name") else ""))
    elif ref.get("object_id"):
        obj = objects[ref["object_id"]]
        parts.append(obj["label"] + (" " + obj["name"] if obj.get("name") else ""))
    if ref.get("text"):
        parts.append(ref["text"])
    return " · ".join(parts)


def summary_markdown(project: dict) -> str:
    """목적: CAD 작업용 근거 문서 생성. 입력: 저장 스냅샷. 출력: 글머리 Markdown."""
    objects = {item["id"]: item for item in project["objects"]}
    features = {item["id"]: item for item in project["features"]}
    photos = {item["id"]: item for item in project["photos"]}
    kinds = {"length": "길이", "width": "폭", "height": "높이", "thickness": "두께", "diameter": "지름", "pitch": "구멍 중심 간격", "gap": "면 사이 거리", "offset": "기준면 대비 높이"}
    views = {"overall": "전체", "front": "정면", "side": "측면", "top": "위", "bottom": "아래", "oblique": "사선", "other": "기타"}
    statuses = {"measured": "실측", "approximate": "대략", "unknown": "미측정"}
    lines = [f"# {markdown_text(project['name'])}", "", f"- 프로젝트 ID: {project['id']}",
             f"- 저장 버전: {project['revision']}", f"- 수정 시각: {project['updated_at']}",
             "- 단위: mm 기준. 원래 입력 단위와 측정 기록은 project.json에 함께 보존.",
             "- 좌표: EXIF 방향을 보정한 images 사진의 픽셀 좌표. 실측 mm와 별도 관리.",
             "- 물체 표시 영역: 식별용 표시. CAD 외곽 형상 또는 자동 환산 치수가 아님.",
             "- 측정 오차: 측정 기록의 불확실성. 제작 허용공차와 구분."]
    if project.get("description"):
        lines.append(f"- 설명: {markdown_text(project['description'])}")
    lines += ["", "- 사진"]
    if not photos:
        lines.append("  - 등록된 사진 없음.")
    for photo in photos.values():
        lines += [f"  - {markdown_text(photo['filename'])} / {views[photo['view']]} / {photo['width']} × {photo['height']} px",
                  f"    - 사진 ID: {photo['id']}",
                  f"    - [실측 표시 사진](../annotated/{photo['id']}.png)",
                  f"    - [좌표 기준 사진](../{photo['image_path']})",
                  f"    - [원본 사진](../{photo['original_path']})"]
        if photo.get("description"):
            lines.append(f"    - 설명: {markdown_text(photo['description'])}")
    lines += ["", "- 물체와 기준 요소"]
    if not objects:
        lines.append("  - 등록된 물체 없음.")
    for obj in objects.values():
        lines.append(f"  - {obj['label']}: {markdown_text(obj.get('name', ''))}")
        if obj.get("description"):
            lines.append(f"    - 설명: {markdown_text(obj['description'])}")
        linked = {annotation["photo_id"] for annotation in project["annotations"] if
                  (annotation["target_type"] == "object" and annotation["target_id"] == obj["id"]) or
                  (annotation["target_type"] == "feature" and features[annotation["target_id"]]["object_id"] == obj["id"])}
        for photo_id in sorted(linked):
            lines.append(f"    - 사진: [{markdown_text(photos[photo_id]['filename'])}](../annotated/{photo_id}.png)")
        for feature in features.values():
            if feature["object_id"] == obj["id"]:
                lines.append(f"    - {feature['label']}: {markdown_text(feature.get('name', ''))} ({ {'hole': '구멍', 'point': '점', 'plane': '면'}[feature['kind']] })")
                if feature.get("description"):
                    lines.append(f"      - 기준 설명: {markdown_text(feature['description'])}")
    lines += ["", "- 치수 기록"]
    attention = []
    if not project["measurements"]:
        lines.append("  - 등록된 치수 없음.")
    for measurement in project["measurements"]:
        selected = next((item for item in measurement["readings"] if item["id"] == measurement.get("selected_reading_id")), None)
        lines += [f"  - {measurement['label']}: {markdown_text(measurement.get('name', ''))} / {kinds[measurement['kind']]}",
                  f"    - 기준: {markdown_text(reference_text(measurement['from_ref'], objects, features))} → {markdown_text(reference_text(measurement['to_ref'], objects, features))}"]
        if measurement["direction"] != "none":
            lines.append("    - 방향: " + ("기준보다 위 (+)" if measurement["direction"] == "up" else "기준보다 아래 (-)"))
        if selected and selected["value_mm"] is not None:
            prefix = "-" if measurement["kind"] == "offset" and measurement["direction"] == "down" else ""
            lines.append(f"    - 채택값: {prefix}{selected['value_mm']:g} mm ({statuses[selected['status']]})")
            if selected["status"] == "approximate":
                attention.append(f"{measurement['label']}: 대략 측정값. 제작 전 확인 필요.")
        else:
            state = "미측정" if not measurement["readings"] or all(item["status"] == "unknown" for item in measurement["readings"]) else "채택값 없음 / 재확인 필요"
            lines.append(f"    - 상태: {state}")
            attention.append(f"{measurement['label']}: {state}.")
        for index, reading in enumerate(measurement["readings"], 1):
            value = "미측정" if reading["value_mm"] is None else f"{reading['value']:g} {reading['unit']} = {reading['value_mm']:g} mm"
            lines.append(f"    - 측정 {index}: {value} / {statuses[reading['status']]}" + (" / 채택" if reading is selected else ""))
            if reading.get("error_mm") is not None:
                lines.append(f"      - 측정 오차: ±{reading['error_mm']:g} mm")
            if reading.get("tool"):
                lines.append(f"      - 도구: {markdown_text(reading['tool'])}")
            if reading.get("note"):
                lines.append(f"      - 메모: {markdown_text(reading['note'])}")
            if reading.get("created_at"):
                lines.append(f"      - 기록 시각: {markdown_text(reading['created_at'])}")
        linked = {item["photo_id"] for item in project["annotations"] if item["target_type"] == "measurement" and item["target_id"] == measurement["id"]}
        for photo_id in sorted(linked):
            lines.append(f"    - 근거 사진: [{markdown_text(photos[photo_id]['filename'])}](../annotated/{photo_id}.png)")
    lines += ["", "- 미측정·재확인 항목"]
    lines.extend(f"  - {item}" for item in attention)
    if not attention:
        lines.append("  - 입력된 치수 기록 기준 미측정·재확인 항목 없음. CAD 제작에 필요한 모든 치수의 완전성을 자동 보장하지 않음.")
    return "\n".join(lines) + "\n"


def validate_png(content: bytes, photo: dict) -> None:
    """목적: 표시 PNG 크기·형식 검증. 입력: 바이트·사진. 출력: 오류 시 예외."""
    if not content or len(content) > MAX_RENDER_BYTES:
        raise AppError("표시 PNG 크기가 너무 크거나 비어 있습니다.", "invalid_annotation_image")
    try:
        with Image.open(io.BytesIO(content)) as image:
            if image.format != "PNG" or image.size != (photo["width"], photo["height"]):
                raise AppError("표시 PNG의 크기가 좌표 기준 사진과 일치하지 않습니다.", "invalid_annotation_image")
            image.verify()
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        if isinstance(exc, AppError):
            raise
        raise AppError("표시 PNG를 읽을 수 없습니다.", "invalid_annotation_image") from exc


def pixel_digest(content: bytes) -> bytes:
    """목적: 압축·메타데이터와 독립된 픽셀 비교. 입력: PNG. 출력: RGBA 픽셀 해시."""
    digest = hashlib.sha256()
    with Image.open(io.BytesIO(content)) as image:
        image.load()
        for top in range(0, image.height, 64):
            stripe = image.crop((0, top, image.width, min(top + 64, image.height))).convert("RGBA")
            digest.update(stripe.tobytes())
    return digest.digest()


def export_project(store: ProjectStore, project_id: str, payload: dict) -> tuple[bytes, str]:
    """목적: 한 저장 버전의 전체 자료 묶음 생성. 입력: 저장소·ID·표시 PNG. 출력: ZIP·이름."""
    with store.lock:
        project = store.load(project_id)
        if not isinstance(payload, dict):
            raise AppError("내보내기 자료가 필요합니다.")
        store.check_revision(project, payload.get("revision"))
        annotated = payload.get("annotated_images")
        if not isinstance(annotated, list):
            raise AppError("사진별 표시 PNG 목록이 필요합니다.")
        photos = {photo["id"]: photo for photo in project["photos"]}
        rendered = {}
        for item in annotated:
            if not isinstance(item, dict) or not isinstance(item.get("photo_id"), str) or item["photo_id"] not in photos or item["photo_id"] in rendered:
                raise AppError("표시 PNG의 사진 식별자가 중복되거나 올바르지 않습니다.")
            value = item.get("data_url")
            if not isinstance(value, str) or not value.startswith("data:image/png;base64,"):
                raise AppError("표시 이미지는 PNG 데이터 형식이어야 합니다.")
            try:
                content = base64.b64decode(value.split(",", 1)[1], validate=True)
            except (binascii.Error, ValueError) as exc:
                raise AppError("표시 PNG 인코딩이 올바르지 않습니다.") from exc
            validate_png(content, photos[item["photo_id"]])
            rendered[item["photo_id"]] = content
        if set(rendered) != set(photos):
            raise AppError("모든 사진의 표시 PNG를 준비한 뒤 내보내세요.", "missing_annotation_image")
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=5) as archive:
            archive.writestr("project.json", json_bytes(project))
            archive.writestr("docu/summary.md", summary_markdown(project).encode("utf-8"))
            for photo in photos.values():
                for field in ("original_path", "image_path"):
                    path = store.project_dir(project_id) / photo[field]
                    if not path.is_file():
                        raise AppError("일부 사진 파일이 없습니다. 저장 폴더를 확인하세요.", "missing_photo", 409)
                    archive.write(path, photo[field])
                archive.writestr(f"annotated/{photo['id']}.png", rendered[photo["id"]])
        return output.getvalue(), f"photo-measure-{project_id[:12]}-r{project['revision']}.zip"


def import_project(store: ProjectStore, content: bytes) -> dict:
    """목적: 안전한 ZIP 검사·새 프로젝트 복원. 입력: 저장소·ZIP. 출력: 새 프로젝트."""
    if not content or len(content) > MAX_REQUEST_BYTES:
        raise AppError("ZIP은 512 MiB 이하로 선택하세요.", "archive_too_large", 413)
    try:
        with zipfile.ZipFile(io.BytesIO(content), "r") as archive:
            entries = archive.infolist()
            if len(entries) > 1000 or sum(item.file_size for item in entries) > MAX_ARCHIVE_BYTES:
                raise AppError("ZIP의 파일 수 또는 해제 크기가 너무 큽니다.", "archive_too_large", 413)
            names = set()
            for item in entries:
                path = PurePosixPath(item.filename)
                mode = item.external_attr >> 16
                if (not item.filename or "\\" in item.filename or ":" in item.filename or "\x00" in item.filename
                    or path.is_absolute() or any(part in {".", ".."} for part in item.filename.split("/"))
                    or stat.S_ISLNK(mode) or item.filename in names or item.flag_bits & 1):
                    raise AppError("ZIP에 안전하지 않거나 중복된 경로가 있습니다.", "unsafe_archive")
                names.add(item.filename)
            if "project.json" not in names or archive.getinfo("project.json").file_size > 32 * 1024 * 1024:
                raise AppError("ZIP에 올바른 project.json이 없습니다.", "invalid_archive")
            project = normalize_project(json.loads(archive.read("project.json").decode("utf-8")))
            files = {}
            for photo in project["photos"]:
                for field in ("original_path", "image_path"):
                    path = photo[field]
                    if path not in names:
                        raise AppError("ZIP에 필요한 원본 또는 좌표 기준 사진이 없습니다.", "missing_photo")
                    limit = MAX_IMAGE_BYTES if field == "original_path" else MAX_RENDER_BYTES
                    if archive.getinfo(path).file_size > limit:
                        raise AppError("ZIP의 사진 크기가 제한을 초과했습니다.", "image_too_large", 413)
                    files[path] = archive.read(path)
                regenerated, width, height, _ = decode_photo(files[photo["original_path"]])
                if (width, height) != (photo["width"], photo["height"]):
                    raise AppError("원본 사진의 보정 크기가 프로젝트 정보와 다릅니다.", "invalid_archive")
                validate_png(files[photo["image_path"]], photo)
                if pixel_digest(regenerated) != pixel_digest(files[photo["image_path"]]):
                    raise AppError("좌표 기준 사진의 내용이 원본의 EXIF 보정 결과와 다릅니다.", "invalid_archive")
            return store.install_import(project, files)
    except (zipfile.BadZipFile, zipfile.LargeZipFile, UnicodeDecodeError, json.JSONDecodeError, KeyError, RuntimeError, EOFError) as exc:
        raise AppError("ZIP을 읽을 수 없습니다. 이 앱에서 내보낸 정상 자료를 사용하세요.", "invalid_archive") from exc
