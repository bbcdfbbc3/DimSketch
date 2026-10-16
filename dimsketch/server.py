"""로컬 사진 실측 웹 앱의 HTTP API와 실행 진입점."""

from __future__ import annotations

import argparse
import io
import logging
import os
import webbrowser
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, jsonify, render_template, request, send_file
from werkzeug.exceptions import HTTPException

try:
    from .export import export_project, import_project
    from .model import AppError, MAX_IMAGE_BYTES, MAX_REQUEST_BYTES, SCHEMA_VERSION
    from .storage import ProjectStore
except ImportError:
    from export import export_project, import_project
    from model import AppError, MAX_IMAGE_BYTES, MAX_REQUEST_BYTES, SCHEMA_VERSION
    from storage import ProjectStore

APP_DIR = Path(__file__).resolve().parent
REPOSITORY_ROOT = APP_DIR.parent
DEFAULT_DATA_DIR = REPOSITORY_ROOT / ".local"
DEFAULT_PORT = 8765


def acquire_instance_lock(data_dir: Path):
    """목적: 같은 저장소의 중복 서버 방지. 입력: 저장 폴더. 출력: 종료까지 보관할 잠금 파일."""
    stream = (data_dir / ".server.lock").open("a+b")
    if stream.seek(0, 2) == 0:
        stream.write(b"0")
        stream.flush()
    stream.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        stream.close()
        raise AppError("이 저장 폴더를 사용하는 사진 실측 앱이 이미 실행 중입니다. 기존 앱을 사용하거나 다른 --data-dir를 지정하세요.", "instance_running", 409) from exc
    return stream


def release_instance_lock(stream) -> None:
    """목적: 종료 시 저장소 잠금 해제. 입력: 잠금 파일. 출력: 파일 닫기."""
    try:
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    finally:
        stream.close()


def create_app(data_dir: Path | str | None = None) -> Flask:
    """목적: 앱·저장소 생성. 입력: 선택 데이터 경로. 출력: Flask 앱."""
    app = Flask(__name__, template_folder=str(APP_DIR / "templates"), static_folder=str(APP_DIR / "static"))
    app.config.update(MAX_CONTENT_LENGTH=MAX_REQUEST_BYTES, MAX_FORM_MEMORY_SIZE=1024 * 1024,
                      MAX_FORM_PARTS=200, JSON_AS_ASCII=False)
    app.json.ensure_ascii = False
    store = ProjectStore(data_dir or DEFAULT_DATA_DIR)
    app.extensions["dimsketch_store"] = store

    @app.before_request
    def local_request_only():
        """목적: 외부 사이트의 로컬 편집 차단. 입력: 현재 요청. 출력: 차단 시 예외."""
        host = urlsplit("http://" + request.host)
        if host.hostname not in {"127.0.0.1", "localhost"}:
            raise AppError("이 앱은 로컬 PC에서만 사용할 수 있습니다.", "local_only", 403)
        if request.headers.get("Sec-Fetch-Site") == "cross-site":
            raise AppError("외부 사이트의 요청은 허용하지 않습니다.", "invalid_origin", 403)
        origin = request.headers.get("Origin")
        if origin and origin != request.host_url.rstrip("/"):
            raise AppError("앱과 같은 주소에서 요청하세요.", "invalid_origin", 403)

    @app.after_request
    def security_headers(response):
        """목적: 로컬 사진 응답 보호. 입력: 응답. 출력: 보안 헤더 응답."""
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(AppError)
    def app_error(error):
        """목적: 사용자 오류 JSON 변환. 입력: 앱 오류. 출력: JSON·상태."""
        return jsonify(error=error.message, code=error.code), error.status

    @app.errorhandler(HTTPException)
    def http_error(error):
        """목적: HTTP 오류 JSON 통일. 입력: HTTP 오류. 출력: JSON·상태."""
        messages = {400: "요청 형식이 올바르지 않습니다.", 404: "요청한 항목을 찾을 수 없습니다.",
                    405: "지원하지 않는 요청 방식입니다.", 413: "요청 크기는 512 MiB 이하, 사진은 파일당 30 MiB 이하로 등록하세요.",
                    415: "JSON 또는 지정된 파일 형식으로 요청하세요."}
        return jsonify(error=messages.get(error.code, "요청을 처리할 수 없습니다."), code=f"http_{error.code}"), error.code

    @app.errorhandler(OSError)
    def storage_error(error):
        """목적: 디스크 오류 설명. 입력: 파일 오류. 출력: JSON·상태."""
        app.logger.exception("실측 자료 파일 처리 실패")
        return jsonify(error="파일을 저장하거나 읽지 못했습니다. 디스크 공간과 저장 폴더의 권한을 확인한 뒤 다시 시도하세요.", code="storage_error"), 500

    @app.route("/")
    def index():
        """목적: 편집 화면 제공. 입력: 없음. 출력: HTML."""
        return render_template("index.html")

    @app.get("/api/health")
    def health():
        """목적: 앱 실행 확인. 입력: 없음. 출력: 상태 JSON."""
        return jsonify(status="ok", app="dimsketch", schema_version=SCHEMA_VERSION)

    @app.get("/api/projects")
    def projects_list():
        """목적: 프로젝트 목록 제공. 입력: 없음. 출력: 요약 JSON."""
        return jsonify(projects=store.list_projects())

    @app.post("/api/projects")
    def project_create():
        """목적: 프로젝트 생성. 입력: 이름·설명 JSON. 출력: 새 프로젝트·201."""
        body = request.get_json()
        if not isinstance(body, dict):
            raise AppError("프로젝트 이름과 설명을 JSON으로 입력하세요.")
        return jsonify(store.create(body.get("name"), body.get("description", ""))), 201

    @app.get("/api/projects/<project_id>")
    def project_get(project_id):
        """목적: 프로젝트 조회. 입력: 식별자. 출력: 프로젝트 JSON."""
        return jsonify(store.load(project_id))

    @app.put("/api/projects/<project_id>")
    def project_save(project_id):
        """목적: 전체 편집 저장. 입력: 식별자·JSON. 출력: 새 버전 JSON."""
        try:
            return jsonify(store.save(project_id, request.get_json()))
        except TypeError as exc:
            raise AppError("프로젝트 항목의 형식이 올바르지 않습니다.") from exc

    @app.post("/api/projects/<project_id>/photos")
    def photos_upload(project_id):
        """목적: 사진 일괄 등록. 입력: 파일 목록·버전. 출력: 프로젝트 JSON."""
        try:
            revision = int(request.form.get("revision", ""))
        except (ValueError, TypeError) as exc:
            raise AppError("사진을 등록할 프로젝트의 저장 버전이 필요합니다.") from exc
        files = request.files.getlist("files")
        uploads = []
        for file in files:
            content = file.stream.read(MAX_IMAGE_BYTES + 1)
            if len(content) > MAX_IMAGE_BYTES:
                raise AppError("사진은 파일당 30 MiB 이하로 등록하세요.", "image_too_large", 413)
            uploads.append((file.filename, content))
        return jsonify(store.add_photos(project_id, revision, uploads))

    @app.get("/api/projects/<project_id>/photos/<photo_id>/<kind>")
    def photo_get(project_id, photo_id, kind):
        """목적: 원본·편집 사진 제공. 입력: 프로젝트·사진·종류. 출력: 파일 응답."""
        return send_file(store.photo_path(project_id, photo_id, kind), conditional=True, max_age=0)

    @app.post("/api/projects/<project_id>/export")
    def project_export(project_id):
        """목적: 저장 버전별 자료 내보내기. 입력: 버전·표시 PNG. 출력: ZIP 응답."""
        content, filename = export_project(store, project_id, request.get_json())
        return send_file(io.BytesIO(content), mimetype="application/zip", as_attachment=True, download_name=filename)

    @app.post("/api/projects/import")
    def project_import():
        """목적: ZIP 복원. 입력: file 폼 파일. 출력: 새 프로젝트·201."""
        upload = request.files.get("file")
        if upload is None:
            raise AppError("가져올 ZIP 파일을 선택하세요.")
        try:
            return jsonify(import_project(store, upload.stream.read(MAX_REQUEST_BYTES + 1))), 201
        except TypeError as exc:
            raise AppError("ZIP 프로젝트 항목의 형식이 올바르지 않습니다.", "invalid_archive") from exc

    return app


def parse_args() -> argparse.Namespace:
    """목적: 실행 옵션 해석. 입력: 명령행. 출력: 포트·저장 경로·브라우저 설정."""
    parser = argparse.ArgumentParser(description="DimSketch 사진 실측 기록 로컬 웹 앱")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="로컬 포트 (기본 8765)")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR, help="프로젝트 저장 폴더")
    parser.add_argument("--no-browser", action="store_true", help="브라우저 자동 열기 생략")
    arguments = parser.parse_args()
    if not 1 <= arguments.port <= 65535:
        parser.error("포트는 1~65535 사이의 정수여야 합니다.")
    if not arguments.data_dir.is_absolute():
        arguments.data_dir = (REPOSITORY_ROOT / arguments.data_dir).resolve()
    return arguments


def main() -> None:
    """목적: Windows 로컬 서버 실행. 입력: 명령행 옵션. 출력: 서버·선택 브라우저."""
    from waitress import create_server

    arguments = parse_args()
    app = create_app(arguments.data_dir)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    url = f"http://127.0.0.1:{arguments.port}"
    try:
        instance_lock = acquire_instance_lock(app.extensions["dimsketch_store"].root)
    except AppError as exc:
        raise SystemExit(exc.message) from exc
    try:
        server = create_server(app, host="127.0.0.1", port=arguments.port, threads=4,
                               max_request_body_size=MAX_REQUEST_BYTES)
    except OSError as exc:
        release_instance_lock(instance_lock)
        raise SystemExit(f"서버를 시작하지 못했습니다. 포트 {arguments.port} 사용 여부를 확인하거나 --port로 변경하세요. ({exc})") from exc
    print(f"DimSketch: {url}\n저장 폴더: {app.extensions['dimsketch_store'].root}\n종료: Ctrl+C", flush=True)
    if not arguments.no_browser:
        webbrowser.open(url)
    try:
        server.run()
    except KeyboardInterrupt:
        print("\n사진 실측 앱을 종료했습니다.")
    finally:
        server.close()
        release_instance_lock(instance_lock)


if __name__ == "__main__":
    main()
