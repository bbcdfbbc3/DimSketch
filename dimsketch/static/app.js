import {drawScene, labelLayout, labelPosition, measurementValue, rotationHandle, rotateRegion} from './renderer.js';

/** 목적: 단일 화면 요소 탐색 · 입력: CSS 선택자 · 출력: 요소 */
const $ = selector => document.querySelector(selector);
/** 목적: 편집 전 독립 상태 보관 · 입력: JSON 호환 값 · 출력: 깊은 복사 */
const clone = value => structuredClone(value);
/** 목적: 데이터 연결용 고유 ID 발급 · 입력: 없음 · 출력: UUID 문자열 */
const uid = () => crypto.randomUUID();
/** 목적: 사용자 입력의 HTML 삽입 방지 · 입력: 문자열 또는 값 · 출력: HTML 이스케이프 문자열 */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const VIEWS = {overall:'전체',front:'정면',side:'측면',top:'위',bottom:'아래',oblique:'사선',other:'기타'};
const KINDS = {length:'길이',width:'폭',height:'높이',thickness:'두께',diameter:'지름',pitch:'구멍 중심 간격',gap:'면 사이 거리',offset:'기준면 대비 높이'};
const FEATURES = {hole:'구멍',point:'기준점',plane:'기준면'};
const STATUSES = {measured:'실측',approximate:'대략',unknown:'미측정'};
const COLORS = ['#236c54','#2874ad','#b36725','#8b54a4','#b34250','#397f83','#71762a'];
const HELP = {select:'표시를 클릭해 수정 · ↻ 핸들로 영역 회전 (Shift: 15° 간격) · 빈 곳 드래그로 사진 이동',rect:'물체를 감싸도록 드래그하세요. 이미 등록한 물체도 연결할 수 있습니다.',polygon:'꼭짓점을 차례로 클릭하세요. Enter 또는 더블클릭으로 완료 · Esc 취소',point:'구멍 중심이나 기준점을 클릭하세요.',plane:'같은 기준면 위 두 점을 클릭하세요.',measure:'측정한 구간의 시작점과 끝점을 클릭하세요. 실제 치수는 직접 입력합니다.'};
const state = {project:null,photoId:null,image:null,mode:'select',tab:'objects',selection:null,linkTarget:null,annotationId:null,view:{scale:1,x:0,y:0},draft:null,gesture:null,undo:[],redo:[],seq:0,savedSeq:0,saveTimer:null,saving:null,saveError:null,busy:false,filter:'',loadToken:0};
let dialogHandler = null;
let toastTimer = null;

/** 목적: 서버 요청과 한국어 오류 처리 · 입력: 주소와 fetch 옵션 · 출력: JSON 또는 응답 객체 */
async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const detail = await response.json().catch(() => ({error:`요청을 처리하지 못했습니다 (${response.status}).`}));
    const error = new Error(detail.error || '요청을 처리하지 못했습니다.');error.status = response.status;error.detail = detail;throw error;
  }
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : response;
}

/** 목적: 간단한 작업 결과 안내 · 입력: 안내 문구와 오류 여부 · 출력: 일시적인 알림 표시 */
function toast(message, error = false) {
  clearTimeout(toastTimer);$('#toast').textContent = message;$('#toast').classList.toggle('error',error);$('#toast').hidden = false;
  toastTimer = setTimeout(() => {$('#toast').hidden = true;},6000);
}

/** 목적: 긴 처리 중 중복 편집 방지 · 입력: 처리 상태와 문구 · 출력: 대기 화면 및 조작 상태 */
function setBusy(busy, text = '처리 중입니다…') {
  state.busy = busy;$('#busy-overlay').hidden = !busy;$('#busy-text').textContent = text;renderControls();
}

/** 목적: 필드용 select 옵션 작성 · 입력: 값과 문구 사전 및 선택값 · 출력: 안전한 HTML */
function optionsHtml(values, selected) {
  return Object.entries(values).map(([value,label]) => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

/** 목적: 공통 입력 필드 작성 · 입력: 이름과 라벨, 값, 입력 종류 · 출력: 안전한 HTML */
function field(name, label, value = '', type = 'text', extra = '') {
  return `<label class="field">${escapeHtml(label)}<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${extra}></label>`;
}

/** 목적: 공통 메모 입력 작성 · 입력: 이름과 라벨 및 값 · 출력: 안전한 HTML */
function textArea(name, label, value = '') {
  return `<label class="field">${escapeHtml(label)}<textarea name="${name}" maxlength="5000">${escapeHtml(value)}</textarea></label>`;
}

/** 목적: 현재 사진 정보 탐색 · 입력: 없음 · 출력: 선택된 사진 또는 undefined */
function currentPhoto() {return state.project?.photos.find(photo => photo.id === state.photoId);}

/** 목적: 보기와 대상 선택 상태를 유지하면서 기록 갱신 · 입력: 변경 전 스냅샷 · 출력: 실행 취소 기록과 자동 저장 예약 */
function commitChange(before) {
  if (JSON.stringify(before) === JSON.stringify(state.project)) return;
  state.undo.push(before);if (state.undo.length > 60) state.undo.shift();state.redo = [];state.seq += 1;if (state.saveError?.status !== 409) state.saveError = null;
  clearTimeout(state.saveTimer);state.saveTimer = setTimeout(() => flushSave(),450);renderRecords();renderPhotos();renderControls();draw();
}

/** 목적: 저장·실행 취소 버튼 상태 갱신 · 입력: 없음 · 출력: 상단 및 도구 상태 표시 */
function renderControls() {
  const enabled = Boolean(state.project) && !state.busy;
  ['project-new','project-select','import-button'].forEach(id => {$(`#${id}`).disabled = state.busy;});
  $('#photo-filter').disabled = !enabled;
  ['zoom-in','zoom-out','fit-button'].forEach(id => {$(`#${id}`).disabled = state.busy || !state.image;});
  ['project-edit','upload-button','export-button','new-record'].forEach(id => {$(`#${id}`).disabled = !enabled;});
  $('#photo-edit').disabled = !enabled || !currentPhoto();
  $('#undo-button').disabled = !enabled || !state.undo.length;$('#redo-button').disabled = !enabled || !state.redo.length;
  $('#delete-annotation').disabled = !enabled || !state.annotationId;
  document.querySelectorAll('[data-mode]').forEach(button => {button.disabled = !enabled || !currentPhoto();button.classList.toggle('active',button.dataset.mode === state.mode);});
  $('#save-retry').hidden = !state.saveError || state.saveError.status === 409;
  $('#conflict-reload').hidden = state.saveError?.status !== 409;$('#conflict-copy').hidden = state.saveError?.status !== 409;
  const status = $('#save-status');status.className = '';status.title = '';
  if (state.saveError) {status.textContent = state.saveError.status === 409 ? '다른 창에서 변경됨 · 내 입력 유지 중' : '저장 실패 · 입력 유지 중';status.className = 'error';status.title = state.saveError.message;}
  else if (state.saving) status.textContent = '저장 중…';
  else if (!state.project) status.textContent = '프로젝트를 선택하세요';
  else if (state.seq !== state.savedSeq) status.textContent = '저장 대기…';
  else {status.textContent = '모든 기록 저장됨';status.className = 'saved';}
}

/** 목적: 편집 중 변경도 빠뜨리지 않고 순차 저장 · 입력: 없음 · 출력: 저장 성공 여부 */
async function flushSave() {
  clearTimeout(state.saveTimer);
  if (state.saving) return state.saving;
  if (!state.project || state.savedSeq === state.seq) return true;
  if (state.saveError?.status === 409) return false;
  state.saving = (async () => {
    while (state.project && state.savedSeq !== state.seq) {
      const sequence = state.seq;const payload = clone(state.project);
      try {
        const saved = await api(`/api/projects/${payload.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        state.project.revision = saved.revision;state.project.updated_at = saved.updated_at;mergeCounters(state.project,saved);state.savedSeq = sequence;state.saveError = null;
      } catch (error) {state.saveError = error;toast(error.message,true);return false;}
    }
    return true;
  })();renderControls();
  const result = await state.saving;state.saving = null;renderControls();return result;
}

/** 목적: 프로젝트 목록 읽기 · 입력: 없음 · 출력: 프로젝트 선택 메뉴 갱신 */
async function refreshProjects() {
  const result = await api('/api/projects');
  $('#project-select').innerHTML = '<option value="">프로젝트 선택</option>' + result.projects.map(project => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('');
  $('#project-select').value = state.project?.id || '';
  return result.projects;
}

/** 목적: 프로젝트를 안전하게 전환 · 입력: 프로젝트 ID 또는 이미 읽은 프로젝트 · 출력: 선택 프로젝트 화면 */
async function openProject(projectOrId) {
  if (!(await flushSave())) {$('#project-select').value = state.project?.id || '';return;}
  setBusy(true,'프로젝트를 여는 중…');
  try {
    const project = typeof projectOrId === 'string' ? await api(`/api/projects/${projectOrId}`) : projectOrId;
    state.project = project;state.seq = 0;state.savedSeq = 0;state.undo = [];state.redo = [];state.saveError = null;state.selection = null;state.annotationId = null;state.filter = '';state.draft = null;
    localStorage.setItem('photo-measure-project',project.id);$('#recovery-notice').hidden = !project.recovery_notice;$('#recovery-notice').textContent = project.recovery_notice || '';await refreshProjects();renderAll();await selectPhoto(project.photos[0]?.id || null);
  } catch (error) {toast(error.message,true);} finally {setBusy(false);}
}

/** 목적: 전체 목록과 편집 패널 동기화 · 입력: 없음 · 출력: 화면 갱신 */
function renderAll() {renderPhotos();renderRecords();renderInspector();renderControls();draw();}

/** 목적: 사진 목록과 물체 필터 갱신 · 입력: 없음 · 출력: 사진 카드와 개수 표시 */
function renderPhotos() {
  const project = state.project;$('#photo-count').textContent = project?.photos.length || 0;
  $('#photo-filter').innerHTML = '<option value="">모든 사진</option>' + (project?.objects || []).map(object => `<option value="${object.id}">${escapeHtml(object.label)} · ${escapeHtml(object.name)}</option>`).join('');
  if (!project?.objects.some(object => object.id === state.filter)) state.filter = '';
  $('#photo-filter').value = state.filter;
  const photos = (project?.photos || []).filter(photo => !state.filter || project.annotations.some(annotation => annotation.photo_id === photo.id && (annotation.target_type === 'object' ? annotation.target_id === state.filter : annotation.target_type === 'feature' ? project.features.find(feature => feature.id === annotation.target_id)?.object_id === state.filter : [project.measurements.find(measurement => measurement.id === annotation.target_id)?.from_ref?.object_id,project.measurements.find(measurement => measurement.id === annotation.target_id)?.to_ref?.object_id].includes(state.filter))));
  $('#photo-list').innerHTML = photos.length ? photos.map(photo => {
    const count = project.annotations.filter(annotation => annotation.photo_id === photo.id).length;
    return `<button class="photo-card ${photo.id === state.photoId ? 'active' : ''}" data-photo="${photo.id}" title="${escapeHtml(photo.description || photo.filename)}"><img loading="lazy" src="/api/projects/${project.id}/photos/${photo.id}/image" alt="${escapeHtml(photo.filename)}"><strong>${escapeHtml(photo.filename)}</strong><small><span>${VIEWS[photo.view] || '기타'}</span><span>표시 ${count}개</span></small></button>`;
  }).join('') : `<div class="list-empty">${project?.photos.length ? '이 물체를 표시한 사진이 없습니다.' : '전체 사진과 가까이 찍은 사진을 함께 추가해보세요.'}</div>`;
}

/** 목적: 편집 사진 읽기 · 입력: 사진 ID · 출력: 캔버스 사진과 보기 상태 */
async function selectPhoto(id) {
  cancelGesture();const token = ++state.loadToken;state.photoId = id;state.image = null;state.annotationId = null;state.draft = null;renderPhotos();renderInspector();renderControls();draw();
  const photo = currentPhoto();$('#photo-title').textContent = photo?.filename || '사진을 추가해 시작하세요';$('#photo-view').textContent = photo ? `${VIEWS[photo.view]} · ${photo.description || '사진 설명을 추가할 수 있습니다'}` : '실측 기록';
  $('#image-size').textContent = photo ? `${photo.width.toLocaleString()} × ${photo.height.toLocaleString()} px` : '';
  $('#canvas-empty').hidden = Boolean(photo);
  if (!photo) return;
  try {const image = await loadImage(`/api/projects/${state.project.id}/photos/${photo.id}/image`);if (token !== state.loadToken) return;state.image = image;fitView();renderControls();} catch (error) {toast(error.message,true);}
}

/** 목적: 이미지 로딩 실패를 명확히 전달 · 입력: 이미지 주소 · 출력: 로딩된 Image */
function loadImage(url) {return new Promise((resolve,reject) => {const image = new Image();image.onload = () => resolve(image);image.onerror = () => reject(new Error('사진을 불러오지 못했습니다. 서버 상태를 확인하세요.'));image.src = url;});}

/** 목적: 사진 전체를 화면에 맞춤 · 입력: 없음 · 출력: 보기 배율과 위치 */
function fitView() {if (!state.image) return;const host = $('#canvas-host');const scale = Math.min((host.clientWidth - 50) / state.image.naturalWidth,(host.clientHeight - 50) / state.image.naturalHeight);state.view = {scale:Math.max(.005,scale),x:(host.clientWidth - state.image.naturalWidth * scale) / 2,y:(host.clientHeight - state.image.naturalHeight * scale) / 2};draw();}

/** 목적: 배율과 이동을 반영해 사진 렌더링 · 입력: 없음 · 출력: 캔버스 그림 */
function draw() {
  const canvas = $('#photo-canvas');const host = $('#canvas-host');const ratio = window.devicePixelRatio || 1;
  const width = Math.round(host.clientWidth * ratio);const height = Math.round(host.clientHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {canvas.width = width;canvas.height = height;}
  const ctx = canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,host.clientWidth,host.clientHeight);
  let draft = state.draft;
  if (draft?.preview && ['line','polygon'].includes(draft.shape)) draft = {...draft,points:[...draft.points,draft.preview]};
  const drawingProject = state.gesture?.annotation ? {...state.project,annotations:state.project.annotations.map(annotation => annotation.id === state.gesture.annotation.id ? state.gesture.annotation : annotation)} : state.project;
  if (state.image && drawingProject) drawScene(ctx,state.image,drawingProject,state.photoId,{...state.view,selectedId:state.annotationId,draft});
  $('#zoom-value').textContent = `${Math.round(state.view.scale * 100)}%`;
}

/** 목적: 공통 기록 목록 표시 · 입력: 없음 · 출력: 물체·기준·치수 목록 */
function renderRecords() {
  const project = state.project;['objects','features','measurements'].forEach(type => {$(`#${type}-count`).textContent = project?.[type].length || 0;});
  document.querySelectorAll('[data-tab]').forEach(button => {button.classList.toggle('active',button.dataset.tab === state.tab);button.setAttribute('aria-selected',String(button.dataset.tab === state.tab));});
  $('#new-record').textContent = {objects:'＋ 물체 등록',features:'＋ 기준 등록',measurements:'＋ 치수 기록'}[state.tab];
  const review = project?.measurements.filter(measurement => !measurement.selected_reading_id && measurement.readings.length).length || 0;
  $('#review-count').textContent = review ? `재확인 ${review}건` : '';
  $('#record-list').innerHTML = project?.[state.tab].length ? project[state.tab].map(record => {
    const color = state.tab === 'objects' ? record.color : state.tab === 'features' ? project.objects.find(object => object.id === record.object_id)?.color : '#216da0';
    const value = state.tab === 'measurements' ? measurementValue(record) : '';
    const subtitle = state.tab === 'objects' ? `사진 ${new Set(project.annotations.filter(annotation => annotation.target_type === 'object' && annotation.target_id === record.id).map(annotation => annotation.photo_id)).size}장에 표시` : state.tab === 'features' ? FEATURES[record.kind] : KINDS[record.kind];
    return `<button class="record-row ${state.selection?.type === state.tab && state.selection.id === record.id ? 'active' : ''}" data-record="${record.id}"><span class="record-badge" style="background:${color}">${escapeHtml(record.label)}</span><span class="record-main"><strong>${escapeHtml(record.name || subtitle)}</strong><small>${escapeHtml(subtitle)}</small></span>${value ? `<span class="record-value ${value === '재확인 필요' ? 'warning' : ''}">${escapeHtml(value)}</span>` : ''}</button>`;
  }).join('') : `<div class="list-empty">${{objects:'사진에서 물체 영역을 표시하거나<br>새 물체를 등록하세요.',features:'물체에 속한 구멍·점·면을<br>공통 기준으로 등록하세요.',measurements:'사진에서 두 점을 찍거나<br>숫자만 먼저 기록할 수 있습니다.'}[state.tab]}</div>`;
}

/** 목적: 공통 기록 선택 · 입력: 목록 종류와 대상 ID · 출력: 상세 패널 및 표시 선택 */
function selectRecord(type, id) {state.tab = type;state.selection = {type,id};const targetType = {objects:'object',features:'feature',measurements:'measurement'}[type];state.annotationId = state.project.annotations.find(annotation => annotation.photo_id === state.photoId && annotation.target_type === targetType && annotation.target_id === id)?.id || null;renderRecords();renderInspector();renderControls();draw();}

/** 목적: 상세 패널에 물체 또는 기준 편집 제공 · 입력: 없음 · 출력: 상세 편집 폼 */
function renderInspector() {
  const panel = $('#inspector');const selection = state.selection;const record = selection && state.project?.[selection.type].find(item => item.id === selection.id);
  if (!record) {panel.innerHTML = '<div class="inspector-empty">위 목록 또는 사진의 표시를 선택하면<br>상세 정보를 수정할 수 있습니다.</div>';return;}
  const count = state.project.annotations.filter(annotation => annotation.target_id === record.id).length;
  if (selection.type === 'measurements') {renderMeasurementInspector(record,count);return;}
  panel.innerHTML = `<div class="inspector-title"><span class="record-badge" style="background:${selection.type === 'objects' ? record.color : state.project.objects.find(object => object.id === record.object_id)?.color}">${escapeHtml(record.label)}</span><strong>${selection.type === 'objects' ? '물체 정보' : FEATURES[record.kind]}</strong></div><form id="record-form">${field('name','이름',record.name,'text','required maxlength="200"')}${textArea('description','설명',record.description)}${selection.type === 'objects' ? field('color','표시 색상',record.color,'color') : `<div class="small-note">소속 물체: ${escapeHtml(state.project.objects.find(object => object.id === record.object_id)?.label)}<br>다른 사진에도 같은 번호로 연결하세요.</div>`}<button type="submit" class="primary">정보 저장</button><div class="inspector-error" role="alert"></div></form><p class="annotation-note">사진 표시 ${count}개 · 같은 번호의 모든 사진에 반영됩니다.</p><button id="mark-record">${selection.type === 'objects' ? '현재 사진에 영역 표시' : '현재 사진에 기준 표시'}</button><br><button id="delete-record" class="danger-link">${selection.type === 'objects' ? '물체' : '기준'} 기록 삭제…</button>`;
  $('#record-form').onsubmit = event => {event.preventDefault();if (state.busy) return;const data = new FormData(event.currentTarget);const name = data.get('name').trim();if (!name) {event.currentTarget.querySelector('.inspector-error').textContent = '이름을 입력하세요. 공백만 입력할 수 없습니다.';return;}const before = clone(state.project);record.name = name;record.description = data.get('description').trim();if (selection.type === 'objects') record.color = data.get('color');commitChange(before);renderInspector();};
  $('#mark-record').onclick = () => selection.type === 'objects' ? markObjectRegion() : setMode(record.kind === 'plane' ? 'plane' : 'point',true);
  $('#delete-record').onclick = () => deleteRecord(selection.type,record.id);
  if (selection.type === 'objects') renderRotationControls();
}

/** 목적: 현재 사진에서 선택한 영역의 회전 입력 제공 · 입력: 없음 · 출력: 각도 입력과 빠른 회전 버튼 */
function renderRotationControls() {
  const annotation = state.project.annotations.find(item => item.id === state.annotationId && item.photo_id === state.photoId);
  if (!rotationHandle(annotation)) return;
  $('#inspector').insertAdjacentHTML('beforeend',`<section class="rotation-controls"><h3>선택 영역 회전</h3><p class="small-note">↻ 핸들을 드래그하거나 각도를 입력하세요.<br>양수는 시계 방향 · 현재 사진의 영역에 적용</p><form id="rotation-form"><label class="field">회전할 각도 (°)<input name="degrees" type="number" value="15" min="-360" max="360" step="any" required></label><div class="rotation-buttons"><button type="button" id="rotate-left">↶ −15°</button><button type="button" id="rotate-right">↷ +15°</button><button type="submit">각도 적용</button></div><p id="rotation-feedback" class="small-note" role="status">Shift를 누르고 드래그하면 15° 간격으로 회전합니다.</p></form></section>`);
  $('#rotation-form').onsubmit = event => {event.preventDefault();applyRegionRotation(Number(new FormData(event.currentTarget).get('degrees')));};
  $('#rotate-left').onclick = () => applyRegionRotation(-15);
  $('#rotate-right').onclick = () => applyRegionRotation(15);
}

/** 목적: 입력 각도만큼 영역을 회전하고 실행 취소·저장에 반영 · 입력: 시계 방향 각도 · 출력: 영역 좌표 갱신 또는 경계 안내 */
function applyRegionRotation(degrees) {
  if (state.busy || !state.image) return;
  if (!Number.isFinite(degrees) || Math.abs(degrees) > 360) {toast('회전 각도는 −360°~360° 사이의 숫자를 입력하세요.',true);return;}
  const index = state.project.annotations.findIndex(item => item.id === state.annotationId && item.photo_id === state.photoId);
  if (index < 0) return;
  const rotated = rotateRegion(state.project.annotations[index],degrees,currentPhoto());
  if (!rotated) {toast('회전한 영역이 사진 밖으로 나갑니다. 영역을 안쪽으로 이동하거나 각도를 줄이세요.',true);return;}
  cancelGesture();const before = clone(state.project);state.project.annotations[index] = rotated;commitChange(before);renderInspector();
}

/** 목적: 공통 물체·기준 선택 옵션 생성 · 입력: 현재 참조 · 출력: select 옵션 */
function refOptions(ref) {
  let html = '<option value="">직접 설명 입력</option>';
  state.project.objects.forEach(object => {html += `<option value="object:${object.id}" ${ref?.object_id === object.id && !ref?.feature_id ? 'selected' : ''}>${escapeHtml(object.label)} · ${escapeHtml(object.name)}</option>`;state.project.features.filter(feature => feature.object_id === object.id).forEach(feature => {html += `<option value="feature:${feature.id}" ${ref?.feature_id === feature.id ? 'selected' : ''}>↳ ${escapeHtml(feature.label)} · ${escapeHtml(feature.name)}</option>`;});});
  return html;
}

/** 목적: 치수 시작·끝 기준 폼 생성 · 입력: 필드 접두사와 라벨 및 참조 · 출력: HTML */
function refFields(prefix, title, ref = {}) {return `<div class="ref-group"><h3>${title}</h3><label class="field">물체 또는 기준<select name="${prefix}_ref">${refOptions(ref)}</select></label>${field(`${prefix}_text`,'정확히 어느 부분인가요?',ref.text || '','text','maxlength="1000" placeholder="예: 윗면, 구멍 중심, 원단 표면"')}</div>`;}

/** 목적: 치수 대상 폼 생성 · 입력: 기존 치수 또는 기본값 · 출력: HTML */
function measurementFields(record = {}) {
  return `${field('name','치수 이름',record.name || '','text','required maxlength="200" placeholder="예: 고정판 A 폭"')}<label class="field">치수 종류<select name="kind">${optionsHtml(KINDS,record.kind || 'length')}</select></label>${refFields('from','시작 기준',record.from_ref)}${refFields('to','끝 기준',record.to_ref)}<label class="field" id="direction-field">기준면에서의 방향<select name="direction">${optionsHtml({none:'해당 없음',up:'위 (+)',down:'아래 (−)'},record.direction || 'none')}</select><small>기준면 대비 높이를 기록할 때 위·아래를 지정하세요.</small></label>`;
}

/** 목적: 측정 결과 폼 생성 · 입력: 이전 측정 결과 · 출력: HTML */
function readingFields(reading = {}) {
  return `<div class="form-row"><label class="field">측정 상태<select name="status">${optionsHtml(STATUSES,reading.status || 'measured')}</select></label><label class="field">단위<select name="unit">${optionsHtml({mm:'mm',cm:'cm'},reading.unit || 'mm')}</select></label></div><div class="form-row">${field('value','측정값',reading.value ?? '','number','min="0" step="any" placeholder="직접 잰 값"')}${field('error','측정 오차 (선택)',reading.error ?? '','number','min="0" step="any" placeholder="예: 1"')}</div>${field('tool','측정 도구 (선택)',reading.tool || '','text','maxlength="200" placeholder="예: 줄자, 버니어 캘리퍼스"')}${textArea('note','측정 메모',reading.note || '')}<div class="small-note">오차는 측정의 불확실성입니다. 제작 시 허용공차와 구분해 기록하세요.</div>`;
}

/** 목적: 입력한 시작·끝 참조를 구조화 · 입력: 폼 데이터와 접두사 · 출력: 물체·기준·설명 참조 */
function parseRef(data, prefix) {const value = data.get(`${prefix}_ref`) || '';const [type,id] = value.split(':');const feature = type === 'feature' && state.project.features.find(item => item.id === id);return {object_id:type === 'object' ? id : feature?.object_id || null,feature_id:feature?.id || null,text:(data.get(`${prefix}_text`) || '').trim()};}

/** 목적: 치수 정의 입력 검증 · 입력: 폼 데이터 · 출력: 치수 필드 또는 오류 */
function parseMeasurement(data) {
  const value = {name:data.get('name').trim(),kind:data.get('kind'),from_ref:parseRef(data,'from'),to_ref:parseRef(data,'to'),direction:data.get('kind') === 'offset' ? data.get('direction') : 'none'};
  if (!value.name) throw new Error('어떤 치수인지 이름을 입력하세요.');
  if (value.kind === 'offset' && value.direction === 'none') throw new Error('기준면에서 위인지 아래인지 선택하세요.');
  for (const ref of [value.from_ref,value.to_ref]) if (!ref.object_id && !ref.text) throw new Error('시작과 끝의 물체를 선택하거나 기준 설명을 입력하세요.');
  return value;
}

/** 목적: 실측값 입력을 검증하고 mm로 정규화 · 입력: 폼 데이터와 치수 종류 · 출력: 새 측정 결과 */
function parseReading(data, kind) {
  const unknown = data.get('status') === 'unknown';const rawValue = data.get('value');const rawError = data.get('error');const value = unknown ? null : Number(rawValue);const error = rawError === '' || unknown ? null : Number(rawError);
  if (!unknown && (rawValue === '' || !Number.isFinite(value) || value < 0 || (value === 0 && !['gap','offset'].includes(kind)))) throw new Error('유효한 측정값을 입력하세요. 길이·지름·구멍 간격은 0보다 커야 합니다.');
  if (error !== null && (!Number.isFinite(error) || error < 0)) throw new Error('측정 오차는 0 이상의 숫자로 입력하세요.');
  const factor = data.get('unit') === 'cm' ? 10 : 1;
  if ((value !== null && !Number.isFinite(value * factor)) || (error !== null && !Number.isFinite(error * factor))) throw new Error('mm로 환산할 수 있는 범위의 숫자를 입력하세요.');
  return {id:uid(),value,unit:data.get('unit'),status:data.get('status'),error,tool:(data.get('tool') || '').trim(),note:(data.get('note') || '').trim(),created_at:new Date().toISOString(),value_mm:value === null ? null : value * factor,error_mm:error === null ? null : error * factor};
}

/** 목적: 치수 상세·측정 이력 표시 · 입력: 치수와 사진 표시 개수 · 출력: 편집 패널 */
function renderMeasurementInspector(record, count) {
  $('#inspector').innerHTML = `<div class="inspector-title"><span class="record-badge" style="background:#216da0">${escapeHtml(record.label)}</span><strong>${escapeHtml(measurementValue(record))}</strong></div><form id="record-form">${measurementFields(record)}<button type="submit" class="primary">치수 기준 저장</button><div class="inspector-error" role="alert"></div></form><h3>측정 기록 ${record.readings.length}개</h3>${!record.selected_reading_id && record.readings.length ? '<div class="review-alert">서로 다른 값이 기록되어 있습니다. 현장을 확인한 뒤 사용할 값을 선택하세요.</div>' : ''}<div id="reading-list">${record.readings.map(reading => `<div class="reading-card ${reading.id === record.selected_reading_id ? 'chosen' : ''}"><strong>${escapeHtml(reading.value === null ? '미측정' : `${reading.value} ${reading.unit}${reading.error === null ? '' : ` ±${reading.error} ${reading.unit}`}`)}</strong><small>${STATUSES[reading.status]} · ${escapeHtml(reading.tool || '도구 미기록')}<br>${escapeHtml(reading.note)}<br>${new Date(reading.created_at).toLocaleString('ko-KR')}</small><button data-adopt="${reading.id}">${reading.id === record.selected_reading_id ? '✓ 채택한 값' : '이 값 채택'}</button><button data-edit-reading="${reading.id}">수정</button></div>`).join('')}</div><button id="add-reading">＋ 재측정값 추가</button><h3>사진 연결</h3><p class="annotation-note">사진 표시 ${count}개 · 다른 각도에서도 ${escapeHtml(record.label)}을 연결하세요.</p><button id="mark-record">현재 사진에 치수선 표시</button><br><button id="delete-record" class="danger-link">치수와 연결된 사진 표시 삭제…</button>`;
  $('#record-form').onsubmit = event => {event.preventDefault();if (state.busy) return;try {const value = parseMeasurement(new FormData(event.currentTarget));if (!['gap','offset'].includes(value.kind) && record.readings.some(reading => reading.status !== 'unknown' && reading.value === 0)) throw new Error('0으로 기록한 측정값이 있습니다. 이 종류의 치수는 0보다 커야 하므로 측정 기록을 먼저 수정하세요.');const before = clone(state.project);Object.assign(record,value);commitChange(before);renderInspector();} catch(error) {event.currentTarget.querySelector('.inspector-error').textContent = error.message;}};
  $('#reading-list').onclick = event => {const adopt = event.target.closest('[data-adopt]');const edit = event.target.closest('[data-edit-reading]');if (adopt) {const before = clone(state.project);record.selected_reading_id = adopt.dataset.adopt;commitChange(before);renderInspector();}if (edit) readingDialog(record,edit.dataset.editReading);};
  $('#add-reading').onclick = () => readingDialog(record);$('#mark-record').onclick = () => setMode('measure',true);$('#delete-record').onclick = () => deleteRecord('measurements',record.id);
}

/** 목적: 재측정값을 이력에 추가 · 입력: 치수와 새 측정 결과 · 출력: 채택 상태와 이력 갱신 */
function appendReading(record, reading) {
  const previous = record.readings.find(item => item.id === record.selected_reading_id);
  record.readings.push(reading);
  if (record.readings.length === 1) record.selected_reading_id = reading.id;
  else if (reading.status === 'unknown' && previous) record.selected_reading_id = previous.id;
  else if (reading.status !== 'unknown' && previous?.status === 'unknown') record.selected_reading_id = reading.id;
  else if (record.selected_reading_id && previous?.value_mm !== null && reading.value_mm !== null && Math.abs(previous.value_mm - reading.value_mm) <= Number.EPSILON * Math.max(1,Math.abs(previous.value_mm),Math.abs(reading.value_mm)) * 8 && previous?.status !== 'unknown' && reading.status !== 'unknown') record.selected_reading_id = reading.id;
  else record.selected_reading_id = null;
}

/** 목적: 측정 결과 입력과 이력 수정 · 입력: 치수와 선택적 이력 ID · 출력: 측정 기록 대화상자 */
function readingDialog(record, readingId = null) {
  const previous = record.readings.find(item => item.id === readingId);
  openDialog(`${record.label} · ${previous ? '측정 기록 수정' : '재측정값 추가'}`,`<p class="dialog-intro">${escapeHtml(record.name)} · ${KINDS[record.kind]}<br>재측정한 값은 이전 값과 함께 보관합니다.</p>${readingFields(previous)}`,data => {const reading = parseReading(data,record.kind);const before = clone(state.project);if (previous) {reading.id = previous.id;reading.created_at = previous.created_at;record.readings[record.readings.findIndex(item => item.id === previous.id)] = reading;if (record.readings.length > 1 && record.readings.some(item => item.value_mm !== reading.value_mm)) record.selected_reading_id = null;} else appendReading(record,reading);commitChange(before);renderInspector();});
}

/** 목적: 공통 입력 대화상자 열기 · 입력: 제목과 HTML 및 처리 함수 · 출력: 편집 대화상자 */
function openDialog(title, content, handler) {
  if (state.busy) return;$('#dialog-title').textContent = title;$('#dialog-content').innerHTML = content;$('#dialog-error').textContent = '';dialogHandler = handler;$('#edit-dialog').showModal();
}

/** 목적: 대화상자 종료와 임시 그리기 정리 · 입력: 없음 · 출력: 대화상자 닫기 */
function closeDialog() {$('#edit-dialog').close();dialogHandler = null;state.draft = null;draw();}

/** 목적: 검증된 팝업 입력을 중복 없이 확정하고 즉시 저장 · 입력: 폼 제출 이벤트 · 출력: 기록 저장 또는 입력 오류 */
async function submitDialog(event) {
  event.preventDefault();const submit = event.currentTarget.querySelector('[type=submit]');
  if (!dialogHandler || submit.disabled || state.busy) return;
  submit.disabled = true;
  try {await dialogHandler(new FormData(event.currentTarget));closeDialog();await flushSave();}
  catch(error) {$('#dialog-error').textContent = error.message;}
  finally {submit.disabled = false;}
}

/** 목적: 새 프로젝트 등록 또는 이름·설명 수정 · 입력: 수정 여부 · 출력: 프로젝트 입력 대화상자 */
function projectDialog(edit = false) {
  if (edit && !state.project) return;
  openDialog(edit ? '프로젝트 이름과 설명' : '새 실측 프로젝트',`${field('name','프로젝트 이름',edit ? state.project.name : '','text','required maxlength="200" placeholder="예: 다이 컷팅 머신 카메라 설치"')}${textArea('description','무엇을 모델링하나요?',edit ? state.project.description : '')}`,async data => {const name = data.get('name').trim();if (!name) throw new Error('프로젝트 이름을 입력하세요.');if (edit) {const before = clone(state.project);state.project.name = name;state.project.description = data.get('description').trim();commitChange(before);if (await flushSave()) await refreshProjects();} else {const project = await api('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,description:data.get('description').trim()})});await openProject(project);}});
}

/** 목적: 프로젝트 안에서 재사용하지 않는 물체 번호 발급 · 입력: 없음 · 출력: A부터 시작하는 공통 번호 */
function nextObjectLabel() {state.project.counters.object += 1;let number = state.project.counters.object;let label = '';while (number > 0) {number -= 1;label = String.fromCharCode(65 + number % 26) + label;number = Math.floor(number / 26);}return label;}

/** 목적: 표시를 현재 사진에 연결 · 입력: 대상 종류와 ID 및 도형 · 출력: 새 표시 */
function addAnnotation(type, id, geometry) {if (!geometry || !currentPhoto()) return null;const annotation = {id:uid(),photo_id:state.photoId,target_type:type,target_id:id,shape:geometry.shape,points:geometry.points.map(point => [...point])};annotation.label_position = clampPoint(labelPosition(annotation));state.project.annotations.push(annotation);state.annotationId = annotation.id;return annotation;}

/** 목적: 기존 물체를 현재 사진에 표시할 영역 모양 선택 · 입력: 현재 물체 선택 · 출력: 사각형 또는 다각형 연결 그리기 */
function markObjectRegion() {
  if (state.busy || state.selection?.type !== 'objects') return;
  const object = state.project?.objects.find(item => item.id === state.selection.id);
  if (!object) return;
  if (!currentPhoto() || !state.image) {toast('영역을 표시할 사진을 먼저 선택하세요. 사진을 불러온 뒤 그릴 수 있습니다.');return;}
  const dialog = $('#region-dialog');if (dialog.open) return;
  $('#region-message').textContent = `${object.label} · ${object.name}\n사각형은 드래그해서 그립니다.\n다각형은 꼭짓점을 클릭한 뒤 Enter 또는 더블클릭으로 완료합니다.`;
  $('#region-close').onclick = () => dialog.close();$('#region-cancel').onclick = () => dialog.close();
  $('#region-rect').onclick = () => {dialog.close();setMode('rect',true);};
  $('#region-polygon').onclick = () => {dialog.close();setMode('polygon',true);};
  dialog.showModal();
}

/** 목적: 물체 새 등록 또는 기존 물체 사진 연결 · 입력: 선택적 도형 · 출력: 물체 선택 대화상자 */
function objectDialog(geometry = null) {
  if (!state.project) return;
  const selected = state.linkTarget?.type === 'objects' ? state.linkTarget.id : '';
  openDialog(geometry ? '이 영역은 어느 물체인가요?' : '새 물체 등록',`${geometry ? `<label class="field">물체 연결<select name="existing" id="existing-target"><option value="">＋ 새 물체 등록</option>${state.project.objects.map(object => `<option value="${object.id}" ${selected === object.id ? 'selected' : ''}>${escapeHtml(object.label)} · ${escapeHtml(object.name)}</option>`).join('')}</select><small>다른 사진의 같은 물체라면 기존 번호를 선택하세요.</small></label>` : ''}<div id="new-target-fields">${field('name','물체 이름','','text','maxlength="200" placeholder="예: 바깥쪽 검은 고정판"')}${textArea('description','물체 설명')}</div>`,data => {const before = clone(state.project);let object = state.project.objects.find(item => item.id === data.get('existing'));if (!object) {const name = data.get('name').trim();if (!name) throw new Error('물체 이름을 입력하세요.');const label = nextObjectLabel();object = {id:uid(),label,name,description:data.get('description').trim(),color:COLORS[(state.project.counters.object - 1) % COLORS.length]};state.project.objects.push(object);}addAnnotation('object',object.id,geometry);state.selection = {type:'objects',id:object.id};state.tab = 'objects';commitChange(before);renderInspector();setMode('select');});
  configureExistingFields();
}

/** 목적: 기존 대상을 선택하면 새 대상 입력 감추기 · 입력: 없음 · 출력: 대화상자 필드 상태 */
function configureExistingFields() {const select = $('#existing-target');if (!select) return;const update = () => {const container = $('#new-target-fields');container.hidden = Boolean(select.value);container.querySelectorAll('input,textarea,select').forEach(input => {input.disabled = Boolean(select.value);});};select.onchange = update;update();}

/** 목적: 물체에 속한 기준점·구멍·면 등록 또는 연결 · 입력: 선택적 도형과 기준 종류 · 출력: 기준 대화상자 */
function featureDialog(geometry = null, kind = 'hole') {
  if (!state.project?.objects.length) {toast('먼저 물체를 등록하세요. 기준은 물체에 속합니다.');objectDialog();return;}
  const selected = state.linkTarget?.type === 'features' ? state.linkTarget.id : '';
  const candidates = state.project.features.filter(feature => !geometry || (geometry.shape === 'line' ? feature.kind === 'plane' : feature.kind !== 'plane'));
  const owner = state.selection?.type === 'objects' ? state.selection.id : state.project.features.find(feature => feature.id === selected)?.object_id || state.project.objects[0].id;
  openDialog(geometry ? '공통 기준을 연결하세요' : '구멍·점·면 등록',`${geometry ? `<label class="field">기준 연결<select name="existing" id="existing-target"><option value="">＋ 새 기준 등록</option>${candidates.map(feature => `<option value="${feature.id}" ${feature.id === selected ? 'selected' : ''}>${escapeHtml(feature.label)} · ${escapeHtml(feature.name)}</option>`).join('')}</select></label>` : ''}<div id="new-target-fields"><label class="field">소속 물체<select name="object_id">${state.project.objects.map(object => `<option value="${object.id}" ${object.id === owner ? 'selected' : ''}>${escapeHtml(object.label)} · ${escapeHtml(object.name)}</option>`).join('')}</select></label><label class="field">기준 종류<select name="kind">${optionsHtml(geometry?.shape === 'line' ? {plane:FEATURES.plane} : geometry ? {hole:FEATURES.hole,point:FEATURES.point} : FEATURES,kind)}</select></label>${field('name','기준 이름','','text','maxlength="200" placeholder="예: 왼쪽 위 구멍 중심"')}${textArea('description','기준 설명')}</div>`,data => {const before = clone(state.project);let feature = state.project.features.find(item => item.id === data.get('existing'));if (!feature) {const name = data.get('name').trim();if (!name) throw new Error('기준 이름을 입력하세요.');const object = state.project.objects.find(item => item.id === data.get('object_id'));const featureKind = data.get('kind');const key = `${object.id}:${featureKind}`;const counter = (state.project.counters.features[key] || 0) + 1;state.project.counters.features[key] = counter;feature = {id:uid(),object_id:object.id,label:`${object.label}-${{hole:'H',point:'P',plane:'F'}[featureKind]}${counter}`,kind:featureKind,name,description:data.get('description').trim()};state.project.features.push(feature);}addAnnotation('feature',feature.id,geometry);state.selection = {type:'features',id:feature.id};state.tab = 'features';commitChange(before);renderInspector();setMode('select');});configureExistingFields();
}

/** 목적: 치수선과 실측 기록을 새 등록하거나 기존 치수 연결 · 입력: 선택적 도형 · 출력: 치수 대화상자 */
function measurementDialog(geometry = null) {
  if (!state.project) return;
  const selected = state.linkTarget?.type === 'measurements' ? state.linkTarget.id : '';
  openDialog(geometry ? '실제로 측정한 치수를 기록하세요' : '치수 먼저 기록하기',`${geometry ? `<label class="field">치수 연결<select name="existing" id="existing-target"><option value="">＋ 새 치수 기록</option>${state.project.measurements.map(measurement => `<option value="${measurement.id}" ${measurement.id === selected ? 'selected' : ''}>${escapeHtml(measurement.label)} · ${escapeHtml(measurement.name)}</option>`).join('')}</select><small>같은 치수를 다른 사진에 표시하려면 기존 번호를 선택하세요.</small></label>` : '<p class="dialog-intro">사진에서 끝점이 보이지 않아도 기준과 수치를 먼저 기록할 수 있습니다.</p>'}<div id="new-target-fields">${measurementFields()}<h3>측정값</h3>${readingFields()}</div><div id="reuse-measurement-note" class="segmented-note" hidden>기존 치수선만 이 사진에 연결합니다. 재측정한 값은 오른쪽 상세 정보에서 추가할 수 있습니다.</div>`,data => {const before = clone(state.project);let measurement = state.project.measurements.find(item => item.id === data.get('existing'));if (!measurement) {const value = parseMeasurement(data);const reading = parseReading(data,value.kind);state.project.counters.measurement += 1;measurement = {id:uid(),label:`M${String(state.project.counters.measurement).padStart(2,'0')}`,...value,readings:[reading],selected_reading_id:reading.id};state.project.measurements.push(measurement);}addAnnotation('measurement',measurement.id,geometry);state.selection = {type:'measurements',id:measurement.id};state.tab = 'measurements';commitChange(before);renderInspector();setMode('select');});configureExistingFields();const select = $('#existing-target');if (select) {const original = select.onchange;select.onchange = () => {original();$('#reuse-measurement-note').hidden = !select.value;};select.onchange();}
}

/** 목적: 사진 방향과 설명 수정 · 입력: 없음 · 출력: 사진 정보 대화상자 */
function photoDialog() {const photo = currentPhoto();if (!photo) return;openDialog('사진 정보',`<p class="dialog-intro">${escapeHtml(photo.filename)} · ${photo.width} × ${photo.height}</p><label class="field">촬영 방향<select name="view">${optionsHtml(VIEWS,photo.view)}</select></label>${textArea('description','보이는 부분과 촬영 방향 설명',photo.description)}`,data => {const before = clone(state.project);photo.view = data.get('view');photo.description = data.get('description').trim();commitChange(before);$('#photo-view').textContent = `${VIEWS[photo.view]} · ${photo.description || '사진 설명을 추가할 수 있습니다'}`;});}

/** 목적: 삭제할 기준의 정체를 치수 설명에 보존 · 입력: 치수 참조와 삭제 기록 · 출력: 삭제 근거가 포함된 설명 */
function deletedRefDescription(ref, record) {const feature = state.project.features.find(item => item.id === ref.feature_id);const object = state.project.objects.find(item => item.id === ref.object_id);return `[삭제된 기준: ${feature?.label || object?.label || record.label} ${feature?.name || object?.name || record.name}] ${ref.text || ''}`;}

/** 목적: 연결 변경 내용을 앱 안에서 확인 · 입력: 설명·버튼 문구·제목 · 출력: 명시적으로 선택한 진행 여부 */
function confirmAction(message, actionLabel, title) {
  const dialog = $('#confirm-dialog');if (dialog.open || state.busy) return Promise.resolve(false);
  $('#confirm-title').textContent = title;$('#confirm-message').textContent = message;$('#confirm-accept').textContent = actionLabel;dialog.returnValue = 'cancel';
  return new Promise(resolve => {dialog.onclose = () => resolve(dialog.returnValue === 'accept');$('#confirm-cancel').onclick = () => dialog.close('cancel');$('#confirm-accept').onclick = () => dialog.close('accept');dialog.showModal();});
}

/** 목적: 참조 관계를 알리고 공통 기록을 안전하게 삭제 · 입력: 기록 종류와 ID · 출력: 관련 표시 정리와 치수 기준 설명 보존 */
async function deleteRecord(type, id) {
  if (state.busy) return;const record = state.project[type].find(item => item.id === id);if (!record) return;
  const featureIds = type === 'objects' ? state.project.features.filter(feature => feature.object_id === id).map(feature => feature.id) : type === 'features' ? [id] : [];
  const affected = state.project.measurements.filter(measurement => [measurement.from_ref,measurement.to_ref].some(ref => ref.object_id === id || featureIds.includes(ref.feature_id)));
  const annotationIds = state.project.annotations.filter(annotation => annotation.target_id === id || featureIds.includes(annotation.target_id)).map(annotation => annotation.id);
  if (affected.some(measurement => [measurement.from_ref,measurement.to_ref].some(ref => (ref.object_id === id || featureIds.includes(ref.feature_id)) && deletedRefDescription(ref,record).length > 1000))) {toast('연결된 치수의 기준 설명이 너무 길어 삭제 근거를 덧붙일 수 없습니다. 해당 치수의 기준 설명을 줄인 뒤 다시 삭제하세요.',true);return;}
  if (!(await confirmAction(`${record.label} · ${record.name} 기록을 삭제할까요?\n\n연결된 사진 표시 ${annotationIds.length}개${type === 'objects' ? `와 하위 기준 ${featureIds.length}개` : ''}가 삭제됩니다.${affected.length ? `\n치수 ${affected.length}개의 해당 기준은 이름을 설명으로 남기고 연결을 해제합니다. 현장을 다시 확인하세요.` : ''}\n실행 취소로 되돌릴 수 있습니다.`, '기록 삭제', '연결된 기록 삭제 확인'))) return;
  const before = clone(state.project);
  affected.forEach(measurement => {for (const ref of [measurement.from_ref,measurement.to_ref]) {if (ref.object_id === id || featureIds.includes(ref.feature_id)) {ref.text = deletedRefDescription(ref,record);if (ref.object_id === id) ref.object_id = null;ref.feature_id = null;}}measurement.selected_reading_id = null;});
  state.project[type] = state.project[type].filter(item => item.id !== id);if (type === 'objects') state.project.features = state.project.features.filter(feature => !featureIds.includes(feature.id));
  state.project.annotations = state.project.annotations.filter(annotation => !annotationIds.includes(annotation.id));state.selection = null;state.annotationId = null;commitChange(before);renderInspector();
}

/** 목적: 선택한 사진 표시만 삭제하고 공통 실측 기록 유지 · 입력: 없음 · 출력: 표시 삭제 */
function deleteAnnotation() {if (!state.annotationId || state.busy) return;const before = clone(state.project);state.project.annotations = state.project.annotations.filter(annotation => annotation.id !== state.annotationId);state.annotationId = null;commitChange(before);toast('이 사진의 표시를 삭제했습니다. 공통 기록은 목록에 남아 있습니다.');}

/** 목적: 실행 취소 또는 다시 실행하되 최신 서버 버전 유지 · 입력: 다시 실행 여부 · 출력: 이전 편집 상태 복원 */
function undoRedo(redo = false) {
  if (!state.project || state.busy) return;const source = redo ? state.redo : state.undo;const target = redo ? state.undo : state.redo;if (!source.length) return;
  target.push(clone(state.project));const restored = source.pop();restored.revision = state.project.revision;restored.updated_at = state.project.updated_at;mergeCounters(restored,state.project);state.project = restored;state.seq += 1;state.selection = null;state.annotationId = null;state.draft = null;clearTimeout(state.saveTimer);state.saveTimer = setTimeout(() => flushSave(),450);renderAll();
}

/** 목적: 취소 후에도 이미 발급한 번호를 다시 사용하지 않기 · 입력: 대상 프로젝트와 이전 번호 상태 · 출력: 순번의 최댓값 보존 */
function mergeCounters(target, source) {target.counters.object = Math.max(target.counters.object,source.counters.object);target.counters.measurement = Math.max(target.counters.measurement,source.counters.measurement);Object.entries(source.counters.features).forEach(([key,value]) => {target.counters.features[key] = Math.max(target.counters.features[key] || 0,value);});}

/** 목적: 사진 표시 도구 선택 · 입력: 도구 이름과 선택 기록 재사용 여부 · 출력: 도구와 안내 갱신 */
function setMode(mode, reuse = false) {cancelGesture();state.mode = mode;state.linkTarget = reuse ? clone(state.selection) : null;state.draft = null;$('#tool-help').textContent = `${HELP[mode]} · 가운데 버튼 드래그로 사진 이동${reuse && state.selection ? ' · 선택한 공통 기록에 연결합니다.' : ''}`;$('#photo-canvas').style.cursor = mode === 'select' ? 'default' : 'crosshair';renderControls();draw();}

/** 목적: 저장 자료와 분리된 미확정 드래그 폐기 · 입력: 없음 · 출력: 조작 상태 해제 */
function cancelGesture() {if (state.gesture?.kind === 'rotate') {const feedback = $('#rotation-feedback');if (feedback) feedback.textContent = 'Shift를 누르고 드래그하면 15° 간격으로 회전합니다.';}if (state.gesture?.middle) $('#photo-canvas').style.cursor = state.mode === 'select' ? 'default' : 'crosshair';state.gesture = null;}

/** 목적: 가운데 버튼의 브라우저 자동 스크롤 차단 · 입력: 마우스 이벤트 · 출력: 가운데 버튼 기본 동작 취소 */
function preventMiddleDefault(event) {if (event.button === 1) event.preventDefault();}

/** 목적: 포인터 취소 시 사진 이동 중의 미완성 도형 보존 · 입력: 없음 · 출력: 조작 해제·커서 복구·미리보기 갱신 */
function cancelPointerGesture() {const panning = state.gesture?.kind === 'pan';cancelGesture();if (!panning) state.draft = null;draw();}

/** 목적: 포인터 위치를 원본 사진 좌표로 변환 · 입력: 포인터 이벤트 · 출력: 화면 및 사진 좌표 */
function eventPoint(event) {const rect = $('#photo-canvas').getBoundingClientRect();const screen = [event.clientX - rect.left,event.clientY - rect.top];return {screen,point:[(screen[0] - state.view.x) / state.view.scale,(screen[1] - state.view.y) / state.view.scale]};}

/** 목적: 사진 경계 밖으로 좌표가 나가지 않게 제한 · 입력: 사진 좌표 · 출력: 사진 내부 좌표 */
function clampPoint(point) {const photo = currentPhoto();return [Math.max(0,Math.min(photo.width,point[0])),Math.max(0,Math.min(photo.height,point[1]))];}

/** 목적: 점과 선분 사이 선택 거리 계산 · 입력: 점과 선분 양끝 · 출력: 사진 좌표 거리 */
function segmentDistance(point, start, end) {const dx = end[0] - start[0];const dy = end[1] - start[1];const denominator = dx * dx + dy * dy;const t = denominator ? Math.max(0,Math.min(1,((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator)) : 0;return Math.hypot(point[0] - start[0] - t * dx,point[1] - start[1] - t * dy);}

/** 목적: 다각형 내부 선택 판정 · 입력: 사진 좌표와 꼭짓점 목록 · 출력: 내부 여부 */
function insidePolygon(point, points) {let inside = false;for (let i = 0,j = points.length - 1;i < points.length;j = i++) {const [xi,yi] = points[i];const [xj,yj] = points[j];if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;}return inside;}

/** 목적: 사진에서 조작할 표시·라벨·꼭짓점 탐색 · 입력: 사진 좌표 · 출력: 대상 표시와 조작 종류 */
function hitTest(point) {
  const tolerance = 9 / state.view.scale;const annotations = state.project.annotations.filter(annotation => annotation.photo_id === state.photoId).reverse();
  const selected = annotations.find(annotation => annotation.id === state.annotationId);
  const handle = selected && rotationHandle(selected,1 / state.view.scale);
  if (handle && Math.hypot(handle.point[0] - point[0],handle.point[1] - point[1]) < tolerance * 1.4) return {annotation:selected,kind:'rotate',center:handle.center,startAngle:Math.atan2(point[1] - handle.center[1],point[0] - handle.center[0])};
  if (selected) {const index = selected.points.findIndex(vertex => Math.hypot(vertex[0] - point[0],vertex[1] - point[1]) < tolerance);if (index >= 0) return {annotation:selected,kind:'vertex',index};}
  for (const annotation of annotations) {
    const {x,y,width,height} = labelLayout($('#photo-canvas').getContext('2d'),state.image,state.project,annotation,1 / state.view.scale);
    if (point[0] >= x && point[0] <= x + width && point[1] >= y - height && point[1] <= y) return {annotation,kind:'label'};
  }
  for (const annotation of annotations) {
    const points = annotation.points;
    if (annotation.shape === 'point' && Math.hypot(point[0] - points[0][0],point[1] - points[0][1]) < tolerance * 1.5) return {annotation,kind:'move'};
    if (annotation.shape === 'line' && segmentDistance(point,points[0],points[1]) < tolerance) return {annotation,kind:'move'};
    if (annotation.shape === 'rect' && point[0] >= Math.min(points[0][0],points[1][0]) && point[0] <= Math.max(points[0][0],points[1][0]) && point[1] >= Math.min(points[0][1],points[1][1]) && point[1] <= Math.max(points[0][1],points[1][1])) return {annotation,kind:'move'};
    if (annotation.shape === 'polygon' && insidePolygon(point,points)) return {annotation,kind:'move'};
  }
  return null;
}

/** 목적: 사진 작업 시작 및 선택 · 입력: 포인터 이벤트 · 출력: 드래그 시작 상태 */
function pointerDown(event) {
  if (!state.image || state.busy || ![0,1].includes(event.button) || state.gesture) return;$('#photo-canvas').focus();const {screen,point:raw} = eventPoint(event);const point = clampPoint(raw);
  if (event.button === 1) {event.preventDefault();state.gesture = {kind:'pan',middle:true,screen,view:{...state.view}};$('#photo-canvas').style.cursor = 'grabbing';}
  else if (state.mode === 'select') {
    const hit = hitTest(raw);
    if (hit) {const type = {object:'objects',feature:'features',measurement:'measurements'}[hit.annotation.target_type];state.selection = {type,id:hit.annotation.target_id};state.tab = type;state.annotationId = hit.annotation.id;state.gesture = {...hit,annotation:clone(hit.annotation),start:point,screen,original:clone(hit.annotation)};renderRecords();renderInspector();renderControls();}
    else {state.annotationId = null;state.gesture = {kind:'pan',screen,view:{...state.view}};renderInspector();renderControls();}
  } else if (state.mode === 'rect') {state.gesture = {kind:'rect',start:point,screen};state.draft = {shape:'rect',points:[point,point]};}
  else state.gesture = {kind:'draw-click',screen,point};
  $('#photo-canvas').setPointerCapture(event.pointerId);draw();
}

/** 목적: 사진 이동·영역·꼭짓점·라벨 드래그 · 입력: 포인터 이벤트 · 출력: 미리보기 또는 표시 좌표 갱신 */
function pointerMove(event) {
  if (!state.image || state.busy) return;const {screen,point:raw} = eventPoint(event);const point = clampPoint(raw);const gesture = state.gesture;
  if (!gesture) {if (state.draft && ['line','polygon'].includes(state.draft.shape)) {state.draft.preview = point;draw();}return;}
  if (gesture.kind === 'pan') {state.view.x = gesture.view.x + screen[0] - gesture.screen[0];state.view.y = gesture.view.y + screen[1] - gesture.screen[1];}
  else if (gesture.kind === 'rect') state.draft.points[1] = point;
  else if (gesture.annotation) {
    const annotation = gesture.annotation;const original = gesture.original;
    if (gesture.kind === 'rotate') {
      const angle = Math.atan2(raw[1] - gesture.center[1],raw[0] - gesture.center[0]);
      let degrees = (angle - gesture.startAngle) * 180 / Math.PI;
      degrees = ((degrees + 180) % 360 + 360) % 360 - 180;
      if (event.shiftKey) degrees = Math.round(degrees / 15) * 15;
      const rotated = rotateRegion(original,degrees,currentPhoto());
      gesture.invalid = !rotated;gesture.annotation = rotated || clone(original);
      const feedback = $('#rotation-feedback');if (feedback) feedback.textContent = rotated ? `회전 중 ${Number(degrees.toFixed(1))}° · 놓으면 적용 · Esc 취소` : '사진 밖으로 나갑니다. 각도를 줄이거나 Esc로 취소하세요.';
    }
    else if (gesture.kind === 'vertex') annotation.points[gesture.index] = point;
    else if (gesture.kind === 'label') {const origin = labelPosition(original);annotation.label_position = clampPoint([origin[0] + point[0] - gesture.start[0],origin[1] + point[1] - gesture.start[1]]);}
    else {
      const photo = currentPhoto();let dx = point[0] - gesture.start[0];let dy = point[1] - gesture.start[1];dx = Math.max(-Math.min(...original.points.map(item => item[0])),Math.min(dx,photo.width - Math.max(...original.points.map(item => item[0]))));dy = Math.max(-Math.min(...original.points.map(item => item[1])),Math.min(dy,photo.height - Math.max(...original.points.map(item => item[1]))));annotation.points = original.points.map(([x,y]) => [x + dx,y + dy]);const position = labelPosition(original);annotation.label_position = clampPoint([position[0] + dx,position[1] + dy]);
    }
  }
  draw();
}

/** 목적: 드래그 또는 두 점 입력 확정 · 입력: 포인터 이벤트 · 출력: 표시 등록 폼 또는 저장 예약 */
function pointerUp(event) {
  const gesture = state.gesture;cancelGesture();if (!gesture || state.busy) return;
  if ($('#photo-canvas').hasPointerCapture(event.pointerId)) $('#photo-canvas').releasePointerCapture(event.pointerId);
  if (gesture.kind === 'pan') {draw();return;}
  const point = clampPoint(eventPoint(event).point);
  if (gesture.invalid) {draw();renderInspector();toast('회전한 영역이 사진 밖으로 나가 적용하지 않았습니다.',true);return;}
  if (gesture.annotation) {const index = state.project.annotations.findIndex(annotation => annotation.id === gesture.annotation.id);if (index >= 0) {const before = clone(state.project);state.project.annotations[index] = gesture.annotation;commitChange(before);renderInspector();}return;}
  if (gesture.kind === 'rect') {if (Math.abs(point[0] - gesture.start[0]) * state.view.scale < 5 || Math.abs(point[1] - gesture.start[1]) * state.view.scale < 5) {state.draft = null;draw();return;}finishGeometry({shape:'rect',points:[gesture.start,point]});}
  else if (gesture.kind === 'draw-click') {
    if (state.mode === 'point') finishGeometry({shape:'point',points:[point]});
    else if (state.mode === 'polygon') {if (!state.draft) state.draft = {shape:'polygon',points:[]};const last = state.draft.points.at(-1);if (!last || Math.hypot(last[0] - point[0],last[1] - point[1]) * state.view.scale > 3) state.draft.points.push(point);state.draft.preview = point;draw();}
    else if (['measure','plane'].includes(state.mode)) {if (!state.draft) state.draft = {shape:'line',points:[point],preview:point};else {if (Math.hypot(state.draft.points[0][0] - point[0],state.draft.points[0][1] - point[1]) * state.view.scale < 4) return;finishGeometry({shape:'line',points:[state.draft.points[0],point]});}draw();}
  }
}

/** 목적: 다각형의 마지막 점 중복을 제거하고 완료 · 입력: 없음 · 출력: 물체 등록 폼 */
function finishPolygon() {if (state.mode !== 'polygon' || !state.draft) return;const points = state.draft.points;if (points.length < 3) {toast('다각형은 세 점 이상을 찍어주세요.');return;}finishGeometry({shape:'polygon',points:points.map(point => [...point])});}

/** 목적: 완성한 사진 도형을 공통 기록에 연결 · 입력: 도형과 사진 좌표 · 출력: 대상 선택 대화상자 */
function finishGeometry(geometry) {state.draft = geometry;draw();if (['rect','polygon'].includes(state.mode)) objectDialog(geometry);else if (['point','plane'].includes(state.mode)) featureDialog(geometry,state.mode === 'plane' ? 'plane' : 'hole');else measurementDialog(geometry);}

/** 목적: 포인터 위치를 유지하며 확대·축소 · 입력: 배율 계수와 화면 좌표 · 출력: 보기 배율 갱신 */
function zoom(factor, screen = null) {if (!state.image || state.busy) return;const host = $('#canvas-host');const anchor = screen || [host.clientWidth / 2,host.clientHeight / 2];const old = state.view.scale;const scale = Math.max(.005,Math.min(20,old * factor));state.view.x = anchor[0] - (anchor[0] - state.view.x) * scale / old;state.view.y = anchor[1] - (anchor[1] - state.view.y) * scale / old;state.view.scale = scale;draw();}

/** 목적: 사용자 사진 여러 장을 저장된 프로젝트에 추가 · 입력: 파일 목록 · 출력: 새 사진과 화면 */
async function uploadPhotos(files) {
  if (!files.length || !state.project) return;if (!(await flushSave())) return;
  setBusy(true,`사진 ${files.length}장을 추가하는 중…`);
  try {const form = new FormData();files.forEach(file => form.append('files',file));form.append('revision',state.project.revision);const project = await api(`/api/projects/${state.project.id}/photos`,{method:'POST',body:form});const previous = new Set(state.project.photos.map(photo => photo.id));state.project = project;state.undo = [];state.redo = [];state.selection = null;state.annotationId = null;renderAll();await selectPhoto(project.photos.find(photo => !previous.has(photo.id))?.id || project.photos[0]?.id);toast(`${files.length}장 추가 완료. 물체부터 표시해보세요.`);} catch(error) {if (error.status === 409) state.saveError = error;toast(error.message,true);} finally {setBusy(false);$('#photo-input').value = '';}
}

/** 목적: 브라우저에서 자료 파일 내려받기 · 입력: Blob과 파일명 · 출력: 파일 다운로드 */
function downloadBlob(blob, filename) {const url = URL.createObjectURL(blob);const link = document.createElement('a');link.href = url;link.download = filename;document.body.append(link);link.click();link.remove();setTimeout(() => URL.revokeObjectURL(url),30000);}

/** 목적: 저장된 같은 버전으로 표시 PNG와 ZIP 생성 · 입력: 없음 · 출력: 프로젝트 자료 ZIP 다운로드 */
async function exportProject() {
  if (!state.project || state.busy) return;
  if ($('#edit-dialog').open) {toast('입력 중인 기록을 먼저 완료하거나 취소하세요.');return;}
  setBusy(true,'기록을 저장하는 중…');
  try {
    if (!(await flushSave())) return;const snapshot = clone(state.project);const annotated = [];
    for (let index = 0;index < snapshot.photos.length;index += 1) {
      const photo = snapshot.photos[index];$('#busy-text').textContent = `표시 사진 준비 ${index + 1} / ${snapshot.photos.length}`;
      const image = await loadImage(`/api/projects/${snapshot.id}/photos/${photo.id}/image`);const canvas = document.createElement('canvas');canvas.width = photo.width;canvas.height = photo.height;
      drawScene(canvas.getContext('2d'),image,snapshot,photo.id,{exporting:true});
      const dataUrl = canvas.toDataURL('image/png');if (dataUrl === 'data:,') throw new Error('사진이 너무 커 표시 이미지를 만들지 못했습니다. 작은 사진으로 다시 시도하세요.');
      annotated.push({photo_id:photo.id,data_url:dataUrl});canvas.width = 1;canvas.height = 1;image.src = '';
      await new Promise(resolve => setTimeout(resolve,0));
    }
    $('#busy-text').textContent = '원본·치수·사진을 ZIP으로 묶는 중…';
    const response = await api(`/api/projects/${snapshot.id}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:snapshot.revision,annotated_images:annotated})});
    downloadBlob(await response.blob(),`${snapshot.name.replace(/[\\/:*?"<>|]/g,'_')}_실측자료.zip`);toast('원본 사진·표시 사진·JSON·글머리 문서를 내보냈습니다.');
  } catch(error) {if (error.status === 409) state.saveError = error;toast(error.message,true);} finally {setBusy(false);}
}

/** 목적: 내보낸 ZIP을 기존 자료와 분리해 복원 · 입력: ZIP 파일 · 출력: 새 프로젝트 */
async function importProject(file) {if (!file || state.busy) return;if (!(await flushSave())) return;setBusy(true,'실측 자료를 불러오는 중…');try {const form = new FormData();form.append('file',file);const project = await api('/api/projects/import',{method:'POST',body:form});setBusy(false);await openProject(project);toast('새 프로젝트로 복원했습니다. 기존 프로젝트는 그대로 보관됩니다.');} catch(error) {toast(error.message,true);} finally {setBusy(false);$('#import-input').value = '';}}

/** 목적: 충돌 시 현재 입력을 파일로 보관 · 입력: 없음 · 출력: JSON 기록 다운로드 */
function downloadLocalCopy() {if (!state.project) return;downloadBlob(new Blob([JSON.stringify(state.project,null,2)],{type:'application/json'}),`${state.project.name.replace(/[\\/:*?"<>|]/g,'_')}_저장되지않은기록.json`);toast('현재 입력을 JSON으로 보관했습니다. 원본 사진은 서버에 있습니다.');}

/** 목적: 충돌한 서버 기록을 명시적 선택 후 다시 읽기 · 입력: 없음 · 출력: 최신 프로젝트 복원 */
async function reloadConflict() {
  if (!state.project || !(await confirmAction('이 창의 입력을 먼저 「내 기록 보관」으로 내려받을 수 있습니다.\n서버 기록을 다시 열면 이 창의 저장되지 않은 변경은 화면에서 사라집니다.\n계속할까요?', '서버 기록 열기', '최신 기록 다시 열기'))) return;
  setBusy(true,'최신 서버 기록을 확인하는 중…');
  try {
    const fresh = await api(`/api/projects/${state.project.id}`);
    state.savedSeq = state.seq;state.saveError = null;setBusy(false);await openProject(fresh);
  } catch(error) {toast(`서버 기록을 읽지 못했습니다. 현재 입력은 유지됩니다. ${error.message}`,true);}
  finally {setBusy(false);}
}

/** 목적: 브라우저 저장을 앱 저장으로 대체하고 편집 단축키 처리 · 입력: 키보드 이벤트 · 출력: 현재 폼 확정과 저장 또는 편집 동작 */
function handleKeydown(event) {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.code === 'KeyS' || event.key.toLowerCase() === 's')) {
    event.preventDefault();
    if (event.repeat || state.busy || $('#confirm-dialog').open || $('#region-dialog').open) return;
    if ($('#edit-dialog').open) {
      const form = $('#dialog-form');const submit = form.querySelector('[type=submit]');
      if (!submit.disabled) form.requestSubmit(submit);
    } else {
      const form = document.activeElement?.form || $('#record-form');
      form?.requestSubmit();return flushSave();
    }
    return;
  }
  const typing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);if ($('#edit-dialog').open || $('#region-dialog').open || typing || state.busy) return;
  if (event.key === 'Escape') {state.draft = null;setMode('select');}
  if (event.key === 'Enter' && state.mode === 'polygon') {event.preventDefault();finishPolygon();}
  if (event.key === 'Delete' || event.key === 'Backspace') {event.preventDefault();deleteAnnotation();}
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {event.preventDefault();undoRedo(event.shiftKey);}
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {event.preventDefault();undoRedo(true);}
  if (event.key.toLowerCase() === 'v') setMode('select');
}

/** 목적: 단축키와 편집 도구 연결 · 입력: 없음 · 출력: UI 이벤트 등록 */
function bindEvents() {
  $('#project-new').onclick = () => projectDialog();$('#project-edit').onclick = () => projectDialog(true);
  $('#project-select').onchange = event => {if (event.target.value && !state.busy) openProject(event.target.value);else event.target.value = state.project?.id || '';};
  $('#upload-button').onclick = () => $('#photo-input').click();$('#photo-input').onchange = event => uploadPhotos([...event.target.files]);
  $('#import-button').onclick = () => {if (!state.busy) $('#import-input').click();};$('#import-input').onchange = event => importProject(event.target.files[0]);$('#export-button').onclick = exportProject;
  $('#save-retry').onclick = () => {state.saveError = null;flushSave();};$('#conflict-copy').onclick = downloadLocalCopy;$('#conflict-reload').onclick = reloadConflict;
  $('#photo-list').onclick = event => {const button = event.target.closest('[data-photo]');if (button && !state.busy) selectPhoto(button.dataset.photo);};
  $('#photo-filter').onchange = event => {state.filter = event.target.value;renderPhotos();};$('#photo-edit').onclick = photoDialog;
  document.querySelectorAll('[data-mode]').forEach(button => {button.onclick = () => setMode(button.dataset.mode);});
  document.querySelectorAll('[data-tab]').forEach(button => {button.onclick = () => {if (state.busy) return;state.tab = button.dataset.tab;renderRecords();};});
  $('#record-list').onclick = event => {const button = event.target.closest('[data-record]');if (button && !state.busy) selectRecord(state.tab,button.dataset.record);};
  $('#new-record').onclick = () => ({objects:objectDialog,features:featureDialog,measurements:measurementDialog}[state.tab])();
  $('#undo-button').onclick = () => undoRedo();$('#redo-button').onclick = () => undoRedo(true);$('#delete-annotation').onclick = deleteAnnotation;
  $('#fit-button').onclick = fitView;$('#zoom-in').onclick = () => zoom(1.25);$('#zoom-out').onclick = () => zoom(.8);
  const canvas = $('#photo-canvas');canvas.onpointerdown = pointerDown;canvas.onpointermove = pointerMove;canvas.onpointerup = pointerUp;
  canvas.onmousedown = preventMiddleDefault;canvas.onauxclick = preventMiddleDefault;
  canvas.onpointercancel = cancelPointerGesture;
  canvas.onlostpointercapture = () => {if (state.gesture?.kind === 'pan') cancelPointerGesture();};
  canvas.ondblclick = event => {if (event.button !== 0) return;event.preventDefault();finishPolygon();};canvas.oncontextmenu = event => {event.preventDefault();state.draft = null;draw();};
  canvas.addEventListener('wheel',event => {event.preventDefault();zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12,eventPoint(event).screen);},{passive:false});
  $('#dialog-close').onclick = closeDialog;$('#dialog-cancel').onclick = closeDialog;$('#edit-dialog').onclose = () => {state.draft = null;draw();};
  $('#dialog-form').onsubmit = submitDialog;
  $('#dialog-content').onchange = event => {if (event.target.name === 'status') {const form = $('#dialog-form');const unknown = event.target.value === 'unknown';form.elements.value.disabled = unknown;form.elements.error.disabled = unknown;}if (event.target.name === 'kind' && $('#dialog-form').elements.direction && event.target.value !== 'offset') $('#dialog-form').elements.direction.value = 'none';};
  document.addEventListener('keydown',handleKeydown);
  window.addEventListener('beforeunload',event => {if (state.seq !== state.savedSeq || state.saving) {event.preventDefault();event.returnValue = '';}});
  new ResizeObserver(() => draw()).observe($('#canvas-host'));
}

/** 목적: 저장된 프로젝트 또는 첫 사용 화면 열기 · 입력: 없음 · 출력: 앱 초기 상태 */
async function initialize() {bindEvents();renderAll();try {const projects = await refreshProjects();const previous = localStorage.getItem('photo-measure-project');const project = projects.find(item => item.id === previous) || projects[0];if (project) await openProject(project.id);} catch(error) {toast(`서버에 연결할 수 없습니다. ${error.message}`,true);}}

initialize();
