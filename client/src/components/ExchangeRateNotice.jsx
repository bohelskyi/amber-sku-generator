import { formatDecimal } from '../lib/formatters';

function rateDateLabel(rateDate, fetchedAt) {
  for (const value of [rateDate, fetchedAt]) {
    const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
    if (match) return `${match[3]}.${match[2]}.${match[1]}`;
  }
  return 'дата не вказана';
}

export function ExchangeRateNotice({ rate, rateDate, fetchedAt, stale }) {
  if (stale !== true || !Number.isFinite(Number(rate)) || Number(rate) <= 0) return null;

  return <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
    Оновлення курсу НБУ за поточний день ще не підтверджено. Для перерахунку USD/UAH
    використано останній успішний курс {formatDecimal(rate)} ₴/$ від {rateDateLabel(rateDate, fetchedAt)}.
  </p>;
}
