"""사진 간 동일 대상과 실제 치수 의미를 지키는 입력 검증."""

from __future__ import annotations

import math
import unittest

from dimsketch.model import AppError, new_project, normalize_project


def project_fixture() -> dict:
    """목적: 여러 사진의 공통 물체·기준·치수 구성. 입력: 없음. 출력: 유효 프로젝트."""
    project = new_project("다이 컷팅 머신 실측", "직접 측정한 값과 사진을 연결")
    project["photos"] = [
        {"id": "front", "filename": "정면.png", "width": 120, "height": 80,
         "original_path": "originals/front.png", "image_path": "images/front.png",
         "view": "front", "description": "작업자 쪽에서 바라본 정면"},
        {"id": "side", "filename": "측면.jpg", "width": 80, "height": 120,
         "original_path": "originals/side.jpg", "image_path": "images/side.png",
         "view": "side", "description": "본체 쪽에서 바라본 측면"},
    ]
    project["objects"] = [
        {"id": "plate", "label": "A", "name": "고정판", "description": "블레이드 제거 후 남는 고정판", "color": "#123ABC"},
        {"id": "body", "label": "B", "name": "본체", "description": "흰색 고정 본체", "color": "#C43A29"},
    ]
    project["features"] = [
        {"id": "hole1", "object_id": "plate", "kind": "hole", "label": "A-H1", "name": "왼쪽 구멍", "description": ""},
        {"id": "hole2", "object_id": "plate", "kind": "hole", "label": "A-H2", "name": "오른쪽 구멍", "description": ""},
        {"id": "plane", "object_id": "plate", "kind": "plane", "label": "A-F1", "name": "윗면", "description": "프로파일 지지면"},
    ]
    project["measurements"] = [
        {"id": "width", "label": "M01", "name": "고정판 폭", "kind": "width", "direction": "none",
         "from_ref": {"object_id": "plate", "feature_id": None, "text": "왼쪽 끝면"},
         "to_ref": {"object_id": "plate", "feature_id": None, "text": "오른쪽 끝면"},
         "readings": [{"id": "width_v1", "value": 12.5, "unit": "cm", "status": "measured", "error": 0.1,
                       "tool": "줄자", "note": "끝면에서 끝면", "created_at": "2026-10-15T08:00:00Z"}],
         "selected_reading_id": "width_v1"},
        {"id": "pitch", "label": "M02", "name": "구멍 중심 간격", "kind": "pitch", "direction": "none",
         "from_ref": {"object_id": "plate", "feature_id": "hole1", "text": "중심"},
         "to_ref": {"object_id": "plate", "feature_id": "hole2", "text": "중심"},
         "readings": [{"id": "pitch_v1", "value": 40, "unit": "mm", "status": "measured", "error": None,
                       "tool": "버니어 캘리퍼스", "note": "", "created_at": "2026-10-15T08:00:00Z"}],
         "selected_reading_id": "pitch_v1"},
        {"id": "offset", "label": "M03", "name": "원단면 대비 지지면 높이", "kind": "offset", "direction": "down",
         "from_ref": {"object_id": None, "feature_id": None, "text": "평평한 원단면 Z=0"},
         "to_ref": {"object_id": "plate", "feature_id": "plane", "text": "윗면"},
         "readings": [{"id": "offset_v1", "value": 15, "unit": "mm", "status": "approximate", "error": 1,
                       "tool": "자", "note": "기준면 아래", "created_at": "2026-10-15T08:00:00Z"}],
         "selected_reading_id": "offset_v1"},
    ]
    project["annotations"] = [
        {"id": "plate_front", "photo_id": "front", "target_type": "object", "target_id": "plate", "shape": "rect",
         "points": [[5, 10], [115, 70]], "label_position": [5, 5]},
        {"id": "plate_side", "photo_id": "side", "target_type": "object", "target_id": "plate", "shape": "polygon",
         "points": [[10, 10], [30, 10], [35, 100], [10, 100]], "label_position": [10, 5]},
        {"id": "hole_front", "photo_id": "front", "target_type": "feature", "target_id": "hole1", "shape": "point",
         "points": [[20, 40]], "label_position": [20, 30]},
        {"id": "width_front", "photo_id": "front", "target_type": "measurement", "target_id": "width", "shape": "line",
         "points": [[5, 75], [115, 75]], "label_position": [50, 70]},
        {"id": "width_side", "photo_id": "side", "target_type": "measurement", "target_id": "width", "shape": "line",
         "points": [[10, 10], [35, 100]], "label_position": [40, 60]},
    ]
    return project


class ProjectModelTests(unittest.TestCase):
    """참조·단위·좌표 검증의 사용자 요구 기반 회귀 검사."""

    def test_shared_objects_features_and_dimensions_keep_identity_across_views(self):
        """목적: 다른 사진의 A·M01 연결 유지 검사. 입력: 정면·측면 기록. 출력: 동일 참조 확인."""
        source = project_fixture()
        result = normalize_project(source)
        object_marks = [item for item in result["annotations"] if item["target_type"] == "object"]
        dimension_marks = [item for item in result["annotations"] if item["target_type"] == "measurement"]
        self.assertEqual({item["photo_id"] for item in object_marks}, {"front", "side"})
        self.assertEqual({item["target_id"] for item in object_marks}, {"plate"})
        self.assertEqual({item["target_id"] for item in dimension_marks}, {"width"})
        self.assertEqual(result["measurements"][1]["from_ref"]["feature_id"], "hole1")
        self.assertEqual(result["measurements"][1]["to_ref"]["feature_id"], "hole2")
        self.assertEqual(source["counters"]["object"], 0, "검증은 입력 원본을 수정하면 안 됨")

    def test_cm_is_normalized_without_changing_pixel_coordinates(self):
        """목적: 실제 mm값과 사진 좌표 분리 검사. 입력: cm·측정 오차. 출력: 125mm·1mm와 원 좌표."""
        source = project_fixture()
        result = normalize_project(source)
        reading = result["measurements"][0]["readings"][0]
        self.assertEqual(reading["value"], 12.5)
        self.assertEqual(reading["unit"], "cm")
        self.assertEqual(reading["value_mm"], 125)
        self.assertEqual(reading["error_mm"], 1)
        self.assertEqual(result["annotations"], source["annotations"])
        self.assertEqual(result["measurements"][2]["direction"], "down")
        self.assertEqual(result["measurements"][2]["readings"][0]["value_mm"], 15)

    def test_unmeasured_value_remains_null_not_zero_or_estimate(self):
        """목적: 미측정값 확정 방지 검사. 입력: 미측정 상태. 출력: 실제값·mm값 null."""
        project = project_fixture()
        reading = project["measurements"][0]["readings"][0]
        reading.update(status="unknown", value=None, value_mm=987)
        result = normalize_project(project)
        self.assertIsNone(result["measurements"][0]["readings"][0]["value"])
        self.assertIsNone(result["measurements"][0]["readings"][0]["value_mm"])

    def test_conflicting_readings_are_preserved_and_selection_is_explicit(self):
        """목적: 재측정값 자동 덮어쓰기 방지. 입력: 125mm·126mm. 출력: 두 이력과 채택값 유지."""
        project = project_fixture()
        measurement = project["measurements"][0]
        measurement["readings"].append({"id": "width_v2", "value": 126, "unit": "mm", "status": "measured",
                                         "error": None, "tool": "캘리퍼스", "note": "다시 측정", "created_at": "2026-10-15T09:00:00Z"})
        result = normalize_project(project)
        self.assertEqual([item["value_mm"] for item in result["measurements"][0]["readings"]], [125, 126])
        self.assertEqual(result["measurements"][0]["selected_reading_id"], "width_v1")
        project["measurements"][0]["selected_reading_id"] = "width_v2"
        self.assertEqual(normalize_project(project)["measurements"][0]["selected_reading_id"], "width_v2")
        project["measurements"][0]["selected_reading_id"] = "missing"
        with self.assertRaises(AppError):
            normalize_project(project)

    def test_unknown_endpoints_can_be_described_without_image_marks(self):
        """목적: 가려진 기준의 설명 기록 허용. 입력: 텍스트 기준·표시 없음. 출력: 참조와 치수 보존."""
        project = project_fixture()
        project["measurements"][0]["from_ref"] = {"object_id": None, "feature_id": None, "text": "가려진 판의 뒤쪽 끝면"}
        project["annotations"] = [item for item in project["annotations"] if item["target_id"] != "width"]
        self.assertEqual(normalize_project(project)["measurements"][0]["from_ref"]["text"], "가려진 판의 뒤쪽 끝면")

    def test_deleting_referenced_objects_features_or_dimensions_is_rejected(self):
        """목적: 연결 대상 삭제로 생기는 참조 유실 방지. 입력: 참조 대상 삭제. 출력: 검증 오류."""
        for field, removed_id in (("objects", "plate"), ("features", "hole1"), ("measurements", "width"), ("photos", "front")):
            with self.subTest(field=field):
                project = project_fixture()
                project[field] = [item for item in project[field] if item["id"] != removed_id]
                with self.assertRaises(AppError):
                    normalize_project(project)

    def test_hole_reference_must_belong_to_selected_object(self):
        """목적: 다른 물체의 구멍으로 오연결 방지. 입력: B 물체·A-H1 조합. 출력: 검증 오류."""
        project = project_fixture()
        project["measurements"][1]["from_ref"]["object_id"] = "body"
        with self.assertRaises(AppError):
            normalize_project(project)

    def test_duplicate_labels_ids_and_invalid_geometry_are_rejected(self):
        """목적: 모호한 번호·잘못된 표시 방지. 입력: 각 오류 변형. 출력: 검증 오류."""
        cases = [
            ("같은 물체 번호", ("objects", 1, "label", "A")),
            ("같은 내부 번호", ("objects", 1, "id", "plate")),
            ("다른 소속 홀 번호", ("features", 0, "label", "B-H1")),
            ("사진 밖 표시", ("annotations", 0, "points", [[5, 10], [121, 70]])),
            ("음수 좌표", ("annotations", 0, "points", [[-1, 10], [115, 70]])),
            ("무한 좌표", ("annotations", 0, "points", [[math.inf, 10], [115, 70]])),
            ("사진 밖 라벨", ("annotations", 0, "label_position", [0, 81])),
            ("짧은 다각형", ("annotations", 1, "points", [[10, 10], [20, 20]])),
            ("다른 치수 표시 종류", ("annotations", 3, "shape", "polygon")),
        ]
        for name, (field, index, key, value) in cases:
            with self.subTest(case=name):
                project = project_fixture()
                project[field][index][key] = value
                with self.assertRaises(AppError):
                    normalize_project(project)

    def test_nonfinite_negative_and_missing_measurements_are_rejected(self):
        """목적: 모델링 불가능한 실측값 방지. 입력: 잘못된 수치. 출력: 검증 오류."""
        for value in (-1, math.inf, math.nan, True, "125", None, 0):
            with self.subTest(value=value):
                project = project_fixture()
                project["measurements"][0]["readings"][0]["value"] = value
                with self.assertRaises(AppError):
                    normalize_project(project)
        project = project_fixture()
        project["measurements"][2]["readings"][0]["value"] = 0
        self.assertEqual(normalize_project(project)["measurements"][2]["readings"][0]["value_mm"], 0)

    def test_number_counters_survive_deletion_and_labels_extend_past_z(self):
        """목적: 삭제 후 번호 재사용·자동 재정렬 방지. 입력: 높은 번호 이력. 출력: 순번 유지."""
        project = project_fixture()
        project["counters"].update(object=40, measurement=90)
        project["counters"]["features"]["plate:hole"] = 9
        project["objects"][1]["label"] = "AA"
        result = normalize_project(project)
        self.assertEqual(result["objects"][1]["label"], "AA")
        self.assertEqual(result["counters"]["object"], 40)
        self.assertEqual(result["counters"]["measurement"], 90)
        self.assertEqual(result["counters"]["features"]["plate:hole"], 9)
        self.assertNotEqual(id(project), id(result))

    def test_inter_object_gap_preserves_both_objects_and_the_measurement_reference(self):
        """목적: 물체 크기와 조립 배치 거리 구분 검사. 입력: A→B 면 간격. 출력: 서로 다른 기준 참조."""
        project = project_fixture()
        dimension = project["measurements"][0]
        dimension.update(kind="gap", name="고정판에서 본체까지")
        dimension["to_ref"] = {"object_id": "body", "feature_id": None, "text": "본체 안쪽면"}
        dimension["readings"][0].update(value=3, unit="mm")
        saved = normalize_project(project)["measurements"][0]
        self.assertEqual(saved["from_ref"]["object_id"], "plate")
        self.assertEqual(saved["to_ref"]["object_id"], "body")
        self.assertEqual(saved["readings"][0]["value_mm"], 3)
        self.assertEqual(saved["to_ref"]["text"], "본체 안쪽면")

    def test_boolean_schema_and_overflowing_cm_values_are_rejected(self):
        """목적: JSON 형식·환산 오버플로 방지. 입력: bool 버전·큰 cm 수치. 출력: 검증 오류."""
        project = project_fixture()
        project["schema_version"] = True
        with self.assertRaises(AppError):
            normalize_project(project)
        for key in ("value", "error"):
            with self.subTest(key=key):
                project = project_fixture()
                project["measurements"][0]["readings"][0][key] = 1e308
                with self.assertRaises(AppError):
                    normalize_project(project)

    def test_reference_height_requires_direction_and_keeps_positive_magnitude(self):
        """목적: 높이의 부호 기준 누락 방지. 입력: 양수 mm와 위·아래·미지정. 출력: 방향 보존 또는 오류."""
        for direction in ("up", "down"):
            with self.subTest(direction=direction):
                project = project_fixture()
                project["measurements"][2]["direction"] = direction
                dimension = normalize_project(project)["measurements"][2]
                self.assertEqual(dimension["direction"], direction)
                self.assertEqual(dimension["readings"][0]["value_mm"], 15)
                self.assertGreater(dimension["readings"][0]["value_mm"], 0)
        project = project_fixture()
        project["measurements"][2]["direction"] = "none"
        with self.assertRaises(AppError):
            normalize_project(project)


if __name__ == "__main__":
    unittest.main()
