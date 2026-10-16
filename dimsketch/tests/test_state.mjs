import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {test} from 'node:test';
import vm from 'node:vm';

import {labelPosition, rotationHandle, rotateRegion} from '../static/renderer.js';

const appSource = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/, '')
  .replace(/\r?\ninitialize\(\);\s*$/, '');

/** 목적: VM 경계를 넘어 값만 비교 · 입력: JSON 호환 값 · 출력: 일반 객체 */
function plain(value) {return JSON.parse(JSON.stringify(value));}

/** 목적: 저장과 포인터 조작을 위한 실제 형식 준비 · 입력: 없음 · 출력: 작은 실측 프로젝트 */
function fixture() {
  return {
    id: 'project', name: '원래 이름', revision: 0, updated_at: 'before',
    counters: {object: 1, measurement: 0, features: {}},
    photos: [{id: 'photo', width: 200, height: 100}],
    objects: [{id: 'plate', label: 'A', name: '고정판', color: '#123456'}],
    features: [], measurements: [],
    annotations: [{id: 'mark', photo_id: 'photo', target_type: 'object', target_id: 'plate',
      shape: 'rect', points: [[10, 10], [30, 30]], label_position: [10, 5]}],
  };
}

/** 목적: 앱 원본 함수에 지연 HTTP와 최소 DOM 주입 · 입력: 없음 · 출력: 실제 상태·함수·관찰 요청 */
function harness() {
  const elements = new Map();
  const canvas = {
    style: {cursor:'default'},
    /** 목적: 포커스 UI 생략 · 입력: 없음 · 출력: 없음 */
    focus() {},
    /** 목적: 포인터 캡처 UI 생략 · 입력: 포인터 번호 · 출력: 없음 */
    setPointerCapture() {},
    /** 목적: 실제 캡처 완료 상태 제공 · 입력: 포인터 번호 · 출력: true */
    hasPointerCapture() {return true;},
    /** 목적: 포인터 해제 UI 생략 · 입력: 포인터 번호 · 출력: 없음 */
    releasePointerCapture() {},
    /** 목적: 화면 좌표의 기준 원점 제공 · 입력: 없음 · 출력: 캔버스 위치 */
    getBoundingClientRect() {return {left: 0, top: 0};},
  };
  elements.set('#photo-canvas', canvas);
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const context = {
    structuredClone, crypto: webcrypto, labelPosition, rotationHandle, rotateRegion,
    document: {
      /** 목적: 렌더링 밖의 최소 요소 제공 · 입력: 선택자 · 출력: 시험용 요소 */
      querySelector(selector) {if (!elements.has(selector)) elements.set(selector, {});return elements.get(selector);},
    },
    /** 목적: 자동 저장 예약을 실제 대기 없이 보관 · 입력: 함수·지연값 · 출력: 예약 번호 */
    setTimeout(callback, delay) {timerId += 1;timers.set(timerId, {callback, delay});return timerId;},
    /** 목적: 취소된 자동 저장 예약 제거 · 입력: 예약 번호 · 출력: 예약 삭제 */
    clearTimeout(id) {timers.delete(id);},
    /** 목적: 지연 HTTP를 관찰해 경쟁 순서 재현 · 입력: URL·요청 옵션 · 출력: 수동 완료 Promise */
    fakeApi(url, options = {}) {
      const payload = options.body ? JSON.parse(options.body) : null;
      return new Promise((resolve, reject) => requests.push({url, payload, resolve, reject}));
    },
  };
  vm.createContext(context);
  vm.runInContext(appSource + '\nglobalThis.testApi = {state, commitChange, flushSave, undoRedo, pointerDown, pointerMove, pointerUp, cancelGesture, parseReading, reloadConflict, applyRegionRotation, hitTest, preventMiddleDefault, cancelPointerGesture};', context);
  // 화면 렌더링만 생략하고 저장·이력·좌표 처리는 app.js 원본을 실행한다.
  vm.runInContext('renderControls=()=>{};renderRecords=()=>{};renderPhotos=()=>{};renderInspector=()=>{};renderAll=()=>{};draw=()=>{};toast=()=>{};api=fakeApi;confirmAction=async()=>true;', context);
  const functions = context.testApi;
  functions.state.project = fixture();
  functions.state.photoId = 'photo';
  functions.state.image = {};
  context.fakeHit = () => ({annotation: functions.state.project.annotations[0], kind: 'move'});
  vm.runInContext('hitTest=point=>fakeHit(point);', context);
  return {...functions, requests, timers, context, canvas};
}

/** 목적: 사용자 이름 변경을 실제 변경 확정 함수에 전달 · 입력: 시험 앱·새 이름 · 출력: 저장 대기 상태 */
function editName(app, name) {
  const before = structuredClone(app.state.project);
  app.state.project.name = name;
  app.commitChange(before);
}

/** 목적: 저장 API의 정상 응답 전달 · 입력: 관찰 요청 · 출력: 증가 버전 응답으로 대기 종료 */
function accept(request) {
  request.resolve({...request.payload, revision: request.payload.revision + 1, updated_at: 'saved'});
}

/** 목적: 실제 포인터 함수 호출용 좌표 구성 · 입력: 화면 x·y · 출력: 좌측 버튼 이벤트 */
function pointer(clientX, clientY) {return {clientX, clientY, pointerId: 1, button: 0};}

test('저장 응답 대기 중 편집도 다음 버전으로 순차 저장한다', async () => {
  const app = harness();
  editName(app, '먼저 편집');
  const saved = app.flushSave();
  assert.equal(app.requests.length, 1);
  editName(app, '응답 대기 중 최신 편집');
  accept(app.requests[0]);
  await nextTurn();
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].payload.revision, 1);
  assert.equal(app.requests[1].payload.name, '응답 대기 중 최신 편집');
  accept(app.requests[1]);
  assert.equal(await saved, true);
  assert.equal(app.state.project.name, '응답 대기 중 최신 편집');
  assert.equal(app.state.project.revision, 2);
  assert.equal(app.state.savedSeq, app.state.seq);
  assert.equal(app.state.saving, null);
});

test('409 이후 추가 편집도 충돌 상태와 사용자 입력을 유지한다', async () => {
  const app = harness();
  editName(app, '처음 작성한 입력');
  const saved = app.flushSave();
  const conflict = Object.assign(new Error('다른 창에서 변경됨'), {status: 409});
  app.requests[0].reject(conflict);
  assert.equal(await saved, false);
  editName(app, '충돌 후 추가 입력');
  assert.equal(app.state.saveError, conflict);
  assert.equal(app.state.project.name, '충돌 후 추가 입력');
  assert.equal(await app.flushSave(), false);
  assert.equal(app.requests.length, 1, '충돌 상태에서 오래된 버전으로 다시 PUT하면 안 됨');
  assert.notEqual(app.state.seq, app.state.savedSeq);
});

test('드래그 도중 자동 저장은 확정 좌표만 보내고 취소 좌표를 저장하지 않는다', async () => {
  const app = harness();
  const original = plain(app.state.project.annotations[0]);
  editName(app, '이전 확정 편집으로 자동 저장 대기');
  app.pointerDown(pointer(20, 20));
  app.pointerMove(pointer(25, 25));
  assert.deepEqual(plain(app.state.gesture.annotation.points), [[15, 15], [35, 35]], '실제 드래그 미리보기는 이동해야 함');
  assert.deepEqual(plain(app.state.project.annotations[0]), original, '미확정 드래그는 저장할 프로젝트를 수정하면 안 됨');
  const saved = app.flushSave();
  assert.deepEqual(app.requests[0].payload.annotations[0], original, '자동 저장에 드래그 중간 좌표가 포함되면 안 됨');
  accept(app.requests[0]);
  assert.equal(await saved, true);
  app.cancelGesture();
  assert.deepEqual(plain(app.state.project.annotations[0]), original);
  assert.equal(app.state.gesture, null);
  assert.equal(app.state.seq, app.state.savedSeq);
  app.pointerUp(pointer(25, 25));
  assert.deepEqual(plain(app.state.project.annotations[0]), original, '취소 후 pointerup도 확정하면 안 됨');
});

test('드래그 확정·실행 취소·다시 실행이 최신 저장 버전을 유지한다', async () => {
  const app = harness();
  app.pointerDown(pointer(20, 20));
  app.pointerMove(pointer(25, 25));
  app.pointerUp(pointer(25, 25));
  assert.deepEqual(plain(app.state.project.annotations[0].points), [[15, 15], [35, 35]]);
  assert.equal(app.state.undo.length, 1);
  let saved = app.flushSave();
  accept(app.requests[0]);
  assert.equal(await saved, true);
  app.undoRedo();
  assert.deepEqual(plain(app.state.project.annotations[0].points), [[10, 10], [30, 30]]);
  assert.equal(app.state.project.revision, 1);
  saved = app.flushSave();
  assert.equal(app.requests[1].payload.revision, 1);
  accept(app.requests[1]);
  assert.equal(await saved, true);
  app.undoRedo(true);
  assert.deepEqual(plain(app.state.project.annotations[0].points), [[15, 15], [35, 35]]);
  assert.equal(app.state.project.revision, 2);
  saved = app.flushSave();
  accept(app.requests[2]);
  assert.equal(await saved, true);
  assert.equal(app.state.project.revision, 3);
  assert.equal(app.state.seq, app.state.savedSeq);
});

test('cm 환산 오버플로를 저장 상태 변경 전에 거부한다', () => {
  const app = harness();
  const data = new Map([['status', 'measured'], ['value', '1e308'], ['error', ''], ['unit', 'cm'], ['tool', ''], ['note', '']]);
  assert.throws(() => app.parseReading(data, 'width'), /mm/);
  data.set('value', '1');data.set('error', '1e308');
  assert.throws(() => app.parseReading(data, 'width'), /mm/);
  assert.equal(app.state.seq, 0);
  assert.equal(app.state.project.measurements.length, 0);
});

test('충돌 후 최신 기록을 읽지 못해도 미저장 입력과 충돌 상태를 유지한다', async () => {
  const app = harness();
  editName(app, '보관해야 할 미저장 입력');
  const conflict = Object.assign(new Error('다른 창에서 변경됨'), {status:409});
  app.state.saveError = conflict;
  const reload = app.reloadConflict();
  await nextTurn();
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].url, '/api/projects/project');
  assert.equal(app.requests[0].payload, null, '읽기 실패가 새 저장 요청을 발생시키면 안 된다');
  app.requests[0].reject(new Error('서버 연결 끊김'));
  await reload;
  assert.equal(app.state.project.name, '보관해야 할 미저장 입력');
  assert.equal(app.state.seq, 1);
  assert.equal(app.state.savedSeq, 0, '읽지 못한 서버 자료를 저장 완료로 처리하면 안 된다');
  assert.equal(app.state.saveError, conflict);
  assert.equal(app.state.busy, false);
});

test('회전 확정은 선택한 사진만 저장하고 실행 취소·다시 실행이 좌표를 복원한다', async () => {
  const app = harness();app.state.annotationId = 'mark';
  const other = {...structuredClone(app.state.project.annotations[0]),id:'other',photo_id:'side'};
  app.state.project.annotations.push(other);
  app.applyRegionRotation(90);
  assert.deepEqual(plain(app.state.project.annotations[0].points),[[30,10],[30,30],[10,30],[10,10]]);
  assert.deepEqual(plain(app.state.project.annotations[1]),other);
  const saved = app.flushSave();assert.equal(app.requests[0].payload.annotations[0].shape,'polygon');accept(app.requests[0]);assert.equal(await saved,true);
  app.undoRedo();assert.equal(app.state.project.annotations[0].shape,'rect');assert.equal(app.state.project.revision,1);
  app.undoRedo(true);assert.equal(app.state.project.annotations[0].shape,'polygon');assert.equal(app.state.project.revision,1);
});

test('회전 드래그는 미확정 좌표를 저장하지 않으며 Shift 각도와 취소를 지원한다', async () => {
  const app = harness();const original = plain(app.state.project.annotations[0]);
  editName(app,'회전 전 확정 편집');
  app.context.fakeHit = () => ({annotation:app.state.project.annotations[0],kind:'rotate',center:[20,20],startAngle:0});
  app.pointerDown(pointer(40,20));
  const radians = 20 * Math.PI / 180;
  app.pointerMove({...pointer(20 + 20 * Math.cos(radians),20 + 20 * Math.sin(radians)),shiftKey:true});
  const expected = rotateRegion(original,15,{width:200,height:100});
  app.state.gesture.annotation.points.forEach((point,index) => point.forEach((value,axis) => assert.ok(Math.abs(value - expected.points[index][axis]) < 1e-9)));
  assert.deepEqual(plain(app.state.project.annotations[0]),original);
  const saved = app.flushSave();assert.deepEqual(app.requests[0].payload.annotations[0],original);accept(app.requests[0]);assert.equal(await saved,true);
  app.cancelGesture();app.pointerUp(pointer(30,30));assert.deepEqual(plain(app.state.project.annotations[0]),original);
  app.pointerDown(pointer(40,20));app.pointerMove(pointer(20,40));app.pointerUp(pointer(20,40));
  assert.equal(app.state.project.annotations[0].shape,'polygon');assert.equal(app.state.undo.length,2);
});

test('사진 경계 초과와 잘못된 각도는 저장·이력을 변경하지 않는다', () => {
  const app = harness();app.state.annotationId = 'mark';app.state.project.annotations[0].points = [[0,0],[100,20]];
  const original = plain(app.state.project);
  app.applyRegionRotation(45);app.applyRegionRotation(Infinity);app.applyRegionRotation(361);
  assert.deepEqual(plain(app.state.project),original);assert.equal(app.state.seq,0);
  app.context.fakeHit = () => ({annotation:app.state.project.annotations[0],kind:'rotate',center:[50,10],startAngle:0});
  app.pointerDown(pointer(100,10));app.pointerMove(pointer(80,40));assert.equal(app.state.gesture.invalid,true);app.pointerUp(pointer(80,40));
  assert.deepEqual(plain(app.state.project),original);assert.equal(app.state.undo.length,0);
});

test('실제 선택 판정은 확대·이동한 보기에서도 회전 핸들을 우선 선택한다', () => {
  const app = harness();app.state.annotationId = 'mark';app.state.view = {scale:2,x:30,y:40};
  const handle = rotationHandle(app.state.project.annotations[0],.5);
  const hit = app.hitTest(handle.point);assert.equal(hit.kind,'rotate');assert.deepEqual(plain(hit.center),[20,20]);
});

test('확대된 물체 위 가운데 버튼 드래그는 선택·저장 좌표를 유지하며 사진만 이동한다', async () => {
  const app = harness();app.state.view = {scale:3,x:-40,y:-30};
  app.state.selection = {type:'objects',id:'plate'};app.state.annotationId = 'mark';
  const original = plain(app.state.project);const selection = plain(app.state.selection);
  app.context.fakeHit = () => {throw new Error('가운데 버튼은 영역 선택 판정을 거치면 안 된다');};
  let prevented = false;
  app.pointerDown({...pointer(20,30),button:1,preventDefault(){prevented = true;}});
  assert.equal(prevented,true);assert.equal(app.canvas.style.cursor,'grabbing');
  app.pointerMove({...pointer(110,70),buttons:4});
  assert.deepEqual(plain(app.state.view),{scale:3,x:50,y:10});
  app.pointerUp({...pointer(110,70),button:1});
  assert.deepEqual(plain(app.state.project),original);assert.deepEqual(plain(app.state.selection),selection);
  assert.equal(app.state.annotationId,'mark');assert.equal(app.state.seq,0);assert.equal(app.state.undo.length,0);
  assert.equal(app.state.gesture,null);assert.equal(app.canvas.style.cursor,'default');
  assert.equal(await app.flushSave(),true);assert.equal(app.requests.length,0);
});

test('가운데 버튼 이동은 모든 도구에서 미완성 다각형·치수선과 도구 선택을 보존한다', () => {
  for (const mode of ['select','rect','polygon','point','plane','measure']) {
    const app = harness();app.state.mode = mode;
    app.state.draft = {shape:mode === 'polygon' ? 'polygon' : 'line',points:[[15,25]],preview:[30,40]};
    app.state.linkTarget = {type:'objects',id:'plate'};
    const draft = plain(app.state.draft);const original = plain(app.state.project);
    app.pointerDown({...pointer(20,20),button:1,preventDefault(){}});
    app.pointerMove(pointer(55,35));app.pointerUp({...pointer(55,35),button:1});
    assert.equal(app.state.mode,mode);assert.deepEqual(plain(app.state.draft),draft);
    assert.deepEqual(plain(app.state.linkTarget),{type:'objects',id:'plate'});
    assert.deepEqual(plain(app.state.project),original);assert.equal(app.state.undo.length,0);
    assert.equal(app.canvas.style.cursor,mode === 'select' ? 'default' : 'crosshair');
  }
});

test('가운데 버튼 이동 취소 후 커서와 미확정 기록이 유지된다', () => {
  const app = harness();app.state.mode = 'polygon';
  app.state.draft = {shape:'polygon',points:[[15,25],[30,40]]};
  const original = plain(app.state.project);const draft = plain(app.state.draft);
  app.pointerDown({...pointer(20,20),button:1,preventDefault(){}});app.pointerMove(pointer(45,35));app.cancelPointerGesture();
  assert.equal(app.canvas.style.cursor,'crosshair');assert.equal(app.state.gesture,null);
  app.pointerUp({...pointer(45,35),button:1});
  assert.deepEqual(plain(app.state.project),original);assert.deepEqual(plain(app.state.draft),draft);assert.equal(app.state.seq,0);
});

test('브라우저 자동 스크롤은 가운데 버튼에만 차단하고 오른쪽 버튼은 편집하지 않는다', () => {
  const app = harness();
  for (const button of [0,1,2]) {
    let prevented = false;app.preventMiddleDefault({button,preventDefault(){prevented = true;}});
    assert.equal(prevented,button === 1);
  }
  app.pointerDown({...pointer(20,20),button:2});assert.equal(app.state.gesture,null);assert.equal(app.state.seq,0);
});
