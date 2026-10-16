"""실제 임시 파일을 사용한 저장·사진·복구 검증."""

from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageOps

from dimsketch.model import AppError
from dimsketch.storage import ProjectStore
from dimsketch.tests.support import image_bytes


class ProjectStoreTests(unittest.TestCase):
    """영구 저장의 충돌·실패·재시작 조건 검증."""

    def setUp(self):
        """목적: 실제 사용자 자료와 분리. 입력: 없음. 출력: 임시 저장소·프로젝트."""
        self.temporary = tempfile.TemporaryDirectory(prefix="photo-measure-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = ProjectStore(self.root)
        self.project = self.store.create("현장 실측", "테스트 프로젝트")
        self.project_id = self.project["id"]

    def test_restart_restores_project_without_changing_the_saved_revision(self):
        """목적: 재실행 후 저장 내용 유지 검사. 입력: 저장한 프로젝트. 출력: 같은 이름·버전·설명."""
        changed = copy.deepcopy(self.project)
        changed.update(name="고정판 실측", description="원단면을 기준으로 기록")
        saved = self.store.save(self.project_id, changed)
        restarted = ProjectStore(self.root)
        self.assertEqual(restarted.load(self.project_id), saved)
        summary = restarted.list_projects()[0]
        self.assertEqual(summary["id"], self.project_id)
        self.assertEqual(summary["name"], "고정판 실측")
        self.assertEqual(summary["revision"], 1)

    def test_stale_save_preserves_the_newer_project(self):
        """목적: 오래된 탭의 덮어쓰기 방지. 입력: 같은 버전의 두 편집. 출력: 두 번째 충돌·첫 저장 유지."""
        first = copy.deepcopy(self.project)
        first["name"] = "먼저 저장한 이름"
        current = self.store.save(self.project_id, first)
        stale = copy.deepcopy(self.project)
        stale["name"] = "오래된 탭 이름"
        with self.assertRaises(AppError) as error:
            self.store.save(self.project_id, stale)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(error.exception.code, "revision_conflict")
        self.assertEqual(self.store.load(self.project_id), current)

    def test_simultaneous_saves_allow_exactly_one_writer(self):
        """목적: 동시 요청에서 덮어쓰기 방지. 입력: 같은 버전의 두 스레드. 출력: 성공 1회·충돌 1회."""
        barrier = threading.Barrier(2)

        def attempt_save(name):
            """목적: 동시 저장 시도. 입력: 편집 이름. 출력: 성공 자료 또는 충돌 오류."""
            candidate = copy.deepcopy(self.project)
            candidate["name"] = name
            barrier.wait(timeout=5)
            try:
                return self.store.save(self.project_id, candidate)
            except AppError as error:
                return error

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt_save, ["첫 편집", "둘째 편집"]))
        winners = [result for result in results if isinstance(result, dict)]
        losers = [result for result in results if isinstance(result, AppError)]
        self.assertEqual(len(winners), 1)
        self.assertEqual(len(losers), 1)
        self.assertEqual(losers[0].status, 409)
        self.assertEqual(self.store.load(self.project_id), winners[0])

    def test_failed_atomic_replace_keeps_prior_data_and_cleans_temporary_files(self):
        """목적: 저장 중 디스크 오류의 원본 보존 검사. 입력: 마지막 교체 실패. 출력: 이전 데이터·백업 유지."""
        directory = self.store.project_dir(self.project_id)
        before = (directory / "project.json").read_bytes()
        candidate = copy.deepcopy(self.project)
        candidate["name"] = "저장에 실패할 이름"
        import os

        original_replace = os.replace

        def fail_primary(source, destination):
            """목적: 마지막 저장 단계 장애 재현. 입력: 교체 경로. 출력: 주 파일에서 OSError."""
            if Path(destination).name == "project.json":
                raise OSError("검증용 디스크 오류")
            return original_replace(source, destination)

        with patch("dimsketch.storage.os.replace", side_effect=fail_primary):
            with self.assertRaises(OSError):
                self.store.save(self.project_id, candidate)
        self.assertEqual((directory / "project.json").read_bytes(), before)
        self.assertEqual(json.loads((directory / "project.backup.json").read_text("utf-8"))["revision"], 0)
        self.assertEqual(self.store.load(self.project_id)["name"], "현장 실측")
        self.assertEqual(list(directory.glob(".save-*.tmp")), [])

    def test_corrupted_primary_recovers_previous_backup_and_preserves_corruption(self):
        """목적: 손상 저장본의 명시적 복구 검사. 입력: 손상된 JSON·정상 백업. 출력: 직전본·알림·손상 사본."""
        candidate = copy.deepcopy(self.project)
        candidate["name"] = "최근 저장"
        self.store.save(self.project_id, candidate)
        directory = self.store.project_dir(self.project_id)
        corrupt_bytes = b'{"broken":'
        (directory / "project.json").write_bytes(corrupt_bytes)
        recovered = ProjectStore(self.root).load(self.project_id)
        self.assertEqual(recovered["name"], "현장 실측")
        self.assertEqual(recovered["revision"], 0)
        self.assertTrue(recovered["recovery_notice"])
        copies = list(directory.glob("project.corrupt-*.json"))
        self.assertEqual(len(copies), 1)
        self.assertEqual(copies[0].read_bytes(), corrupt_bytes)
        self.assertEqual(ProjectStore(self.root).load(self.project_id), recovered)

    def test_corrupted_primary_and_backup_are_reported_without_overwriting(self):
        """목적: 복구 불가능한 자료 보존 검사. 입력: 두 손상 파일. 출력: 오류·바이트 보존."""
        directory = self.store.project_dir(self.project_id)
        (directory / "project.json").write_bytes(b"primary-broken")
        (directory / "project.backup.json").write_bytes(b"backup-broken")
        with self.assertRaises(AppError) as error:
            ProjectStore(self.root).load(self.project_id)
        self.assertEqual(error.exception.code, "corrupt_project")
        self.assertEqual((directory / "project.json").read_bytes(), b"primary-broken")
        self.assertEqual((directory / "project.backup.json").read_bytes(), b"backup-broken")

    def test_supported_images_keep_original_bytes_and_receive_png_editing_copy(self):
        """목적: JPG·PNG·WebP 원본과 편집본 분리 검사. 입력: 세 형식. 출력: 원본 해시·크기 유지."""
        uploads = [(f"사진.{extension}", image_bytes(image_format))
                   for extension, image_format in (("jpg", "JPEG"), ("png", "PNG"), ("webp", "WEBP"))]
        project = self.store.add_photos(self.project_id, 0, uploads)
        self.assertEqual(project["revision"], 1)
        self.assertEqual(len(project["photos"]), 3)
        for photo, (_, original) in zip(project["photos"], uploads):
            with self.subTest(filename=photo["filename"]):
                original_file = self.store.photo_path(self.project_id, photo["id"], "original")
                editing_file = self.store.photo_path(self.project_id, photo["id"], "image")
                self.assertEqual(hashlib.sha256(original_file.read_bytes()).digest(), hashlib.sha256(original).digest())
                with Image.open(editing_file) as image:
                    self.assertEqual(image.format, "PNG")
                    self.assertEqual(image.size, (120, 80))
                self.assertEqual((photo["width"], photo["height"]), (120, 80))

    def test_exif_rotation_changes_editing_coordinates_only(self):
        """목적: 휴대폰 EXIF 회전과 좌표 일치 검사. 입력: 방향 6 JPEG. 출력: 80×120 편집본·원본 보존."""
        original = image_bytes("JPEG", (120, 80), orientation=6)
        project = self.store.add_photos(self.project_id, 0, [("스마트폰.jpg", original)])
        photo = project["photos"][0]
        self.assertEqual((photo["width"], photo["height"]), (80, 120))
        self.assertEqual(self.store.photo_path(self.project_id, photo["id"], "original").read_bytes(), original)
        with Image.open(BytesIO(original)) as source:
            expected = ImageOps.exif_transpose(source).convert("RGB")
        with Image.open(self.store.photo_path(self.project_id, photo["id"], "image")) as actual:
            self.assertEqual(actual.size, expected.size)
            self.assertEqual(actual.convert("RGB").tobytes(), expected.tobytes())

    def test_invalid_member_rolls_back_the_entire_batch(self):
        """목적: 일부 사진만 저장되는 혼합 업로드 방지. 입력: 정상·손상 사진. 출력: 사진·버전 모두 그대로."""
        for broken in (b"not-an-image", image_bytes("GIF")):
            with self.subTest(content_type=broken[:6]):
                with self.assertRaises(AppError):
                    self.store.add_photos(self.project_id, 0, [("valid.png", image_bytes()), ("broken.png", broken)])
                loaded = self.store.load(self.project_id)
                self.assertEqual(loaded["photos"], [])
                self.assertEqual(loaded["revision"], 0)
                directory = self.store.project_dir(self.project_id)
                self.assertEqual(list((directory / "originals").iterdir()), [])
                self.assertEqual(list((directory / "images").iterdir()), [])

    def test_upload_disk_failure_removes_new_photo_files(self):
        """목적: 파일 저장 도중 실패의 부분 자료 방지. 입력: 사진 JSON 저장 실패. 출력: 기존 상태·파일 정리."""
        with patch.object(self.store, "_write", side_effect=OSError("검증용 저장 실패")):
            with self.assertRaises(OSError):
                self.store.add_photos(self.project_id, 0, [("valid.png", image_bytes())])
        self.assertEqual(self.store.load(self.project_id)["photos"], [])
        directory = self.store.project_dir(self.project_id)
        self.assertEqual(list((directory / "originals").iterdir()), [])
        self.assertEqual(list((directory / "images").iterdir()), [])

    def test_image_byte_pixel_and_photo_count_limits_fail_without_partial_write(self):
        """목적: 큰 자료를 대량 할당 없이 거부 검사. 입력: 안전한 축소 제한. 출력: 제한 오류·빈 프로젝트."""
        with patch("dimsketch.storage.MAX_IMAGE_BYTES", 16):
            with self.assertRaises(AppError) as error:
                self.store.add_photos(self.project_id, 0, [("large.png", image_bytes())])
            self.assertEqual(error.exception.status, 413)
        with patch("dimsketch.storage.MAX_IMAGE_PIXELS", 100):
            with self.assertRaises(AppError) as error:
                self.store.add_photos(self.project_id, 0, [("large.png", image_bytes())])
            self.assertEqual(error.exception.status, 413)
        with patch("dimsketch.storage.MAX_PHOTOS", 1):
            with self.assertRaises(AppError):
                self.store.add_photos(self.project_id, 0, [("a.png", image_bytes()), ("b.png", image_bytes())])
        with patch("PIL.Image.MAX_IMAGE_PIXELS", 100):
            with self.assertRaises(AppError) as error:
                self.store.add_photos(self.project_id, 0, [("bomb.png", image_bytes())])
            self.assertEqual(error.exception.status, 413)
        self.assertEqual(self.store.load(self.project_id)["photos"], [])

    def test_filename_traversal_cannot_escape_internal_photo_ids(self):
        """목적: 사용자 파일명과 저장 경로 분리 검사. 입력: 상위 경로 파일명. 출력: 내부 폴더의 안전한 경로."""
        project = self.store.add_photos(self.project_id, 0, [("..\\..\\outside.png", image_bytes())])
        photo = project["photos"][0]
        self.assertEqual(photo["filename"], "outside.png")
        original = self.store.photo_path(self.project_id, photo["id"], "original")
        self.assertEqual(original.parent, self.store.project_dir(self.project_id) / "originals")
        self.assertEqual(original.stem, photo["id"])
        self.assertFalse((self.root / "outside.png").exists())
        with self.assertRaises(AppError):
            self.store.load("../outside")

    def test_photo_dimensions_paths_and_membership_cannot_be_mutated_by_save(self):
        """목적: 좌표 기준 사진 정보의 임의 변경 방지. 입력: 크기·경로·목록 변조. 출력: 오류·원본 유지."""
        saved = self.store.add_photos(self.project_id, 0, [("front.png", image_bytes())])
        for field, value in (("width", 100), ("height", 90), ("image_path", "images/other.png"),
                             ("original_path", "originals/other.png")):
            with self.subTest(field=field):
                candidate = copy.deepcopy(saved)
                candidate["photos"][0][field] = value
                with self.assertRaises(AppError):
                    self.store.save(self.project_id, candidate)
        removed = copy.deepcopy(saved)
        removed["photos"] = []
        with self.assertRaises(AppError):
            self.store.save(self.project_id, removed)
        self.assertEqual(self.store.load(self.project_id), saved)

    def test_counter_history_cannot_be_reduced_by_stale_client_state(self):
        """목적: 삭제 후 번호 재사용 방지. 입력: 서버 순번보다 작은 편집 순번. 출력: 서버 최댓값 유지."""
        candidate = copy.deepcopy(self.project)
        candidate["counters"] = {"object": 27, "measurement": 10, "features": {"old-object:hole": 5}}
        saved = self.store.save(self.project_id, candidate)
        saved["counters"] = {"object": 0, "measurement": 0, "features": {}}
        result = self.store.save(self.project_id, saved)
        self.assertEqual(result["counters"], {"object": 27, "measurement": 10, "features": {"old-object:hole": 5}})

    def test_new_project_disk_failure_does_not_leave_a_broken_project_entry(self):
        """목적: 초기 저장 실패의 불완전 프로젝트 방지. 입력: 생성 중 디스크 실패. 출력: 기존 목록 유지."""
        before = self.store.list_projects()
        before_directories = sorted(path.name for path in self.store.projects_dir.iterdir())
        with patch.object(self.store, "_write", side_effect=OSError("검증용 초기 저장 실패")):
            with self.assertRaises(OSError):
                self.store.create("생성 실패 프로젝트")
        self.assertEqual(self.store.list_projects(), before)
        self.assertEqual(sorted(path.name for path in self.store.projects_dir.iterdir()), before_directories)

    def test_animated_webp_is_rejected_without_losing_existing_photos(self):
        """목적: 여러 프레임 사진의 좌표 모호성 방지. 입력: animated WebP. 출력: 업로드 거부·원본 유지."""
        saved = self.store.add_photos(self.project_id, 0, [("original.png", image_bytes())])
        output = BytesIO()
        first = Image.new("RGB", (12, 8), "red")
        second = Image.new("RGB", (12, 8), "blue")
        first.save(output, "WEBP", save_all=True, append_images=[second], duration=100, loop=0)
        with self.assertRaises(AppError) as error:
            self.store.add_photos(self.project_id, saved["revision"], [("moving.webp", output.getvalue())])
        self.assertEqual(error.exception.code, "unsupported_image")
        self.assertEqual(self.store.load(self.project_id), saved)


if __name__ == "__main__":
    unittest.main()
