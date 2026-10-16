# Development and validation

[English README](../README.md) · [한국어 안내](README.ko.md)

DimSketch uses Python 3.11, Flask 3.1.3, Waitress 3.0.2, Pillow 12.3.0, and vanilla JavaScript with Canvas 2D. Python dependencies are pinned; Node 22 is used for JavaScript tests and is not required to run the app.

From the repository root in PowerShell:

```powershell
.\.venv\Scripts\python.exe -m compileall -q .\dimsketch
.\.venv\Scripts\python.exe -W error::ResourceWarning -m unittest discover -s .\dimsketch\tests -t . -v
node --test .\dimsketch\tests\test_renderer.mjs .\dimsketch\tests\test_state.mjs
node --check .\dimsketch\static\app.js
node --check .\dimsketch\static\renderer.js
.\.venv\Scripts\python.exe -m pip check
```

Tests use temporary data. They cover references across photos, units and uncertainty, repeated measurements, atomic saves, conflicts, original image preservation, ZIP round trips, invalid archives, instance locks, rendering, rotation, undo/redo, and middle-button panning without changing saved geometry.

Store local verification artifacts in `.checks/`, which is excluded from Git. Use synthetic photos for public examples. Keep user photos, measurements, exported ZIP files, and machine-specific project data out of source commits.
