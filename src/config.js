// 설정은 이 파일 한 곳에서만 관리합니다.
// 숫자/이름을 바꾸고 싶으면 여기만 고치면 됩니다.

const args = process.argv.slice(2);

module.exports = {
  // 구글 시트 ID (GitHub Secrets 또는 .env 의 SPREADSHEET_ID)
  SPREADSHEET_ID: (process.env.SPREADSHEET_ID || '').trim(),

  // 시트 탭 이름 (시트에 있는 이름과 똑같아야 합니다)
  TABS: {
    seasons: '시즌설정',     // A 시즌 / B 감시 ON/OFF / C 설명
    registry: '상품등록',    // A 시즌 / B 상품번호 / C 상품명 / D 감시 ON/OFF / E URL / F~ 사이즈 체크박스
    log: '품절_알림기록',    // A 시각 / B 종류 / C 상품명 / D 내용 / E URL
    history: '통합이력',     // A 시각 / B 시즌 / C 종류 / D 상품번호 / E 상품명 / F 내용 / G 상품 URL
    restock: '입고일정',      // 예약발송 SKU 표를 붙여넣는 탭 (제품명 / 사이즈 / 예약발송일 / 입고예정일 …)
    browser: '브라우저_수집', // 크롬 수집 스크립트가 채움 (A 상품번호 / B 수집 시각 / C 보는 사람 수 / D 재고 JSON / E 오류)
  },

  // 시즌 탭(예: 26FW) 헤더. 시즌 탭이 없으면 이 헤더로 자동 생성합니다.
  SEASON_TAB_HEADER: ['상품번호', '상품명', '감시 여부', '판매 상태', '품절 옵션', '판매중 옵션', '문제 발생 시각', '마지막 알림', '마지막 확인', '재고 적은 옵션'],

  // 체크된 사이즈의 남은 재고가 이 수 이하가 되면 "재입고 일정 확인" 알림 (크롬 수집에 수량 정보가 있을 때만)
  LOW_STOCK_LIMIT: Number(process.env.LOW_STOCK_LIMIT || 5),
  //   'restock' : '입고일정' 탭에 앞으로 입고 일정이 있는 사이즈만 체크 (기본)
  //   'all'     : 체크된 모든 사이즈
  LOW_STOCK_SCOPE: (process.env.LOW_STOCK_SCOPE || 'restock').toLowerCase(),

  // 상품등록 탭에서 사이즈 체크박스가 시작되는 열 (0부터: A=0 … F=5)
  SIZE_COLUMN_START: 5,

  // 무신사 조회 방식
  //   'auto'    : 크롬 수집 데이터(사이즈별)가 최신이면 그걸 쓰고, 아니면 브랜드 목록(상품 단위) (기본)
  //   'listing' : 브랜드 목록만 사용
  //   'product' : 상품 상세 페이지 직접 확인 (상세 페이지가 열리는 환경에서만)
  SOURCE: (process.env.SOURCE || 'auto').toLowerCase(),
  BROWSER_MAX_AGE_MIN: Number(process.env.BROWSER_MAX_AGE_MIN || 40), // 크롬 수집 값 유효 시간(분)

  CONCURRENCY: Number(process.env.CONCURRENCY || 3),          // 동시에 여는 상품 페이지 수
  PAGE_TIMEOUT_MS: Number(process.env.PAGE_TIMEOUT_MS || 30000),
  DELAY_BETWEEN_MS: Number(process.env.DELAY_BETWEEN_MS || 800), // 상품 사이 쉬는 시간 (서버 배려)
  HEADLESS: process.env.HEADLESS !== 'false',                  // false = 크롬 창을 띄워서 확인
  BROWSER_CHANNEL: process.env.BROWSER_CHANNEL || undefined,   // 'chrome' = PC에 설치된 크롬 사용

  // --watch 실행 시 반복 간격(분)
  INTERVAL_MINUTES: Number(process.env.INTERVAL_MINUTES || 5),

  // 슬랙 (없으면 시트 기록만 함)
  SLACK_WEBHOOK_URL: (process.env.SLACK_WEBHOOK_URL || '').trim(),

  // --dry-run 또는 DRY_RUN=1 : 시트에 쓰지 않고, 슬랙도 보내지 않고 로그만 출력
  DRY_RUN: args.includes('--dry-run') || process.env.DRY_RUN === '1',
  WATCH: args.includes('--watch'),

  TIMEZONE: 'Asia/Seoul',
};
