import { useEffect } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const getFocusableElements = (container) => (
  container
    ? Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (element) => element.getClientRects().length > 0
        && element.getAttribute('aria-hidden') !== 'true'
    )
    : []
);

const canReceiveFocus = (element) => Boolean(
  element
    && !element.disabled
    && element.tabIndex >= 0
    && element.getClientRects().length > 0
);

export function useDialogAccessibility({
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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusInitialElement = () => {
      const container = containerRef.current;
      const initialElement = initialFocusRef?.current;
      const focusTarget = canReceiveFocus(initialElement)
        ? initialElement
        : getFocusableElements(container)[0] || container;
      focusTarget?.focus({ preventScroll: true });
    };
    const focusFrame = window.requestAnimationFrame(focusInitialElement);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      if (previousActiveElement?.isConnected) {
        previousActiveElement.focus({ preventScroll: true });
      }
    };
  }, [containerRef, initialFocusRef, isOpen]);

  useEffect(() => {
    if (!isOpen || !isInteractionEnabled) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !closeDisabled) {
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
