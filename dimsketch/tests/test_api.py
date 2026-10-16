"""브라우저와 같은 API 흐름으로 저장·자료 전달 검증."""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import stat
import tempfile
import unittest
import warnings
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo

from dimsketch.server import create_app
from dimsketch.tests.support import image_bytes, zip_bytes, zip_entries
from dimsketch.tests.test_model import project_fixture


class PhotoMeasureAPITests(unittest.TestCase):
    """오류 응답과 왕복 자료의 사용 의미를 검증하는 통합 검사."""

    def setUp(self):
        """목적: HTTP별 임시 프로젝트 생성. 입력: 없음. 출력: 클라이언트·빈 프로젝트."""
        self.temporary = tempfile.TemporaryDirectory(prefix="photo-measure-api-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = create_app(self.root)
        self.app.config.update(TESTING=True)
        self.client = self.app.test_client()
        response = self.client.post("/api/projects", json={"name": "다이 컷팅 머신", "description": "실측 자료"})
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        self.project = response.get_json()
        self.project_id = self.project["id"]
        self.url = f"/api/projects/{self.project_id}"

    def upload(self, uploads=None, revision=None):
        """목적: 실제 멀티파트 사진 전송. 입력: 이름·바이트 목록·버전. 출력: HTTP 응답."""
        if uploads is None:
            uploads = [("정면.png", image_bytes()), ("측면.jpg", image_bytes("JPEG", (80, 120)))]
        return self.client.post(self.url + "/photos", data={
            "revision": str(self.project["revision"] if revision is None else revision),
            "files": [(BytesIO(content), filename) for filename, content in uploads],
        }, content_type="multipart/form-data")

    def populated_project(self):
        """목적: 사진·물체·치수가 연결된 실사용 자료 저장. 입력: 없음. 출력: 저장된 프로젝트."""
        response = self.upload()
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        uploaded = response.get_json()
        sample = project_fixture()
        remap = {"front": uploaded["photos"][0]["id"], "side": uploaded["photos"][1]["id"]}
        for annotation in sample["annotations"]:
            annotation["photo_id"] = remap[annotation["photo_id"]]
        for actual, expected in zip(uploaded["photos"], sample["photos"]):
            actual.update(view=expected["view"], description=expected["description"])
        for field in ("objects", "features", "measurements", "annotations"):
            uploaded[field] = sample[field]
        response = self.client.put(self.url, json=uploaded)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.project = response.get_json()
        return self.project

    def test_rotated_region_coordinates_survive_save_export_and_import(self):
        """목적: 회전 영역의 저장·ZIP 호환성 검사. 입력: 회전된 사각형 꼭짓점. 출력: 모든 좌표·다른 사진·치수 보존."""
        project = self.populated_project()
        before_measurements = copy.deepcopy(project["measurements"])
        before_other = copy.deepcopy(project["annotations"][1:])
        mark = project["annotations"][0]
        mark.update(shape="polygon", points=[[60.5, 5.25], [100.75, 40.5], [60.5, 75.75], [20.25, 40.5]])
        expected = copy.deepcopy(mark)
        response = self.client.put(self.url, json=project)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        project = response.get_json()
        self.assertEqual(self.client.get(self.url).get_json()["annotations"][0], expected)
        exported = self.export_response(project)
        self.assertEqual(exported.status_code, 200, exported.get_data(as_text=True) if exported.status_code != 200 else "")
        imported = self.import_response(exported.data)
        self.assertEqual(imported.status_code, 201, imported.get_data(as_text=True))
        restored = imported.get_json()
        self.assertEqual(restored["annotations"][0], expected)
        self.assertEqual(restored["annotations"][1:], before_other)
        self.assertEqual(restored["measurements"], before_measurements)

    def annotation_payload(self, project):
        """목적: 내보내기용 사진별 PNG 구성. 입력: 프로젝트. 출력: 사진 ID·PNG data URL 목록."""
        return [{"photo_id": photo["id"], "data_url": "data:image/png;base64," + base64.b64encode(
            image_bytes("PNG", (photo["width"], photo["height"]))
        ).decode("ascii")} for photo in project["photos"]]

    def export_response(self, project):
        """목적: 확정 버전 자료 내보내기. 입력: 저장 프로젝트. 출력: ZIP HTTP 응답."""
        return self.client.post(self.url + "/export", json={
            "revision": project["revision"], "annotated_images": self.annotation_payload(project),
        })

    def import_response(self, content):
        """목적: 자료 ZIP 다시 불러오기. 입력: ZIP 바이트. 출력: HTTP 응답."""
        return self.client.post("/api/projects/import", data={"file": (BytesIO(content), "measurements.zip")},
                                content_type="multipart/form-data")

    def download_bytes(self, url):
        """목적: 응답 파일을 닫고 내용 읽기. 입력: 다운로드 URL. 출력: HTTP 파일 바이트."""
        with self.client.get(url) as response:
            self.assertEqual(response.status_code, 200)
            return response.data

    def assert_rejected_import_preserves_projects(self, content):
        """목적: 실패한 가져오기의 기존 자료 보존 검사. 입력: 잘못된 ZIP. 출력: 오류·변경 없음 단언."""
        before = self.client.get("/api/projects").get_json()
        project_before = self.client.get(self.url).get_json()
        response = self.import_response(content)
        self.assertGreaterEqual(response.status_code, 400, response.get_data(as_text=True))
        self.assertLess(response.status_code, 500, response.get_data(as_text=True))
        self.assertTrue(response.get_json()["error"])
        self.assertEqual(self.client.get("/api/projects").get_json(), before)
        self.assertEqual(self.client.get(self.url).get_json(), project_before)
        self.assertEqual(list((self.root / "projects").glob(".import-*")), [])

    def test_health_index_and_project_list_expose_a_working_local_app(self):
        """목적: 시작 화면·기본 API 연결 검사. 입력: HTTP 조회. 출력: 정상 화면·현재 프로젝트."""
        health = self.client.get("/api/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.get_json()["schema_version"], 1)
        self.assertEqual(health.get_json()["status"], "ok")
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn("text/html", page.content_type)
        projects = self.client.get("/api/projects").get_json()["projects"]
        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0]["name"], "다이 컷팅 머신")
        self.assertEqual(self.client.get(self.url).get_json(), self.project)

    def test_invalid_requests_return_readable_json_without_creating_projects(self):
        """목적: 잘못된 입력의 사용자 오류 처리 검사. 입력: 빈 이름·비정상 JSON. 출력: 4xx 설명."""
        for payload in ({"name": "   "}, {"name": 123}, None, []):
            with self.subTest(payload=payload):
                response = self.client.post("/api/projects", json=payload)
                self.assertIn(response.status_code, (400, 415))
                self.assertTrue(response.get_json()["error"])
        response = self.client.put(self.url, data="{", content_type="application/json")
        self.assertEqual(response.status_code, 400)
        self.assertTrue(response.get_json()["error"])
        self.assertEqual(len(self.client.get("/api/projects").get_json()["projects"]), 1)

    def test_http_save_normalizes_units_and_stale_tabs_get_conflict(self):
        """목적: 실제 저장 API의 치수 의미와 충돌 검사. 입력: 두 탭 편집. 출력: mm·409·최신값 유지."""
        project = self.populated_project()
        reading = project["measurements"][0]["readings"][0]
        self.assertEqual(reading["value_mm"], 125)
        self.assertEqual(reading["error_mm"], 1)
        first = copy.deepcopy(project)
        first["objects"][0]["name"] = "검증된 고정판"
        saved = self.client.put(self.url, json=first).get_json()
        stale = copy.deepcopy(project)
        stale["objects"][0]["name"] = "오래된 정보"
        conflict = self.client.put(self.url, json=stale)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.get_json()["code"], "revision_conflict")
        self.assertEqual(self.client.get(self.url).get_json(), saved)

    def test_http_dangling_reference_rejection_keeps_current_state(self):
        """목적: 참조 대상 삭제의 HTTP 저장 거부 검사. 입력: A-H1 삭제. 출력: 400·정상본 유지."""
        project = self.populated_project()
        broken = copy.deepcopy(project)
        broken["features"] = [item for item in broken["features"] if item["id"] != "hole1"]
        response = self.client.put(self.url, json=broken)
        self.assertEqual(response.status_code, 400)
        self.assertTrue(response.get_json()["error"])
        self.assertEqual(self.client.get(self.url).get_json(), project)

    def test_http_original_download_and_rotated_image_use_the_correct_coordinate_frame(self):
        """목적: 사진 HTTP 전달과 EXIF 좌표 기준 검사. 입력: 회전 JPEG. 출력: 원본 동일·보정 크기."""
        original = image_bytes("JPEG", (120, 80), orientation=6)
        response = self.upload([("phone.jpg", original)])
        self.assertEqual(response.status_code, 200)
        photo = response.get_json()["photos"][0]
        self.assertEqual((photo["width"], photo["height"]), (80, 120))
        download = self.client.get(f"{self.url}/photos/{photo['id']}/original")
        self.addCleanup(download.close)
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.data, original)
        editing = self.client.get(f"{self.url}/photos/{photo['id']}/image")
        self.addCleanup(editing.close)
        self.assertEqual(editing.status_code, 200)
        from PIL import Image

        with Image.open(BytesIO(editing.data)) as image:
            self.assertEqual(image.size, (80, 120))
            self.assertEqual(image.format, "PNG")
        missing = self.client.get(f"{self.url}/photos/missing/image")
        self.assertEqual(missing.status_code, 404)

    def test_http_failed_batch_and_stale_upload_do_not_save_partial_photos(self):
        """목적: 업로드 실패·충돌의 원본 보존 검사. 입력: 혼합 파일·오래된 버전. 출력: 기존 상태 유지."""
        failed = self.upload([("valid.png", image_bytes()), ("bad.png", b"broken")])
        self.assertEqual(failed.status_code, 400)
        self.assertEqual(self.client.get(self.url).get_json()["photos"], [])
        self.assertEqual(self.client.get(self.url).get_json()["revision"], 0)
        self.project = self.upload([("valid.png", image_bytes())]).get_json()
        conflict = self.upload([("second.png", image_bytes())], revision=0)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(self.client.get(self.url).get_json(), self.project)

    def test_export_keeps_originals_ids_provenance_and_bullet_summary(self):
        """목적: CAD 전달 묶음의 자료 추적 가능성 검사. 입력: 다중 사진 치수. 출력: 원본·JSON·글머리 문서."""
        project = self.populated_project()
        response = self.export_response(project)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True) if response.status_code != 200 else "")
        self.assertIn("zip", response.content_type)
        entries = zip_entries(response.data)
        self.assertIn("project.json", entries)
        self.assertIn("docu/summary.md", entries)
        exported = json.loads(entries["project.json"])
        self.assertEqual(exported, project)
        self.assertEqual(exported["schema_version"], 1)
        for photo in project["photos"]:
            self.assertIn(photo["original_path"], entries)
            self.assertIn(photo["image_path"], entries)
            self.assertIn(f"annotated/{photo['id']}.png", entries)
            original = self.download_bytes(f"{self.url}/photos/{photo['id']}/original")
            self.assertEqual(hashlib.sha256(entries[photo["original_path"]]).digest(), hashlib.sha256(original).digest())
        summary = entries["docu/summary.md"].decode("utf-8")
        for evidence in ("A", "고정판", "A-H1", "A-H2", "M01", "125", "mm", "정면.png", "측면.jpg", "원단면"):
            self.assertIn(evidence, summary)
        self.assertRegex(summary, r"(?m)^\s*- ")
        self.assertNotRegex(summary, r"(?m)^\s*\|.*\|\s*$")
        self.assertEqual(self.client.get(self.url).get_json(), project, "내보내기는 저장 버전을 바꾸면 안 됨")

    def test_export_rejects_stale_incomplete_or_wrong_annotation_images(self):
        """목적: JSON과 다른 사진 표시 묶음 방지. 입력: 버전·사진·PNG 오류. 출력: 요청 거부·정상본 유지."""
        project = self.populated_project()
        valid = self.annotation_payload(project)
        cases = [
            ("오래된 버전", {"revision": project["revision"] - 1, "annotated_images": valid}, 409),
            ("PNG 누락", {"revision": project["revision"], "annotated_images": valid[:1]}, 400),
            ("PNG 중복", {"revision": project["revision"], "annotated_images": valid + valid[:1]}, 400),
            ("사진 ID 오류", {"revision": project["revision"], "annotated_images": [dict(valid[0], photo_id="missing"), valid[1]]}, 400),
            ("PNG 크기 오류", {"revision": project["revision"], "annotated_images": [dict(valid[0], data_url="data:image/png;base64," + base64.b64encode(image_bytes("PNG", (1, 1))).decode("ascii")), valid[1]]}, 400),
            ("JPEG 위장", {"revision": project["revision"], "annotated_images": [dict(valid[0], data_url="data:image/png;base64," + base64.b64encode(image_bytes("JPEG")).decode("ascii")), valid[1]]}, 400),
            ("손상 PNG", {"revision": project["revision"], "annotated_images": [dict(valid[0], data_url="data:image/png;base64,YmFk"), valid[1]]}, 400),
        ]
        for name, payload, expected_status in cases:
            with self.subTest(case=name):
                response = self.client.post(self.url + "/export", json=payload)
                self.assertEqual(response.status_code, expected_status, response.get_data(as_text=True))
                self.assertTrue(response.get_json()["error"])
                self.assertEqual(self.client.get(self.url).get_json(), project)

    def test_export_import_roundtrip_creates_new_project_and_keeps_all_links(self):
        """목적: ZIP 복원의 기존 자료 보존·참조 연결 검사. 입력: 정상 내보내기. 출력: 새 프로젝트·같은 치수."""
        project = self.populated_project()
        response = self.export_response(project)
        self.assertEqual(response.status_code, 200)
        imported = self.import_response(response.data)
        self.assertEqual(imported.status_code, 201, imported.get_data(as_text=True))
        restored = imported.get_json()
        self.assertNotEqual(restored["id"], project["id"])
        self.assertEqual(restored["revision"], 0)
        for field in ("photos", "objects", "features", "measurements", "annotations", "counters"):
            self.assertEqual(restored[field], project[field], field)
        self.assertEqual(self.client.get(self.url).get_json(), project)
        self.assertEqual(len(self.client.get("/api/projects").get_json()["projects"]), 2)
        for photo in restored["photos"]:
            restored_bytes = self.download_bytes(f"/api/projects/{restored['id']}/photos/{photo['id']}/original")
            original_bytes = self.download_bytes(f"{self.url}/photos/{photo['id']}/original")
            self.assertEqual(restored_bytes, original_bytes)
        restarted = create_app(self.root).test_client()
        self.assertEqual(restarted.get(f"/api/projects/{restored['id']}").get_json(), restored)

    def test_import_rejects_traversal_absolute_and_duplicate_members(self):
        """목적: ZIP 경로로 다른 파일 덮어쓰기 방지. 입력: 위험 경로·중복 이름. 출력: 거부·기존 자료 유지."""
        project = self.populated_project()
        exported = self.export_response(project).data
        entries = zip_entries(exported)
        for name in ("../escape.txt", "originals/../../escape.png", "..\\escape.txt", "/absolute.txt", "C:/outside.png"):
            with self.subTest(path=name):
                malicious = dict(entries)
                malicious[name] = b"escape"
                self.assert_rejected_import_preserves_projects(zip_bytes(malicious))
        duplicate = BytesIO(exported)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with ZipFile(duplicate, "a") as archive:
                archive.writestr("project.json", entries["project.json"])
        self.assert_rejected_import_preserves_projects(duplicate.getvalue())
        self.assertFalse((self.root / "escape.txt").exists())

    def test_import_rejects_missing_corrupt_or_mismatched_photo_and_project(self):
        """목적: 불완전 복원으로 CAD 근거 유실 방지. 입력: 누락·손상·잘못된 연결. 출력: 거부·기존 자료 유지."""
        project = self.populated_project()
        entries = zip_entries(self.export_response(project).data)
        cases = []
        missing_photo = dict(entries)
        missing_photo.pop(project["photos"][0]["original_path"])
        cases.append(("원본 누락", zip_bytes(missing_photo)))
        corrupt_photo = dict(entries)
        corrupt_photo[project["photos"][0]["original_path"]] = b"broken-photo"
        cases.append(("원본 손상", zip_bytes(corrupt_photo)))
        wrong_size = dict(entries)
        wrong_size[project["photos"][0]["image_path"]] = image_bytes("PNG", (1, 1))
        cases.append(("편집본 크기 불일치", zip_bytes(wrong_size)))
        from PIL import Image

        different_pixels = BytesIO()
        Image.new("RGB", (120, 80), "black").save(different_pixels, "PNG")
        same_size_wrong_content = dict(entries)
        same_size_wrong_content[project["photos"][0]["image_path"]] = different_pixels.getvalue()
        cases.append(("편집본 내용 불일치", zip_bytes(same_size_wrong_content)))
        bad_refs = dict(entries)
        bad_project = copy.deepcopy(project)
        bad_project["annotations"][0]["target_id"] = "missing"
        bad_refs["project.json"] = json.dumps(bad_project).encode("utf-8")
        cases.append(("참조 유실", zip_bytes(bad_refs)))
        missing_project = dict(entries)
        missing_project.pop("project.json")
        cases.append(("JSON 누락", zip_bytes(missing_project)))
        cases.append(("손상 ZIP", b"not-a-zip"))
        for name, content in cases:
            with self.subTest(case=name):
                self.assert_rejected_import_preserves_projects(content)

    def test_summary_exposes_signed_height_unmeasured_and_conflicting_readings(self):
        """목적: CAD 확인 사항이 문서에서도 드러나는지 검사. 입력: 미측정·충돌·아래 높이. 출력: 값·상태 명시."""
        project = self.populated_project()
        width = project["measurements"][0]
        width["readings"].append(dict(width["readings"][0], id="width_v2", value=126, unit="mm", note="재측정"))
        width["selected_reading_id"] = None
        pitch = project["measurements"][1]
        pitch["readings"][0].update(status="unknown", value=None)
        saved = self.client.put(self.url, json=project)
        self.assertEqual(saved.status_code, 200)
        project = saved.get_json()
        exported = zip_entries(self.export_response(project).data)
        summary = exported["docu/summary.md"].decode("utf-8")
        self.assertIn("재확인", summary)
        self.assertIn("미측정", summary)
        self.assertIn("125 mm", summary)
        self.assertIn("126 mm", summary)
        self.assertIn("-15 mm", summary)
        structured = json.loads(exported["project.json"])
        self.assertIsNone(structured["measurements"][1]["readings"][0]["value_mm"])
        self.assertIsNone(structured["measurements"][0]["selected_reading_id"])

    def test_import_rejects_symlinks_excessive_expansion_and_member_count(self):
        """목적: 비정상 ZIP의 파일 처리 차단 검사. 입력: 링크·과도한 해제 크기·파일 수. 출력: 거부·원본 보존."""
        project = self.populated_project()
        exported = self.export_response(project).data
        symlink_archive = BytesIO(exported)
        with ZipFile(symlink_archive, "a") as archive:
            entry = ZipInfo("originals/link.png")
            entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(entry, "../../outside.png")
        self.assert_rejected_import_preserves_projects(symlink_archive.getvalue())
        with patch("dimsketch.export.MAX_ARCHIVE_BYTES", 16):
            response = self.import_response(exported)
            self.assertEqual(response.status_code, 413)
            self.assertEqual(response.get_json()["code"], "archive_too_large")
        many_entries = {f"extra/{index}.txt": b"x" for index in range(1001)}
        many_entries["project.json"] = json.dumps(project).encode("utf-8")
        self.assert_rejected_import_preserves_projects(zip_bytes(many_entries))
        self.assertEqual(len(self.client.get("/api/projects").get_json()["projects"]), 1)

    def test_request_size_limit_returns_json_and_preserves_existing_project(self):
        """목적: 대량 요청의 HTTP 오류·원본 보존 검사. 입력: 안전한 축소 요청 제한. 출력: 413·정상 상태."""
        self.app.config["MAX_CONTENT_LENGTH"] = 100
        response = self.client.put(self.url, data=" " * 101, content_type="application/json")
        self.assertEqual(response.status_code, 413)
        self.assertTrue(response.get_json()["error"])
        self.assertEqual(self.client.get(self.url).get_json(), self.project)


if __name__ == "__main__":
    unittest.main()
