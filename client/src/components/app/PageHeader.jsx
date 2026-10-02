import { AppPageHeader } from './UiPrimitives.jsx';

export function PageHeader() {
  return (
    <AppPageHeader
      eyebrow="Робоча область"
      title="Товари"
      description="Створення, пошук і контроль товарів в одному робочому просторі."
    />
  );
}

export function Toast({ message }) {
  if (!message) return null;
  return <div className="toast" role="status" aria-live="polite">{message}</div>;
}
