// 시트 '예약발송 SKU 업데이트' 탭 읽기 → 상품번호·사이즈별 앞으로의 입고 일정
//   탭 내용: 예약발송 SKU 파일의 같은 이름 탭을 통째로 넣은 것 (제목줄 위치는 자동으로 찾음)
//   '종료' 표시나 날짜가 지난 줄은 자동으로 빠지므로 앞쪽의 지난 일정은 그대로 둬도 됨
//   필요한 제목: 제품명, 사이즈, 예약발송일, 입고예정일 (있으면 사용: 컬러, 입고수량, 종료여부)
//   상품 연결: 제품명을 상품등록의 상품명과 비교 (띄어쓰기·-·_ 무시)
//             제품명에 색상이 없으면 같은 표에서 컬러 코드로 색상 이름을 찾아 붙임 (예: CH → 차콜)

const { normalizeSize } = require('./stock');

const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\-_./]/g, '');
const hasColor = (name) => /[-_]/.test(String(name));

// 시트 날짜 값 → 'YYYY-MM-DD' (숫자 일련번호 / '2026. 11. 30' / '2026-11-30' 모두 처리)
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const m = String(v).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}
const mmdd = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');

// rows: 탭 전체(제목줄 포함), products: 상품등록 상품 목록, today: 'YYYY-MM-DD'
// → { bySize: Map(상품번호 → Map(사이즈 → [{ship, arrive, qty}])), unmatched: [제품명…], count }
// styleByGoods: Map(상품번호 → 무신사 브랜드 품번) — 있으면 바코드로 먼저 연결 (바코드 = 스타일+컬러 + 사이즈 3자리)
function buildRestockIndex(rows, products, today, styleByGoods = new Map()) {
  const out = { bySize: new Map(), unmatched: [], count: 0 };
  const headerIdx = rows.findIndex((r) => r.some((c) => String(c).trim() === '제품명'));
  if (headerIdx < 0) return out;
  const head = rows[headerIdx].map((c) => String(c ?? '').trim());
  const col = (name) => head.indexOf(name);
  const c = { barcode: col('바코드'), name: col('제품명'), size: col('사이즈'), color: col('컬러'), ship: col('예약발송일'), arrive: col('입고예정일'), qty: col('입고수량'), done: col('종료여부') };
  if (c.name < 0 || c.size < 0) return out;
  const data = rows.slice(headerIdx + 1).filter((r) => String(r[c.name] ?? '').trim() && String(r[c.name]).trim() !== '-');

  // 컬러 코드 → 색상 이름 (제품명이 "상품-색상" 형태인 줄에서 배움)
  const colorName = new Map();
  if (c.color >= 0) {
    for (const r of data) {
      const name = String(r[c.name]);
      if (hasColor(name)) colorName.set(String(r[c.color]).trim(), name.split(/[-_]/).pop().trim());
    }
  }
  const byName = new Map(products.map((p) => [norm(p.name), p.goodsNo]));
  // 정확히 안 맞으면: 상품 이름(앞부분)이 같고 색상이 서로 포함되면 연결 (예: 스카이 블루 ↔ 라이트 스카이 블루). 후보가 하나일 때만.
  const split = (n) => { const i = Math.max(String(n).lastIndexOf('-'), String(n).lastIndexOf('_')); return i < 0 ? [norm(n), ''] : [norm(String(n).slice(0, i)), norm(String(n).slice(i + 1))]; };
  const parts = products.map((p) => ({ goodsNo: p.goodsNo, part: split(p.name) }));
  const findGoods = (name) => {
    const exact = byName.get(norm(name));
    if (exact) return exact;
    const [base, color] = split(name);
    if (!color) return null;
    const hits = parts.filter((x) => x.part[0] === base && x.part[1] && (x.part[1].includes(color) || color.includes(x.part[1])));
    return hits.length === 1 ? hits[0].goodsNo : null;
  };
  const unmatched = new Set();
  // 품번 → 상품번호 (감시 대상 상품만)
  const byStyle = new Map();
  const targetNos = new Set(products.map((p) => p.goodsNo));
  for (const [g, st] of styleByGoods) if (st && targetNos.has(g)) byStyle.set(norm(st), g);
  out.byBarcode = 0;

  for (const r of data) {
    if (c.done >= 0 && String(r[c.done] ?? '').trim() === '종료') continue;
    const ship = c.ship >= 0 ? toDate(r[c.ship]) : null;
    const arrive = c.arrive >= 0 ? toDate(r[c.arrive]) : null;
    const last = [ship, arrive].filter(Boolean).sort().pop();
    if (last && last < today) continue; // 이미 지난 일정

    // 1순위: 바코드 앞부분(스타일+컬러)으로 품번과 연결, 끝 3자리는 사이즈 (예: CBFUW0401KK 0XS)
    const barcode = c.barcode >= 0 ? String(r[c.barcode] ?? '').trim() : '';
    let goodsNo = barcode.length > 3 ? byStyle.get(norm(barcode.slice(0, -3))) : null;
    if (goodsNo) out.byBarcode++;
    // 2순위: 제품명
    let name = String(r[c.name]).trim();
    if (!goodsNo) {
      if (!hasColor(name) && c.color >= 0 && colorName.has(String(r[c.color]).trim())) name = `${name}-${colorName.get(String(r[c.color]).trim())}`;
      goodsNo = findGoods(name);
    }
    if (!goodsNo) { unmatched.add(barcode ? `${name}(${barcode.slice(0, -3)})` : name); continue; }

    const rawSize = barcode.length > 3 && goodsNo && byStyle.size ? barcode.slice(-3) : String(r[c.size]);
    const size = normalizeSize(String(rawSize).replace(/^0+/, ''));
    if (!out.bySize.has(goodsNo)) out.bySize.set(goodsNo, new Map());
    const m = out.bySize.get(goodsNo);
    if (!m.has(size)) m.set(size, []);
    m.get(size).push({ ship, arrive, qty: c.qty >= 0 ? r[c.qty] : '' });
    out.count++;
  }
  for (const m of out.bySize.values()) for (const list of m.values()) list.sort((a, b) => String(a.arrive || a.ship).localeCompare(String(b.arrive || b.ship)));
  out.unmatched = [...unmatched];
  return out;
}

// 알림 문구용: 가장 가까운 일정 "입고 12/3 · 예약발송 12/11"
function describeRestock(entries) {
  const e = entries && entries[0];
  if (!e) return '';
  return [e.arrive && `입고 ${mmdd(e.arrive)}`, e.ship && `예약발송 ${mmdd(e.ship)}`].filter(Boolean).join(' · ');
}

module.exports = { buildRestockIndex, describeRestock, toDate };
