import { AlertCircle, CheckCircle2, Inbox, LoaderCircle } from 'lucide-react';

export function AppPageHeader({ eyebrow, title, description, actions }) {
  return (
    <header className="page-heading fade-up">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className={eyebrow ? 'page-title mt-1' : 'page-title'}>{title}</h1>
        {description && <p className="section-subtitle mt-1 max-w-3xl">{description}</p>}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 self-start lg:self-center">
          {actions}
        </div>
      )}
    </header>
  );
}

export function Notice({ children, tone = 'error', actions }) {
  const Icon = tone === 'success' ? CheckCircle2 : AlertCircle;
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={18} className="notice-icon" aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Завантаження…', compact = false }) {
  return (
    <div className={`state-panel ${compact ? 'is-compact' : ''}`} role="status" aria-live="polite">
      <LoaderCircle size={22} className="animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ children, icon = Inbox, compact = false }) {
  const EmptyIcon = icon;
  return (
    <div className={`state-panel state-panel-empty ${compact ? 'is-compact' : ''}`}>
      <EmptyIcon size={24} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function StatusBadge({ children, tone = 'neutral', className = '' }) {
  return <span className={`ui-status-badge is-${tone} ${className}`.trim()}>{children}</span>;
}
