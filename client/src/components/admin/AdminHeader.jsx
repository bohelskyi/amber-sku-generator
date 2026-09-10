import { Link } from 'react-router-dom';
import { AppPageHeader } from '../app/UiPrimitives.jsx';

export function AdminHeader() {
  return (
    <AppPageHeader
      eyebrow="Налаштування"
      title="Каталог і ціни"
      description="Структура SKU, варіанти, матриці та модифікатори."
      actions={<Link to="/" className="btn btn-outline btn-compact-md">До робочої області</Link>}
    />
  );
}
