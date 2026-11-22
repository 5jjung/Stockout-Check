// 시즌 신상품 품절 체크 — 실행 시작점
//   npm run check   : 한 번 확인 (GitHub Actions 가 이걸 주기적으로 실행)
//   npm run watch   : 켜 둔 동안 INTERVAL_MINUTES 마다 계속 확인 (PC에서 실시간 감시용)
//   npm run dry     : 시트·슬랙에 아무것도 쓰지 않고 결과만 출력

const { DRY_RUN, WATCH, INTERVAL_MINUTES, TABS, SOURCE } = require('./config');
const { fetchSeasonListing, listingToRaws } = require('./listing');
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
  console.log(`[시작] ${stamp()} · 조회 방식: ${SOURCE === 'product' ? '상세 페이지(사이즈별)' : '브랜드 목록(상품 단위)'} · 시즌 ON: ${[...seasons].filter(([, on]) => on).map(([s]) => s).join(', ') || '없음'}`
    + ` · 확인할 상품 ${targets.length}개 (감시 OFF ${offProducts.length}개는 제외)`
    + (DRY_RUN ? ' [DRY-RUN: 시트·슬랙에 쓰지 않음]' : ''));
  if (!seasonProducts.length) return;

  // 1) 무신사 조회
  const raws = SOURCE === 'product' ? await fetchByProduct(targets) : await fetchByListing(targets);

  // 2) 시즌별로 직전 상태와 비교
  const now = stamp();
  const logRows = [];
  const historyRows = [];
  const slackLines = [];
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
      const { row, events } = evaluate({ product, prevRow: prev?.values || null, snap, now });
      updates.push({ sheetRow: prev ? prev.sheetRow : nextRow++, values: row });

      const url = productUrl(product.goodsNo);
      const name = row[1];
      for (const ev of events) {
        logRows.push([now, ev.label, name, ev.text, url]);
        historyRows.push([now, season, ev.label, product.goodsNo, name, ev.text, url]);
        console.log(`   [${ev.label}] ${product.goodsNo} ${name} — ${ev.text}`);
        if (ev.notify) slackLines.push(`• <${url}|${esc(name)}> — *${ev.label}*: ${esc(ev.text)}`);
      }
    }
    // 감시 OFF 상품: 시즌 탭에 이미 줄이 있으면 '감시 안 함'으로만 바꿔 둠 (새 줄은 만들지 않음)
    for (const product of offProducts.filter((p) => p.season === season)) {
      const prev = tab.rows.get(product.goodsNo);
      if (!prev) continue;
      const v = Array.from({ length: 9 }, (_, i) => prev.values[i] ?? '');
      updates.push({ sheetRow: prev.sheetRow, values: [product.goodsNo, v[1] || product.name, '감시 OFF', '⏸ 감시 안 함 (재입고 일정 없음)', '', '', '', v[7], v[8]] });
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

  const sec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[완료] 변동 ${logRows.length}건 기록 ('${TABS.log}', '${TABS.history}') · 슬랙 ${slackLines.length}건 · 조회 실패 ${failed}건 · ${sec}초`);
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
  for (const season of [...new Set(seasonProducts.map((p) => p.season))]) {
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

async function main() {
  if (!WATCH) return runOnce();
  console.log(`[실시간 감시] ${INTERVAL_MINUTES}분마다 확인합니다. 멈추려면 Ctrl+C`);
  for (;;) {
    const t = Date.now();
    try { await runOnce(); } catch (e) { console.error('[오류]', e.message); }
    await sleep(Math.max(10_000, INTERVAL_MINUTES * 60_000 - (Date.now() - t)));
  }
}

main().catch((e) => { console.error('[실패]', e.message); process.exitCode = 1; });
