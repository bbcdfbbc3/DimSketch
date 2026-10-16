"""사진 실측 프로젝트의 공통 형식과 입력 검증."""

from __future__ import annotations

import copy
import math
import re
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

SCHEMA_VERSION = 1
MAX_IMAGE_BYTES = 30 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_REQUEST_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
MAX_PHOTOS = 100
VIEWS = {"overall", "front", "side", "top", "bottom", "oblique", "other"}
KINDS = {"length", "width", "height", "thickness", "diameter", "pitch", "gap", "offset"}
FEATURE_KINDS = {"hole": "H", "point": "P", "plane": "F"}
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


class AppError(ValueError):
    """사용자에게 설명 가능한 요청·저장 오류."""

    def __init__(self, message: str, code: str = "invalid_input", status: int = 400):
        """목적: 오류 정보 구성. 입력: 설명·코드·HTTP 상태. 출력: 오류 객체."""
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


ValidationError = AppError


def now_iso() -> str:
    """목적: UTC 시각 생성. 입력: 없음. 출력: ISO 문자열."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def new_id() -> str:
    """목적: 내부 식별자 생성. 입력: 없음. 출력: UUID 문자열."""
    return uuid4().hex


def check_id(value: Any, name: str = "식별자") -> str:
    """목적: 경로에 사용할 식별자 검사. 입력: 값·항목명. 출력: 유효 문자열."""
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise AppError(f"{name} 형식이 올바르지 않습니다.")
    return value


def text_field(value: Any, name: str, limit: int = 5000) -> str:
    """목적: 사용자 설명 검사. 입력: 값·항목명·최대 길이. 출력: 문자열."""
    if not isinstance(value, str) or len(value) > limit:
        raise AppError(f"{name}은(는) {limit}자 이내의 글자로 입력하세요.")
    return value


def integer(value: Any, name: str, minimum: int = 0) -> int:
    """목적: 정수 검사. 입력: 값·항목명·최솟값. 출력: 정수."""
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise AppError(f"{name}은(는) {minimum} 이상의 정수여야 합니다.")
    return value


def number(value: Any, name: str, minimum: float = 0) -> float:
    """목적: 유한 실수 검사. 입력: 값·항목명·최솟값. 출력: 실수."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AppError(f"{name}에 숫자를 입력하세요.")
    if not math.isfinite(value) or value < minimum:
        raise AppError(f"{name}에 {minimum} 이상의 유한한 숫자를 입력하세요.")
    return value


def label_index(label: str) -> int:
    """목적: 물체 번호 순번 계산. 입력: A~Z·AA 형식. 출력: 1부터 시작하는 순번."""
    if not re.fullmatch(r"[A-Z]{1,6}", label):
        raise AppError("물체 번호는 A, B, AA처럼 영문 대문자로 입력하세요.")
    result = 0
    for char in label:
        result = result * 26 + ord(char) - 64
    return result


def new_project(name: Any, description: Any = "") -> dict:
    """목적: 빈 프로젝트 생성. 입력: 이름·설명. 출력: 초기 프로젝트."""
    name = text_field(name, "프로젝트 이름", 200).strip()
    if not name:
        raise AppError("프로젝트 이름을 입력하세요.")
    stamp = now_iso()
    return {"schema_version": SCHEMA_VERSION, "id": new_id(), "name": name,
            "description": text_field(description, "프로젝트 설명"), "revision": 0,
            "created_at": stamp, "updated_at": stamp,
            "counters": {"object": 0, "measurement": 0, "features": {}},
            "photos": [], "objects": [], "features": [], "measurements": [], "annotations": []}


def records(project: dict, field: str) -> dict[str, dict]:
    """목적: 목록의 중복·형식 검사. 입력: 프로젝트·필드명. 출력: ID별 항목."""
    items = project.get(field)
    if not isinstance(items, list) or len(items) > 10000:
        raise AppError(f"{field} 목록 형식 또는 개수가 올바르지 않습니다.")
    result = {}
    for item in items:
        if not isinstance(item, dict):
            raise AppError(f"{field}의 각 항목은 객체여야 합니다.")
        item_id = check_id(item.get("id"), field)
        if item_id in result:
            raise AppError(f"{field}에 중복된 식별자가 있습니다.")
        result[item_id] = item
    return result


def check_ref(ref: Any, objects: dict, features: dict) -> None:
    """목적: 치수 기준의 참조 검사. 입력: 기준·물체·기준 요소. 출력: 오류 시 예외."""
    if not isinstance(ref, dict):
        raise AppError("치수의 시작·끝 기준을 입력하세요.")
    object_id, feature_id = ref.get("object_id"), ref.get("feature_id")
    if object_id is not None and object_id not in objects:
        raise AppError("치수가 참조하는 물체가 없습니다. 연결 항목을 먼저 정리하세요.")
    if feature_id is not None:
        if feature_id not in features or features[feature_id]["object_id"] != object_id:
            raise AppError("치수의 기준 요소와 소속 물체가 일치하지 않습니다.")
    text_field(ref.get("text", ""), "치수 기준 설명", 1000)
    if object_id is None and feature_id is None and not ref.get("text", "").strip():
        raise AppError("치수의 시작·끝에 물체, 기준 요소 또는 기준 설명을 입력하세요.")


def check_point(point: Any, photo: dict) -> None:
    """목적: 이미지 좌표 검사. 입력: 점·사진. 출력: 오류 시 예외."""
    if not isinstance(point, list) or len(point) != 2:
        raise AppError("표시 좌표는 x, y 한 쌍이어야 합니다.")
    x, y = number(point[0], "x 좌표"), number(point[1], "y 좌표")
    if x > photo["width"] or y > photo["height"]:
        raise AppError("표시 좌표가 사진의 크기를 벗어났습니다.")


def _normalize_project(value: Any) -> dict:
    """목적: 저장 자료 검증·mm값 정규화. 입력: 프로젝트 JSON. 출력: 검증된 복사본."""
    if not isinstance(value, dict) or type(value.get("schema_version")) is not int or value.get("schema_version") != SCHEMA_VERSION:
        raise AppError("지원하지 않는 프로젝트 형식입니다. schema_version 1 자료를 사용하세요.")
    project = copy.deepcopy(value)
    check_id(project.get("id"), "프로젝트 식별자")
    project["name"] = text_field(project.get("name"), "프로젝트 이름", 200).strip()
    if not project["name"]:
        raise AppError("프로젝트 이름을 입력하세요.")
    text_field(project.get("description", ""), "프로젝트 설명")
    integer(project.get("revision"), "저장 버전")
    text_field(project.get("created_at"), "생성 시각", 100)
    text_field(project.get("updated_at"), "수정 시각", 100)
    photos, objects, features, measurements, annotations = (
        records(project, field) for field in ("photos", "objects", "features", "measurements", "annotations")
    )
    if len(photos) > MAX_PHOTOS:
        raise AppError(f"사진은 프로젝트당 {MAX_PHOTOS}장까지 등록할 수 있습니다.")
    counters = project.get("counters")
    if not isinstance(counters, dict) or not isinstance(counters.get("features"), dict):
        raise AppError("번호 관리 정보가 올바르지 않습니다.")
    integer(counters.get("object"), "물체 번호 순번")
    integer(counters.get("measurement"), "치수 번호 순번")
    for counter in counters["features"].values():
        integer(counter, "기준 요소 번호 순번")
    for photo in photos.values():
        for field in ("width", "height"):
            integer(photo.get(field), "사진 크기", 1)
        if photo["width"] * photo["height"] > MAX_IMAGE_PIXELS:
            raise AppError("사진은 4천만 화소 이하로 등록하세요.", "image_too_large", 413)
        text_field(photo.get("filename"), "사진 이름", 1000)
        for field, folder in (("original_path", "originals"), ("image_path", "images")):
            path = photo.get(field)
            if not isinstance(path, str) or not re.fullmatch(rf"{folder}/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)", path):
                raise AppError("사진 저장 경로가 올바르지 않습니다.")
        if photo.get("view") not in VIEWS:
            raise AppError("사진의 촬영 방향을 선택하세요.")
        text_field(photo.get("description", ""), "사진 설명")
    labels = set()
    for obj in objects.values():
        label = text_field(obj.get("label"), "물체 번호", 20)
        if label in labels:
            raise AppError("물체 번호가 중복되었습니다.")
        labels.add(label)
        counters["object"] = max(counters["object"], label_index(label))
        text_field(obj.get("name", ""), "물체 이름", 200)
        text_field(obj.get("description", ""), "물체 설명")
        if not isinstance(obj.get("color"), str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", obj["color"]):
            raise AppError("물체 색상을 #RRGGBB 형식으로 지정하세요.")
    labels.clear()
    for feature in features.values():
        object_id, kind = feature.get("object_id"), feature.get("kind")
        if object_id not in objects or kind not in FEATURE_KINDS:
            raise AppError("기준 요소의 소속 물체 또는 종류가 올바르지 않습니다.")
        label = feature.get("label")
        match = re.fullmatch(re.escape(objects[object_id]["label"]) + "-" + FEATURE_KINDS[kind] + r"([1-9][0-9]*)", label or "")
        if not match or label in labels:
            raise AppError("기준 요소 번호가 올바르지 않거나 중복되었습니다.")
        labels.add(label)
        key = object_id + ":" + kind
        counters["features"][key] = max(counters["features"].get(key, 0), int(match.group(1)))
        text_field(feature.get("name", ""), "기준 요소 이름", 200)
        text_field(feature.get("description", ""), "기준 요소 설명")
    labels.clear()
    for measurement in measurements.values():
        label = measurement.get("label", "")
        match = re.fullmatch(r"M([0-9]{2,})", label)
        if not match or int(match.group(1)) < 1 or label in labels:
            raise AppError("치수 번호는 M01처럼 중복 없이 지정하세요.")
        labels.add(label)
        counters["measurement"] = max(counters["measurement"], int(match.group(1)))
        text_field(measurement.get("name", ""), "치수 이름", 200)
        if measurement.get("kind") not in KINDS or measurement.get("direction") not in {"none", "up", "down"}:
            raise AppError("치수 종류와 방향을 선택하세요.")
        if measurement["kind"] == "offset" and measurement["direction"] == "none":
            raise AppError("기준면 대비 높이는 기준보다 위인지 아래인지 선택하세요.")
        check_ref(measurement.get("from_ref"), objects, features)
        check_ref(measurement.get("to_ref"), objects, features)
        readings = records({"readings": measurement.get("readings")}, "readings")
        for reading in readings.values():
            if reading.get("unit") not in {"mm", "cm"} or reading.get("status") not in {"measured", "approximate", "unknown"}:
                raise AppError("치수의 단위와 측정 상태를 선택하세요.")
            multiplier = 10 if reading["unit"] == "cm" else 1
            if reading["status"] == "unknown":
                reading["value"] = None
                reading["value_mm"] = None
            else:
                reading["value"] = number(reading.get("value"), "실측값")
                if measurement["kind"] not in {"gap", "offset"} and reading["value"] == 0:
                    raise AppError("길이·폭·높이·두께·지름·구멍 간격은 0보다 커야 합니다.")
                reading["value_mm"] = number(reading["value"] * multiplier, "mm 환산 실측값")
            error = reading.get("error")
            reading["error_mm"] = None if error is None else number(number(error, "측정 오차") * multiplier, "mm 환산 측정 오차")
            text_field(reading.get("tool", ""), "측정 도구", 200)
            text_field(reading.get("note", ""), "측정 메모")
            text_field(reading.get("created_at", ""), "측정 시각", 100)
        selected = measurement.get("selected_reading_id")
        if selected is not None and selected not in readings:
            raise AppError("채택한 측정 기록이 존재하지 않습니다.")
    targets = {"object": objects, "feature": features, "measurement": measurements}
    for annotation in annotations.values():
        photo_id, target_type = annotation.get("photo_id"), annotation.get("target_type")
        if photo_id not in photos or target_type not in targets or annotation.get("target_id") not in targets[target_type]:
            raise AppError("사진 표시가 참조하는 사진·물체·치수가 없습니다. 연결 항목을 먼저 정리하세요.")
        shape, points = annotation.get("shape"), annotation.get("points")
        allowed = {"object": {"rect", "polygon"}, "feature": {"point", "line"}, "measurement": {"line"}}
        if shape not in allowed[target_type] or not isinstance(points, list):
            raise AppError("사진 표시 종류가 올바르지 않습니다.")
        expected = {"rect": 2, "line": 2, "point": 1}.get(shape)
        if (expected is not None and len(points) != expected) or (shape == "polygon" and not 3 <= len(points) <= 1000):
            raise AppError("사진 표시에 필요한 점의 수가 올바르지 않습니다.")
        for point in points:
            check_point(point, photos[photo_id])
        if annotation.get("label_position") is not None:
            check_point(annotation["label_position"], photos[photo_id])
    return project


def normalize_project(value: Any) -> dict:
    """목적: 잘못된 JSON 자료의 검증 오류 통일. 입력: 프로젝트. 출력: 정규화 자료."""
    try:
        return _normalize_project(value)
    except (TypeError, OverflowError) as exc:
        raise AppError("프로젝트 항목의 자료형 또는 숫자 범위가 올바르지 않습니다.") from exc
