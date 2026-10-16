"""실측 자료의 원자적 저장과 원본·편집용 사진 관리."""

from __future__ import annotations

import copy
import io
import json
import os
import shutil
import tempfile
import threading
import warnings
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

try:
    from .model import (AppError, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_PHOTOS,
                        check_id, integer, new_id, new_project, normalize_project, now_iso)
except ImportError:
    from model import (AppError, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_PHOTOS,
                       check_id, integer, new_id, new_project, normalize_project, now_iso)


def decode_photo(content: bytes) -> tuple[bytes, int, int, str]:
    """목적: 원본 검증·EXIF 회전 보정. 입력: 사진 바이트. 출력: PNG·크기·확장자."""
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise AppError("사진은 파일당 30 MiB 이하로 등록하세요.", "image_too_large", 413)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as source:
                extension = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}.get(source.format)
                if extension is None or getattr(source, "n_frames", 1) != 1:
                    raise AppError("움직이지 않는 JPG·PNG·WebP 사진을 등록하세요.", "unsupported_image")
                if source.width * source.height > MAX_IMAGE_PIXELS:
                    raise AppError("사진은 4천만 화소 이하로 등록하세요.", "image_too_large", 413)
                source.load()
                image = ImageOps.exif_transpose(source)
                if image.mode not in {"RGB", "RGBA", "L", "LA"}:
                    image = image.convert("RGBA" if "transparency" in image.info else "RGB")
                output = io.BytesIO()
                image.save(output, format="PNG")
                return output.getvalue(), image.width, image.height, extension
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise AppError("사진은 4천만 화소 이하로 등록하세요.", "image_too_large", 413) from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        if isinstance(exc, AppError):
            raise
        raise AppError("사진을 읽을 수 없습니다. 손상되지 않은 JPG·PNG·WebP 파일을 사용하세요.", "invalid_image") from exc


def json_bytes(project: dict) -> bytes:
    """목적: 읽기 쉬운 JSON 인코딩. 입력: 프로젝트. 출력: UTF-8 바이트."""
    return (json.dumps(project, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


class ProjectStore:
    """프로젝트 단위 파일 저장소. 한 프로세스 내 요청을 잠금으로 직렬화."""

    def __init__(self, data_dir: Path | str):
        """목적: 저장소 준비. 입력: 데이터 디렉터리. 출력: 저장소·프로세스 잠금."""
        self.root = Path(data_dir).expanduser().resolve()
        self.projects_dir = self.root / "projects"
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def project_dir(self, project_id: str) -> Path:
        """목적: 프로젝트 경로 계산. 입력: 식별자. 출력: 저장소 내부 경로."""
        return self.projects_dir / check_id(project_id, "프로젝트 식별자")

    def _atomic_bytes(self, destination: Path, content: bytes) -> None:
        """목적: 파일 원자적 교체. 입력: 경로·바이트. 출력: 저장 파일."""
        descriptor, temporary = tempfile.mkstemp(prefix=".save-", suffix=".tmp", dir=destination.parent)
        temporary_path = Path(temporary)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, destination)
        finally:
            temporary_path.unlink(missing_ok=True)

    def _read_json(self, path: Path) -> dict:
        """목적: 저장 자료 읽기·검증. 입력: JSON 경로. 출력: 정상 프로젝트."""
        if path.stat().st_size > 32 * 1024 * 1024:
            raise AppError("프로젝트 JSON 크기가 너무 큽니다.", "corrupt_project", 409)
        return normalize_project(json.loads(path.read_text(encoding="utf-8")))

    def _load(self, project_id: str) -> dict:
        """목적: 정상 자료 또는 직전 백업 복구. 입력: 식별자. 출력: 프로젝트."""
        directory = self.project_dir(project_id)
        path, backup = directory / "project.json", directory / "project.backup.json"
        if not path.exists() and not backup.exists():
            raise AppError("프로젝트를 찾을 수 없습니다.", "not_found", 404)
        try:
            project = self._read_json(path)
            if project["id"] != project_id:
                raise AppError("저장된 프로젝트 식별자가 일치하지 않습니다.")
            return project
        except (OSError, ValueError, TypeError, KeyError):
            try:
                project = self._read_json(backup)
                if project["id"] != project_id:
                    raise AppError("백업의 프로젝트 식별자가 일치하지 않습니다.")
            except (OSError, ValueError, TypeError, KeyError) as exc:
                raise AppError("프로젝트와 백업을 읽을 수 없습니다. 원본 파일을 보존한 채 저장 폴더를 확인하세요.", "corrupt_project", 409) from exc
            if path.exists():
                shutil.copy2(path, directory / f"project.corrupt-{new_id()}.json")
            project["recovery_notice"] = "저장 파일을 읽을 수 없어 직전 정상 백업을 복구했습니다. 최근 입력을 확인하세요."
            self._atomic_bytes(path, json_bytes(project))
            return project

    def _write(self, project: dict, backup: bool = True) -> None:
        """목적: 직전 정상본 보관 후 저장. 입력: 프로젝트·백업 여부. 출력: JSON 파일."""
        directory = self.project_dir(project["id"])
        path = directory / "project.json"
        if backup and path.exists():
            previous = self._read_json(path)
            self._atomic_bytes(directory / "project.backup.json", json_bytes(previous))
        self._atomic_bytes(path, json_bytes(project))

    def create(self, name: Any, description: Any = "") -> dict:
        """목적: 새 프로젝트 저장. 입력: 이름·설명. 출력: 초기 프로젝트."""
        with self.lock:
            project = new_project(name, description)
            directory = self.project_dir(project["id"])
            directory.mkdir()
            try:
                (directory / "originals").mkdir()
                (directory / "images").mkdir()
                self._write(project, backup=False)
            except OSError:
                if directory.resolve().parent == self.projects_dir:
                    shutil.rmtree(directory)
                raise
            return project

    def load(self, project_id: str) -> dict:
        """목적: 프로젝트 조회. 입력: 식별자. 출력: 분리된 프로젝트 객체."""
        with self.lock:
            return self._load(project_id)

    def list_projects(self) -> list[dict]:
        """목적: 최근 수정순 목록 조회. 입력: 없음. 출력: 요약·손상 상태 목록."""
        with self.lock:
            summaries = []
            for directory in self.projects_dir.iterdir():
                if not directory.is_dir() or directory.name.startswith("."):
                    continue
                try:
                    project = self._load(directory.name)
                    summaries.append({key: project[key] for key in ("id", "name", "description", "revision", "created_at", "updated_at")} | {
                        "photo_count": len(project["photos"]), "object_count": len(project["objects"]),
                        "measurement_count": len(project["measurements"]), "recovery_notice": project.get("recovery_notice", "")})
                except AppError as exc:
                    summaries.append({"id": directory.name, "name": directory.name, "updated_at": "", "error": exc.message})
            return sorted(summaries, key=lambda summary: summary["updated_at"], reverse=True)

    def check_revision(self, project: dict, revision: Any) -> None:
        """목적: 오래된 편집 덮어쓰기 방지. 입력: 현재 자료·기대 버전. 출력: 충돌 시 예외."""
        integer(revision, "저장 버전")
        if revision != project["revision"]:
            raise AppError("다른 탭이나 작업에서 자료가 바뀌었습니다. 현재 입력을 내보내거나 복사한 뒤 프로젝트를 다시 여세요.", "revision_conflict", 409)

    def save(self, project_id: str, incoming: Any) -> dict:
        """목적: 사용자 편집 저장. 입력: 식별자·전체 프로젝트. 출력: 버전이 증가한 자료."""
        with self.lock:
            current = self._load(project_id)
            if not isinstance(incoming, dict):
                raise AppError("저장할 프로젝트 JSON이 필요합니다.")
            self.check_revision(current, incoming.get("revision"))
            if incoming.get("id") != project_id:
                raise AppError("프로젝트 식별자를 변경할 수 없습니다.")
            candidate = normalize_project(incoming)
            previous_photos = {photo["id"]: photo for photo in current["photos"]}
            if {photo["id"] for photo in candidate["photos"]} != set(previous_photos):
                raise AppError("사진은 사진 등록 기능으로 추가하세요. 기존 사진을 임의로 제거할 수 없습니다.")
            for photo in candidate["photos"]:
                previous = previous_photos[photo["id"]]
                for field in ("filename", "original_path", "image_path", "width", "height"):
                    if photo[field] != previous[field]:
                        raise AppError("사진의 원본 경로와 크기는 변경할 수 없습니다.")
            for field in ("object", "measurement"):
                candidate["counters"][field] = max(candidate["counters"][field], current["counters"][field])
            for key, value in current["counters"]["features"].items():
                candidate["counters"]["features"][key] = max(candidate["counters"]["features"].get(key, 0), value)
            candidate["created_at"] = current["created_at"]
            candidate["updated_at"] = now_iso()
            candidate["revision"] = current["revision"] + 1
            candidate.pop("recovery_notice", None)
            self._write(candidate)
            return candidate

    def add_photos(self, project_id: str, revision: int, uploads: list[tuple[str, bytes]]) -> dict:
        """목적: 일괄 사진 등록. 입력: 식별자·버전·파일 목록. 출력: 전체 성공한 프로젝트."""
        with self.lock:
            current = self._load(project_id)
            self.check_revision(current, revision)
            if not uploads:
                raise AppError("등록할 사진을 선택하세요.")
            if len(current["photos"]) + len(uploads) > MAX_PHOTOS:
                raise AppError(f"사진은 프로젝트당 {MAX_PHOTOS}장까지 등록할 수 있습니다.")
            candidate = copy.deepcopy(current)
            directory = self.project_dir(project_id)
            staged = []
            for filename, content in uploads:
                edited, width, height, extension = decode_photo(content)
                photo_id = new_id()
                photo = {"id": photo_id, "filename": str(filename).replace("\\", "/").split("/")[-1][:1000] or f"photo.{extension}",
                         "original_path": f"originals/{photo_id}.{extension}", "image_path": f"images/{photo_id}.png",
                         "width": width, "height": height, "view": "other", "description": ""}
                candidate["photos"].append(photo)
                staged.extend([(directory / photo["original_path"], content), (directory / photo["image_path"], edited)])
            candidate["revision"] += 1
            candidate["updated_at"] = now_iso()
            written = []
            try:
                for path, content in staged:
                    self._atomic_bytes(path, content)
                    written.append(path)
                self._write(normalize_project(candidate))
            except (OSError, ValueError):
                for path in written:
                    path.unlink(missing_ok=True)
                raise
            return candidate

    def photo_path(self, project_id: str, photo_id: str, kind: str) -> Path:
        """목적: 사진 다운로드 경로 확인. 입력: 프로젝트·사진·종류. 출력: 검증된 경로."""
        with self.lock:
            if kind not in {"original", "image"}:
                raise AppError("사진 종류를 찾을 수 없습니다.", "not_found", 404)
            project = self._load(project_id)
            photo = next((item for item in project["photos"] if item["id"] == photo_id), None)
            if photo is None:
                raise AppError("사진을 찾을 수 없습니다.", "not_found", 404)
            path = self.project_dir(project_id) / photo["original_path" if kind == "original" else "image_path"]
            if not path.is_file():
                raise AppError("사진 파일이 없습니다. 저장 폴더 또는 원본 ZIP을 확인하세요.", "missing_photo", 404)
            return path

    def install_import(self, project: dict, files: dict[str, bytes]) -> dict:
        """목적: 검증된 가져오기 자료 설치. 입력: 자료·파일. 출력: 새 ID의 프로젝트."""
        with self.lock:
            project = copy.deepcopy(project)
            project["id"] = new_id()
            project["revision"] = 0
            project["created_at"] = now_iso()
            project["updated_at"] = project["created_at"]
            project.pop("recovery_notice", None)
            project = normalize_project(project)
            staging = Path(tempfile.mkdtemp(prefix=".import-", dir=self.projects_dir))
            try:
                (staging / "originals").mkdir()
                (staging / "images").mkdir()
                for path, content in files.items():
                    target = staging / path
                    if target.parent.name not in {"originals", "images"} or target.parent.parent != staging:
                        raise AppError("가져오기 사진 경로가 올바르지 않습니다.")
                    target.write_bytes(content)
                self._atomic_bytes(staging / "project.json", json_bytes(project))
                os.replace(staging, self.project_dir(project["id"]))
            finally:
                if staging.exists() and staging.resolve().parent == self.projects_dir:
                    shutil.rmtree(staging)
            return project
