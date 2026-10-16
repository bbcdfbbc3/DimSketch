# DimSketch ZIP v1

## 파일과 연결

루트 `project.json`의 정수 `schema_version`이 1인 형식을 지원한다. `revision`은 저장 횟수이며 형식 버전과 다르다. 파일 이름이나 프로젝트 이름으로 버전을 추측하지 않는다.

| 경로/필드 | 의미 |
|---|---|
| `project.json` | 프로젝트 ID, revision, 사진·물체·기준 요소·측정·표시 목록 |
| `originals/` | 원본 사진. 방향 메타데이터가 있을 수 있음 |
| `images/` | EXIF 방향이 보정된 좌표 기준 사진 |
| `annotated/<photo_id>.png` | 같은 좌표 기준 사진 위에 식별자와 치수 표시 |
| `docu/summary.md` | 사람이 읽는 요약. 수치는 JSON과 대조 |
| `photos` | `id`, `filename`, `width`, `height`, `view`, `original_path`, `image_path`, `description` |
| `objects` | `id`, `label`(A/B/AA…), `name`, `description`, `color` |
| `features` | `id`, `object_id`, `kind`, `label`, `name`, `description` |
| `measurements` | 양쪽 기준, 치수 종류, 측정 이력과 채택값 |
| `annotations` | 사진 ID와 대상 ID를 연결하는 픽셀 표시 |

사진 `view`는 `overall/front/side/top/bottom/oblique/other`이다. 같은 `side`라도 좌우 어느 쪽인지, 사진이 정확한 직교 투영인지 보장하지 않는다.

기준 요소 `kind`는 `hole/point/plane`, 표시 번호는 `A-H1/A-P1/A-F1` 형태다. ID가 실제 연결 키이고 label은 사용자에게 설명하는 이름이다. 구멍이라는 정보만으로 지름, 축 방향, 관통 여부, 나사 가공은 결정되지 않는다.

## 치수 해석

측정에는 `id`, `label`(M01…), `name`, `kind`, `direction`, `from_ref`, `to_ref`, `readings`, `selected_reading_id`가 있다.

- `kind`: `length/width/height/thickness/diameter/pitch/gap/offset`.
- `pitch`는 구멍 중심 간격이다. `gap`은 면 사이 거리다.
- 양쪽 ref에는 `object_id`, `feature_id`, `text`가 있다. ID가 없어도 숨겨진 끝면처럼 text만으로 기준을 설명할 수 있다.
- 각 reading의 `value`, `unit`(`mm/cm`), `status`(`measured/approximate/unknown`), `error`, `tool`, `note`, `created_at`을 보존한다.
- `value_mm`, `error_mm`는 저장 시 만들어지는 환산값이다. 검사 도구는 원래 수치와 단위에서 다시 계산하며 저장된 환산값이 다르면 오류를 낸다.
- `selected_reading_id`에 지정된 reading만 채택한다. 목록의 첫 항목·마지막 항목 또는 평균을 대신 쓰지 않는다.
- `unknown`의 수치는 사용할 수 없다. 채택 항목이 없으면 채택값도 없다.
- `offset`은 수치가 음이 아닌 크기로 저장되고 `direction=down`일 때 실제 부호는 음수, `up`일 때 양수다. 모델의 Z축을 정한 뒤 기준 관계에 맞춰 배치한다.
- `error_mm`는 ± 측정 오차이며 제조 공차가 아니다.

## 사진 좌표의 한계

모든 표시점은 `images/`의 픽셀 좌표다. 물체의 rect/polygon은 식별 영역이며 CAD 외곽선이 아니다. 점·선도 측정 대상을 가리키는 표시다. 실제 거리와 3D 위치를 자동으로 결정하지 않는다.

정면·측면·평면 사진의 조합은 형상 해석에 도움이 되지만 카메라 보정이나 3D 좌표계가 저장되는 형식은 아니다. 반지름, 각도, 나사 규격, 부품 배치 등은 전용 필드가 없으므로 설명·사진·사용자 답변에서 근거를 확보해야 한다.

## 검사 도구의 범위

`inspect_bundle.py`는 경로, 용량, JSON 형식, ID 참조, 사진 파일 존재, 치수 단위·상태·환산값을 검사한다. 출력의 `issues`는 채택값 없음, 대략값, 근거 연결 부족 등의 확인 항목이다. 목록이 비어도 CAD에 필요한 정보가 충분하다는 뜻은 아니다.

검사 도구는 이미지 픽셀 자체의 유효성이나 EXIF 보정 결과 일치까지 확인하지 않는다. 실제로 이미지를 열어 확인하고, 불일치가 보이면 재내보내기를 요청한다. 원본 파일은 수정하지 않는다.
