import { AppPageHeader } from './UiPrimitives.jsx';

export function PageHeader({ title = 'Товари', description = 'Створення, пошук і контроль товарів в одному робочому просторі.', breadcrumbs, actions, status }) {
  return (
    <AppPageHeader
      eyebrow={breadcrumbs ? undefined : 'Робоча область'}
      title={title}
      description={description}
      breadcrumbs={breadcrumbs}
      actions={actions}
      status={status}
    />
  );
}

export function Toast({ message }) {
  if (!message) return null;
  return <div className="toast" role="status" aria-live="polite">{message}</div>;
}
