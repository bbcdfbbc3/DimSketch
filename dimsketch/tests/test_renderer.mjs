import assert from 'node:assert/strict';
import {test} from 'node:test';
import {annotationLabel, annotationTarget, drawScene, measurementValue, regionPoints, rotationHandle, rotateRegion} from '../static/renderer.js';

/** 목적: 실제 단위 표시 검증용 치수 구성 · 입력: 측정 기록의 변경값 · 출력: 공통 치수 기록 */
function dimension(overrides = {}) {
  return {
    id: 'm1', label: 'M01', kind: 'width', direction: 'none',
    from_ref: {object_id: 'a'}, to_ref: {object_id: 'a'},
    readings: [{id: 'r1', value: 12.5, unit: 'cm', status: 'measured', error: 0.1}],
    selected_reading_id: 'r1', ...overrides,
  };
}

/** 목적: 여러 사진의 동일 대상 연결 준비 · 입력: 없음 · 출력: 공통 물체·구멍·치수와 표시 */
function fixture() {
  return {
    objects: [{id: 'a', label: 'A', name: '고정 구조판', color: '#126d53'}],
    features: [{id: 'h1', label: 'A-H1', name: '구멍 중심', object_id: 'a'}],
    measurements: [dimension()],
    annotations: [
      {id: 'ann1', photo_id: 'front', target_type: 'measurement', target_id: 'm1', shape: 'line', points: [[100, 200], [300, 200]], label_position: [150, 180]},
      {id: 'ann2', photo_id: 'side', target_type: 'measurement', target_id: 'm1', shape: 'line', points: [[30, 70], [90, 70]], label_position: [40, 50]},
      {id: 'ann3', photo_id: 'side', target_type: 'feature', target_id: 'h1', shape: 'point', points: [[90, 70]], label_position: [100, 90]},
    ],
  };
}

/** 목적: 브라우저 독립적인 좌표·그리기 상태 관찰 · 입력: 화면 픽셀 배율 · 출력: Canvas 호출·칠하기 기록과 컨텍스트 */
function recordingContext(pixelRatio = 1) {
  const calls = [];const paints = [];const stack = [];
  let transform = {a:pixelRatio,b:0,c:0,d:pixelRatio,e:0,f:0};
  const properties = ['strokeStyle','fillStyle','lineWidth','lineJoin','shadowColor','shadowBlur','shadowOffsetX','shadowOffsetY','font','textBaseline','textAlign'];
  const ctx = {calls,paints,strokeStyle:'#000',fillStyle:'#000',lineWidth:1,shadowColor:'rgba(0,0,0,0)',shadowBlur:0,shadowOffsetX:0,shadowOffsetY:0,
    measureText: text => ({width: text.length * 7}),getTransform: () => ({...transform})};
  for (const name of ['save', 'restore', 'translate', 'scale', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'closePath', 'arc', 'rect', 'fillRect', 'strokeRect', 'fillText', 'setLineDash']) {
    ctx[name] = (...args) => {
      calls.push([name,...args]);
      if (name === 'save') stack.push({styles:Object.fromEntries(properties.map(property => [property,ctx[property]])),transform:{...transform}});
      else if (name === 'restore') {const saved = stack.pop();Object.assign(ctx,saved.styles);transform = saved.transform;}
      else if (name === 'translate') {transform.e += transform.a * args[0] + transform.c * args[1];transform.f += transform.b * args[0] + transform.d * args[1];}
      else if (name === 'scale') {transform.a *= args[0];transform.b *= args[0];transform.c *= args[1];transform.d *= args[1];}
      if (['stroke','fill','fillRect','strokeRect','fillText'].includes(name)) paints.push({name,args,...Object.fromEntries(properties.map(property => [property,ctx[property]])),transform:{...transform}});
    };
  }
  return ctx;
}

test('cm와 측정 오차를 mm로 환산하고 실측값을 임의로 정수화하지 않는다', () => {
  assert.equal(measurementValue(dimension()), '125 ±1 mm');
  assert.equal(measurementValue(dimension({readings: [{id:'r1',value:1.2345,unit:'mm',status:'approximate',error:null}]})), '약 1.2345 mm');
});

test('원단면 아래 높이와 위 높이를 서로 구분한다', () => {
  const reading = {id: 'r1', value: 35, unit: 'mm', status: 'measured', error: null};
  assert.equal(measurementValue(dimension({kind:'offset',direction:'down',readings:[reading]})), '−35 mm');
  assert.equal(measurementValue(dimension({kind:'offset',direction:'up',readings:[reading]})), '+35 mm');
});

test('미측정값과 채택되지 않은 재측정값을 확정 수치로 표시하지 않는다', () => {
  assert.equal(measurementValue(dimension({readings: [{id:'r1',value:null,unit:'mm',status:'unknown',error:null}]})), '미측정');
  assert.equal(measurementValue(dimension({selected_reading_id: null})), '재확인 필요');
  assert.equal(measurementValue(dimension({selected_reading_id:null,readings:[]})), '미측정');
});

test('여러 각도 사진의 같은 치수와 구멍은 공통 번호·값·색상을 사용한다', () => {
  const project = fixture();
  assert.equal(annotationLabel(project, project.annotations[0]), annotationLabel(project, project.annotations[1]));
  assert.equal(annotationLabel(project, project.annotations[2]), 'A-H1 · 구멍 중심');
  assert.equal(annotationTarget(project, project.annotations[2]).color, '#126d53');
  project.measurements[0].readings[0].value = 13;
  assert.equal(annotationLabel(project, project.annotations[0]), 'M01  130 ±1 mm');
  assert.equal(annotationLabel(project, project.annotations[1]), 'M01  130 ±1 mm');
});

test('확대·이동과 PNG 렌더링 모두 저장된 끝점 좌표를 그대로 사용한다', () => {
  const project = fixture();
  const original = structuredClone(project);
  const image = {naturalWidth: 600, naturalHeight: 400, width:600, height:400};
  for (const options of [{scale:0.5,x:20,y:30}, {scale:3,x:-50,y:-80}, {exporting:true}]) {
    const ctx = recordingContext();
    drawScene(ctx, image, project, 'front', options);
    assert.ok(ctx.calls.some(call => call[0] === 'moveTo' && call[1] === 100 && call[2] === 200));
    assert.ok(ctx.calls.some(call => call[0] === 'lineTo' && call[1] === 300 && call[2] === 200));
    assert.equal(ctx.calls.filter(call => call[0] === 'fillText').length, 1, '다른 사진의 표시는 렌더링하지 않는다');
    assert.ok(ctx.calls.some(call => call[0] === 'fillText' && call[1] === 'M01  125 ±1 mm'));
  }
  assert.deepEqual(project, original, '렌더링이 실제 좌표나 측정값을 변경하면 안 된다');
});

test('시계 방향 90° 회전은 크기·중심·번호·라벨 좌표를 유지한다', () => {
  const annotation = {id:'area',target_type:'object',target_id:'a',shape:'rect',points:[[60,70],[140,130]],label_position:[50,50]};
  const original = structuredClone(annotation);
  const rotated = rotateRegion(annotation,90,{width:200,height:200});
  assert.equal(rotated.shape,'polygon');
  assert.deepEqual(rotated.points,[[130,60],[130,140],[70,140],[70,60]]);
  assert.equal(rotated.target_id,'a');assert.deepEqual(rotated.label_position,annotation.label_position);
  assert.deepEqual(rotationHandle(rotated).center,[100,100]);
  assert.deepEqual(annotation,original,'원본이나 다른 사진의 표시를 수정하면 안 된다');
  const restored = rotateRegion(rotated,-90,{width:200,height:200});
  restored.points.forEach((point,index) => point.forEach((value,axis) => assert.ok(Math.abs(value - regionPoints(original)[index][axis]) < 1e-9)));
  assert.deepEqual(rotateRegion(annotation,360,{width:200,height:200}),original);
});

test('사진 밖으로 나가는 회전은 영역을 변형하지 않고 거부한다', () => {
  const annotation = {target_type:'object',shape:'rect',points:[[0,0],[100,20]]};
  assert.equal(rotateRegion(annotation,45,{width:200,height:100}),null);
  assert.equal(rotateRegion(annotation,NaN,{width:200,height:100}),null);
  assert.equal(rotationHandle({...annotation,target_type:'measurement'}),null);
  assert.equal(rotationHandle({...annotation,shape:'line'}),null);
});

test('핸들은 보기 배율과 사진 가장자리에 맞추고 PNG에는 포함하지 않는다', () => {
  const project = fixture();
  const annotation = {id:'area',photo_id:'front',target_type:'object',target_id:'a',shape:'polygon',points:[[100,100],[200,100],[200,150],[100,150]],label_position:[100,90]};
  project.annotations = [annotation];
  assert.deepEqual(rotationHandle(annotation,2).point,[150,44]);
  const edge = {...annotation,shape:'rect',points:[[10,10],[30,30]]};
  assert.deepEqual(rotationHandle(edge).point,[20,58]);
  assert.notDeepEqual(rotationHandle(edge).point,rotationHandle(edge).center);
  const image = {naturalWidth:600,naturalHeight:400};
  for (const exporting of [false,true]) {
    const ctx = recordingContext();drawScene(ctx,image,project,'front',{selectedId:'area',exporting});
    assert.equal(ctx.calls.some(call => call[0] === 'fillText' && call[1] === '↻'),!exporting);
    assert.ok(ctx.calls.some(call => call[0] === 'lineTo' && call[1] === 200 && call[2] === 150));
  }
});

test('선택한 치수의 선·양쪽 화살표를 강조하고 라벨을 겹친 물체보다 위에 그린다', () => {
  const project = fixture();
  project.annotations.push({id:'area',photo_id:'front',target_type:'object',target_id:'a',shape:'rect',points:[[80,100],[340,250]],label_position:[140,175]});
  const original = structuredClone(project);const image = {naturalWidth:600,naturalHeight:400};
  const ctx = recordingContext();drawScene(ctx,image,project,'front',{selectedId:'ann1'});
  const labels = ctx.paints.filter(paint => paint.name === 'fillText');
  assert.equal(labels.at(-1).args[0],'M01  125 ±1 mm');assert.equal(labels.at(-1).fillStyle,'#fff');
  const labelBoxes = ctx.paints.filter(paint => paint.name === 'fillRect');
  assert.notEqual(labelBoxes.at(-1).fillStyle,labelBoxes[0].fillStyle);
  const halos = ctx.paints.filter(paint => paint.name === 'stroke' && paint.shadowBlur > 0);
  assert.equal(halos.length,3,'치수선과 양쪽 화살표를 함께 강조해야 함');
  assert.ok(halos.every(paint => paint.strokeStyle === '#fff'));
  const colorStrokes = ctx.paints.filter(paint => paint.name === 'stroke' && paint.strokeStyle === '#126d53' && paint.lineWidth > 2);
  assert.equal(colorStrokes.length,3);assert.ok(colorStrokes.every(paint => paint.shadowBlur === 0));
  assert.ok(halos.every(paint => paint.lineWidth > colorStrokes[0].lineWidth));
  assert.equal(ctx.shadowBlur,0,'다음 표시의 그리기 상태로 그림자가 새면 안 됨');
  assert.deepEqual(project,original,'선택 표시가 저장 순서·좌표·측정값을 바꾸면 안 됨');
});

test('선택 효과와 손잡이 및 미완성 도형은 PNG 내보내기에 섞이지 않는다', () => {
  const project = fixture();
  project.annotations.push({id:'area',photo_id:'front',target_type:'object',target_id:'a',shape:'polygon',points:[[50,50],[250,60],[230,250],[70,230]]});
  const image = {naturalWidth:600,naturalHeight:400};const baseline = recordingContext();
  drawScene(baseline,image,project,'front',{exporting:true});
  for (const selectedId of ['ann1','area']) {
    const ctx = recordingContext();
    drawScene(ctx,image,project,'front',{exporting:true,selectedId,draft:{shape:'rect',points:[[10,10],[100,100]]}});
    assert.deepEqual(ctx.calls,baseline.calls);assert.deepEqual(ctx.paints,baseline.paints);
  }
});

test('사각형·다각형·기준점 선택 강조는 확대·축소와 화면 픽셀 배율에 관계없이 같은 크기로 보인다', () => {
  const image = {naturalWidth:600,naturalHeight:400};
  for (const shape of ['rect','polygon','point']) {
    const project = fixture();
    project.annotations = [{id:'selected',photo_id:'front',target_type:shape === 'point' ? 'feature' : 'object',target_id:shape === 'point' ? 'h1' : 'a',shape,
      points:shape === 'point' ? [[100,100]] : shape === 'rect' ? [[100,100],[250,250]] : [[100,100],[250,100],[200,250]]}];
    let baseline;
    for (const pixelRatio of [1,2]) for (const scale of [0.5,1,3]) {
      const ctx = recordingContext(pixelRatio);drawScene(ctx,image,project,'front',{selectedId:'selected',scale});
      const halo = ctx.paints.find(paint => paint.name === 'stroke' && paint.shadowBlur > 0);
      assert.ok(halo,`${shape}에도 선택 외곽선이 있어야 함`);
      const actual = [halo.lineWidth * Math.hypot(halo.transform.a,halo.transform.b) / pixelRatio,halo.shadowBlur / pixelRatio];
      baseline ||= actual;assert.deepEqual(actual,baseline);
    }
  }
});
