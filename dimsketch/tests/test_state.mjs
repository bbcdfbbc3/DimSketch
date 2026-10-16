import assert from 'node:assert/strict';
import {File} from 'node:buffer';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {test} from 'node:test';
import vm from 'node:vm';

import {labelPosition, measurementValue, rotationHandle, rotateRegion} from '../static/renderer.js';

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
  elements.set('#edit-dialog', {
    open:false,
    /** 목적: 팝업 열림 상태 재현 · 입력: 없음 · 출력: 열린 팝업 */
    showModal() {this.open = true;},
    /** 목적: 팝업 닫힘 상태 재현 · 입력: 없음 · 출력: 닫힌 팝업 */
    close() {this.open = false;},
  });
  elements.set('#confirm-dialog', {open:false});
  elements.set('#region-dialog', {
    open:false,
    /** 목적: 영역 방식 선택 창 열림 재현 · 입력: 없음 · 출력: 열린 선택 창 */
    showModal() {this.open = true;},
    /** 목적: 선택·취소로 닫힌 창 재현 · 입력: 없음 · 출력: 닫힌 선택 창 */
    close() {this.open = false;},
  });
  const requests = [];
  const notices = [];
  const timers = new Map();
  let timerId = 0;
  const context = {
    structuredClone, crypto: webcrypto, labelPosition, measurementValue, rotationHandle, rotateRegion,
    FormData: class {
      /** 목적: 폼 입력을 실제 읽기 함수에 전달 · 입력: 시험용 폼 · 출력: 입력값 맵 */
      constructor(form) {return form ? new Map(form.values) : new FormData();}
    },
    document: {
      /** 목적: 렌더링 밖의 최소 요소 제공 · 입력: 선택자 · 출력: 시험용 요소 */
      querySelector(selector) {if (['#record-form','#existing-target'].includes(selector)) return elements.get(selector) || null;if (!elements.has(selector)) elements.set(selector, {});return elements.get(selector);},
    },
    /** 목적: 자동 저장 예약을 실제 대기 없이 보관 · 입력: 함수·지연값 · 출력: 예약 번호 */
    setTimeout(callback, delay) {timerId += 1;timers.set(timerId, {callback, delay});return timerId;},
    /** 목적: 취소된 자동 저장 예약 제거 · 입력: 예약 번호 · 출력: 예약 삭제 */
    clearTimeout(id) {timers.delete(id);},
    /** 목적: 지연 HTTP를 관찰해 경쟁 순서 재현 · 입력: URL·요청 옵션 · 출력: 수동 완료 Promise */
    fakeApi(url, options = {}) {
      const payload = typeof options.body === 'string' ? JSON.parse(options.body) : options.body || null;
      return new Promise((resolve, reject) => requests.push({url, method:options.method, payload, resolve, reject}));
    },
    /** 목적: 사용자에게 표시할 완료·실패 안내 관찰 · 입력: 안내와 오류 여부 · 출력: 안내 기록 */
    fakeToast(message, error = false) {notices.push({message,error});},
  };
  vm.createContext(context);
  vm.runInContext(appSource + '\nglobalThis.testApi = {state, commitChange, flushSave, undoRedo, pointerDown, pointerMove, pointerUp, cancelGesture, parseReading, reloadConflict, applyRegionRotation, hitTest, preventMiddleDefault, cancelPointerGesture, handleKeydown, submitDialog, openDialog, closeDialog, renderInspector, markObjectRegion, finishPolygon, handlePaste, objectDialog, measurementDialog};', context);
  // 화면 렌더링만 생략하고 저장·이력·좌표 처리는 app.js 원본을 실행한다.
  vm.runInContext('renderControls=()=>{};renderRecords=()=>{};renderPhotos=()=>{};renderInspector=()=>{};renderAll=()=>{};draw=()=>{};toast=fakeToast;api=fakeApi;confirmAction=async()=>true;', context);
  const functions = context.testApi;
  functions.state.project = fixture();
  functions.state.photoId = 'photo';
  functions.state.image = {};
  context.fakeHit = () => ({annotation: functions.state.project.annotations[0], kind: 'move'});
  vm.runInContext('hitTest=point=>fakeHit(point);', context);
  return {...functions, requests, notices, timers, context, canvas, elements};
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

/** 목적: 저장 단축키와 기본 동작 차단 여부 관찰 · 입력: 키 옵션 · 출력: 키보드 이벤트 */
function saveKey(options = {}) {
  return {key:'s',code:'KeyS',ctrlKey:true,defaultPrevented:false,
    preventDefault() {this.defaultPrevented = true;},...options};
}

/** 목적: 선택 항목의 실제 상세 패널 버튼 연결 · 입력: 앱·종류·번호 · 출력: 상세 패널 HTML */
function inspectRecord(app, type, id) {
  app.state.selection = {type,id};app.state.tab = type;app.elements.set('#record-form',{});
  app.elements.set('#inspector',{innerHTML:'',insertAdjacentHTML(position,html){this.innerHTML += html;}});
  app.renderInspector();return app.elements.get('#inspector').innerHTML;
}

/** 목적: 신규 생성 팝업에 사용자 입력 전달 · 입력: 앱·필드 값 · 출력: 실제 제출과 저장 결과 */
function submitValues(app, values) {
  const button = {disabled:false};
  return app.submitDialog({currentTarget:{values:Object.entries(values),querySelector(){return button;}},preventDefault(){}});
}

/** 목적: 채택값과 이전 이력이 있는 치수 준비 · 입력: 앱 · 출력: 원본 치수와 신규 입력용 값 */
function seedMeasurement(app) {
  app.state.project.features.push({id:'hole',object_id:'plate',kind:'hole',label:'A-H1',name:'구멍',description:'원본 기준'});
  app.state.project.counters.features['plate:hole'] = 1;app.state.project.counters.measurement = 1;
  const record = {id:'dimension',label:'M01',name:'기준면 높이',kind:'offset',direction:'down',
    from_ref:{object_id:'plate',feature_id:'hole',text:'구멍 중심'},to_ref:{object_id:'plate',feature_id:null,text:'아랫면'},
    readings:[{id:'old',value:12,unit:'cm',status:'measured',error:null,tool:'자',note:'이전 측정',created_at:'2020-01-01T00:00:00Z',value_mm:120,error_mm:null},
      {id:'adopted',value:12.5,unit:'cm',status:'approximate',error:0.2,tool:'줄자',note:'채택한 측정',created_at:'2020-01-02T00:00:00Z',value_mm:125,error_mm:2}],selected_reading_id:'adopted'};
  app.state.project.measurements.push(record);
  app.state.project.annotations.push({id:'dimension-mark',photo_id:'photo',target_type:'measurement',target_id:record.id,shape:'line',points:[[40,30],[80,30]]});
  return {record,values:{name:record.name,kind:record.kind,direction:record.direction,from_ref:'feature:hole',from_text:'구멍 중심',to_ref:'object:plate',to_text:'아랫면',
    status:'approximate',unit:'cm',value:'12.5',error:'0.2',tool:'줄자',note:'채택한 측정'}};
}

test('기존 물체 정보는 표시 버튼 아래에서 수정 가능한 새 물체로 생성하고 원본과 영역을 유지한다', async () => {
  const app = harness();const source = app.state.project.objects[0];source.description = '같은 형식의 고정판';
  app.state.annotationId = 'mark';const original = plain(app.state.project);
  const panel = inspectRecord(app,'objects',source.id);
  assert.ok(panel.indexOf('id="mark-record"') < panel.indexOf('id="create-from-record"'));
  assert.ok(panel.indexOf('id="create-from-record"') < panel.indexOf('id="delete-record"'));
  app.elements.get('#create-from-record').onclick();
  const content = app.elements.get('#dialog-content').innerHTML;
  assert.match(content,/name="name" type="text" value="고정판"/);assert.match(content,/같은 형식의 고정판/);
  assert.match(content,/name="color" type="color" value="#123456"/);
  assert.equal(app.state.project.counters.object,1);assert.equal(app.state.project.objects.length,1);
  const saved = submitValues(app,{existing:source.id,name:'다른 고정판',description:'새 물체 설명',color:'#abcdef'});await nextTurn();
  const payload = app.requests[0].payload;const created = payload.objects[1];
  assert.equal(created.label,'B');assert.notEqual(created.id,source.id);assert.equal(created.name,'다른 고정판');assert.equal(created.color,'#abcdef');
  assert.deepEqual(payload.objects[0],original.objects[0]);assert.deepEqual(payload.annotations,original.annotations);
  assert.deepEqual(payload.features,original.features);assert.equal(app.state.annotationId,null);
  accept(app.requests[0]);await saved;assert.equal(app.state.selection.id,created.id);
  app.undoRedo();assert.equal(app.state.project.objects.length,1);assert.equal(app.state.project.counters.object,2);
  app.undoRedo(true);assert.equal(app.state.project.objects[1].id,created.id);
});

test('새 치수는 채택한 입력을 미리 채우고 새 번호·측정 ID·시각으로 시작하며 이전 이력과 치수선을 복사하지 않는다', async () => {
  const app = harness();const {record,values} = seedMeasurement(app);const original = plain(app.state.project);
  app.state.annotationId = 'dimension-mark';const panel = inspectRecord(app,'measurements',record.id);
  assert.ok(panel.indexOf('id="mark-record"') < panel.indexOf('id="create-from-record"'));
  assert.ok(panel.indexOf('id="create-from-record"') < panel.indexOf('id="delete-record"'));
  app.elements.get('#create-from-record').onclick();const content = app.elements.get('#dialog-content').innerHTML;
  for (const pattern of [/value="기준면 높이"/,/value="offset" selected/,/value="down" selected/,/value="feature:hole" selected/,/value="object:plate" selected/,/value="approximate" selected/,/value="cm" selected/,/value="12.5"/,/value="0.2"/,/value="줄자"/,/채택한 측정/]) assert.match(content,pattern);
  const saved = submitValues(app,{...values,existing:record.id,name:'다른 기준면 높이',value:'13.2',note:'새 치수 확인'});await nextTurn();
  const payload = app.requests[0].payload;const created = payload.measurements[1];const reading = created.readings[0];
  assert.equal(created.label,'M02');assert.notEqual(created.id,record.id);assert.equal(created.readings.length,1);
  assert.equal(reading.value_mm,132);assert.equal(reading.error_mm,2);assert.equal(created.selected_reading_id,reading.id);
  assert.ok(!record.readings.some(item => item.id === reading.id || item.created_at === reading.created_at));
  assert.deepEqual(created.from_ref,record.from_ref);assert.deepEqual(created.to_ref,record.to_ref);
  assert.deepEqual(payload.measurements[0],original.measurements[0]);assert.deepEqual(payload.annotations,original.annotations);
  assert.equal(app.state.annotationId,null);accept(app.requests[0]);await saved;
  const newRecord = app.state.project.measurements[1];assert.notEqual(newRecord.from_ref,record.from_ref);
  newRecord.from_ref.text = '독립된 기준 설명';assert.equal(app.state.project.measurements[0].from_ref.text,'구멍 중심');
});

test('새 항목 팝업을 취소하거나 잘못 입력하면 번호·기록·원본 선택을 유지한다', async () => {
  for (const type of ['objects','measurements']) {
    const app = harness();const seeded = type === 'measurements' ? seedMeasurement(app) : null;
    const record = seeded?.record || app.state.project.objects[0];inspectRecord(app,type,record.id);
    const original = plain(app.state.project);const selection = plain(app.state.selection);
    app.elements.get('#create-from-record').onclick();app.closeDialog();
    assert.deepEqual(plain(app.state.project),original);assert.deepEqual(plain(app.state.selection),selection);
    app.elements.get('#create-from-record').onclick();
    await submitValues(app,seeded ? {...seeded.values,value:'-1'} : {name:'   ',description:'설명',color:'#123456'});
    assert.equal(app.elements.get('#edit-dialog').open,true);assert.ok(app.elements.get('#dialog-error').textContent);
    assert.deepEqual(plain(app.state.project),original);assert.equal(app.requests.length,0);assert.equal(app.state.seq,0);
  }
});

test('채택값이 없는 치수는 이전 이력을 임의로 고르지 않고 새 값을 입력받는다', async () => {
  const app = harness();const {record,values} = seedMeasurement(app);record.selected_reading_id = null;
  inspectRecord(app,'measurements',record.id);app.elements.get('#create-from-record').onclick();
  const content = app.elements.get('#dialog-content').innerHTML;
  assert.match(content,/채택한 측정값이 없어/);assert.match(content,/name="value" type="number" value=""/);
  assert.doesNotMatch(content,/value="12.5"/);
  await submitValues(app,{...values,value:''});assert.equal(app.requests.length,0);assert.equal(app.state.project.counters.measurement,1);
  const saved = submitValues(app,{...values,value:'14'});await nextTurn();
  assert.equal(app.requests[0].payload.measurements[1].readings[0].value_mm,140);
  accept(app.requests[0]);await saved;assert.equal(record.selected_reading_id,null);assert.equal(record.readings.length,2);
});

test('미측정 치수를 재사용하면 숫자 입력은 비활성화하고 새 미측정 기록을 생성한다', async () => {
  const app = harness();const {record,values} = seedMeasurement(app);const adopted = record.readings[1];
  Object.assign(adopted,{status:'unknown',value:null,value_mm:null,error:null,error_mm:null});
  inspectRecord(app,'measurements',record.id);app.elements.get('#create-from-record').onclick();
  const content = app.elements.get('#dialog-content').innerHTML;
  assert.match(content,/value="unknown" selected/);assert.match(content,/name="value"[^>]*disabled/);assert.match(content,/name="error"[^>]*disabled/);
  const saved = submitValues(app,{...values,status:'unknown',value:undefined,error:undefined});await nextTurn();
  const reading = app.requests[0].payload.measurements[1].readings[0];
  assert.equal(reading.value,null);assert.equal(reading.error,null);assert.notEqual(reading.id,adopted.id);
  accept(app.requests[0]);await saved;
});

test('일반 신규 물체·치수 등록은 기존 정보 재사용 없이도 빈 폼에서 정상 생성한다', async () => {
  for (const type of ['objects','measurements']) {
    const app = harness();const seeded = type === 'measurements' ? seedMeasurement(app) : null;
    if (seeded) app.measurementDialog();else app.objectDialog();
    assert.match(app.elements.get('#dialog-content').innerHTML,/name="name" type="text" value=""/);
    const saved = submitValues(app,seeded ? {...seeded.values,name:'직접 등록한 치수'} : {name:'직접 등록한 물체',description:'설명'});await nextTurn();
    assert.equal(app.requests[0].payload[type].length,2);accept(app.requests[0]);await saved;
  }
});

/** 목적: 클립보드 파일과 기본 동작 관찰 · 입력: 파일 목록과 이벤트 옵션 · 출력: 붙여넣기 이벤트 */
function imagePaste(files, options = {}) {
  return {target:{tagName:'BODY'},defaultPrevented:false,
    clipboardData:{items:files.map(file => ({kind:'file',type:file.type,getAsFile(){return file;}})),files},
    preventDefault(){this.defaultPrevented = true;},...options};
}

/** 목적: 파일 업로드 후 실제 사진 선택까지 실행 · 입력: 없음 · 출력: 이미지 로딩 화면만 생략한 앱 */
function pasteHarness() {
  const app = harness();vm.runInContext('loadImage=async()=>({});fitView=()=>{};',app.context);return app;
}

test('붙여넣은 이미지는 미저장 편집 후 한 번만 업로드하고 사진 모음과 선택을 갱신한다', async () => {
  const app = pasteHarness();editName(app,'사진 추가 전에 보존할 편집');
  const files = [new File(['capture bytes'],'capture.png',{type:'image/png'}),new File(['photo bytes'],'photo.jpg',{type:'image/jpeg'})];
  const event = imagePaste(files);const pasted = app.handlePaste(event);
  assert.equal(event.defaultPrevented,true);assert.equal(app.state.busy,true);
  assert.equal(app.requests.length,1);assert.equal(app.requests[0].method,'PUT');
  app.handlePaste(imagePaste(files));assert.equal(app.requests.length,1,'저장 대기 중 두 번째 붙여넣기는 중복 업로드하면 안 됨');
  accept(app.requests[0]);await nextTurn();
  const upload = app.requests[1];assert.equal(upload.method,'POST');assert.equal(upload.url,'/api/projects/project/photos');
  assert.equal(upload.payload.get('revision'),'1');
  const uploaded = upload.payload.getAll('files');assert.equal(uploaded.length,2,'items와 files의 같은 이미지를 중복 추가하면 안 됨');
  assert.deepEqual(uploaded.map(file => file.name),['capture.png','photo.jpg']);
  assert.equal(await uploaded[0].text(),'capture bytes');
  const project = plain(app.state.project);project.revision += 1;
  project.photos.push({id:'pasted',filename:'capture.png',width:200,height:100},{id:'pasted-2',filename:'photo.jpg',width:200,height:100});
  upload.resolve(project);await pasted;
  assert.equal(app.state.project.photos.length,3);assert.equal(app.state.photoId,'pasted');
  assert.equal(app.state.project.name,'사진 추가 전에 보존할 편집');
  assert.equal(app.state.busy,false);assert.equal(app.state.savedSeq,app.state.seq);
  assert.match(app.notices.at(-1).message,/2장 추가 완료/);
});

test('클립보드 items가 없거나 파일을 반환하지 않아도 files의 이미지를 추가한다', async () => {
  for (const items of [undefined,[{kind:'file',type:'image/png',getAsFile(){return null;}}]]) {
    const app = pasteHarness();const file = new File(['capture'],'image.png',{type:'image/png'});
    const event = imagePaste([],{clipboardData:{items,files:[file]}});const pasted = app.handlePaste(event);
    await nextTurn();assert.equal(event.defaultPrevented,true);
    assert.equal(app.requests[0].payload.getAll('files').length,1);
    const project = plain(app.state.project);project.photos.push({id:'pasted',filename:'image.png',width:200,height:100});
    app.requests[0].resolve(project);await pasted;assert.equal(app.state.photoId,'pasted');
  }
});

test('텍스트 붙여넣기와 Ctrl+V·Cmd+V는 작성 중인 다각형을 취소하지 않는다', () => {
  const app = harness();app.state.mode = 'polygon';app.state.draft = {shape:'polygon',points:[[15,25],[30,40]]};
  const draft = plain(app.state.draft);
  for (const modifiers of [{ctrlKey:true},{metaKey:true}]) app.handleKeydown({key:'v',...modifiers});
  for (const clipboardData of [null,{items:[{kind:'string',type:'text/plain'}],files:[]}]) {
    const event = imagePaste([],{clipboardData});app.handlePaste(event);assert.equal(event.defaultPrevented,false);
  }
  assert.equal(app.state.mode,'polygon');assert.deepEqual(plain(app.state.draft),draft);assert.equal(app.requests.length,0);
  app.handleKeydown({key:'v'});assert.equal(app.state.mode,'select');assert.equal(app.state.draft,null);
});

test('입력창·편집 팝업·작업 중에는 클립보드 이미지를 사진으로 추가하지 않는다', () => {
  const file = new File(['capture'],'image.png',{type:'image/png'});
  for (const condition of ['INPUT','TEXTAREA','SELECT','editable','active-input','edit','confirm','region','busy','handled']) {
    const app = harness();const event = imagePaste([file]);
    if (['INPUT','TEXTAREA','SELECT'].includes(condition)) event.target = {tagName:condition};
    if (condition === 'editable') event.target = {tagName:'SPAN',isContentEditable:true};
    if (condition === 'active-input') app.context.document.activeElement = {tagName:'INPUT'};
    if (['edit','confirm','region'].includes(condition)) app.elements.get(`#${condition}-dialog`).open = true;
    if (condition === 'busy') app.state.busy = true;
    if (condition === 'handled') event.defaultPrevented = true;
    app.handlePaste(event);
    assert.equal(event.defaultPrevented,condition === 'handled');assert.equal(app.requests.length,0);
    assert.equal(app.state.project.photos.length,1);
  }
});

test('프로젝트가 없으면 이미지 붙여넣기는 프로젝트 선택 안내만 표시한다', () => {
  const app = harness();app.state.project = null;
  const event = imagePaste([new File(['capture'],'image.png',{type:'image/png'})]);app.handlePaste(event);
  assert.equal(event.defaultPrevented,true);assert.equal(app.requests.length,0);assert.match(app.notices[0].message,/프로젝트/);
});

test('붙여넣기 업로드 실패는 기존 사진을 유지하고 다시 시도할 수 있게 한다', async () => {
  const app = pasteHarness();const original = plain(app.state.project);
  const pasted = app.handlePaste(imagePaste([new File(['capture'],'image.png',{type:'image/png'})]));await nextTurn();
  app.requests[0].reject(new Error('사진 업로드 연결 실패'));await pasted;
  assert.deepEqual(plain(app.state.project),original);assert.equal(app.state.busy,false);
  assert.equal(app.notices.at(-1).error,true);assert.match(app.notices.at(-1).message,/연결 실패/);
});

test('기존 편집의 저장 충돌이 발생하면 붙여넣기 업로드를 중단하고 편집을 보존한다', async () => {
  const app = pasteHarness();editName(app,'충돌해도 남겨야 할 입력');
  const pasted = app.handlePaste(imagePaste([new File(['capture'],'image.png',{type:'image/png'})]));
  const conflict = Object.assign(new Error('다른 창에서 변경됨'),{status:409});app.requests[0].reject(conflict);await pasted;
  assert.equal(app.requests.length,1);assert.equal(app.state.busy,false);assert.equal(app.state.saveError,conflict);
  assert.equal(app.state.project.photos.length,1);assert.equal(app.state.project.name,'충돌해도 남겨야 할 입력');
  assert.notEqual(app.state.savedSeq,app.state.seq);
});

test('기존 물체의 영역 표시에서 선택한 사각형·다각형을 다른 사진의 같은 물체로 저장한다', async () => {
  for (const mode of ['rect','polygon']) {
    const app = harness();const original = plain(app.state.project.annotations[0]);
    app.state.project.photos.push({id:'side',width:200,height:100});app.state.photoId = 'side';
    app.state.selection = {type:'objects',id:'plate'};
    app.elements.set('#record-form',{});app.renderInspector();
    app.elements.get('#mark-record').onclick();
    assert.equal(app.elements.get('#region-dialog').open,true);
    assert.equal(app.state.mode,'select');assert.equal(app.state.seq,0);
    app.elements.get(`#region-${mode}`).onclick();
    assert.equal(app.elements.get('#region-dialog').open,false);assert.equal(app.state.mode,mode);
    assert.deepEqual(plain(app.state.linkTarget),{type:'objects',id:'plate'});
    app.elements.set('#existing-target',{value:'plate'});
    app.elements.set('#new-target-fields',{querySelectorAll(){return [];}});
    if (mode === 'rect') {
      app.pointerDown(pointer(50,20));app.pointerMove(pointer(100,60));app.pointerUp(pointer(100,60));
    } else {
      for (const [x,y] of [[50,20],[100,20],[90,60],[60,50]]) {app.pointerDown(pointer(x,y));app.pointerUp(pointer(x,y));}
      app.finishPolygon();
    }
    assert.equal(app.elements.get('#edit-dialog').open,true);
    assert.match(app.elements.get('#dialog-content').innerHTML,/<option value="plate" selected>/);
    const button = {disabled:false};const form = {values:[['existing','plate']],querySelector(){return button;}};
    const saved = app.submitDialog({currentTarget:form,preventDefault(){}});await nextTurn();
    const payload = app.requests[0].payload;
    assert.equal(payload.objects.length,1);assert.equal(payload.counters.object,1);
    assert.deepEqual(payload.annotations[0],original);
    assert.equal(payload.annotations[1].photo_id,'side');assert.equal(payload.annotations[1].target_id,'plate');
    assert.equal(payload.annotations[1].shape,mode);assert.equal(payload.annotations[1].points.length,mode === 'rect' ? 2 : 4);
    accept(app.requests[0]);await saved;
    assert.equal(app.state.savedSeq,app.state.seq);assert.equal(app.state.mode,'select');
    app.undoRedo();assert.equal(app.state.project.annotations.length,1);assert.equal(app.state.project.objects.length,1);
    app.undoRedo(true);assert.equal(app.state.project.annotations[1].shape,mode);
  }
});

test('영역 방식 선택을 취소하거나 선택 중 단축키를 눌러도 기존 기록을 바꾸지 않는다', () => {
  for (const close of ['region-cancel','region-close']) {
    const app = harness();app.state.selection = {type:'objects',id:'plate'};
    const original = plain(app.state.project);const selection = plain(app.state.selection);
    app.markObjectRegion();
    const save = saveKey();app.handleKeydown(save);app.handleKeydown({key:'Delete'});
    assert.equal(save.defaultPrevented,true);assert.equal(app.elements.get('#region-dialog').open,true);
    app.elements.get(`#${close}`).onclick();
    assert.equal(app.elements.get('#region-dialog').open,false);
    assert.deepEqual(plain(app.state.project),original);assert.deepEqual(plain(app.state.selection),selection);
    assert.equal(app.state.mode,'select');assert.equal(app.state.linkTarget,null);
    assert.equal(app.state.seq,0);assert.equal(app.requests.length,0);
  }
});

test('선택한 사진이나 로드된 이미지가 없으면 영역 그리기를 시작하지 않는다', () => {
  for (const missing of ['photo','image']) {
    const app = harness();app.state.selection = {type:'objects',id:'plate'};
    if (missing === 'photo') app.state.photoId = null;
    else app.state.image = null;
    app.markObjectRegion();
    assert.equal(app.elements.get('#region-dialog').open,false);
    assert.equal(app.state.mode,'select');assert.equal(app.state.seq,0);
  }
});

test('Ctrl+S는 브라우저 저장을 차단하고 자동 저장 대기 없이 변경을 전송한다', async () => {
  const app = harness();editName(app,'단축키로 저장할 이름');
  const event = saveKey();const saved = app.handleKeydown(event);
  assert.equal(event.defaultPrevented,true);
  assert.equal(app.requests.length,1);
  assert.equal(app.requests[0].payload.name,'단축키로 저장할 이름');
  assert.equal(app.timers.size,0,'예약된 자동 저장은 즉시 저장으로 대체해야 함');
  accept(app.requests[0]);assert.equal(await saved,true);
  assert.equal(app.state.savedSeq,app.state.seq);
});

test('입력 중인 폼과 포커스가 없는 상세 폼도 저장 단축키로 먼저 확정한다', async () => {
  for (const tagName of ['INPUT','TEXTAREA','SELECT',null]) {
    const app = harness();let submissions = 0;
    const form = {requestSubmit() {submissions += 1;editName(app,'폼에 작성 중인 최신 값');}};
    if (tagName) app.context.document.activeElement = {tagName,form};
    else app.elements.set('#record-form',form);
    const event = saveKey();const saved = app.handleKeydown(event);
    assert.equal(event.defaultPrevented,true);assert.equal(submissions,1);
    assert.equal(app.requests[0].payload.name,'폼에 작성 중인 최신 값');
    accept(app.requests[0]);assert.equal(await saved,true);
  }
});

test('팝업의 실측값은 Ctrl+S로 확정·저장하며 처리 중 중복 등록하지 않는다', async () => {
  const app = harness();const button = {disabled:false};let submitted;let submissions = 0;
  const form = {
    values:[['status','measured'],['value','12.5'],['error',''],['unit','cm'],['tool','줄자'],['note','새 실측값']],
    querySelector() {return button;},
    requestSubmit() {submissions += 1;submitted = app.submitDialog({currentTarget:this,preventDefault(){}});},
  };
  app.elements.set('#dialog-form',form);app.context.document.activeElement = {tagName:'INPUT',form};
  app.openDialog('실측값 입력','',data => {
    const before = structuredClone(app.state.project);
    app.state.project.measurements.push({id:'measurement',readings:[app.parseReading(data,'width')]});
    app.commitChange(before);
  });
  const event = saveKey();app.handleKeydown(event);app.handleKeydown(saveKey());
  assert.equal(event.defaultPrevented,true);assert.equal(submissions,1);assert.equal(button.disabled,true);
  await nextTurn();
  assert.equal(app.requests.length,1);
  assert.equal(app.requests[0].payload.measurements[0].readings[0].value_mm,125);
  accept(app.requests[0]);await submitted;
  assert.equal(app.state.savedSeq,app.state.seq);
  assert.equal(app.elements.get('#edit-dialog').open,false);assert.equal(button.disabled,false);
});

test('잘못된 실측값은 저장 단축키를 눌러도 팝업 입력을 유지한다', async () => {
  const app = harness();const button = {disabled:false};let submitted;
  const form = {
    values:[['status','measured'],['value','-1'],['error',''],['unit','mm']],
    querySelector() {return button;},
    requestSubmit() {submitted = app.submitDialog({currentTarget:this,preventDefault(){}});},
  };
  app.elements.set('#dialog-form',form);
  app.openDialog('실측값 입력','',data => app.parseReading(data,'width'));
  app.handleKeydown(saveKey());await submitted;
  assert.equal(app.requests.length,0);assert.equal(app.elements.get('#edit-dialog').open,true);
  assert.ok(app.elements.get('#dialog-error').textContent);
  assert.equal(new Map(form.values).get('value'),'-1');assert.equal(button.disabled,false);
});

test('저장 단축키는 연결 실패 후 입력을 유지하고 다시 저장할 수 있다', async () => {
  const app = harness();editName(app,'연결 실패에도 남겨야 할 입력');
  const saved = app.handleKeydown(saveKey());const error = new Error('서버 연결 끊김');
  app.requests[0].reject(error);assert.equal(await saved,false);
  assert.equal(app.state.saveError,error);assert.notEqual(app.state.seq,app.state.savedSeq);
  assert.equal(app.state.project.name,'연결 실패에도 남겨야 할 입력');
  const retried = app.handleKeydown(saveKey());assert.equal(app.requests.length,2);
  accept(app.requests[1]);assert.equal(await retried,true);assert.equal(app.state.saveError,null);
});

test('저장 단축키는 한글 배열·Cmd를 지원하고 대기·확인 창·키 반복 중에는 제출하지 않는다', async () => {
  for (const options of [{key:'ㄴ'},{ctrlKey:false,metaKey:true,key:'S'}]) {
    const app = harness();editName(app,'다른 키보드에서도 저장');
    const event = saveKey(options);const saved = app.handleKeydown(event);
    assert.equal(event.defaultPrevented,true);assert.equal(app.requests.length,1);
    accept(app.requests[0]);assert.equal(await saved,true);
  }
  for (const condition of ['busy','confirm','repeat','no-project']) {
    const app = harness();
    if (condition === 'busy') app.state.busy = true;
    if (condition === 'confirm') app.elements.get('#confirm-dialog').open = true;
    if (condition === 'no-project') app.state.project = null;
    const event = saveKey({repeat:condition === 'repeat'});await app.handleKeydown(event);
    assert.equal(event.defaultPrevented,true);assert.equal(app.requests.length,0);
  }
});

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
