import { useState } from 'react';
import { restoreReviewLinks, restoreReviewReport } from '../../lib/restore-review-report.js';

export default function RestoreReviewHandoff({ items = [] }) {
  const [copyState, setCopyState] = useState('');
  const blocked = items.filter((item) => item.disposition === 'conflict');
  if (!blocked.length) return null;
  const report = restoreReviewReport(blocked);
  async function copy() {
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await globalThis.navigator.clipboard.writeText(report);
      setCopyState('Звіт скопійовано.');
    } catch {
      setCopyState('Не вдалося скопіювати. Відкрийте текст звіту нижче та скопіюйте вручну.');
    }
  }
  return <section className="mt-4 rounded border p-4" aria-label="Передавання відновлення на перевірку">
    <h3 className="font-semibold">Потребують окремої перевірки: {blocked.length}</h3>
    <p className="mt-2 text-sm">Попередній стан може бути не зафіксований. Адміністратор має перевірити історію кожного товару. Цей звіт не відновлює товари й не вмикає їх у Magento.</p>
    <details className="mt-3"><summary className="min-h-[34px] cursor-pointer py-2">Переглянути товари для Адміністратора ({blocked.length})</summary><ul className="mt-3 space-y-2">{blocked.map((item, index) => {
      const links = restoreReviewLinks(item);
      return <li key={`${item.inputSku}:${index}`}><strong>{item.article || item.inputSku}</strong>
        {item.productId != null && <span> · товар №{item.productId}</span>}
        <span className="block text-sm">{item.reasonCode || 'Причина не зафіксована'}</span>
        {links && <span className="flex flex-wrap gap-3 text-sm"><a className="underline" href={links.product} target="_blank" rel="noopener noreferrer">Відкрити товар у новій вкладці</a><a className="underline" href={links.history} target="_blank" rel="noopener noreferrer">Історія цього артикулу у новій вкладці</a></span>}
      </li>;
    })}</ul></details>
    <button type="button" className="mt-3 rounded border px-3 py-2" onClick={() => void copy()}>Скопіювати звіт для Адміністратора</button>
    {copyState && <p role="status" className="mt-2 text-sm">{copyState}</p>}
    <details className="mt-3"><summary className="min-h-[34px] cursor-pointer py-2">Факти та текст звіту</summary><pre className="mt-2 whitespace-pre-wrap break-words text-sm">{report}</pre></details>
  </section>;
}
