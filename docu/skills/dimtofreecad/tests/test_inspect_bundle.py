"""Portable behavioral checks for DimSketch evidence handling (no FreeCAD required)."""

import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "inspect_bundle.py"
SPEC = importlib.util.spec_from_file_location("inspect_bundle", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=")


def fixture():
    return {
        "schema_version": 1, "id": "project1", "name": "한글 고정판", "revision": 3,
        "photos": [{"id": "front", "filename": "정면.png", "width": 1, "height": 1,
                    "view": "front", "original_path": "originals/front.png", "image_path": "images/front.png"}],
        "objects": [{"id": "plate", "label": "A", "name": "판"}],
        "features": [{"id": "hole1", "object_id": "plate", "kind": "hole", "label": "A-H1"}],
        "measurements": [{"id": "width", "label": "M01", "kind": "width", "direction": "none",
                          "from_ref": {"object_id": "plate", "feature_id": None, "text": "왼쪽 끝"},
                          "to_ref": {"object_id": "plate", "feature_id": None, "text": "오른쪽 끝"},
                          "selected_reading_id": "r1",
                          "readings": [{"id": "r1", "value": 12.5, "unit": "cm", "status": "measured", "error": 0.1},
                                       {"id": "r2", "value": 126, "unit": "mm", "status": "measured", "error": None}]}],
        "annotations": [{"id": "mark", "photo_id": "front", "target_type": "measurement",
                         "target_id": "width", "shape": "line", "points": [[0, 0], [1, 1]]}]
    }


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dimtofreecad-test-")
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def bundle(self, project=None, extra=None, omit=()):
        path = self.root / "한글 sample.zip"
        entries = {"project.json": json.dumps(fixture() if project is None else project, ensure_ascii=False),
                   "originals/front.png": PNG, "images/front.png": PNG, "annotated/front.png": PNG,
                   "docu/summary.md": "# 한글 요약\n"}
        entries.update(extra or {})
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, content in entries.items():
                if name not in omit:
                    info = zipfile.ZipInfo(name)
                    # Preserve malformed raw names rather than Windows-normalizing the test input.
                    info.filename = name
                    archive.writestr(info, content)
        return path

    def test_selected_value_conversion_and_evidence_are_preserved(self):
        path = self.bundle()
        report = MODULE.inspect_bundle(path, self.root / "result")
        dimension = report["measurements"][0]
        self.assertEqual(dimension["signed_value_mm"], 125)
        self.assertEqual(dimension["selected_reading"]["error_mm"], 1)
        self.assertEqual(dimension["photo_ids"], ["front"])
        self.assertEqual(report["source"]["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual((self.root / "result/input/images/front.png").read_bytes(), PNG)
        self.assertEqual(json.loads((self.root / "result/analysis.json").read_text(encoding="utf-8")), report)

    def test_negative_offset_is_not_lost(self):
        project = fixture()
        project["measurements"][0].update(kind="offset", direction="down")
        report = MODULE.inspect_bundle(self.bundle(project))
        self.assertEqual(report["measurements"][0]["signed_value_mm"], -125)

    def test_missing_selection_unknown_and_approximate_remain_distinct(self):
        for state in ("unselected", "unknown", "approximate"):
            with self.subTest(state=state):
                project = fixture()
                measurement = project["measurements"][0]
                if state == "unselected":
                    measurement["selected_reading_id"] = None
                else:
                    measurement["readings"][0]["status"] = state
                report = MODULE.inspect_bundle(self.bundle(project))
                self.assertIn("approximate" if state == "approximate" else "missing_value", [i["code"] for i in report["issues"]])
                if state != "approximate":
                    self.assertIsNone(report["measurements"][0]["signed_value_mm"])

    def test_missing_required_images_fail_before_creating_output(self):
        with self.assertRaises(ValueError):
            MODULE.inspect_bundle(self.bundle(omit=("images/front.png",)), self.root / "result")
        self.assertFalse((self.root / "result").exists())

    def test_missing_annotated_photo_is_reported(self):
        report = MODULE.inspect_bundle(self.bundle(omit=("annotated/front.png",)))
        self.assertIn("missing_annotated", [i["code"] for i in report["issues"]])

    def test_unknown_files_are_never_extracted(self):
        report = MODULE.inspect_bundle(self.bundle(extra={"run.py": "raise RuntimeError('must not run')"}), self.root / "result")
        self.assertEqual(report["ignored_files"], ["run.py"])
        self.assertFalse((self.root / "result/input/run.py").exists())

    def test_existing_output_is_preserved(self):
        output = self.root / "result"
        output.mkdir()
        (output / "keep.txt").write_text("keep")
        with self.assertRaises(ValueError):
            MODULE.inspect_bundle(self.bundle(), output)
        self.assertEqual((output / "keep.txt").read_text(), "keep")

    def test_unsafe_paths_case_collisions_and_file_parent_conflicts_fail(self):
        for name in ("../escape.txt", "/absolute.txt", "C:/drive.txt", "images\\escape.png", "bad\x00name", "CON", "folder./file", "PROJECT.JSON", "images"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                MODULE.inspect_bundle(self.bundle(extra={name: "x"}))

    def test_symlink_is_rejected(self):
        path = self.bundle()
        with zipfile.ZipFile(path, "a") as archive:
            info = zipfile.ZipInfo("link")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "../../outside")
        with self.assertRaises(ValueError):
            MODULE.inspect_bundle(path)

    def test_malformed_version_duplicate_ids_and_dangling_references_fail(self):
        cases = []
        for version in (True, 2):
            project = fixture()
            project["schema_version"] = version
            cases.append(project)
        project = fixture()
        project["objects"].append(dict(project["objects"][0]))
        cases.append(project)
        project = fixture()
        project["measurements"][0]["selected_reading_id"] = "missing"
        cases.append(project)
        project = fixture()
        project["measurements"][0]["from_ref"]["feature_id"] = "missing"
        cases.append(project)
        project = fixture()
        project["annotations"][0]["target_id"] = "missing"
        cases.append(project)
        for project in cases:
            with self.subTest(project=project), self.assertRaises(ValueError):
                MODULE.inspect_bundle(self.bundle(project))

    def test_bad_numeric_values_and_stale_unit_cache_fail(self):
        for value in (float("nan"), float("inf"), -1, True, 0, 1e308):
            project = fixture()
            project["measurements"][0]["readings"][0]["value"] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                MODULE.inspect_bundle(self.bundle(project))
        project = fixture()
        project["measurements"][0]["readings"][0]["value_mm"] = 12.5
        with self.assertRaises(ValueError):
            MODULE.inspect_bundle(self.bundle(project))

    def test_duplicate_json_keys_are_rejected(self):
        with self.assertRaises(ValueError):
            MODULE.inspect_bundle(self.bundle(extra={"project.json": '{"schema_version":1,"schema_version":2}'}))

    def test_file_count_limit(self):
        with self.assertRaises(ValueError):
            MODULE.inspect_bundle(self.bundle(extra={f"extras/{i}": "x" for i in range(1001)}))

    def test_cli_works_outside_repository_and_returns_structured_errors(self):
        path = self.bundle()
        result = subprocess.run([sys.executable, "-X", "utf8", str(SCRIPT), str(path)], cwd=self.root,
                                capture_output=True, text=True, encoding="utf-8", check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["project"]["name"], "한글 고정판")
        result = subprocess.run([sys.executable, "-X", "utf8", str(SCRIPT), str(self.root / "missing.zip")], cwd=self.root,
                                capture_output=True, text=True, encoding="utf-8", check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn("error", json.loads(result.stderr))


if __name__ == "__main__":
    unittest.main()
