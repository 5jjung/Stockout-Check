const test = require('node:test');
const assert = require('node:assert/strict');
const { toSnapshot, evaluate, parsePrevRow, normalizeSize } = require('../src/stock');
const { collect } = require('../src/musinsa');

const ORDER = ['S', 'M', 'L', 'XL', 'FREE', 'XS'];
const NOW = '2026-11-22 10:00';
const product = (watch, checks) => ({
  goodsNo: '6884871', name: '와플 후드 롱슬리브-네이비', watch, sizeOrder: ORDER,
  sizeChecks: new Map(Object.entries(checks)),
});
const snap = (sizes, status = 'SALE') => ({ name: '와플 후드 롱슬리브-네이비', status, sizes, sizesKnown: true });

test('사이즈 이름 통일', () => {
  assert.equal(normalizeSize(' free '), 'FREE');
  assert.equal(normalizeSize('F'), 'FREE');
  assert.equal(normalizeSize('xl'), 'XL');
});

test('무신사 원본 → 판정 (옵션별 재고)', () => {
  const raw = {
    detail: { goodsSaleType: 'SALE', isOutOfStock: false, goodsNm: 'A' },
    options: [{ no: '1', values: ['M'], active: true }, { no: '2', values: ['L'], active: true }],
    inventory: new Map([['1', true], ['2', false]]),
  };
  assert.deepEqual(toSnapshot(raw, ORDER).sizes, { M: true, L: false });
  const soldOut = { ...raw, detail: { ...raw.detail, isOutOfStock: true } };
  assert.equal(toSnapshot(soldOut, ORDER).status, 'SOLDOUT');
});

test('처음 보는 상품: 체크 해제 사이즈는 무시, 기록만 하고 슬랙 X', () => {
  const { row, events } = evaluate({ product: product(true, { S: false, M: true, L: true }), prevRow: null, snap: snap({ S: false, M: true, L: true }), now: NOW });
  assert.equal(row[3], '✅ 판매중');
  assert.equal(row[4], '');
  assert.equal(row[5], 'M, L');
  assert.equal(events.length, 0);
});

test('판매중 상품의 체크된 사이즈 품절 → 기록 + 슬랙', () => {
  const p = product(true, { S: false, M: true, L: true });
  const prevRow = ['6884871', 'x', '감시 ON', '✅ 판매중', '', 'M, L', '', '', ''];
  const { row, events } = evaluate({ product: p, prevRow, snap: snap({ S: false, M: false, L: true }), now: NOW });
  assert.equal(row[3], '❌ 사이즈 품절');
  assert.equal(row[4], 'M');
  assert.equal(row[6], NOW);
  assert.equal(events.length, 1);
  assert.equal(events[0].label, '품절 발생');
  assert.equal(events[0].text, 'M 품절');
  assert.equal(events[0].notify, true);
});

test('체크 해제 사이즈는 품절·재입고 모두 무시', () => {
  const p = product(true, { S: false, M: true });
  const prevRow = ['6884871', 'x', '감시 ON', '✅ 판매중', '', 'M', '', '', ''];
  let r = evaluate({ product: p, prevRow, snap: snap({ S: false, M: true }), now: NOW });
  assert.equal(r.events.length, 0);
  r = evaluate({ product: p, prevRow: r.row, snap: snap({ S: true, M: true }), now: NOW });
  assert.equal(r.events.length, 0);
  assert.equal(r.row[5], 'M');
});

test('체크된 사이즈 재입고 → 슬랙', () => {
  const p = product(true, { M: true, L: true });
  const prevRow = ['6884871', 'x', '감시 ON', '❌ 사이즈 품절', 'M', 'L', '2026-11-21 09:00', '', ''];
  const { row, events } = evaluate({ product: p, prevRow, snap: snap({ M: true, L: true }), now: NOW });
  assert.equal(row[3], '✅ 판매중');
  assert.equal(row[6], '');
  assert.equal(events[0].label, '재입고');
  assert.equal(events[0].notify, true);
});

test('조회 실패: 기존 값 유지, 변동 없음', () => {
  const prevRow = ['6884871', 'x', '감시 ON', '❌ 사이즈 품절', 'M', 'L', '2026-11-21 09:00', '', ''];
  const { row, events } = evaluate({ product: product(true, {}), prevRow, snap: { error: 'HTTP 403' }, now: NOW });
  assert.deepEqual(row.slice(0, 8), prevRow.slice(0, 8));
  assert.match(row[8], /조회 실패/);
  assert.equal(events.length, 0);
});

test('직전 줄 해석', () => {
  assert.deepEqual(parsePrevRow(['1', 'x', '', '❌ 사이즈 품절', 'S, M', 'L']), { status: 'SALE', sizes: { S: false, M: false, L: true } });
  assert.equal(parsePrevRow(['1', 'x', '', '❓ 조회 실패']), null);
});

test('응답 JSON에서 상품정보·옵션·재고 찾기', () => {
  const found = { detail: null, options: new Map(), inventory: new Map() };
  collect({ data: { goodsNo: 6884871, goodsNm: 'A', goodsSaleType: 'SALE', isOutOfStock: false } }, found, '6884871');
  collect({ data: { basic: [{ no: 11, activated: true, optionValues: [{ no: 101, name: 'M' }] }] } }, found, '6884871');
  collect({ data: [{ productVariantId: 11, outOfStock: true }] }, found, '6884871');
  assert.equal(found.detail.goodsSaleType, 'SALE');
  assert.deepEqual(found.options.get('11').values, ['M']);
  assert.equal(found.inventory.get('11'), false);
});

const { listingToRaws, collectItems: collectListing, seasonTags } = require('../src/listing');

test('목록 방식: 판매중 / 품절 표시 / 목록에서 빠짐', () => {
  assert.deepEqual(seasonTags('26FW'), ['26FALL', '26WINTER']);
  const items = new Map();
  collectListing({ data: { list: [{ goodsNo: 1000001, goodsName: 'A', isSoldOut: false }, { goodsNo: 1000002, goodsName: 'B', isSoldOut: true }] } }, items);
  const { raws } = listingToRaws(['1000001', '1000002', '1000003'], items);
  assert.equal(toSnapshot(raws.get('1000001')).status, 'SALE');
  assert.equal(toSnapshot(raws.get('1000002')).status, 'SOLDOUT');
  assert.equal(toSnapshot(raws.get('1000003')).status, 'SOLDOUT');
  assert.match(toSnapshot(raws.get('1000003')).note, /목록에서 빠짐/);
});

test('목록 방식: 목록이 거의 비면 전부 조회 실패로 처리', () => {
  const { raws } = listingToRaws(['1000001', '1000002', '1000003'], new Map());
  assert.ok(raws.get('1000001').error);
});

const { browserRowToRaw } = require('../src/browser-data');

test('크롬 수집 줄 → 사이즈별 판정, 오래된 값은 무시', () => {
  const stock = {
    detail: { goodsSaleType: 'SALE', isOutOfStock: false, goodsNm: 'A' },
    options: [{ no: 11, activated: true, optionValues: [{ no: 101, name: 'M' }] }, { no: 12, activated: true, optionValues: [{ no: 102, name: 'L' }] }],
    inventory: [{ productVariantId: 11, outOfStock: false }, { productVariantId: 12, outOfStock: true }],
  };
  const now = Date.parse('2026-11-22T08:00:00Z');
  const raw = browserRowToRaw(['1', '2026-11-22T07:55:00Z', '', JSON.stringify(stock), ''], now);
  assert.deepEqual(toSnapshot(raw, ORDER).sizes, { M: true, L: false });
  assert.equal(browserRowToRaw(['1', '2026-11-22T06:00:00Z', '', JSON.stringify(stock), ''], now), null);
  assert.equal(browserRowToRaw(['1', '2026-11-22T07:55:00Z', '', JSON.stringify({ error: 'x' }), 'x'], now), null);
});
