import { Dialog } from '../ui/index.js';

export function WorkspaceDialog({ title, busy, onClose, children, className = '', initialFocusRef, suspended = false }) {
  return <Dialog title={title} busy={busy} onClose={onClose} initialFocusRef={initialFocusRef} suspended={suspended}
    className={className} showHeader={false} legacy>{children}</Dialog>;
}
