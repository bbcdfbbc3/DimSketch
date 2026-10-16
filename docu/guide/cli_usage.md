# dimtofreecad 보조 명령

DimSketch 앱 실행 명령은 [기존 CLI 안내](../cli_usage.md)를 참고한다. 이 문서는 스킬에 포함된 ZIP 검사·FreeCAD 탐색 명령을 다룬다.

스킬 원본은 `docu/skills/dimtofreecad/`에 있다. 설치 후에는 같은 명령에서 스크립트 경로만 설치된 스킬 폴더로 바꾸면 된다. 다른 프로젝트에서 실행할 때는 스크립트, ZIP, 결과 폴더에 절대 경로를 사용한다.

## ZIP 검사

```powershell
.\.venv\Scripts\python.exe .\docu\skills\dimtofreecad\scripts\inspect_bundle.py 'C:\data\sample.zip'
```

- 필수 위치 인자 `zip_path`: DimSketch v1 ZIP 경로.
- 선택 `--output`: 아직 존재하지 않는 결과 폴더. 지정하면 `input/`에 선언된 사진·JSON·요약을 꺼내고 `analysis.json`을 저장한다.
- 기본 동작: 파일을 쓰지 않고 검사 결과 JSON을 표준 출력으로 출력한다.
- 종료 코드 `0`: 입력 형식 검사 성공. `issues`가 남을 수 있고 CAD 치수의 완전성을 보장하지 않는다.
- 종료 코드 `2`: 입력·읽기·쓰기 오류. 오류 JSON은 표준 오류로 출력한다. 추출 도중 실패하면 부분 결과가 남을 수 있으므로 새 폴더로 재시도한다.
- 기존 결과 폴더와 입력 ZIP을 덮어쓰지 않는다. 검사 실패 시 입력 원본은 그대로 유지된다.

```powershell
.\.venv\Scripts\python.exe .\docu\skills\dimtofreecad\scripts\inspect_bundle.py 'C:\data\sample.zip' --output '.\.local\dimtofreecad\sample-01'
```

## FreeCAD 탐색

```powershell
.\.venv\Scripts\python.exe .\docu\skills\dimtofreecad\scripts\probe_freecad.py
.\.venv\Scripts\python.exe .\docu\skills\dimtofreecad\scripts\probe_freecad.py --executable 'C:\Tools\FreeCAD\bin\FreeCADCmd.exe'
```

- 선택 `--executable`: 우선 확인할 FreeCAD/FreeCADCmd 실행 파일 경로.
- 기본 탐색: `FREECAD_EXECUTABLE` 환경 변수, PATH, 운영체제별 일반 설치 경로.
- 프로그램을 실행하거나 설치하지 않고 후보 경로 JSON을 출력한다. 후보가 없어도 정상 종료한다.
- `runtime_verified`는 항상 `false`다. 에이전트가 실제 실행 파일의 버전·도움말·필요 모듈을 확인해야 한다.
- ZIP 검사와 경로 탐색은 Python 3.10 이상 및 표준 라이브러리만 필요하다. 실제 모델 생성은 FreeCAD의 Python 환경이 필요하다.

## 보조 도구 검증

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s .\docu\skills\dimtofreecad\tests -v
```

이 검증은 입력 해석, 파일 보존, 독립 실행을 검사한다. 실제 FreeCAD 모델 생성·도면 렌더링 검증은 포함하지 않는다.
