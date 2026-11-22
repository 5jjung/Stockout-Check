// 품절 판정 규칙 (시트·브라우저와 무관한 순수 계산만 모아 둔 파일 → 테스트하기 쉬움)
//
// 감시 규칙
//   - 상품등록 D열(감시 ON/OFF) 체크   → 감시 대상
//   - 상품등록 D열 체크 해제           → 재입고 일정 없음 → 확인하지 않음 (index.js 에서 제외)
//   - 사이즈 칸(F~) 체크               → 그 사이즈 품절을 감시
//   - 사이즈 칸 체크 해제              → 재입고 일정 없음 → 그 사이즈는 무시
//   - 사이즈 칸 빈칸                   → 원래 없는 사이즈. 무신사에 생기면 감시 대상으로 봄

const STATUS_KO = {
  SALE: '판매중',
  SOLDOUT: '전체 품절',
  STOP_SALE: '판매 중지',
  GONE: '상품 삭제됨',
  STAND_BY_SALE: '판매 대기',
};
const STATUS_TEXT = {
  SOLDOUT: '🚫 전체 품절',
  STOP_SALE: '🚫 판매 중지',
  GONE: '🚫 상품 삭제됨',
  STAND_BY_SALE: '⏳ 판매 대기',
};
const NO_RESTOCK_TAG = '(일정없음)';   // 품절 옵션 칸에서 "재입고 일정 없는 사이즈" 표시
const PROBLEM_STATUSES = ['SOLDOUT', 'STOP_SALE', 'GONE'];

// 사이즈 이름 통일: 'free', 'F', 'ONE SIZE' → 'FREE' / ' m ' → 'M'
function normalizeSize(label) {
  const s = String(label ?? '').normalize('NFKC').toUpperCase().replace(/\s+/g, '');
  if (['F', 'FREE', 'FREESIZE', 'ONESIZE', 'OS', '프리', '단일옵션', '단일사이즈'].includes(s)) return 'FREE';
  return s;
}

// 무신사 옵션 값들(예: ['블랙', 'M'])에서 사이즈 하나 고르기
function pickSize(values, knownSizes = []) {
  const list = (values || []).map(normalizeSize).filter(Boolean);
  return list.find((v) => knownSizes.includes(v)) || list[list.length - 1] || '';
}

// 이 상품의 이 사이즈를 "감시"하는가?
function isSizeWatched(product, size) {
  if (!product.watch) return false;
  return product.sizeChecks.get(size) !== false; // 체크 해제(FALSE)만 제외
}

// 시트 열 순서(S, M, L, XL …)대로 정렬, 모르는 사이즈는 뒤로
function sortSizes(sizes, order = []) {
  const rank = (s) => (order.includes(s) ? order.indexOf(s) : order.length);
  return [...sizes].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// 무신사에서 받은 원본 → { name, status, sizes: {M: true(재고있음)/false(품절)}, sizesKnown }
function toSnapshot(raw, knownSizes = []) {
  if (!raw || raw.error) return { error: raw?.error || '조회 결과 없음' };
  if (raw.gone) return { name: '', status: 'GONE', sizes: {}, sizesKnown: true };
  const d = raw.detail;
  if (!d) return { error: '상품 정보를 받지 못함' };

  let status = d.goodsSaleType || 'UNKNOWN';
  if (status === 'SALE' && d.isOutOfStock === true) status = 'SOLDOUT'; // 판매중인데 전체 재고 없음

  const sizes = {};
  let unknown = false;
  const liveOptions = (raw.options || []).filter((x) => !x.isDeleted);
  // 재고 목록이 있는데 옵션 번호와 하나도 안 맞으면 → 사이즈 판정 불가 (전부 품절로 잘못 보는 것 방지)
  if (status === 'SALE' && raw.inventory && raw.inventory.size && !liveOptions.some((o) => raw.inventory.has(String(o.no)))) {
    return { name: d.goodsNm || '', status, sizes: {}, sizesKnown: false, note: raw.note || '' };
  }
  for (const o of liveOptions) {
    const size = pickSize(o.values, knownSizes);
    if (!size) continue;
    let inStock;
    if (status !== 'SALE' || o.active === false) inStock = false;
    else if (raw.inventory && raw.inventory.size) inStock = raw.inventory.get(String(o.no)) === true;
    else if (typeof o.outOfStock === 'boolean') inStock = !o.outOfStock;
    else { unknown = true; continue; }
    sizes[size] = sizes[size] === true || inStock; // 같은 사이즈가 여러 줄이면 하나라도 재고 있으면 재고 있음
  }
  const sizesKnown = !unknown && (Object.keys(sizes).length > 0 || status !== 'SALE');
  return { name: d.goodsNm || '', status, sizes, sizesKnown, note: raw.note || '' };
}

const splitList = (v) => String(v || '').split(',').map((x) => x.replace(NO_RESTOCK_TAG, '').trim()).filter(Boolean);

// 시즌 탭에 적혀 있던 직전 상태 읽기 (별도 저장 탭 없이 시즌 탭 자체를 기준으로 씀)
function parsePrevRow(row) {
  const d = String(row?.[3] || '');
  if (!d || d.startsWith('❓')) return null; // 처음 보는 상품 또는 한 번도 조회 성공 못 함
  let status = 'SALE';
  if (d.includes('전체 품절')) status = 'SOLDOUT';
  else if (d.includes('판매 중지')) status = 'STOP_SALE';
  else if (d.includes('삭제')) status = 'GONE';
  else if (d.includes('판매 대기')) status = 'STAND_BY_SALE';
  const sizes = {};
  for (const s of splitList(row[4])) sizes[normalizeSize(s)] = false;
  for (const s of splitList(row[5])) sizes[normalizeSize(s)] = true;
  return { status, sizes };
}

function statusText(cur, product) {
  if (cur.status !== 'SALE') return STATUS_TEXT[cur.status] || `❓ ${cur.status}`;
  const sold = Object.keys(cur.sizes).filter((s) => !cur.sizes[s]);
  if (sold.some((s) => isSizeWatched(product, s))) return '❌ 사이즈 품절';
  if (sold.length) return '⏸ 품절 (재입고 일정 없음)';
  return '✅ 판매중';
}

// 이벤트 종류 이름 (감시 대상이 아니면 꼬리표를 붙임)
function eventLabel(type, watched) {
  if (watched) return type;
  if (type === '재입고' || type === '판매 재개') return `${type} (재입고 일정 없던 항목)`;
  return `${type} (재입고 일정 없음)`;
}

// 직전 상태 → 지금 상태 비교해서 변동 목록 만들기
function diff(prev, cur, product, sizesKnown, order) {
  const events = [];
  if (prev.status !== cur.status) {
    const text = `${STATUS_KO[prev.status] || prev.status} → ${STATUS_KO[cur.status] || cur.status}`;
    const stillSold = cur.status === 'SALE' && sizesKnown ? sortSizes(Object.keys(cur.sizes).filter((s) => !cur.sizes[s]), order) : [];
    events.push({
      type: cur.status === 'SALE' ? '판매 재개' : (STATUS_KO[cur.status] || cur.status),
      watched: product.watch,
      text: stillSold.length ? `${text} (아직 품절: ${stillSold.join(', ')})` : text,
    });
  }
  if (cur.status !== 'SALE' || prev.status !== 'SALE' || !sizesKnown) return events;
  // 직전에 사이즈 정보가 아예 없었으면(옵션 확인 불가였던 경우) 비교 대신 현재 상태만 기록
  if (!Object.keys(prev.sizes).length) return events.concat(firstEvents(cur, product, order));

  const groups = new Map(); // `${type}|${watched}` → [sizes]
  const add = (type, size) => {
    const key = `${type}|${isSizeWatched(product, size)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(size);
  };
  for (const [size, inStock] of Object.entries(cur.sizes)) {
    const before = prev.sizes[size];
    if (before !== false && !inStock) add('품절 발생', size);       // 재고 있음(또는 새 옵션) → 품절
    else if (before === false && inStock) add('재입고', size);       // 품절 → 재고 있음
  }
  for (const [size, before] of Object.entries(prev.sizes)) {
    if (before === true && !(size in cur.sizes)) add('옵션 삭제', size);
  }
  for (const [key, sizes] of groups) {
    const [type, watched] = key.split('|');
    const list = sortSizes(sizes, order).join(', ');
    const suffix = { '품절 발생': '품절', '재입고': '재입고', '옵션 삭제': '옵션 삭제' }[type];
    events.push({ type, watched: watched === 'true', text: `${list} ${suffix}` });
  }
  return events;
}

// 처음 보는 상품: 지금 이미 문제가 있으면 '최초 확인'으로 기록만 (슬랙 X)
function firstEvents(cur, product, order) {
  if (cur.status !== 'SALE') {
    return [{ type: '최초 확인', watched: product.watch, text: `현재 ${STATUS_KO[cur.status] || cur.status}`, first: true }];
  }
  const sold = sortSizes(Object.keys(cur.sizes).filter((s) => !cur.sizes[s]), order);
  if (!sold.length) return [];
  const label = sold.map((s) => (isSizeWatched(product, s) ? s : `${s}${NO_RESTOCK_TAG}`)).join(', ');
  return [{ type: '최초 확인', watched: sold.some((s) => isSizeWatched(product, s)), text: `현재 품절: ${label}`, first: true }];
}

// 슬랙으로 알릴 이벤트인가? (감시 대상 변동 → 알림 / 최초 확인 → 기록만)
function shouldNotify(ev) {
  return !ev.first && ev.watched;
}

// 상품 하나 평가 → 시즌 탭에 쓸 한 줄 + 변동 목록
//   product : 상품등록 한 줄 { goodsNo, name, watch, sizeChecks, sizeOrder }
//   prevRow : 시즌 탭의 기존 줄 (없으면 null)
//   snap    : toSnapshot() 결과
function evaluate({ product, prevRow, snap, now }) {
  const order = product.sizeOrder || [];
  const watchText = product.watch ? '감시 ON' : '감시 OFF (재입고 일정 없음)';
  const prevPadded = Array.from({ length: 9 }, (_, i) => prevRow?.[i] ?? '');

  // 조회 실패: 기존 값을 그대로 두고 '마지막 확인'에만 실패 표시 → 잘못된 품절/재입고 기록 방지
  if (snap.error) {
    const row = prevRow ? prevPadded : [product.goodsNo, product.name, watchText, '❓ 조회 실패', '', '', '', '', ''];
    row[0] = product.goodsNo;
    row[2] = watchText;
    row[8] = `${now} (조회 실패: ${snap.error})`;
    return { row, events: [] };
  }

  // 체크 해제된 사이즈(재입고 일정 없음)는 아예 보지 않음
  const onlyWatched = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([s]) => isSizeWatched(product, s)));
  const parsed = parsePrevRow(prevRow);
  const prev = parsed && { ...parsed, sizes: onlyWatched(parsed.sizes) };
  // 옵션 재고를 못 받았으면 직전 사이즈 정보 유지 (사이즈 변동 판정은 건너뜀)
  const sizes = onlyWatched(snap.sizesKnown ? snap.sizes : prev?.sizes);
  const cur = { status: snap.status, sizes };
  const events = prev ? diff(prev, cur, product, snap.sizesKnown, order) : firstEvents(cur, product, order);
  for (const ev of events) {
    ev.label = eventLabel(ev.type, ev.watched);
    ev.notify = shouldNotify(ev);
  }

  const allSizes = sortSizes(Object.keys(sizes), order);
  const sold = allSizes.filter((s) => !sizes[s]);
  const available = allSizes.filter((s) => sizes[s]);
  const watchedIssue = product.watch && (PROBLEM_STATUSES.includes(cur.status) || sold.some((s) => isSizeWatched(product, s)));

  const row = [
    product.goodsNo,
    snap.name || product.name || prevPadded[1],
    watchText,
    statusText(cur, product),
    sold.map((s) => (isSizeWatched(product, s) ? s : `${s}${NO_RESTOCK_TAG}`)).join(', '),
    available.join(', '),
    watchedIssue ? (prevPadded[6] || now) : '',                    // 문제 발생 시각: 문제가 이어지는 동안 유지
    events.some((e) => e.notify) ? now : prevPadded[7],             // 마지막 알림
    snap.note ? `${now} (${snap.note})` : snap.sizesKnown ? now : `${now} (옵션 재고 확인 불가)`, // 마지막 확인
  ];
  return { row, events };
}

module.exports = {
  normalizeSize, pickSize, isSizeWatched, sortSizes, toSnapshot, parsePrevRow,
  statusText, diff, evaluate, NO_RESTOCK_TAG, STATUS_KO,
};
