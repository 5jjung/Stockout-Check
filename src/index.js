// 시즌 신상품 품절 체크 — 실행 시작점
//   npm run check   : 한 번 확인 (GitHub Actions 가 이걸 주기적으로 실행)
//   npm run watch   : 켜 둔 동안 INTERVAL_MINUTES 마다 계속 확인 (PC에서 실시간 감시용)
//   npm run dry     : 시트·슬랙에 아무것도 쓰지 않고 결과만 출력

const { DRY_RUN, WATCH, INTERVAL_MINUTES, TABS, SOURCE, LOW_STOCK_LIMIT, LOW_STOCK_SCOPE, HEARTBEAT, BROWSER_MAX_AGE_MIN } = require('./config');

// 이번 실행의 크롬 수집 상태 (상태 알림용)
const runStats = { chromeSized: null, chromeAgeMin: null };
const { buildRestockIndex, describeRestock } = require('./restock');
const { fetchSeasonListing, listingToRaws } = require('./listing');
const { browserRowToRaw } = require('./browser-data');
const { createSheets } = require('./sheets');
const { fetchProducts, productUrl } = require('./musinsa');
const { toSnapshot, evaluate } = require('./stock');
const { sendSlack, esc } = require('./slack');
const { stamp, sleep } = require('./time');

async function runOnce() {
  const startedAt = Date.now();
  const sheets = createSheets();
  const seasons = await sheets.readSeasons();
  const { products, sizeOrder } = await sheets.readRegistry();

  // 시즌설정에서 ON 인 시즌의 상품만 (같은 상품번호가 두 번 있으면 위쪽 줄 기준)
  const seen = new Set();
  const seasonProducts = products.filter((p) => {
    if (seasons.get(p.season) !== true) return false;
    const key = `${p.season}|${p.goodsNo}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // 감시 OFF(재입고 일정 없음) 상품은 확인하지 않음
  const targets = seasonProducts.filter((p) => p.watch);
  const offProducts = seasonProducts.filter((p) => !p.watch);
  console.log(`[시작] ${stamp()} · 조회 방식: ${{ product: '상세 페이지', listing: '브랜드 목록', auto: '크롬 수집 + 브랜드 목록' }[SOURCE] || SOURCE} · 시즌 ON: ${[...seasons].filter(([, on]) => on).map(([s]) => s).join(', ') || '없음'}`
    + ` · 확인할 상품 ${targets.length}개 (감시 OFF ${offProducts.length}개는 제외)`
    + (DRY_RUN ? ' [DRY-RUN: 시트·슬랙에 쓰지 않음]' : ''));
  if (!seasonProducts.length) return;

  // 1) 무신사 조회
  let raws;
  if (SOURCE === 'product') raws = await fetchByProduct(targets);
  else if (SOURCE === 'listing') raws = await fetchByListing(targets);
  else raws = await fetchAuto(targets, sheets);

  // 재고 부족 체크 범위: 입고일정 탭에 앞으로 입고 일정이 있는 사이즈만
  let restockIndex = null;
  if (LOW_STOCK_SCOPE === 'restock') {
    const rows = await sheets.readRestockTab();
    if (!rows) {
      restockIndex = { bySize: new Map(), unmatched: [], count: 0 };
      console.log(`   [입고일정] '${TABS.restock}' 탭이 없어 재고 부족 알림을 쉽니다.`);
    } else {
      // 무신사 브랜드 품번 (크롬 수집 값, 오래된 값이어도 품번은 그대로라 사용)
      const styleByGoods = new Map();
      for (const [g, r] of await sheets.readBrowserTab()) {
        try { const st = JSON.parse(r[3])?.detail?.styleNo; if (st) styleByGoods.set(g, st); } catch { /* 무시 */ }
      }
      restockIndex = buildRestockIndex(rows, targets, stamp().slice(0, 10), styleByGoods);
      console.log(`   [입고일정] 앞으로의 일정 ${restockIndex.count}건 (바코드로 연결 ${restockIndex.byBarcode}건) · 연결된 상품 ${restockIndex.bySize.size}개 · 품번 아는 상품 ${styleByGoods.size}개`
        + (restockIndex.unmatched.length ? ` · 상품등록에서 못 찾은 제품명: ${restockIndex.unmatched.join(', ')}` : ''));
    }
  }
  const restockFor = (goodsNo) => {
    if (!restockIndex) return null; // 'all' 범위
    const m = restockIndex.bySize.get(goodsNo) || new Map();
    return new Map([...m].map(([size, list]) => [size, describeRestock(list)]));
  };

  // 2) 시즌별로 직전 상태와 비교
  const now = stamp();
  const logRows = [];
  const historyRows = [];
  const slackLines = [];
  const lowStockLines = [];
  let failed = 0;

  for (const season of [...new Set(seasonProducts.map((p) => p.season))]) {
    if (!DRY_RUN) await sheets.ensureSeasonTab(season);
    const tab = await sheets.readSeasonTab(season).catch(() => ({ rows: new Map(), lastRow: 1 }));
    const updates = [];
    let nextRow = tab.lastRow + 1;

    for (const product of targets.filter((p) => p.season === season)) {
      const snap = toSnapshot(raws.get(product.goodsNo), sizeOrder);
      if (snap.error) failed++;
      const prev = tab.rows.get(product.goodsNo);
      const { row, events } = evaluate({ product, prevRow: prev?.values || null, snap, now, lowLimit: LOW_STOCK_LIMIT, restock: restockFor(product.goodsNo) });
      updates.push({ sheetRow: prev ? prev.sheetRow : nextRow++, values: row });

      const url = productUrl(product.goodsNo);
      const name = row[1];
      for (const ev of events) {
        logRows.push([now, ev.label, name, ev.text, url]);
        historyRows.push([now, season, ev.label, product.goodsNo, name, ev.text, url]);
        // 공개 저장소의 실행 기록은 누구나 볼 수 있으므로 입고 일정(내부 정보)은 기록에 남기지 않음
        console.log(`   [${ev.label}] ${product.goodsNo} ${name} — ${ev.lowStock ? ev.text.replace(/ \([^)]*\)/g, '') : ev.text}`);
        if (ev.notify) (ev.lowStock ? lowStockLines : slackLines).push(`• <${url}|${esc(name)}> — *${ev.label}*: ${esc(ev.text)}`);
      }
    }
    // 감시 OFF 상품: 시즌 탭에 이미 줄이 있으면 '감시 안 함'으로만 바꿔 둠 (새 줄은 만들지 않음)
    for (const product of offProducts.filter((p) => p.season === season)) {
      const prev = tab.rows.get(product.goodsNo);
      if (!prev) continue;
      const v = Array.from({ length: 10 }, (_, i) => prev.values[i] ?? '');
      updates.push({ sheetRow: prev.sheetRow, values: [product.goodsNo, v[1] || product.name, '감시 OFF', '⏸ 감시 안 함 (재입고 일정 없음)', '', '', '', v[7], v[8], ''] });
    }
    if (!DRY_RUN) await sheets.writeSeasonRows(season, updates);
    console.log(`   '${season}' 탭 ${updates.length}개 상품 현황 갱신${DRY_RUN ? ' (DRY-RUN: 실제로는 안 씀)' : ''}`);
  }

  // 3) 기록 남기기 + 슬랙
  if (!DRY_RUN) {
    await sheets.appendLog(logRows);
    await sheets.appendHistory(historyRows);
  }
  await sendSlack(`🔔 *시즌 신상품 품절 체크* (${slackLines.length}건)`, slackLines);
  await sendSlack(LOW_STOCK_SCOPE === 'restock'
    ? `📦 *입고 예정 상품 재고 ${LOW_STOCK_LIMIT}개 이하* (${lowStockLines.length}건)`
    : `📦 *재고 ${LOW_STOCK_LIMIT}개 이하 — 재입고 일정 확인 부탁드립니다* (${lowStockLines.length}건)`, lowStockLines);

  // 상태 알림: 변동이 없을 때 "이상 없음" (기본 1시간에 한 번) + 크롬 수집이 멈췄으면 경고
  const kstMinute = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', minute: 'numeric' }).format(new Date()));
  const due = HEARTBEAT === 'every' || (HEARTBEAT === 'hourly' && kstMinute < 10);
  const chromeStale = SOURCE === 'auto' && (runStats.chromeAgeMin === null || runStats.chromeAgeMin > BROWSER_MAX_AGE_MIN);
  const quiet = slackLines.length + lowStockLines.length === 0;
  if (HEARTBEAT !== 'off' && due && (quiet || chromeStale)) {
    const chromeText = SOURCE !== 'auto' ? ''
      : ` · 사이즈 확인 ${runStats.chromeSized}/${targets.length}개 · 크롬 마지막 수집 ${runStats.chromeAgeMin === null ? '없음' : `${runStats.chromeAgeMin}분 전`}`;
    const lines = [
      `• 품절 체크: 감시 상품 ${targets.length}개 · 새 품절/재입고 ${slackLines.length}건 · 조회 실패 ${failed}개`,
      restockIndex
        ? `• 재고 ${LOW_STOCK_LIMIT}개 이하 체크: 입고 예정 상품 ${restockIndex.bySize.size}개 · 새 알림 ${lowStockLines.length}건`
        : `• 재고 ${LOW_STOCK_LIMIT}개 이하 체크: 새 알림 ${lowStockLines.length}건`,
    ];
    if (chromeText) lines.push(`• 크롬 수집${chromeText.replace(/^ · /, ': ')}`);
    if (chromeStale) lines.push('• ⚠️ 크롬 수집이 멈췄습니다 → 사이즈 품절·재고 부족은 확인되지 않고, 상품 전체 품절만 확인 중입니다. 사무실 PC 크롬의 무신사 탭을 확인해 주세요.');
    await sendSlack(`${chromeStale ? '⚠️' : '✅'} *품절 체크 ${quiet ? '이상 없음' : '상태'}* (${now})`, lines);
  }

  const sec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[완료] 변동 ${logRows.length}건 기록 ('${TABS.log}', '${TABS.history}') · 슬랙 ${slackLines.length + lowStockLines.length}건 · 조회 실패 ${failed}건 · ${sec}초`);
  if (targets.length && failed === targets.length) throw new Error('모든 상품 조회에 실패했습니다. 무신사 차단 여부를 확인해 주세요 (README "조회가 전부 실패할 때").');
}

// 상세 페이지 방식: 상품마다 열어서 사이즈별 재고까지 확인
async function fetchByProduct(targets) {
  let done = 0;
  return fetchProducts([...new Set(targets.map((p) => p.goodsNo))], {
    onEach: (g, raw) => {
      done++;
      if (raw.error) console.warn(`   [조회 실패] ${g}: ${raw.error}`);
      if (done % 20 === 0) console.log(`   … ${done}개 확인`);
    },
  });
}

// 목록 방식: 시즌별 브랜드 목록 페이지에서 상품 단위 품절 확인
async function fetchByListing(targets) {
  const raws = new Map();
  for (const season of [...new Set(targets.map((p) => p.season))]) {
    const goodsNos = [...new Set(targets.filter((p) => p.season === season).map((p) => p.goodsNo))];
    let items = new Map();
    try {
      const r = await fetchSeasonListing(season);
      items = r.items;
      for (const line of r.log) console.log(`   [목록 ${season}] ${line}`);
    } catch (e) {
      console.warn(`   [목록 ${season}] 수집 실패: ${e.message.split('\n')[0]}`);
    }
    const { raws: seasonRaws, found } = listingToRaws(goodsNos, items);
    const soldFlag = goodsNos.filter((g) => items.get(g)?.soldOut).length;
    const missing = goodsNos.filter((g) => !items.has(g));
    console.log(`   [목록 ${season}] 등록 상품 ${goodsNos.length}개 중 목록에서 ${found}개 확인 · 품절 표시 ${soldFlag}개 · 목록에 없음 ${missing.length}개`
      + (missing.length ? ` (${missing.slice(0, 15).join(', ')}${missing.length > 15 ? ' …' : ''})` : ''));
    for (const [g, raw] of seasonRaws) raws.set(g, raw);
  }
  return raws;
}

// 자동: 크롬 수집(사이즈별)이 최신인 상품은 그 값, 나머지는 브랜드 목록(상품 단위)
async function fetchAuto(targets, sheets) {
  const browserRows = await sheets.readBrowserTab();
  const raws = await fetchByListing(targets);
  let fromChrome = 0;
  for (const p of targets) {
    const raw = browserRowToRaw(browserRows.get(p.goodsNo));
    if (raw) { raws.set(p.goodsNo, raw); fromChrome++; }
  }
  const latest = Math.max(0, ...[...browserRows.values()].map((r) => Date.parse(r[1])).filter(Number.isFinite));
  runStats.chromeSized = fromChrome;
  runStats.chromeAgeMin = latest ? Math.round((Date.now() - latest) / 60000) : null;
  console.log(`   [크롬 수집] 사이즈별 확인 ${fromChrome}개 / 목록으로만 확인 ${targets.length - fromChrome}개`
    + ` · 마지막 크롬 수집 ${latest ? `${Math.round((Date.now() - latest) / 60000)}분 전` : '없음'}`);
  const withQty = targets.filter((p) => raws.get(p.goodsNo)?.quantity?.size).length;
  console.log(`   [크롬 수집] 남은 수량 정보 있는 상품 ${withQty}개${withQty ? '' : ' (수량 정보가 없으면 재고 부족 알림은 동작하지 않음)'}`);
  // 미리보기(DRY-RUN)일 때 크롬 원본 데이터 몇 개를 그대로 보여줌 (판정 점검용)
  if (DRY_RUN) {
    for (const g of (process.env.DEBUG_GOODS || '6884859,6885281').split(',')) {
      const r = browserRows.get(g.trim());
      if (r) console.log(`   [크롬 원본] ${g} ${String(r[3]).slice(0, 3000)}`);
    }
  }
  // 크롬이 사이즈 옵션을 못 받았을 때 남긴 진단 정보 (원인 파악용)
  for (const r of browserRows.values()) {
    try {
      const d = JSON.parse(r[3]).debug;
      if (d) { console.log(`   [크롬 진단] ${r[0]} ${r[4] || ''}\n${JSON.stringify(d, null, 1).slice(0, 4000)}`); break; }
    } catch { /* 무시 */ }
  }
  if (fromChrome < targets.length) console.log('   (크롬 수집이 없거나 오래된 상품은 상품 전체 품절만 확인합니다. 사무실 PC 크롬에 무신사 탭이 열려 있는지 확인해 주세요)');
  return raws;
}

async function main() {
  if (!WATCH) return runOnce();
  console.log(`[실시간 감시] ${INTERVAL_MINUTES}분마다 확인합니다. 멈추려면 Ctrl+C`);
  for (;;) {
    const t = Date.now();
    try { await runOnce(); } catch (e) { console.error('[오류]', e.message); }
    await sleep(Math.max(10_000, INTERVAL_MINUTES * 60_000 - (Date.now() - t)));
  }
}

main().catch(async (e) => {
  console.error('[실패]', e.message);
  process.exitCode = 1;
  // 실행 자체가 실패하면 바로 슬랙으로 알림
  await sendSlack(`❌ *품절 체크 실행 실패* (${stamp()})`, [`• ${e.message.split('\n')[0]}`]).catch(() => {});
});
