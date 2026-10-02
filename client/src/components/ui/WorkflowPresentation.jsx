import { Check, ChevronDown, Copy, MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { copyPlainText } from '../../lib/clipboard';
import { Button, IconButton, SectionHeader } from './Primitives';

export function CopyAction({ value, label = 'Скопіювати', buttonLabel, compact = false, className = '', iconSize = 14, onCopied }) {
  const [state, setState] = useState('idle');
  const timerRef = useRef(null);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  async function copy() {
    if (value === undefined || value === null || String(value) === '') return;
    try {
      await copyPlainText(value); setState('copied'); onCopied?.(true);
    } catch { setState('error'); onCopied?.(false); }
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setState('idle'), 1800);
  }
  const accessibleLabel = state === 'copied' ? 'Скопійовано' : state === 'error' ? 'Не вдалося скопіювати' : label;
  const visibleLabel = state === 'copied' ? 'Скопійовано' : state === 'error' ? 'Не вдалося скопіювати' : buttonLabel;
  return <span className={`ui-copy-action ${className}`.trim()}>
    {buttonLabel ? <Button type="button" variant={compact ? 'secondary' : 'amber'} size={compact ? 'compactMd' : 'md'} onClick={copy}
      aria-label={label}>{state === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{visibleLabel}</Button>
      : <IconButton type="button" icon={state === 'copied' ? Check : Copy} label={label} size={iconSize} variant="secondary" onClick={copy} />}
    {!buttonLabel && state === 'error' && <span className="ui-copy-feedback is-error">Не вдалося скопіювати</span>}
    <span className="sr-only" role="status" aria-live="polite">{state === 'idle' ? '' : accessibleLabel}</span>
  </span>;
}

export function ActionMenu({ label = 'Дії', children, align = 'end', className = '' }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const rootRef = useRef(null);
  const popupRef = useRef(null);
  const triggerRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 6, left: align === 'end' ? rect.right : rect.left });
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target) && !popupRef.current?.contains(event.target)) setOpen(false);
    };
    const closeForLayoutChange = () => setOpen(false);
    const closeEscape = (event) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); } };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    window.addEventListener('resize', closeForLayoutChange);
    window.addEventListener('scroll', closeForLayoutChange, true);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape);
      window.removeEventListener('resize', closeForLayoutChange); window.removeEventListener('scroll', closeForLayoutChange, true); };
  }, [align, open]);
  return <div ref={rootRef} className={`ui-action-menu ${className}`.trim()}>
    <IconButton ref={triggerRef} type="button" icon={MoreHorizontal} label={label} variant="secondary"
      aria-expanded={open} onClick={() => setOpen((value) => !value)} />
    {open && position && createPortal(<div ref={popupRef} className={`ui-action-menu-popup is-${align}`} aria-label={label}
      style={{ top: position.top, left: position.left }} onClick={(event) => { if (event.target.closest('button,a')) setOpen(false); }}>{children}</div>, document.body)}
  </div>;
}

export function TechnicalDisclosure({ summary = 'Технічні деталі', children, className = '', defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return <details className={`ui-technical-disclosure ${className}`.trim()} open={open}>
    <summary onClick={(event) => { event.preventDefault(); setOpen((value) => !value); }}><span>{summary}</span><ChevronDown size={16} aria-hidden="true" /></summary>
    {open && <div className="ui-technical-content">{typeof children === 'function' ? children() : children}</div>}
  </details>;
}

export function OperationReceipt({ title, description, identity, identityLabel = 'Артикул', actions, children, details, tone = 'success' }) {
  return <section className={`ui-operation-receipt is-${tone}`} role="status">
    <div className="ui-operation-receipt-main"><div className="min-w-0">
      <p className="ui-operation-receipt-title">{title}</p>{description && <p className="ui-operation-receipt-description">{description}</p>}
      {identity && <p className="ui-operation-identity"><span>{identityLabel}</span><strong>{identity}</strong></p>}{children}
    </div>{actions && <div className="ui-operation-receipt-actions">{actions}</div>}</div>
    {details && <TechnicalDisclosure>{details}</TechnicalDisclosure>}
  </section>;
}

export function ChangeSummary({ title = 'Що зміниться', description, items = [], unchanged, actions }) {
  return <section className="ui-change-summary"><SectionHeader title={title} description={description} actions={actions} as="h3" />
    <dl>{items.map((item) => <div key={item.key || item.label} className={item.changed === false ? 'is-unchanged' : 'is-changed'}>
      <dt>{item.label}</dt><dd><span>{item.before ?? '—'}</span><span aria-hidden="true">→</span><strong>{item.after ?? '—'}</strong></dd>
    </div>)}</dl>{unchanged && <p className="ui-change-unchanged">{unchanged}</p>}
  </section>;
}

export function SelectionSummary({ count, label, description, actions }) {
  return <div className="ui-selection-summary" role="status"><div><strong>{count}</strong><span>{label}</span>
    {description && <p>{description}</p>}</div>{actions && <div>{actions}</div>}</div>;
}

export function TableShell({ children, label, description, toolbar, footer, className = '' }) {
  return <section className={`ui-table-shell ${className}`.trim()} aria-label={label}>
    {(label || description || toolbar) && <header className="ui-table-shell-header"><div>{label && <h2>{label}</h2>}{description && <p>{description}</p>}</div>{toolbar}</header>}
    <div className="ui-table-scroll">{children}</div>{footer && <footer className="ui-table-shell-footer">{footer}</footer>}
  </section>;
}

export function TableToolbar({ children, primary, secondary, label = 'Інструменти таблиці' }) {
  return <div className="ui-table-toolbar" role="group" aria-label={label}><div>{primary || children}</div>{secondary && <div>{secondary}</div>}</div>;
}

export function FilterBar({ children, actions, label = 'Фільтри' }) {
  return <div className="ui-filter-bar" role="group" aria-label={label}><div className="ui-filter-controls">{children}</div>{actions && <div className="ui-filter-actions">{actions}</div>}</div>;
}

export function Pagination({ hasPrevious = false, hasNext = false, onPrevious, onNext, previousLabel = 'Назад', nextLabel = 'Далі',
  summary, busy = false, label = 'Навігація сторінками' }) {
  if (!hasPrevious && !hasNext && !summary) return null;
  return <nav className="ui-pagination" aria-label={label}><Button type="button" size="compactMd" disabled={!hasPrevious || busy} onClick={onPrevious}>{previousLabel}</Button>
    {summary && <span role="status">{summary}</span>}<Button type="button" size="compactMd" disabled={!hasNext || busy} onClick={onNext}>{nextLabel}</Button></nav>;
}
