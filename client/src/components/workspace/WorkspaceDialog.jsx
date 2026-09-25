import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDialogAccessibility } from '../../hooks/useDialogAccessibility';

export function WorkspaceDialog({ title, busy, onClose, children }) {
  const container = useRef(null);
  const backgroundState = useRef([]);
  const releaseBackground = useCallback(() => {
    backgroundState.current.forEach(([element, inert]) => { element.inert = inert; });
    backgroundState.current = [];
  }, []);
  useDialogAccessibility({ containerRef: container, isOpen: true, closeDisabled: busy, onClose, beforeFocusRestore: releaseBackground });
  useEffect(() => {
    const background = [...document.body.children].filter((element) => element !== container.current);
    backgroundState.current = background.map((element) => [element, element.inert]);
    background.forEach((element) => { element.inert = true; });
    return releaseBackground;
  }, [releaseBackground]);
  return createPortal(<section ref={container} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
    className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4">
    <div className="card max-h-[90vh] w-full max-w-lg overflow-auto p-5 space-y-4">{children}</div>
  </section>, document.body);
}
