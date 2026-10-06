import { isTestProduct } from '../../lib/test-product.js';

export function TestProductNotice({ product, preview = false }) {
  if (!isTestProduct(product)) return null;
  return <section className="test-product-notice" aria-label={preview ? 'Серверна перевірка TEST товару' : 'Тестовий товар'}>
    <strong>{preview ? 'Сервер підтвердив TEST товар' : 'TEST · Тестовий товар'}</strong>
    <p>У Magento передається вимкненим для покупців (стан 2). Фото й відновлення не вмикають його.</p>
    {preview && <p>Окремий артикул TEST-… призначить сервер після збереження. Фактична доставка перевіряється окремо.</p>}
  </section>;
}
