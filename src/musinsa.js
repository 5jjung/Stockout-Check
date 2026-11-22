// 무신사 상품 페이지를 실제 브라우저(Playwright)로 열어서
// 페이지가 스스로 불러오는 상품정보·옵션·재고 데이터를 가로채 읽습니다.
//
// 왜 브라우저로?
//   무신사 상품 API(goods-detail)는 프로그램이 직접 요청하면 403으로 막습니다.
//   브라우저로 페이지를 열면 사람이 볼 때와 같은 방식으로 데이터가 오기 때문에
//   그 응답을 옆에서 읽기만 합니다. (모자란 정보만 페이지 안에서 한 번 더 요청)
//
// 데이터 주소가 바뀌어도 버티도록, 주소가 아니라 "데이터 모양"으로 찾습니다.
//   상품정보 : goodsSaleType 이 들어 있는 객체
//   옵션     : optionValues 배열을 가진 항목들의 배열
//   재고     : productVariantId + outOfStock 을 가진 항목들의 배열

const { chromium } = require('playwright');
const { CONCURRENCY, PAGE_TIMEOUT_MS, DELAY_BETWEEN_MS, HEADLESS, BROWSER_CHANNEL } = require('./config');
const { sleep } = require('./time');

const productUrl = (goodsNo) => `https://www.musinsa.com/products/${goodsNo}`;
const API = 'https://goods-detail.musinsa.com/api2/goods';

async function openBrowser() {
  const browser = await chromium.launch({ headless: HEADLESS, channel: BROWSER_CHANNEL });
  // 헤드리스 표시(HeadlessChrome)가 없는 일반 크롬 User-Agent 사용
  const major = (browser.version().match(/^\d+/) || ['130'])[0];
  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1280, height: 900 },
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  });
  // 이미지·폰트·영상은 받지 않음 (속도/데이터 절약)
  await context.route('**/*', (route) => (
    ['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()
  ));
  return { browser, context };
}

// JSON 안을 훑으며 필요한 데이터 모으기
function collect(json, found, goodsNo, depth = 0) {
  if (!json || typeof json !== 'object' || depth > 8) return;
  if (Array.isArray(json)) {
    const objs = json.filter((x) => x && typeof x === 'object');
    if (objs.length && objs.every((x) => Array.isArray(x.optionValues))) {
      for (const o of objs) {
        const no = String(o.no ?? o.optionNo ?? o.productVariantId ?? '');
        found.options.set(no || `idx${found.options.size}`, {
          no,
          values: o.optionValues.map((v) => v?.name ?? v?.optionValueName ?? v?.value ?? ''),
          valueNos: o.optionValues.map((v) => v?.no).filter((x) => x != null),
          active: o.activated !== false,
          isDeleted: o.isDeleted === true,
          outOfStock: typeof o.outOfStock === 'boolean' ? o.outOfStock
            : typeof o.isSoldOut === 'boolean' ? o.isSoldOut : undefined,
        });
      }
      return;
    }
    if (objs.length && objs.every((x) => 'productVariantId' in x && 'outOfStock' in x)) {
      for (const x of objs) found.inventory.set(String(x.productVariantId), x.outOfStock === false);
      return;
    }
    for (const x of objs) collect(x, found, goodsNo, depth + 1);
    return;
  }
  if (typeof json.goodsSaleType === 'string' && (json.goodsNo == null || String(json.goodsNo) === goodsNo)) {
    if (!found.detail || (!found.detail.goodsNm && json.goodsNm)) {
      found.detail = { goodsSaleType: json.goodsSaleType, isOutOfStock: json.isOutOfStock === true, goodsNm: json.goodsNm || '' };
    }
  }
  for (const v of Object.values(json)) if (v && typeof v === 'object') collect(v, found, goodsNo, depth + 1);
}

// 페이지 안에서(브라우저 쿠키 그대로) 직접 요청 — 페이지가 안 불러온 정보만 보충
async function fetchInPage(page, url, body) {
  return page.evaluate(async ({ url, body }) => {
    try {
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }, { url, body });
}

// 상품 하나 조회 → stock.toSnapshot() 이 읽는 원본 형태
async function fetchProduct(context, goodsNo, { debug = false } = {}) {
  const found = { detail: null, options: new Map(), inventory: new Map(), urls: [] };
  const page = await context.newPage();
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!/musinsa\.com/.test(url) || !(res.headers()['content-type'] || '').includes('json')) return;
      found.urls.push(`${res.status()} ${url}`);
      if (res.ok()) collect(await res.json(), found, goodsNo);
    } catch { /* 페이지 닫힌 뒤 도착한 응답 등은 무시 */ }
  });
  try {
    const res = await page.goto(productUrl(goodsNo), { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    const code = res ? res.status() : 0;
    if (code === 404) return { gone: true };
    if (code >= 400) return { error: `상품 페이지 HTTP ${code}` };
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    if (!found.detail) collect(await fetchInPage(page, `${API}/${goodsNo}`), found, goodsNo);
    if (!found.options.size) collect(await fetchInPage(page, `${API}/${goodsNo}/v2/options?goodsSaleType=SALE`), found, goodsNo);
    if (found.options.size && !found.inventory.size && ![...found.options.values()].every((o) => typeof o.outOfStock === 'boolean')) {
      const optionValueNos = [...new Set([...found.options.values()].flatMap((o) => o.valueNos))];
      // 재고 주소는 무신사 사정에 따라 바뀔 수 있음 → npm run probe 로 실제 주소 확인
      collect(await fetchInPage(page, `${API}/${goodsNo}/options/v2/prioritized-inventories`, { optionValueNos }), found, goodsNo);
    }

    // 페이지 자체가 "없는 상품" 화면인지 확인
    if (!found.detail) {
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/존재하지\s*않는\s*상품|삭제된\s*상품/.test(text)) return { gone: true };
    }
    const raw = { detail: found.detail, options: [...found.options.values()], inventory: found.inventory };
    if (debug) raw.debugUrls = found.urls;
    return raw;
  } catch (e) {
    return { error: e.message.split('\n')[0] };
  } finally {
    await page.close().catch(() => {});
  }
}

// 여러 상품을 CONCURRENCY 개씩 나눠 조회 → Map(상품번호 → 원본)
async function fetchProducts(goodsNos, { onEach } = {}) {
  const { browser, context } = await openBrowser();
  const results = new Map();
  const queue = [...goodsNos];
  try {
    const worker = async () => {
      while (queue.length) {
        const g = queue.shift();
        const raw = await fetchProduct(context, g);
        results.set(g, raw);
        if (onEach) onEach(g, raw);
        await sleep(DELAY_BETWEEN_MS);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  } finally {
    await browser.close().catch(() => {});
  }
  return results;
}

module.exports = { openBrowser, fetchProduct, fetchProducts, productUrl, collect };
