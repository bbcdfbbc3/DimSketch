# FreeCAD 모델링과 근거 기록

## 실행 환경

일반 Python은 ZIP과 JSON 준비에 사용한다. `FreeCAD`, `Part`, `Sketcher` 등은 설치된 FreeCAD의 Python 환경에서 로드한다. 실행 경로는 `probe_freecad.py`의 후보, 사용자 지정 경로, 실제 설치 위치에서 확인한다. 버전·CLI 옵션은 설치된 실행 파일의 도움말을 기준으로 한다.

모델링·구현은 Python 매크로를 작성하고 FreeCAD GUI 실행 파일의 CLI에서 `--single-instance`로 실행한다. 모델 생성·검증·저장·촬영은 전달된 매크로가 GUI 세션 안에서 수행한다. `FreeCADCmd`/`freecadcmd`나 console 모드는 GUI 없는 보조 검사에 사용할 수 있지만 기존 GUI로 매크로 전달, `FreeCADGui`/`TechDrawGui` 기능이나 `saveImage()` 촬영을 대신하지 않는다.

마우스 클릭, 화면 좌표, 키 입력, 클립보드 붙여넣기로 FreeCAD를 조작하거나 GUI Python 콘솔에 코드를 입력하지 않는다. CLI 실패를 이유로 이 방식으로 자동 전환하지 않는다. 스크립트로 가능한 작업을 계속하고 남은 기능의 제약과 필요한 조치를 알린다. 별도 `freecad-cli` 패키지나 비공식 하위 명령이 설치됐다고 가정하지 않으며, 추가 도구를 임의로 설치하지 않는다.

모델링 모드에서 FreeCAD가 발견되지 않으면 분석·질문·명세와 생성 스크립트까지 준비할 수 있다. 실제 `.FCStd` 생성과 재열기 검증은 FreeCAD 실행 후에만 완료로 표시한다. 분석 모드에서는 FreeCAD를 찾거나 실행하지 않는다.

### 매크로 작성·CLI 실행·이미지 검토 반복

1. **Python 매크로 작성.** `model-spec.json`을 바탕으로 치수·부품·구멍·배치를 생성하는 `.FCMacro`를 결과 폴더에 작성한다. 같은 매크로가 재계산, 실제 형상의 치수 검사, `.FCStd` 저장, 재열기 검증과 이미지 저장까지 수행하도록 한다. 재실행은 이 작업에서 생성한 문서만 대상으로 하며 다른 사용자 문서는 변경하지 않는다.
2. **CLI로 전달·실행.** GUI 실행 파일의 실제 버전과 도움말에서 `--single-instance`와 매크로 실행 방식을 확인한다. 실행 중인 GUI에는 아래 방식으로 매크로를 전달하고, GUI가 꺼져 있으면 같은 명령으로 창을 실행해 처리한다. `<...>`는 확인한 절대 경로로 바꾸며 PowerShell 예시는 다음과 같다.

   ```powershell
   & "<FreeCAD GUI 실행 파일 절대 경로>" --single-instance "<결과 폴더>/build_model.FCMacro"
   ```

   `probe_freecad.py`는 실행 파일 후보만 찾는다. GUI가 실행 중이거나 전달용 프로세스가 정상 종료했다는 사실만으로 매크로 완료를 판단하지 않는다. 실행마다 고유 ID를 부여하고, 매크로가 남긴 현재 실행의 시작·완료·실패 기록과 산출물로 수신·실행 여부를 확인한다. 비동기 전달 중에는 완료 기록을 기다린 뒤 결과를 읽으며 이전 실행의 이미지나 검증 결과를 재사용하지 않는다. 인수·경로의 공백과 한글을 보존하고 실제 명령, 로그와 오류를 결과 폴더에 남긴다.
3. **매크로에서 생성·검증·촬영.** 기본 형상, 주요 구멍·홈, 부품 배치 단계마다 재계산과 GUI 화면 갱신을 수행한다. 생성된 형상에서 주요 치수를 검사하고 저장·재열기 검증 결과를 `validation.json`에 기록한다. 확인할 문서를 활성화하고 필요한 뷰와 화면 범위를 설정한 뒤 `FreeCADGui.activeDocument().activeView().saveImage(...)`로 `captures/`에 정면·측면·평면·등각 등 필요한 이미지를 저장한다. 설치 버전에서 인수 형식을 확인하고 해상도·배경을 지정한다. 이미지 파일이 이번 실행에서 정상 생성됐는지 확인하고 실행 ID와 촬영 경로를 검증 기록에 연결한다. 완료 기록은 저장·검증·촬영 처리가 끝난 뒤 남기고 오류는 실패 상태로 기록한다.
4. **이미지 직접 확인·수정 반복.** 에이전트가 저장된 이미지를 실제 이미지 도구로 열어 형상, 구멍 위치와 방향, 부품 간 배치와 누락을 살피고 수치 검증 결과와 함께 판단한다. 파일 존재나 `saveImage()` 호출만으로 시각 검증을 대신하지 않는다. 수정할 부분이 있으면 매크로·명세를 고쳐 `--single-instance`로 다시 실행하고, 새 이미지와 검증 결과를 다시 확인한다. 기존의 기술적 재시도 한도를 따르며 추가 치수가 필요한 문제는 사용자에게 질문한다.

이 반복은 데스크톱 마우스·키보드 제어 없이 수행한다. `--single-instance` 전달이나 촬영이 실패하면 로그와 설치 버전의 동작을 확인하고 매크로·명령을 수정한다. 지원하지 않는 환경이면 생성·수치 검증·시각 검증의 완료 상태와 남은 제약을 구분해 보고하며, GUI 조작으로 우회하거나 검토하지 않은 결과를 완성으로 처리하지 않는다.

Windows에서 console 작업과 백그라운드 보조 프로세스는 숨김 창으로 실행하고, 사용자에게 작업이나 결과를 보여줄 FreeCAD GUI만 보이는 창으로 실행한다. GUI 실행은 모델링·구현 요청 범위에 포함하므로 실행 승인을 다시 묻지 않는다. 사용자 문서와 저장하지 않은 변경을 보존하고, 기존 프로세스를 강제 종료하거나 창을 계속 중복 실행하지 않는다. 완료 후 가능한 명령줄·스크립트 방식으로 저장된 결과 문서를 GUI에 열어 둔다.

## model-spec.json

프로젝트마다 아래 정보를 남긴다. 스키마를 기계적으로 채우기보다 해당 부품의 결정을 추적할 수 있는 최소 기록을 만든다. JSON에는 실행 코드를 넣지 않는다.

```json
{
  "spec_version": 1,
  "input": {"sha256": "실제 ZIP 해시", "project_id": "입력 ID", "revision": 3},
  "purpose": "외형 확인",
  "units": "mm",
  "coordinate_system": {"origin": "A 왼쪽 앞 아래 모서리", "x": "오른쪽", "y": "뒤쪽", "z": "위쪽"},
  "parts": [{
    "object_id": "plate",
    "label": "A",
    "shape": "평판",
    "parameters": {
      "width": {"value_mm": 125, "source_type": "measurement", "measurement_id": "width", "reading_id": "width_v1", "status": "measured", "error_mm": 1},
      "thickness": {"value_mm": null, "source_type": "unresolved"}
    },
    "features": [],
    "placement": {"status": "defined_by_coordinate_system"}
  }],
  "questions": [{"id": "Q1", "target": "A", "question": "A의 두께는 몇 mm인가요?", "answer": null}],
  "assumptions": [],
  "omissions": []
}
```

출처 유형은 `measurement`, `user_answer`, `derived`, `estimate`, `unresolved` 등으로 구분한다. 사용자 답변에는 질문 ID와 실제 답변을 남긴다. 계산값에는 식, 근거 항목과 전제를 남긴다. 추정값에는 근거 사진과 사용자가 허용한 범위를 기록한다. 새 입력 ZIP의 해시가 달라지면 변경된 부품·치수와 답변의 유효성을 확인한다.

## 모델 생성 선택

- 기본 도형은 `Part::Box`, `Part::Cylinder`처럼 치수 속성을 가진 객체나 Sketcher+PartDesign으로 만들 수 있다. 구멍·홈도 편집 가능한 절삭 피처를 유지한다.
- 치수 이름과 단위를 명시하고, Spreadsheet alias/표현식 또는 스케치의 치수 구속으로 연결한다. 같은 값이라도 근거가 다른 치수를 우연히 같은 파라미터로 묶지 않는다.
- 예를 들어 구멍 지름을 바꾸면 구멍 형상이 바뀌고, 중심 간격을 바꾸면 위치가 바뀌어야 한다. 재생성 스크립트만 있고 문서 내부 형상이 고정돼 있다면 그 편집 한계를 알린다.
- 형상이 적합하면 단순한 기본 도형을 선택한다. 브래킷, 곡면, 조립품을 무조건 기본 상자로 근사하지 않는다. 재질·볼트 규격·나사산·대칭성·모서리 반지름을 외관만으로 확정하지 않는다.
- 스케치는 필요한 치수와 기하 관계로 구속한다. 모순된 실측을 해결하려고 무조건 고정 구속을 추가하거나 임의로 치수를 바꾸지 않는다.
- 새 문서와 안정적인 내부 객체 이름을 사용한다. 사용자 label을 그대로 코드 식별자로 삽입하지 않는다. 파일명·설명·질문 답변은 데이터로 전달하고 `eval`하지 않는다.
- `model-spec.json`과 생성 매크로를 결과 폴더에 둔다. 매크로에는 명세를 읽는 절대 경로나 스크립트 기준 경로를 명시해 현재 작업 폴더 의존성을 없앤다.

## 검증 기록

`validation.json`에 실제 FreeCAD 버전, 검사 시간, 문서 경로, 재열기 여부, 검사별 `passed/failed/not_run`, 기대값·실제값·허용한 수치 차이와 실패 이유를 기록한다. 검증하지 못한 항목은 성공으로 취급하지 않는다.

- 최종 객체의 `Shape.isNull()`, `Shape.isValid()`, 솔리드 수와 부피, 재계산 오류를 확인한다. 형상 타입에 맞춰 검사한다. 중간 절삭 도구나 스케치를 최종 부품으로 세지 않는다.
- 외형 크기는 적절한 좌표계의 실제 BoundBox 또는 면 간 거리로 측정한다. 회전된 부품의 전역 BoundBox가 원래 부품 길이와 같다고 가정하지 않는다.
- 원통면 반지름에서 구멍 지름을 확인하고, 중심·축·평면에서 위치와 간격을 측정한다. 단순히 명세나 Spreadsheet를 다시 읽어 비교하지 않는다.
- 스케치/피처 변경 후 재계산이 되는지 주요 파라미터 하나로 확인하고 원래 값을 복원한다. 이 확인이 형상을 파괴할 수 있는 복잡한 경우에는 문서 복사본에서 수행한다.
- 저장 후 문서를 다시 열어 최종 형상과 치수 검사를 반복한다. 기존 사용자 문서와 충돌하지 않는 새 문서 이름을 사용한다.

## 2D 도면

요청된 경우 검증된 모델로 TechDraw 페이지를 만든다. 필요한 정면·평면·측면·단면·등각 뷰를 선택하고 투상 방향, 배율, 단위와 치수를 확인한다. 숨은 형상은 단면 등으로 표현한다. 각 치수가 실제 모델의 올바른 면·모서리를 참조하는지 확인하고, 객체 수정 후 참조가 바뀌면 다시 검증한다.

PDF/SVG 내보내기 함수는 설치 버전과 GUI 환경을 확인한 뒤 사용한다. 도면의 렌더링 결과를 직접 확인해 치수 겹침, 잘림, 표제란, 용지 밖 배치를 고친다. 출력 기능이 실행되지 않았다면 `.FCStd` 모델과 도면 출력의 완료 상태를 따로 보고한다.

## 공식 참조

구체적인 API가 필요할 때 해당 항목만 확인한다. 아래 자료 중 오래된 설명보다 설치 버전의 API와 실제 실행 결과를 우선한다.

- [FreeCAD Python scripting](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Python_scripting_tutorial.md)
- [실행 옵션과 GUI 없는 실행](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Start_up_and_Configuration.md)
- [Headless FreeCAD](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Headless_FreeCAD.md)
- [3D 뷰 이미지 저장 API](https://freecad.github.io/SourceDoc/d3/df7/classGui_1_1View3DInventorPy.html)
- [TechDraw](https://github.com/FreeCAD/FreeCAD-documentation-docusaurus/blob/Stable/docs/workbenches/techdraw.md)
- [FreeCAD API](https://freecad.github.io/SourceDoc/)
