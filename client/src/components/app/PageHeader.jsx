import { ClipboardList, History } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AppPageHeader } from './UiPrimitives.jsx';

export function PageHeader() {
  return (
    <AppPageHeader
      eyebrow="Робоча область"
      title="Amber SKU Manager"
      description="Створення, пошук і контроль товарів в одному робочому просторі."
      actions={<>
        <Link to="/admin/corrections?from=client" className="btn btn-outline btn-compact-md gap-2">
          <ClipboardList size={15} aria-hidden="true" />
          Запити
        </Link>
        <Link to="/admin/corrections/history?from=client" className="btn btn-outline btn-compact-md gap-2">
          <History size={15} aria-hidden="true" />
          Журнал
        </Link>
      </>}
    />
  );
}

export function Toast({ message }) {
  if (!message) return null;
  return <div className="toast">{message}</div>;
}
