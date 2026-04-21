const { fetchJson } = require('../utils/http');

const NBU_USD_URL =
  'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json';

let cachedUsdUahRate = null;
let cachedUsdUahDate = null;

function getKyivDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' });
}

async function getUsdUahRate() {
  const today = getKyivDateString();
  if (cachedUsdUahRate && cachedUsdUahDate === today) return cachedUsdUahRate;

  const data = await fetchJson(NBU_USD_URL);
  const rate = data && data[0] && data[0].rate ? Number(data[0].rate) : null;
  if (!rate) throw new Error('NBU rate missing');

  cachedUsdUahRate = rate;
  cachedUsdUahDate = today;
  return rate;
}

module.exports = {
  getUsdUahRate,
};
