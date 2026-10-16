[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 8765,
    [string]$DataDir = '',
    [switch]$NoBrowser
)

# 목적: 로컬 DimSketch 실행
# 입력: 포트, 선택적 데이터 경로, 브라우저 자동 열기 생략 여부
# 출력: 현재 콘솔에서 서버 실행. Ctrl+C로 종료
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$appRoot = Join-Path $repositoryRoot 'dimsketch'
$pythonPath = Join-Path $repositoryRoot '.venv\Scripts\python.exe'
$serverPath = Join-Path $appRoot 'server.py'
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw '앱 전용 환경이 없습니다. .\scripts\setup.ps1를 먼저 실행하세요.'
}
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
    throw "앱 실행 파일을 찾을 수 없습니다: $serverPath"
}
$launchArguments = @($serverPath, '--port', [string]$Port)
if (-not [string]::IsNullOrWhiteSpace($DataDir)) {
    $resolvedDataDir = if ([System.IO.Path]::IsPathRooted($DataDir)) { $DataDir } else { Join-Path $repositoryRoot $DataDir }
    $launchArguments += @('--data-dir', $resolvedDataDir)
}
if ($NoBrowser) {
    $launchArguments += '--no-browser'
}
& $pythonPath @launchArguments
if ($LASTEXITCODE -ne 0) {
    throw 'DimSketch을 시작하지 못했습니다. 위 오류와 포트 사용 상태를 확인하세요.'
}
