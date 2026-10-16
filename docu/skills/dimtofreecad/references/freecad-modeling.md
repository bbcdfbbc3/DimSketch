# FreeCAD 모델링과 근거 기록

## 실행 환경

일반 Python은 ZIP과 JSON 준비에 사용한다. `FreeCAD`, `Part`, `Sketcher` 등은 설치된 FreeCAD의 Python 환경에서 로드한다. 실행 경로는 `probe_freecad.py`의 후보, 사용자 지정 경로, 실제 설치 위치에서 확인한다. 버전·CLI 옵션은 설치된 실행 파일의 도움말을 기준으로 한다.

FreeCADCmd는 GUI 없는 작업에 적합하다. FreeCADGui/TechDrawGui에 의존하는 기능과 이미지·PDF 출력은 GUI 실행 환경을 따로 확인한다. Windows에서 백그라운드 보조 프로세스를 시작할 때는 숨김 창을 사용하고, 실제 사용자가 보고 조작할 결과 창을 요청한 경우에만 표시한다. 사용자의 기존 문서를 닫거나 프로세스 전체를 종료하지 않는다.

FreeCAD가 발견되지 않으면 분석·질문·명세와 생성 스크립트까지 준비할 수 있다. 실제 `.FCStd` 생성과 재열기 검증은 FreeCAD 실행 후에만 완료로 표시한다.

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
- [TechDraw](https://github.com/FreeCAD/FreeCAD-documentation-docusaurus/blob/Stable/docs/workbenches/techdraw.md)
- [FreeCAD API](https://freecad.github.io/SourceDoc/)
