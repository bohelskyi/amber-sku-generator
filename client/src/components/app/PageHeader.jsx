import { AppPageHeader } from './UiPrimitives.jsx';

export function PageHeader({ title = 'Товари', description, breadcrumbs, actions, status }) {
  return (
    <AppPageHeader
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
