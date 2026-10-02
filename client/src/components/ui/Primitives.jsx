import { createElement, forwardRef } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight, Inbox, LoaderCircle, X } from 'lucide-react';
import { Link, NavLink, matchPath, useLocation } from 'react-router-dom';

export function Breadcrumbs({ items = [], label = 'Навігаційний шлях' }) {
  if (!items.length) return null;
  return <nav className="ui-breadcrumbs" aria-label={label}><ol>
    {items.map((item, index) => <li key={`${item.label}-${index}`}>
      {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
      {item.to && index < items.length - 1
        ? <Link to={item.to}>{item.label}</Link>
        : <span aria-current={index === items.length - 1 ? 'page' : undefined}>{item.label}</span>}
    </li>)}
  </ol></nav>;
}

export function PageHeader({ eyebrow, title, description, actions, breadcrumbs, status }) {
  return <header className="page-heading fade-up">
    <div className="min-w-0">
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <div className="ui-page-title-row">
        <h1 className={eyebrow || breadcrumbs ? 'page-title mt-1' : 'page-title'}>{title}</h1>
        {status}
      </div>
      {description && <p className="section-subtitle mt-1 max-w-3xl">{description}</p>}
    </div>
    {actions && <div className="ui-page-actions">{actions}</div>}
  </header>;
}

export function SectionHeader({ title, description, actions, as = 'h2' }) {
  return <header className="ui-section-header">
    <div className="min-w-0">
      {createElement(as, null, title)}
      {description && <p>{description}</p>}
    </div>
    {actions && <div className="ui-section-actions">{actions}</div>}
  </header>;
}

export function LocalNavigation({ label, items = [], className = '' }) {
  const { pathname } = useLocation();
  return <nav className={`local-workspace-nav ${className}`.trim()} aria-label={label}>
    {items.map(({ to, label: title, end = true, activePaths }) => {
      if (!activePaths) return <NavLink key={to} to={to} end={end}>{title}</NavLink>;
      const active = activePaths.some((path) => matchPath({ path, end: false }, pathname));
      return <Link key={to} to={to} className={active ? 'active' : undefined}
        aria-current={active ? 'page' : undefined}>{title}</Link>;
    })}
  </nav>;
}

const buttonVariants = { primary: 'btn-primary', amber: 'btn-amber', secondary: 'btn-outline', outline: 'btn-outline', danger: 'btn-danger', ghost: 'btn-ghost' };
const buttonSizes = { sm: 'btn-compact', compact: 'btn-compact', md: '', compactMd: 'btn-compact-md', icon: 'btn-icon', iconMd: 'btn-icon-md' };

export const Button = forwardRef(function Button({ variant = 'secondary', size = 'md', busy = false, className = '', children, disabled, ...props }, ref) {
  return <button ref={ref} type="button" className={`btn ${buttonVariants[variant] || buttonVariants.secondary} ${buttonSizes[size] || ''} ${className}`.trim()}
    disabled={disabled || busy} aria-busy={busy || undefined} {...props}>{children}</button>;
});

export const IconButton = forwardRef(function IconButton({ label, icon: Icon, size = 16, children, ...props }, ref) {
  return <Button ref={ref} size="iconMd" aria-label={label} title={label} {...props}>
    {Icon && <Icon size={size} aria-hidden="true" />}{children}
  </Button>;
});

export function Field({ label, htmlFor, required = false, optional = false, hint, error, children, className = '' }) {
  const describedBy = [hint && htmlFor ? `${htmlFor}-hint` : null, error && htmlFor ? `${htmlFor}-error` : null].filter(Boolean).join(' ') || undefined;
  const control = typeof children === 'function' ? children({ 'aria-describedby': describedBy, 'aria-invalid': Boolean(error) || undefined }) : children;
  return <div className={`ui-field ${error ? 'has-error' : ''} ${className}`.trim()}>
    {label && <label htmlFor={htmlFor} className="ui-field-label">{label}
      {required && <span className="ui-required" aria-hidden="true"> *</span>}
      {optional && <span className="ui-optional"> Необов’язково</span>}
    </label>}
    {control}
    {hint && <p id={htmlFor ? `${htmlFor}-hint` : undefined} className="ui-field-hint">{hint}</p>}
    {error && <FieldError id={htmlFor ? `${htmlFor}-error` : undefined}>{error}</FieldError>}
  </div>;
}

export function FieldGroup({ legend, description, children, className = '' }) {
  return <fieldset className={`ui-field-group ${className}`.trim()}>
    {legend && <legend>{legend}</legend>}
    {description && <p className="ui-field-group-description">{description}</p>}
    <div className="ui-field-group-content">{children}</div>
  </fieldset>;
}

export function FieldError({ children, id }) {
  if (!children) return null;
  return <p id={id} className="ui-field-error" role="alert">{children}</p>;
}

export function ErrorSummary({ title = 'Перевірте введені дані', errors = [], children }) {
  if (!errors.length && !children) return null;
  return <div className="ui-error-summary" role="alert" tabIndex={-1}>
    <strong>{title}</strong>
    {errors.length > 0 && <ul>{errors.map((error, index) => <li key={error.id || `${error.message}-${index}`}>
      {error.href ? <a href={error.href}>{error.message}</a> : error.message}
    </li>)}</ul>}
    {children}
  </div>;
}

export function Notice({ children, tone = 'error', title, actions }) {
  const Icon = tone === 'success' ? CheckCircle2 : AlertCircle;
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    <Icon size={18} className="notice-icon" aria-hidden="true" />
    <div className="min-w-0 flex-1">{title && <p className="notice-title">{title}</p>}{children}</div>
    {actions && <div className="ui-notice-actions">{actions}</div>}
  </div>;
}

export function LoadingState({ label = 'Завантаження…', compact = false }) {
  return <div className={`state-panel ${compact ? 'is-compact' : ''}`} role="status" aria-live="polite">
    <LoaderCircle size={22} className="animate-spin" aria-hidden="true" /><span>{label}</span>
  </div>;
}

export function EmptyState({ children, title, description, action, icon = Inbox, compact = false }) {
  const EmptyIcon = icon;
  return <div className={`state-panel state-panel-empty ${compact ? 'is-compact' : ''}`}>
    <EmptyIcon size={24} aria-hidden="true" />
    <div>{title && <strong className="state-panel-title">{title}</strong>}{description && <p>{description}</p>}{children}</div>
    {action}
  </div>;
}

export function ReadState({ kind, title, description, action, compact = false }) {
  if (kind === 'loading') return <LoadingState compact={compact} label={description || title} />;
  if (kind === 'empty') return <EmptyState compact={compact} title={title} description={description} action={action} />;
  if (kind === 'error') return <Notice tone="error" title={title} actions={action}>{description}</Notice>;
  return null;
}

export function StatusBadge({ children, tone = 'neutral', className = '' }) {
  return <span className={`ui-status-badge is-${tone} ${className}`.trim()}>{children}</span>;
}

export function SaveState({ state = 'idle', message }) {
  if (state === 'idle' && !message) return null;
  const labels = { dirty: 'Є незбережені зміни', saving: 'Зберігаємо…', saved: 'Збережено', error: 'Не вдалося зберегти', stale: 'Дані змінилися' };
  const label = message || labels[state];
  if (!label) return null;
  return <span className={`ui-save-state is-${state}`} role={state === 'error' ? 'alert' : 'status'} aria-live="polite">
    {label}
  </span>;
}

export function CloseButton({ onClick, label = 'Закрити', disabled = false }) {
  return <button type="button" className="ui-close-button" onClick={onClick} disabled={disabled} aria-label={label} title={label}>
    <X size={18} aria-hidden="true" />
  </button>;
}
