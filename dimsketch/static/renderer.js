/** 목적: 사진 표시의 대상 정보를 탐색 · 입력: 프로젝트와 표시 · 출력: 대상 객체와 공통 색상 */
export function annotationTarget(project, annotation) {
  const collection = {object: 'objects', feature: 'features', measurement: 'measurements'}[annotation.target_type];
  const target = project[collection]?.find(item => item.id === annotation.target_id);
  const objectId = annotation.target_type === 'object' ? target?.id : annotation.target_type === 'feature' ? target?.object_id : target?.from_ref?.object_id;
  return {target, color: project.objects.find(item => item.id === objectId)?.color || '#216da0'};
}

/** 목적: 채택된 실측값을 읽기 쉬운 문구로 표시 · 입력: 치수 기록 · 출력: mm 기준 표시 문구 */
export function measurementValue(measurement) {
  if (!measurement.selected_reading_id) return measurement.readings.length ? '재확인 필요' : '미측정';
  const reading = measurement.readings.find(item => item.id === measurement.selected_reading_id);
  if (!reading || reading.status === 'unknown' || reading.value === null) return '미측정';
  const value = reading.value * (reading.unit === 'cm' ? 10 : 1);
  const error = reading.error == null ? null : reading.error * (reading.unit === 'cm' ? 10 : 1);
  const sign = measurement.kind === 'offset' ? (measurement.direction === 'down' ? '−' : '+') : '';
  return `${reading.status === 'approximate' ? '약 ' : ''}${sign}${Number(value.toFixed(6))}${error === null ? '' : ` ±${Number(error.toFixed(6))}`} mm`;
}

/** 목적: 사진 표시의 라벨 문구 구성 · 입력: 프로젝트와 표시 · 출력: 공통 번호 및 치수 문구 */
export function annotationLabel(project, annotation) {
  const {target} = annotationTarget(project, annotation);
  if (!target) return '?';
  return annotation.target_type === 'measurement' ? `${target.label}  ${measurementValue(target)}` : `${target.label}${target.name ? ` · ${target.name}` : ''}`;
}

/** 목적: 표시 라벨의 사진 좌표 계산 · 입력: 표시와 기본 간격 · 출력: 사진 좌표 쌍 */
export function labelPosition(annotation, gap = 12) {
  if (annotation.label_position) return annotation.label_position;
  const points = annotation.points;
  if (annotation.shape === 'line') return [(points[0][0] + points[1][0]) / 2 + gap, (points[0][1] + points[1][1]) / 2 - gap];
  return [Math.min(...points.map(point => point[0])) + gap, Math.min(...points.map(point => point[1])) - gap];
}

/** 목적: 회전 가능한 물체 영역의 실제 꼭짓점 구성 · 입력: 사진 표시 · 출력: 꼭짓점 또는 null */
export function regionPoints(annotation) {
  if (annotation?.target_type !== 'object') return null;
  if (annotation.shape === 'polygon') return annotation.points;
  if (annotation.shape !== 'rect') return null;
  const [[x1,y1],[x2,y2]] = annotation.points;
  return [[x1,y1],[x2,y1],[x2,y2],[x1,y2]];
}

/** 목적: 회전 중심과 배율에 무관한 핸들 위치 계산 · 입력: 영역·사진 좌표당 화면 배율 역수 · 출력: 중심·연결점·핸들 또는 null */
export function rotationHandle(annotation, unit = 1) {
  const points = regionPoints(annotation);
  if (!points) return null;
  const center = [0,1].map(axis => points.reduce((sum,point) => sum + point[axis],0) / points.length);
  const top = Math.min(...points.map(point => point[1]));
  const bottom = Math.max(...points.map(point => point[1]));
  // 사진 윗가장자리에 붙은 영역의 핸들은 아래쪽에 배치한다.
  const below = top < 36 * unit;
  const anchor = [center[0],below ? bottom : top];
  const y = below ? bottom + 28 * unit : top - 28 * unit;
  return {center,anchor,point:[center[0],y]};
}

/** 목적: 영역 크기와 중심을 유지하며 사진 안에서 회전 · 입력: 표시·시계 방향 각도·사진 크기 · 출력: 회전 복사본 또는 경계 초과 시 null */
export function rotateRegion(annotation, degrees, photo) {
  const points = regionPoints(annotation);
  if (!points || !Number.isFinite(degrees)) return null;
  const angle = degrees % 360;
  if (Math.abs(angle) < 1e-10) return structuredClone(annotation);
  const {center:[cx,cy]} = rotationHandle(annotation);
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians);const sin = Math.sin(radians);
  const rotated = points.map(([x,y]) => [cx + (x - cx) * cos - (y - cy) * sin,cy + (x - cx) * sin + (y - cy) * cos]);
  const epsilon = 1e-7;
  if (rotated.some(([x,y]) => x < -epsilon || y < -epsilon || x > photo.width + epsilon || y > photo.height + epsilon)) return null;
  return {...structuredClone(annotation),shape:'polygon',points:rotated.map(([x,y]) => [Math.max(0,Math.min(photo.width,x)),Math.max(0,Math.min(photo.height,y))])};
}

/** 목적: 선택 영역의 회전 손잡이 표시 · 입력: 캔버스·표시·글자 배율·색상 · 출력: 연결선과 원형 회전 핸들 */
function drawRotationHandle(ctx, annotation, unit, color) {
  const handle = rotationHandle(annotation,unit);
  if (!handle) return;
  ctx.strokeStyle = color;ctx.lineWidth = 1.5 * unit;ctx.beginPath();ctx.moveTo(...handle.anchor);ctx.lineTo(...handle.point);ctx.stroke();
  ctx.fillStyle = '#fff';ctx.beginPath();ctx.arc(...handle.point,9 * unit,0,Math.PI * 2);ctx.fill();ctx.stroke();
  ctx.fillStyle = color;ctx.font = `600 ${14 * unit}px "Segoe UI", sans-serif`;ctx.textAlign = 'center';ctx.textBaseline = 'middle';ctx.fillText('↻',handle.point[0],handle.point[1]);
}

/** 목적: 사진 경계 안의 라벨 위치와 크기 계산 · 입력: 캔버스, 사진, 프로젝트, 표시 및 글자 배율 · 출력: 라벨 상자 좌표 */
export function labelLayout(ctx, image, project, annotation, unit) {
  let text = annotationLabel(project,annotation);
  ctx.font = `600 ${13 * unit}px "Segoe UI", "Malgun Gothic", sans-serif`;
  const maxWidth = Math.max(20 * unit,image.naturalWidth - 14 * unit);
  if (ctx.measureText(text).width > maxWidth) {
    while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) text = text.slice(0,-1);
    text += '…';
  }
  const width = ctx.measureText(text).width + 14 * unit;
  const height = 24 * unit;
  const [rawX,rawY] = labelPosition(annotation);
  const x = Math.max(0,Math.min(rawX,image.naturalWidth - width));
  const y = Math.max(height,Math.min(rawY,image.naturalHeight));
  return {x,y,width,height,text};
}

/** 목적: 선택한 선을 사진에서 구분하도록 외곽선과 그림자 추가 · 입력: 캔버스·화면 단위·선택 여부 · 출력: 현재 경로의 외곽선과 원래 색 선 */
function strokeGeometry(ctx, unit, selected) {
  if (selected) {
    ctx.save();ctx.strokeStyle = '#fff';ctx.lineWidth = 6 * unit;
    const transform = ctx.getTransform();
    ctx.shadowColor = 'rgba(0,0,0,0.25)';ctx.shadowBlur = 4 * unit * Math.hypot(transform.a,transform.b);
    ctx.shadowOffsetX = 0;ctx.shadowOffsetY = 0;ctx.stroke();ctx.restore();
  }
  ctx.stroke();
}

/** 목적: 치수선 끝의 화살표 그리기 · 입력: 캔버스와 두 점·크기·화면 단위·선택 여부 · 출력: 선택 강조를 포함한 화살표 */
function drawArrow(ctx, from, to, size, unit, selected) {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  ctx.beginPath();
  ctx.moveTo(to[0], to[1]);
  ctx.lineTo(to[0] - size * Math.cos(angle - Math.PI / 6), to[1] - size * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(to[0], to[1]);
  ctx.lineTo(to[0] - size * Math.cos(angle + Math.PI / 6), to[1] - size * Math.sin(angle + Math.PI / 6));
  strokeGeometry(ctx,unit,selected);
}

/** 목적: 하나의 영역·점·선을 그리기 · 입력: 캔버스와 표시 및 사진 좌표 크기 · 출력: 캔버스 그리기 */
function drawGeometry(ctx, annotation, unit, selected, color) {
  const points = annotation.points;
  ctx.strokeStyle = color;
  ctx.fillStyle = `${color}${selected ? '55' : '22'}`;
  ctx.lineWidth = (selected ? 3 : 2) * unit;
  ctx.lineJoin = 'round';
  ctx.setLineDash(annotation.target_type === 'feature' && annotation.shape === 'line' ? [7 * unit, 4 * unit] : []);
  ctx.beginPath();
  if (annotation.shape === 'point') {
    const [x, y] = points[0];
    ctx.arc(x, y, 7 * unit, 0, Math.PI * 2);
    ctx.moveTo(x - 11 * unit, y);ctx.lineTo(x + 11 * unit, y);
    ctx.moveTo(x, y - 11 * unit);ctx.lineTo(x, y + 11 * unit);
    strokeGeometry(ctx,unit,selected);
  } else if (annotation.shape === 'rect') {
    ctx.rect(points[0][0], points[0][1], points[1][0] - points[0][0], points[1][1] - points[0][1]);ctx.fill();strokeGeometry(ctx,unit,selected);
  } else {
    ctx.moveTo(...points[0]);
    points.slice(1).forEach(point => ctx.lineTo(...point));
    if (annotation.shape === 'polygon') {ctx.closePath();ctx.fill();}
    strokeGeometry(ctx,unit,selected);
    if (annotation.target_type === 'measurement' && points.length > 1) {
      drawArrow(ctx, points[0], points[1], 9 * unit, unit, selected);drawArrow(ctx, points[1], points[0], 9 * unit, unit, selected);
      points.forEach(([x, y]) => {ctx.beginPath();ctx.arc(x, y, 2.5 * unit, 0, Math.PI * 2);ctx.fillStyle = color;ctx.fill();});
    }
  }
  ctx.setLineDash([]);
  if (selected) points.forEach(([x, y]) => {ctx.fillStyle = '#fff';ctx.strokeStyle = color;ctx.lineWidth = 1.5 * unit;ctx.beginPath();ctx.rect(x - 4 * unit, y - 4 * unit, 8 * unit, 8 * unit);ctx.fill();ctx.stroke();});
}

/** 목적: 편집 및 PNG 내보내기에 동일한 사진·표시 렌더링 사용 · 입력: 캔버스, 사진, 프로젝트, 보기 옵션 · 출력: 캔버스 그리기 */
export function drawScene(ctx, image, project, photoId, options = {}) {
  const {scale = 1, x = 0, y = 0, selectedId = null, draft = null, exporting = false} = options;
  const unit = exporting ? Math.max(1, Math.min(2.8, image.naturalWidth / 1500)) : 1 / scale;
  ctx.save();ctx.translate(x, y);ctx.scale(scale, scale);ctx.drawImage(image, 0, 0);
  const annotations = project.annotations.filter(item => item.photo_id === photoId);
  if (!exporting && selectedId) annotations.sort((first,second) => Number(first.id === selectedId) - Number(second.id === selectedId));
  annotations.forEach(annotation => {
    const {target, color} = annotationTarget(project, annotation);
    if (!target) return;
    const selected = !exporting && annotation.id === selectedId;
    ctx.save();drawGeometry(ctx, annotation, unit, selected, color);
    const {x:lx,y:ly,text,width,height} = labelLayout(ctx,image,project,annotation,unit);
    ctx.fillStyle = selected ? '#203f35' : '#ffffffed';ctx.fillRect(lx, ly - height, width, height);
    ctx.strokeStyle = color;ctx.lineWidth = (selected ? 2 : 1) * unit;ctx.strokeRect(lx, ly - height, width, height);
    ctx.fillStyle = selected ? '#fff' : color;ctx.textBaseline = 'middle';ctx.fillText(text, lx + 7 * unit, ly - height / 2);
    if (selected && !exporting) drawRotationHandle(ctx,annotation,unit,color);
    ctx.restore();
  });
  if (!exporting && draft?.points?.length) {ctx.save();ctx.setLineDash([5 * unit, 4 * unit]);drawGeometry(ctx, {shape:draft.shape,target_type:'object',points:draft.points}, unit, true, '#e18c24');ctx.restore();}
  ctx.restore();
}
