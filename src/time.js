const { TIMEZONE } = require('./config');

// 한국시간 'YYYY-MM-DD HH:mm'
function stamp(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { stamp, sleep };
