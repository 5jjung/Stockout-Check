// 크롬 수집 스크립트가 '브라우저_수집' 탭에 적어 둔 사이즈별 재고 읽기
//   열: A 상품번호 / B 수집 시각(ISO) / C 보는 사람 수 / D 재고 데이터(JSON) / E 오류
//   수집 시각이 BROWSER_MAX_AGE_MIN 보다 오래됐으면 쓰지 않음
//   (그 상품은 브랜드 목록 방식으로 상품 단위만 확인)

const { BROWSER_MAX_AGE_MIN } = require('./config');

// 재고 항목에서 "남은 수량"으로 볼 수 있는 값 이름 (무신사 응답에 있는 것만 사용)
const QTY_KEYS = ['remainQuantity', 'remainingQuantity', 'stockQuantity', 'availableQuantity', 'quantity', 'remainCount', 'stock'];
const qtyOf = (x) => { for (const k of QTY_KEYS) if (typeof x[k] === 'number') return x[k]; return undefined; };

// 시트 한 줄 → stock.toSnapshot() 이 읽는 원본. 쓸 수 없으면 null
function browserRowToRaw(row, nowMs = Date.now()) {
  if (!row) return null;
  const t = Date.parse(row[1]);
  if (!Number.isFinite(t) || nowMs - t > BROWSER_MAX_AGE_MIN * 60000) return null; // 오래된 값
  let s;
  try { s = JSON.parse(row[3]); } catch { return null; }
  if (!s || s.error) return null;
  if (s.gone) return { gone: true, note: '크롬 확인' };
  if (!s.detail) return null;
  // 판매중인데 사이즈 옵션이 없으면 사이즈 정보가 없는 것 → 쓰지 않음 (목록 방식으로 대신 확인)
  const onSale = s.detail.goodsSaleType === 'SALE' && s.detail.isOutOfStock !== true;
  if (onSale && !(s.options || []).length) return null;
  return {
    detail: s.detail,
    options: (s.options || []).map((o) => ({
      no: String(o.no ?? ''),
      values: (o.optionValues || []).map((v) => v?.name ?? ''),
      active: o.activated !== false,
      isDeleted: o.isDeleted === true,
      outOfStock: typeof o.outOfStock === 'boolean' ? o.outOfStock : undefined,
    })),
    inventory: new Map((s.inventory || []).map((x) => [String(x.productVariantId), x.outOfStock === false])),
    quantity: new Map((s.inventory || []).filter((x) => qtyOf(x) !== undefined).map((x) => [String(x.productVariantId), qtyOf(x)])),
    note: '',
  };
}

module.exports = { browserRowToRaw, qtyOf };
