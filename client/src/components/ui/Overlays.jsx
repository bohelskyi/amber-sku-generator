import { useCallback, useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useDialogAccessibility } from '../../hooks/useDialogAccessibility';
import { Button, CloseButton } from './Primitives';

const overlayLayers = [];
const overlaySubscribers = new Set();
let backgroundState = [];
const notifyOverlayChange = () => overlaySubscribers.forEach((notify) => notify());
const subscribeOverlay = (notify) => { overlaySubscribers.add(notify); return () => overlaySubscribers.delete(notify); };
const getTopOverlay = () => overlayLayers.at(-1)?.token || null;

function registerOverlay(element, token) {
  if (!element) return () => {};
  if (!overlayLayers.length) {
    backgroundState = [...document.body.children].filter((candidate) => candidate !== element)
      .map((candidate) => [candidate, candidate.inert]);
    backgroundState.forEach(([candidate]) => { candidate.inert = true; });
  } else {
    overlayLayers.at(-1).element.inert = true;
  }
  const layer = { element, released: false, token };
  element.inert = false;
  overlayLayers.push(layer);
  notifyOverlayChange();
  return () => {
    if (layer.released) return;
    layer.released = true;
    const index = overlayLayers.indexOf(layer);
    const wasTop = index === overlayLayers.length - 1;
    if (index >= 0) overlayLayers.splice(index, 1);
    if (wasTop && overlayLayers.length) overlayLayers.at(-1).element.inert = false;
    if (!overlayLayers.length) {
      backgroundState.forEach(([candidate, inert]) => { if (candidate.isConnected) candidate.inert = inert; });
      backgroundState = [];
    }
    notifyOverlayChange();
  };
}

function useOverlayLayer(containerRef, enabled) {
  const token = useId();
  const releaseRef = useRef(() => {});
  const topOverlay = useSyncExternalStore(subscribeOverlay, getTopOverlay, getTopOverlay);
  useEffect(() => {
    if (!enabled) return undefined;
    releaseRef.current = registerOverlay(containerRef.current, token);
    return () => { releaseRef.current(); releaseRef.current = () => {}; };
  }, [containerRef, enabled, token]);
  const release = useCallback(() => releaseRef.current(), []);
  return { release, isTop: enabled && topOverlay === token };
}

export function Dialog({ open = true, suspended = false, title, description, children, footer, actions, busy = false,
  onClose, initialFocusRef, className = '', size = 'md', showHeader = true, legacy = false }) {
  const containerRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  const enabled = open && !suspended;
  const layer = useOverlayLayer(containerRef, enabled);
  useDialogAccessibility({ containerRef, initialFocusRef, isOpen: enabled, isInteractionEnabled: layer.isTop,
    closeDisabled: busy, onClose, beforeFocusRestore: layer.release });
  if (!open) return null;
  return createPortal(<section ref={containerRef} hidden={suspended} tabIndex={-1} role="dialog" aria-modal="true"
    aria-label={legacy ? title : undefined} aria-labelledby={legacy ? undefined : titleId}
    aria-describedby={!legacy && description ? descriptionId : undefined} className="ui-dialog-backdrop">
    {legacy ? <div className={`card max-h-[90vh] w-full max-w-lg overflow-auto p-5 space-y-4 ${className}`.trim()}>{children}</div>
      : <div className={`ui-dialog-surface is-${size} ${className}`.trim()}>
      {showHeader ? <header className="ui-dialog-header">
        <div className="min-w-0"><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
        {actions}{onClose && <CloseButton onClick={onClose} disabled={busy} />}
      </header> : <><h2 id={titleId} className="sr-only">{title}</h2>{description && <p id={descriptionId} className="sr-only">{description}</p>}</>}
      <div className="ui-dialog-body">{children}</div>
      {footer && <footer className="ui-dialog-footer">{footer}</footer>}
    </div>}
  </section>, document.body);
}

export function Drawer({ open, title, description, children, footer, busy = false, onClose, initialFocusRef, className = '', side = 'left' }) {
  const containerRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  const layer = useOverlayLayer(containerRef, open);
  useDialogAccessibility({ containerRef, initialFocusRef, isOpen: open, isInteractionEnabled: layer.isTop,
    closeDisabled: busy, onClose, beforeFocusRestore: layer.release });
  if (!open) return null;
  return createPortal(<section ref={containerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
    aria-describedby={description ? descriptionId : undefined} className={`ui-drawer-backdrop is-${side}`} onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose?.();
    }}>
    <div className={`ui-drawer-surface ${className}`.trim()}>
      <header className="ui-drawer-header"><div className="min-w-0"><h2 id={titleId}>{title}</h2>
        {description && <p id={descriptionId}>{description}</p>}</div><CloseButton onClick={onClose} disabled={busy} /></header>
      <div className="ui-drawer-body">{children}</div>
      {footer && <footer className="ui-drawer-footer">{footer}</footer>}
    </div>
  </section>, document.body);
}

export function ConfirmDialog({ open, title, description, children, confirmLabel = 'Підтвердити', cancelLabel = 'Скасувати',
  tone = 'primary', busy = false, confirmDisabled = false, onConfirm, onClose }) {
  const cancelRef = useRef(null);
  return <Dialog open={open} title={title} description={description} busy={busy} onClose={onClose} initialFocusRef={cancelRef}
    size="sm" footer={<><Button ref={cancelRef} onClick={onClose} disabled={busy}>{cancelLabel}</Button>
      <Button variant={tone === 'danger' ? 'danger' : 'primary'} busy={busy} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</Button></>}>
    {children}
  </Dialog>;
}
