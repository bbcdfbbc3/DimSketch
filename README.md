# DimSketch

[한국어 안내](docu/README.ko.md) · [Command reference](docu/cli_usage.md)

DimSketch is a local web app for organizing measured dimensions across photos. Mark the same object in different views, record measurements, and export a reference package for CAD modeling.

## Features

- Link objects, holes, reference points, and planes across photos.
- Draw, rotate, and edit regions; pan with the middle mouse button and zoom with the wheel.
- Record measurements in mm or cm, with uncertainty, measurement history, and explicit reference points.
- Save confirmed edits automatically and detect conflicting edits from other tabs.
- Export and restore ZIP packages containing original photos, annotated images, JSON, and a Markdown summary.

Dimensions are entered manually. DimSketch does not infer real dimensions from pixels or generate CAD automatically. The interface is currently in Korean.

## Quick start

Requires **Windows, Python 3.11 (64-bit), and a desktop browser**.

Run from the repository folder in PowerShell:

```powershell
.\scripts\setup.ps1
.\scripts\start.ps1
```

Open **http://127.0.0.1:8765**. Keep PowerShell open while using the app; press **Ctrl+C** to stop the server. Python dependencies are pinned in `requirements.txt`; Node.js is only needed for developer tests.

Projects and photos stay in the local `.local/` folder, which is excluded from Git. Export important work as ZIP backups. Publishing this repository does not publish your photos or host the app online.

For execution-policy help, controls, and data migration, see the [Korean guide](docu/README.ko.md). For tests, see [Development](docu/development.md).
