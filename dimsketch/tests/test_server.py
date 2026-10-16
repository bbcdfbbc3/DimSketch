"""실제 서버 실행 없이 Windows CLI와 저장소 중복 실행 규칙 검증."""

from __future__ import annotations

import argparse
import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from dimsketch.model import AppError
from dimsketch.server import (
    DEFAULT_DATA_DIR,
    REPOSITORY_ROOT,
    acquire_instance_lock,
    main,
    parse_args,
    release_instance_lock,
)


class LocalServerTests(unittest.TestCase):
    """작업 디렉터리 독립성과 단일 저장소 서버 보장 검사."""

    def test_cli_defaults_and_explicit_paths_are_stable(self):
        """목적: 문서 기본값과 CLI 호환 검사. 입력: 기본·명시 옵션. 출력: 포트·저장 경로·브라우저 플래그."""
        with patch("sys.argv", ["server.py"]):
            arguments = parse_args()
        self.assertEqual(arguments.port, 8765)
        self.assertEqual(arguments.data_dir, DEFAULT_DATA_DIR)
        self.assertEqual(DEFAULT_DATA_DIR, REPOSITORY_ROOT / ".local")
        self.assertTrue(arguments.data_dir.is_absolute())
        self.assertFalse(arguments.no_browser)
        with tempfile.TemporaryDirectory(prefix="photo-measure-cwd-") as elsewhere, \
                patch("os.getcwd", return_value=elsewhere), \
                patch("sys.argv", ["server.py", "--port", "9876", "--data-dir", "measurements", "--no-browser"]):
            explicit = parse_args()
        self.assertEqual(explicit.port, 9876)
        self.assertEqual(explicit.data_dir, REPOSITORY_ROOT / "measurements")
        self.assertTrue(explicit.no_browser)

    def test_invalid_ports_exit_with_actionable_usage_error(self):
        """목적: 실행 불가능한 포트의 초기 거부 검사. 입력: 경계 밖 포트. 출력: 코드 2·포트 설명."""
        for port in ("0", "65536", "abc"):
            with self.subTest(port=port):
                output = io.StringIO()
                with patch("sys.argv", ["server.py", "--port", port]), contextlib.redirect_stderr(output):
                    with self.assertRaises(SystemExit) as error:
                        parse_args()
                self.assertEqual(error.exception.code, 2)
                self.assertIn("port", output.getvalue())

    def test_instance_lock_blocks_second_server_and_can_be_reacquired(self):
        """목적: 같은 자료의 두 프로세스 서버 방지. 입력: 같은 저장소의 두 잠금. 출력: 충돌·해제 후 재획득."""
        with tempfile.TemporaryDirectory(prefix="photo-measure-lock-") as temporary:
            first = acquire_instance_lock(Path(temporary))
            try:
                with self.assertRaises(AppError) as error:
                    acquire_instance_lock(Path(temporary))
                self.assertEqual(error.exception.code, "instance_running")
                self.assertEqual(error.exception.status, 409)
            finally:
                release_instance_lock(first)
            second = acquire_instance_lock(Path(temporary))
            release_instance_lock(second)

    def test_main_binds_loopback_and_respects_no_browser(self):
        """목적: 로컬 실행·종료의 실제 연결 검사. 입력: 가짜 서버와 실행 옵션. 출력: loopback·정리·브라우저 생략."""
        with tempfile.TemporaryDirectory(prefix="photo-measure-main-") as temporary:
            arguments = argparse.Namespace(port=9876, data_dir=Path(temporary), no_browser=True)
            server = Mock()
            with patch("dimsketch.server.parse_args", return_value=arguments), \
                    patch("waitress.create_server", return_value=server) as create, \
                    patch("dimsketch.server.webbrowser.open") as browser, \
                    contextlib.redirect_stdout(io.StringIO()):
                main()
            self.assertEqual(create.call_args.kwargs["host"], "127.0.0.1")
            self.assertEqual(create.call_args.kwargs["port"], 9876)
            server.run.assert_called_once()
            server.close.assert_called_once()
            browser.assert_not_called()
            released = acquire_instance_lock(Path(temporary))
            release_instance_lock(released)

    def test_failed_server_bind_releases_storage_lock(self):
        """목적: 포트 충돌 후 재시작 가능성 검사. 입력: bind 오류. 출력: 설명·잠금 해제."""
        with tempfile.TemporaryDirectory(prefix="photo-measure-bind-") as temporary:
            arguments = argparse.Namespace(port=9876, data_dir=Path(temporary), no_browser=True)
            with patch("dimsketch.server.parse_args", return_value=arguments), \
                    patch("waitress.create_server", side_effect=OSError("port busy")):
                with self.assertRaises(SystemExit) as error:
                    main()
            self.assertIn("9876", str(error.exception))
            released = acquire_instance_lock(Path(temporary))
            release_instance_lock(released)


if __name__ == "__main__":
    unittest.main()
