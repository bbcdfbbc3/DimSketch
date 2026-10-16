[CmdletBinding()]
param()

# 목적: DimSketch 전용 Python 3.11 환경과 고정 의존성 설치
# 입력: 없음. 출력: .venv 생성 및 패키지 검증
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$venvRoot = Join-Path $repositoryRoot '.venv'
$pythonPath = Join-Path $venvRoot 'Scripts\python.exe'
$requirementsPath = Join-Path $repositoryRoot 'requirements.txt'

if (-not (Test-Path -LiteralPath $requirementsPath -PathType Leaf)) {
    throw "앱 의존성 파일을 찾을 수 없습니다: $requirementsPath"
}
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($null -eq $launcher) {
        throw 'Python Launcher를 찾을 수 없습니다. Python 3.11 64비트를 설치한 뒤 다시 실행하세요.'
    }
    & $launcher.Source -3.11 -m venv $venvRoot
    if ($LASTEXITCODE -ne 0) {
        throw '앱 가상 환경을 만들지 못했습니다. Python 3.11 64비트 설치 상태를 확인하세요.'
    }
}
& $pythonPath -c "import sys, struct; sys.exit(0 if sys.version_info[:2] == (3, 11) and struct.calcsize('P') == 8 else 1)"
if ($LASTEXITCODE -ne 0) {
    throw '앱 가상 환경에는 Python 3.11 64비트가 필요합니다. 기존 환경을 보존한 뒤 별도 환경을 구성하세요.'
}
& $pythonPath -m pip install --disable-pip-version-check -r $requirementsPath
if ($LASTEXITCODE -ne 0) {
    throw '앱 패키지 설치에 실패했습니다. 인터넷 연결과 위 오류를 확인한 뒤 이 스크립트를 다시 실행하세요.'
}
& $pythonPath -m pip check
if ($LASTEXITCODE -ne 0) {
    throw '앱 패키지 의존성이 충돌합니다. 위 패키지 목록을 확인하세요.'
}
Write-Host 'DimSketch 설치 완료. .\scripts\start.ps1로 실행하세요.'
