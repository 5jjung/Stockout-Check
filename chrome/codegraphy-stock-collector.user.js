// ==UserScript==
// @name         코드그라피 사이즈 품절 수집
// @namespace    stockout-check
// @version      1.3.0
// @description  무신사 탭이 열려 있는 동안 10분마다 감시 상품의 사이즈별 재고를 확인해 구글 시트에 적습니다.
// @match        https://www.musinsa.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @updateURL    https://raw.githubusercontent.com/5jjung/Stockout-Check/main/chrome/codegraphy-stock-collector.user.js
// @downloadURL  https://raw.githubusercontent.com/5jjung/Stockout-Check/main/chrome/codegraphy-stock-collector.user.js
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ───── 설정 ─────
  // 코드에 직접 쓰지 않고, Tampermonkey 메뉴 "설정 입력 (웹앱 주소·토큰)"으로 넣습니다.
  // (그래야 스크립트가 자동 업데이트돼도 설정이 지워지지 않음)
  const cfg = () => ({ url: GM_getValue('webappUrl', ''), token: GM_getValue('token', '') });
  // ────────────────
  const INTERVAL_MIN = 10;   // 몇 분마다 확인할지
  const PARALLEL = 2;        // 동시에 확인하는 상품 수
  const API = 'https://goods-detail.musinsa.com/api2/goods';

  if (window.top !== window.self) return; // 페이지 안 작은 창(iframe)에서는 실행 안 함

  // 무신사 탭을 여러 개 열어도 한 탭만 수집하도록 (2분간 신호 없으면 다른 탭이 이어받음)
  const TAB_ID = Math.random().toString(36).slice(2);
  const isLeader = (force = false) => {
    const lock = GM_getValue('leader', null);
    if (force || !lock || lock.id === TAB_ID || Date.now() - lock.t > 90000) {
      GM_setValue('leader', { id: TAB_ID, t: Date.now() });
      return true;
    }
    return false;
  };
  setInterval(() => { const l = GM_getValue('leader', null); if (l && l.id === TAB_ID) GM_setValue('leader', { id: TAB_ID, t: Date.now() }); }, 30000);
  // 탭을 닫거나 새로고침하면 수집 담당을 바로 내려놓음 (다른 탭·새 페이지가 즉시 이어받음)
  window.addEventListener('pagehide', () => { const l = GM_getValue('leader', null); if (l && l.id === TAB_ID) GM_setValue('leader', null); });

  // 화면 오른쪽 아래 작은 상태 표시
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;background:#111;color:#fff;font:12px/1.4 sans-serif;padding:6px 10px;border-radius:6px;opacity:.85;pointer-events:none;max-width:320px';
  const show = (t) => { badge.textContent = `품절수집 v${GM_info.script.version} · ${t}`; if (!badge.isConnected) document.body.appendChild(badge); };

  // 구글 시트(웹앱) 통신
  function webapp(method, payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: method === 'GET' ? `${cfg().url}?token=${encodeURIComponent(cfg().token)}` : cfg().url,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        data: method === 'POST' ? JSON.stringify({ token: cfg().token, rows: payload }) : undefined,
        onload: (r) => { try { const j = JSON.parse(r.responseText); j.ok ? resolve(j) : reject(new Error(j.error)); } catch (e) { reject(new Error(`웹앱 응답 오류 (${r.status})`)); } },
        onerror: () => reject(new Error('웹앱 연결 실패')),
        ontimeout: () => reject(new Error('웹앱 시간 초과')),
        timeout: 60000,
      });
    });
  }

  // 무신사 데이터 요청 (이 탭의 로그인·쿠키 그대로 사용)
  async function get(url, body) {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return { status: 404 };
    if (!res.ok) return { status: res.status };
    return { status: 200, json: await res.json() };
  }

  // JSON 안에서 옵션 목록·재고 목록을 "모양"으로 찾기 (주소/구조가 조금 바뀌어도 동작)
  function find(json, test, depth = 0) {
    if (!json || typeof json !== 'object' || depth > 8) return null;
    if (Array.isArray(json)) {
      const objs = json.filter((x) => x && typeof x === 'object');
      if (objs.length && objs.every(test)) return objs;
      for (const x of objs) { const f = find(x, test, depth + 1); if (f) return f; }
      return null;
    }
    for (const v of Object.values(json)) { const f = find(v, test, depth + 1); if (f) return f; }
    return null;
  }
  // 조건에 맞는 배열을 전부 찾기 (옵션 "묶음"과 실제 "사이즈별 항목"이 둘 다 optionValues 를 가짐)
  function findAll(json, test, out = [], depth = 0) {
    if (!json || typeof json !== 'object' || depth > 8) return out;
    if (Array.isArray(json)) {
      const objs = json.filter((x) => x && typeof x === 'object');
      if (objs.length && objs.every(test)) { out.push(objs); return out; }
      for (const x of objs) findAll(x, test, out, depth + 1);
      return out;
    }
    for (const v of Object.values(json)) findAll(v, test, out, depth + 1);
    return out;
  }
  function findDetail(json, goodsNo, depth = 0) {
    if (!json || typeof json !== 'object' || depth > 8) return null;
    if (!Array.isArray(json) && typeof json.goodsSaleType === 'string' && (json.goodsNo == null || String(json.goodsNo) === goodsNo)) return json;
    for (const v of Object.values(json)) { const f = findDetail(v, goodsNo, depth + 1); if (f) return f; }
    return null;
  }

  const isOption = (x) => Array.isArray(x.optionValues);
  const isInventory = (x) => 'productVariantId' in x && 'outOfStock' in x;
  const keysOf = (j) => (j && typeof j === 'object' ? JSON.stringify(j).slice(0, 200) : '');

  // 옵션 주소 후보 ({g}=상품번호, {t}=판매상태). 실제로 되는 주소를 찾으면 기억해 두고 계속 씀
  const OPTION_URLS = [
    `${API}/{g}/options?goodsSaleType={t}`,
    `${API}/{g}/v2/options?goodsSaleType={t}`,
    `${API}/{g}/options`,
    `${API}/{g}/v2/options`,
  ];
  const fill = (tpl, g, t) => tpl.split('{g}').join(g).split('{t}').join(encodeURIComponent(t));

  // 상품 페이지 HTML 안의 데이터(JSON)에서 찾기
  async function fromPageHtml(goodsNo, test) {
    try {
      const html = await (await fetch(`/products/${goodsNo}`, { credentials: 'include' })).text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const sc of doc.querySelectorAll('script')) {
        const txt = sc.textContent.trim();
        if (!txt.startsWith('{') && !txt.startsWith('[')) continue;
        try { const f = find(JSON.parse(txt), test); if (f && f.length) return f; } catch { /* 무시 */ }
      }
    } catch { /* 무시 */ }
    return null;
  }

  // 실제 상품 페이지를 보이지 않는 작은 창에 열어, 페이지가 부른 데이터 주소 목록 얻기
  function discoverUrls(goodsNo) {
    return new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-20px;bottom:0;width:10px;height:10px;opacity:0;border:0';
      f.src = `/products/${goodsNo}`;
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        let urls = [];
        try {
          urls = f.contentWindow.performance.getEntriesByType('resource').map((e) => e.name)
            .filter((u) => /musinsa\.com/.test(u) && !/\.(js|css|png|jpe?g|gif|webp|svg|woff2?|ico)(\?|$)/i.test(u));
        } catch (e) { urls = [`ERR ${e.message}`]; }
        f.remove();
        resolve({ goodsNo, urls: [...new Set(urls)] });
      };
      f.onload = () => setTimeout(finish, 8000);
      setTimeout(finish, 25000);
      document.body.appendChild(f);
    });
  }

  let discovering = null; // 한 번 실행에 한 번만 찾음
  let optionFailures = 0;  // 이번 실행에서 옵션 찾기 실패 횟수 (3번 넘으면 나머지는 시도하지 않음 — 서버 배려)
  async function getOptions(goodsNo, saleType, debug) {
    const learned = GM_getValue('optionUrlTpl', null);
    if (optionFailures >= 3) { debug.tried.push('건너뜀 (앞 상품들에서 옵션 주소를 못 찾음)'); return null; }
    const result = await findOptionsFor(goodsNo, saleType, debug, learned);
    if (!result) optionFailures++;
    return result;
  }
  async function findOptionsFor(goodsNo, saleType, debug, learned) {
    const tpls = [...new Set([learned, ...OPTION_URLS].filter(Boolean))];
    for (const tpl of tpls) {
      const r = await get(fill(tpl, goodsNo, saleType));
      const opts = r.json && find(r.json, isOption);
      if (opts && opts.length) { if (tpl !== learned) GM_setValue('optionUrlTpl', tpl); return { opts, json: r.json }; }
      debug.tried.push(`${r.status} ${fill(tpl, goodsNo, saleType)} ${keysOf(r.json)}`);
    }
    const inHtml = await fromPageHtml(goodsNo, isOption);
    if (inHtml) return { opts: inHtml, json: null };
    // 마지막 방법: 실제 페이지가 부르는 주소에서 찾기
    if (!discovering) discovering = discoverUrls(goodsNo);
    const disc = await discovering;
    debug.discovered = disc.urls;
    // 다른 탭 작업이 그새 주소를 찾았으면 그걸로
    const nowLearned = GM_getValue('optionUrlTpl', null);
    if (nowLearned && nowLearned !== learned) {
      const r = await get(fill(nowLearned, goodsNo, saleType));
      const opts = r.json && find(r.json, isOption);
      if (opts && opts.length) return { opts, json: r.json };
    }
    // 찾은 상품번호가 들어간 데이터 주소를 이 상품번호로 바꿔 전부 시험 (상품 페이지·상세 주소 제외)
    const cands = disc.urls
      .filter((x) => x.includes(disc.goodsNo) && !/\/products\//.test(x) && x !== `${API}/${disc.goodsNo}`)
      .map((x) => x.split(disc.goodsNo).join(goodsNo));
    for (const u of cands.slice(0, 15)) {
      const r = await get(u);
      const opts = r.json && find(r.json, isOption);
      debug.tried.push(`${r.status} ${u} ${keysOf(r.json)}`);
      if (opts && opts.length) {
        GM_setValue('optionUrlTpl', u.split(goodsNo).join('{g}'));
        return { opts, json: r.json };
      }
    }
    return null;
  }

  // 상품 하나 확인 → 시트에 적을 재고 데이터
  async function collect(goodsNo) {
    const d = await get(`${API}/${goodsNo}`);
    if (d.status === 404) return { gone: true };
    if (d.status !== 200) return { error: `상세 HTTP ${d.status}` };
    const detail = findDetail(d.json, goodsNo);
    if (!detail) return { error: '상세 정보 없음' };
    const base = { detail: { goodsSaleType: detail.goodsSaleType, isOutOfStock: detail.isOutOfStock === true, goodsNm: detail.goodsNm || '' } };
    if (detail.goodsSaleType !== 'SALE' || detail.isOutOfStock === true) return { ...base, options: [], inventory: [] }; // 전체 품절·판매중지는 옵션 볼 필요 없음

    const debug = { tried: [] };
    const found = await getOptions(goodsNo, detail.goodsSaleType, debug);
    if (!found) return { ...base, options: [], inventory: [], error: '사이즈 옵션을 받지 못함', debug };
    // 재고: 옵션 응답 안에 같이 있으면 그걸, 없으면 재고 주소에 따로 요청
    const groups = found.json ? findAll(found.json, isOption) : [found.opts];
    const allValueNos = [...new Set(groups.flat().flatMap((x) => x.optionValues.map((v) => v.no)).filter((v) => v != null))];
    let inventory = (found.json && find(found.json, isInventory)) || [];
    if (!inventory.length) {
      const inv = await get(`${API}/${goodsNo}/options/v2/prioritized-inventories`, { optionValueNos: allValueNos });
      inventory = (inv.json && find(inv.json, isInventory)) || [];
      if (!inventory.length) debug.tried.push(`${inv.status} 재고 POST prioritized-inventories ${keysOf(inv.json)}`);
    }
    // 실제 사이즈별 항목 고르기: 재고 번호(productVariantId)와 번호가 맞는 목록
    //  (예: basic=[{사이즈 묶음: S,M,L}] 은 묶음이라 재고와 번호가 안 맞음 → optionItems 같은 목록을 씀)
    const invIds = new Set(inventory.map((x) => String(x.productVariantId)));
    const options = groups.find((g) => g.some((x) => invIds.has(String(x.no))))
      || groups.slice().sort((a, b) => b.length - a.length)[0];
    const optStock = (x) => (typeof x.outOfStock === 'boolean' ? x.outOfStock : typeof x.isSoldOut === 'boolean' ? x.isSoldOut : undefined);
    const stock = {
      ...base,
      options: options.map((x) => ({
        no: x.no, managedCode: x.managedCode, activated: x.activated, isDeleted: x.isDeleted, outOfStock: optStock(x),
        optionValues: x.optionValues.map((v) => ({ no: v.no, name: v.name })),
      })),
      inventory: inventory.map((x) => ({ productVariantId: x.productVariantId, outOfStock: x.outOfStock })),
    };
    // 재고 번호와 맞는 사이즈 항목이 하나도 없으면 판정 불가 (잘못된 품절 방지)
    if (stock.inventory.length && !stock.options.some((x) => invIds.has(String(x.no)))) {
      stock.error = '옵션과 재고 번호가 맞지 않음';
      stock.debug = { ...debug, groups: groups.map((g) => g.slice(0, 3)), inventorySample: inventory.slice(0, 3) };
      return stock;
    }
    if (!stock.inventory.length && !stock.options.every((x) => typeof x.outOfStock === 'boolean')) {
      stock.error = '옵션별 재고를 받지 못함';
      stock.debug = debug;
    }
    return stock;
  }

  let running = false;
  async function run(force = false) {
    if (running) return;
    if (!cfg().url || !cfg().token) { show('설정 필요: Tampermonkey 메뉴 → 설정 입력'); return; }
    if (!isLeader(force)) { show('다른 무신사 탭에서 수집 중 · 이 탭은 대기'); return; }
    running = true;
    discovering = null;
    optionFailures = 0;
    const started = new Date();
    try {
      show('상품 목록 받는 중…');
      const { goodsNos } = await webapp('GET');
      const rows = [];
      let ok = 0; let fail = 0;
      const queue = [...goodsNos];
      await Promise.all(Array.from({ length: PARALLEL }, async () => {
        while (queue.length) {
          const g = queue.shift();
          let stock;
          try { stock = await collect(g); } catch (e) { stock = { error: e.message }; }
          if (stock.error) fail++; else ok++;
          rows.push([g, new Date().toISOString(), '', JSON.stringify(stock), stock.error || '']);
          show(`확인 중 ${ok + fail}/${goodsNos.length}`);
        }
      }));
      for (let i = 0; i < rows.length; i += 40) await webapp('POST', rows.slice(i, i + 40));
      const next = new Date(started.getTime() + INTERVAL_MIN * 60000);
      show(`${started.toTimeString().slice(0, 5)} 완료 · 성공 ${ok} / 실패 ${fail} · 다음 ${next.toTimeString().slice(0, 5)}`);
      GM_setValue('lastRun', { t: Date.now(), ok, fail });
    } catch (e) {
      show(`오류: ${e.message}`);
    } finally {
      running = false;
    }
  }

  GM_registerMenuCommand('지금 바로 수집', () => run(true));
  GM_registerMenuCommand('설정 입력 (웹앱 주소·토큰)', () => {
    const url = prompt('Apps Script 웹 앱 URL (https://script.google.com/macros/s/…/exec)', cfg().url);
    if (url === null) return;
    const token = prompt('토큰 (Apps Script setup 실행 로그에 나온 값)', cfg().token);
    if (token === null) return;
    GM_setValue('webappUrl', url.trim());
    GM_setValue('token', token.trim());
    run(true);
  });

  // 1분마다 "할 차례인지" 확인 → 마지막 수집 후 INTERVAL_MIN 이 지났으면 수집
  //  (탭을 새로고침하거나 여러 개 열어도 늦어지지 않음)
  const tick = () => {
    const last = GM_getValue('lastRun', null);
    const due = !last || Date.now() - last.t >= INTERVAL_MIN * 60000;
    if (due) run();
    else if (!running) {
      const l = GM_getValue('lastRun', null);
      const mins = Math.max(0, Math.ceil((INTERVAL_MIN * 60000 - (Date.now() - l.t)) / 60000));
      show(`마지막 ${new Date(l.t).toTimeString().slice(0, 5)} · 성공 ${l.ok} / 실패 ${l.fail} · 약 ${mins}분 후 다시 확인`);
    }
  };
  show('시작 준비 중…');
  setTimeout(tick, 3000);
  setInterval(tick, 60000);
})();
