// 무신사 브랜드 목록 페이지로 상품 품절 확인 (상품 단위)
//   상세 페이지는 GitHub 서버에서 막히므로, 브랜드 목록 페이지에서
//   - 목록에 있고 품절 표시 없음 → 판매중
//   - 목록에 품절 표시                → 전체 품절
//   - 목록에서 빠짐                    → 품절로 추정 (무신사 목록은 품절 상품을 숨김)
//   사이즈별 품절은 이 방식으로는 알 수 없습니다.

const { openBrowser } = require('./musinsa');
const { PAGE_TIMEOUT_MS } = require('./config');

const BRAND = process.env.MUSINSA_BRAND || 'codegraphy';
const listingUrl = (tag) => `https://www.musinsa.com/brand/${BRAND}/products?${tag ? `tag=${tag}&` : ''}gf=A`;

// 시즌 → 무신사 목록 태그 (26FW → 26FALL, 26WINTER / 27SS → 27SPRING, 27SUMMER)
function seasonTags(season) {
  const yy = season.slice(0, 2);
  return season.endsWith('FW') ? [`${yy}FALL`, `${yy}WINTER`] : [`${yy}SPRING`, `${yy}SUMMER`];
}

const SOLD_KEYS = ['isSoldOut', 'soldOut', 'isOutOfStock'];

// 목록 데이터(JSON)에서 상품번호와 품절 표시 찾기
function collectItems(json, items, depth = 0) {
  if (!json || typeof json !== 'object' || depth > 8) return;
  if (Array.isArray(json)) { for (const x of json) collectItems(x, items, depth + 1); return; }
  const no = json.goodsNo ?? json.goodsId;
  if (no != null && /^\d{5,}$/.test(String(no))) {
    const key = String(no);
    const prev = items.get(key) || {};
    const flag = SOLD_KEYS.map((k) => json[k]).find((v) => typeof v === 'boolean');
    items.set(key, {
      name: prev.name || json.goodsName || json.goodsNm || '',
      soldOut: flag ?? prev.soldOut,
      from: 'json',
    });
  }
  for (const v of Object.values(json)) if (v && typeof v === 'object') collectItems(v, items, depth + 1);
}

// 시즌 목록 수집 → { items: Map(상품번호 → {name, soldOut}), log: [...] }
async function fetchSeasonListing(season) {
  const { browser, context } = await openBrowser();
  const items = new Map();
  const log = [];
  try {
    const page = await context.newPage();
    page.on('response', async (res) => {
      try {
        if (!/musinsa\.com/.test(res.url()) || !(res.headers()['content-type'] || '').includes('json') || !res.ok()) return;
        collectItems(await res.json(), items);
      } catch { /* 무시 */ }
    });
    for (const tag of seasonTags(season)) {
      const before = items.size;
      const res = await page.goto(listingUrl(tag), { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
      const status = res ? res.status() : 0;
      if (status >= 400) { log.push(`${tag}: HTTP ${status}`); continue; }
      await page.waitForSelector('a[href*="/products/"]', { timeout: 20000 }).catch(() => {});
      // 아래로 내리며 화면에 나온 상품 링크 모으기 (목록이 스크롤로 더 불러옴)
      let stable = 0; let last = -1;
      for (let round = 0; round < 60 && stable < 4; round++) {
        const links = await page.$$eval('a[href*="/products/"]', (as) => as.map((a) => {
          const m = (a.getAttribute('href') || '').match(/\/products\/(\d+)/);
          if (!m) return null;
          const box = a.closest('li, [class*="item"], [class*="Item"]') || a;
          const text = box.innerText || '';
          // 상품 칸 하나의 글자만 볼 것 (칸을 못 찾아 목록 전체를 잡은 경우는 무시)
          return { no: m[1], name: a.querySelector('img')?.getAttribute('alt') || '', soldText: text.length < 400 && /(^|\s)(품절|SOLD\s*OUT)(\s|$)/i.test(text) };
        }).filter(Boolean));
        for (const l of links) {
          const prev = items.get(l.no) || {};
          items.set(l.no, { name: prev.name || l.name, soldOut: prev.soldOut ?? (l.soldText || undefined), from: prev.from || 'page' });
        }
        if (items.size === last) stable++; else { stable = 0; last = items.size; }
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
        await page.waitForTimeout(1000);
      }
      log.push(`${tag}: ${items.size - before}개 추가 (누적 ${items.size})`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { items, log };
}

// 목록 결과 → 상품별 원본 (stock.toSnapshot 이 읽는 형태)
function listingToRaws(goodsNos, items, minFoundRatio = 0.5) {
  const raws = new Map();
  const found = goodsNos.filter((g) => items.has(g)).length;
  // 목록이 비정상적으로 적게 잡혔으면(차단·페이지 변경) 전부 "조회 실패" → 잘못된 품절 기록 방지
  if (!goodsNos.length || found / goodsNos.length < minFoundRatio) {
    const reason = `목록에서 ${found}/${goodsNos.length}개만 확인됨 (목록 수집 이상)`;
    for (const g of goodsNos) raws.set(g, { error: reason });
    return { raws, found };
  }
  for (const g of goodsNos) {
    const it = items.get(g);
    if (!it) raws.set(g, { detail: { goodsSaleType: 'SOLDOUT', goodsNm: '' }, options: [], note: '목록에서 빠짐 → 품절 추정' });
    else raws.set(g, { detail: { goodsSaleType: it.soldOut ? 'SOLDOUT' : 'SALE', goodsNm: it.name }, options: [], note: it.soldOut ? '목록 품절 표시' : '목록 확인' });
  }
  return { raws, found };
}

module.exports = { fetchSeasonListing, listingToRaws, seasonTags, collectItems };
