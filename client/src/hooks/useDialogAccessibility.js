import { useEffect } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

let bodyScrollLockCount = 0;
let bodyOriginalOverflow = '';

function acquireBodyScrollLock() {
  if (bodyScrollLockCount === 0) bodyOriginalOverflow = document.body.style.overflow;
  bodyScrollLockCount += 1;
  document.body.style.overflow = 'hidden';
  let released = false;
  return () => {
    if (released) return;
    released = true;
    bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
    if (bodyScrollLockCount === 0) document.body.style.overflow = bodyOriginalOverflow;
  };
}

const getFocusableElements = (container) => (
  container
    ? Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (element) => element.getClientRects().length > 0
        && element.getAttribute('aria-hidden') !== 'true'
    )
    : []
);

const canReceiveFocus = (element) => {
  if (!element || element.disabled || element.tabIndex < 0 || element.hidden
    || element.getAttribute('aria-hidden') === 'true' || element.closest('[inert],[hidden]')) return false;
  if (element.style?.display === 'none' || element.style?.visibility === 'hidden') return false;
  const style = globalThis.getComputedStyle?.(element);
  if (style?.display === 'none' || style?.visibility === 'hidden') return false;
  return element.getClientRects().length > 0 || /jsdom/i.test(globalThis.navigator?.userAgent || '');
};

export function useDialogAccessibility({
  beforeFocusRestore,
  closeDisabled = false,
  containerRef,
  initialFocusRef,
  isInteractionEnabled = true,
  isOpen,
  onClose,
}) {
  useEffect(() => {
    if (!isOpen) return undefined;

    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const container = containerRef.current;
    const releaseBodyScrollLock = acquireBodyScrollLock();

    return () => {
      releaseBodyScrollLock();
      beforeFocusRestore?.();
      if (previousActiveElement?.isConnected && canReceiveFocus(previousActiveElement)) {
        previousActiveElement.focus({ preventScroll: true });
      } else {
        const restoreFallback = () => {
          const fallback = Array.from(document.querySelectorAll(FOCUSABLE_SELECTOR)).find(
            (element) => element.isConnected && !container?.contains(element) && canReceiveFocus(element)
          );
          fallback?.focus({ preventScroll: true });
        };
        restoreFallback();
        queueMicrotask(() => {
          if (!canReceiveFocus(document.activeElement)) restoreFallback();
        });
      }
    };
  }, [beforeFocusRestore, containerRef, isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const focusInitialElement = () => {
      const container = containerRef.current;
      const initialElement = initialFocusRef?.current;
      const focusTarget = canReceiveFocus(initialElement)
        ? initialElement
        : getFocusableElements(container)[0] || container;
      focusTarget?.focus({ preventScroll: true });
    };
    focusInitialElement();
    const focusFrame = window.requestAnimationFrame(focusInitialElement);
    return () => window.cancelAnimationFrame(focusFrame);
  }, [containerRef, initialFocusRef, isOpen]);

  useEffect(() => {
    if (!isOpen || !isInteractionEnabled) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !closeDisabled) {
        // An expanded combobox owns the first Escape to dismiss its options.
        // Let its local handler run before considering closing the dialog.
        if (event.target instanceof Element && event.target.closest('[role="combobox"][aria-expanded="true"]')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose?.();
        return;
      }

      if (event.key !== 'Tab') return;

      const container = containerRef.current;
      const focusableElements = getFocusableElements(container);
      if (focusableElements.length === 0) {
        event.preventDefault();
        container?.focus({ preventScroll: true });
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      const focusIsOutside = !container?.contains(activeElement);

      if (focusIsOutside || (event.shiftKey && activeElement === firstElement)) {
        event.preventDefault();
        (event.shiftKey ? lastElement : firstElement).focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [closeDisabled, containerRef, isInteractionEnabled, isOpen, onClose]);
}
