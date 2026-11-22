// 상품 하나를 열어 무신사에서 어떤 데이터를 받았는지 보여주는 점검 도구
//   사용법: npm run probe -- 6885281
//   시트에는 아무것도 쓰지 않습니다. 조회가 이상할 때 원인 확인용.

const { openBrowser, fetchProduct } = require('../src/musinsa');
const { toSnapshot } = require('../src/stock');

(async () => {
  const goodsNo = process.argv[2] || '6885281';
  const { browser, context } = await openBrowser();
  try {
    const raw = await fetchProduct(context, goodsNo, { debug: true });
    console.log(`\n[받은 JSON 응답 주소] (${(raw.debugUrls || []).length}개)`);
    for (const u of raw.debugUrls || []) console.log('  ', u);
    console.log('\n[상품정보]', JSON.stringify(raw.detail || raw.error || (raw.gone && '삭제됨')));
    console.log('[옵션]', JSON.stringify(raw.options || []));
    console.log('[재고]', JSON.stringify([...(raw.inventory || new Map())]));
    console.log('\n[판정 결과]', JSON.stringify(toSnapshot(raw, ['S', 'M', 'L', 'XL', 'FREE', 'XS']), null, 2));
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
