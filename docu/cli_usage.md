# DimSketch command reference

[English README](../README.md) · [한국어 안내](README.ko.md)

Run these commands from the repository root in Windows PowerShell. Python 3.11 (64-bit) is required.

```powershell
.\scripts\setup.ps1
.\scripts\start.ps1
```

`setup.ps1` has no additional options. It creates `.venv/` and installs `requirements.txt` without changing other Python environments.

`start.ps1` accepts `-Port` (default `8765`), `-DataDir` (default `.local/`), and `-NoBrowser` (skip automatic browser launch). Relative data paths are resolved against the repository root, regardless of the current working directory.

```powershell
.\scripts\start.ps1 -Port 8766 -DataDir .\.local\alternate -NoBrowser
```

The equivalent direct Python options are `--port`, `--data-dir`, and `--no-browser`:

```powershell
.\.venv\Scripts\python.exe .\dimsketch\server.py --port 8766 --data-dir .local/alternate --no-browser
```

The default URL is `http://127.0.0.1:8765`. Keep the console open while using DimSketch and press `Ctrl+C` to stop it. Only one server can use a given data directory. Restart the server and refresh the page after changing application source or templates.

If PowerShell blocks scripts, use a policy override for the current process:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```
