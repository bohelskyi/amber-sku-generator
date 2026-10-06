import { useLayoutEffect, useMemo, useRef, useState } from 'react';

export function usePhotoSort(photos, locked, onReorder) {
  const [draft, setDraft] = useState(null);
  const [announcement, announce] = useState('');
  const active = useRef(null);
  const cards = useRef(new Map());
  const positions = useRef(new Map());
  const signature = photos.map(photo => photo.id).join('|');
  const valid = !locked && draft?.signature === signature;
  const baselineOrder = useMemo(() => photos.map(photo => photo.id), [photos]);
  const order = valid ? draft.order : baselineOrder;
  const ordered = order.map(id => photos.find(photo => photo.id === id));
  const keyboardId = valid && draft.mode === 'keyboard' ? draft.id : null;
  const update = next => {
    if (next?.order !== active.current?.order) {
      positions.current.clear();
      for (const [id, element] of cards.current) {
        element.getAnimations?.().forEach(animation => animation.cancel());
        const rect = element.getBoundingClientRect();
        positions.current.set(id, { left: rect.left + window.scrollX, top: rect.top + window.scrollY });
      }
    }
    active.current = next; setDraft(next);
  };
  const cancel = () => { update(null); announce('Переміщення скасовано.'); };
  const begin = (id, mode, point = {}) => {
    if (locked || photos.length < 2) return;
    update({ id, mode, signature, order: photos.map(photo => photo.id), ...point });
    announce('Фото вибрано. Стрілки змінюють порядок, Enter підтверджує, Escape скасовує.');
  };
  const move = (current, target) => {
    const index = current.order.indexOf(current.id);
    if (target < 0 || target >= current.order.length || index === target) return current;
    const order = [...current.order]; order.splice(index, 1); order.splice(target, 0, current.id);
    announce(`Позиція ${target + 1} із ${order.length}.${target === 0 ? ' Головне фото.' : ''}`);
    return { ...current, order };
  };
  const commit = () => {
    const current = active.current;
    update(null);
    if (!current || locked || current.signature !== signature) return;
    if (current.order.join('|') !== signature) onReorder(current.order);
    announce('Порядок фотографій підтверджено. Перше фото — головне.');
  };
  useLayoutEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    for (const [id, element] of cards.current) {
      element.getAnimations?.().forEach(animation => animation.cancel());
      const rect = element.getBoundingClientRect(); const previous = positions.current.get(id);
      const left = rect.left + window.scrollX, top = rect.top + window.scrollY;
      if (!reduced && previous && element.animate && (left !== previous.left || top !== previous.top)) {
        element.animate([{ transform: `translate(${previous.left - left}px, ${previous.top - top}px)` }, { transform: 'translate(0, 0)' }], { duration: 180, easing: 'ease-out' });
      }
    }
    positions.current.clear();
    if (keyboardId) cards.current.get(keyboardId)?.querySelector('.product-photo-drag')?.focus({ preventScroll: true });
  }, [order, keyboardId]);
  const pointerHandlers = {
    onPointerMove(event) {
      const current = active.current;
      if (!current || current.mode !== 'pointer' || current.pointerId !== event.pointerId) return;
      if (locked || current.signature !== signature) { cancel(); return; }
      const moved = current.moved || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= 6;
      if (!moved) return;
      let nearest = -1; let distance = Infinity;
      // Compare layout boxes, rather than animated visual boxes, to avoid oscillating targets.
      for (const [index, photoId] of current.order.entries()) {
        const element = cards.current.get(photoId); if (!element) continue;
        const parent = element.offsetParent?.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        const left = parent ? parent.left + element.offsetLeft : rect.left;
        const top = parent ? parent.top + element.offsetTop : rect.top;
        const next = Math.hypot(event.clientX - (left + rect.width / 2), event.clientY - (top + rect.height / 2));
        if (next < distance) { distance = next; nearest = index; }
      }
      update({ ...move(current, nearest), x: event.clientX, y: event.clientY, moved });
    },
    onPointerUp(event) {
      if (active.current?.pointerId !== event.pointerId) return;
      if (active.current.moved) commit(); else update(null);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel: cancel,
    onLostPointerCapture() { if (active.current?.mode === 'pointer') cancel(); },
  };
  const handle = id => ({
    onPointerDown(event) {
      if (locked || photos.length < 2 || event.isPrimary === false || (event.pointerType !== 'touch' && event.button !== 0)) return;
      event.preventDefault();
      event.currentTarget.focus();
      // Capture on the stable list: the dragged item's DOM moves during sorting.
      event.currentTarget.closest('ol')?.setPointerCapture?.(event.pointerId);
      begin(id, 'pointer', { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false });
    },
    onBlur(event) {
      if (active.current?.mode !== 'keyboard') return;
      if (event.relatedTarget) { cancel(); return; }
      const handle = event.currentTarget;
      // A DOM reorder can transiently blur the moved handle; layout restores it.
      queueMicrotask(() => { if (active.current?.mode === 'keyboard' && document.activeElement !== handle) cancel(); });
    },
    onKeyDown(event) {
      if (locked) return;
      const current = active.current;
      if (event.key === 'Escape' && current) { event.preventDefault(); cancel(); return; }
      if ([' ', 'Enter'].includes(event.key)) {
        event.preventDefault();
        if (current?.mode === 'keyboard' && current.id === id) commit(); else begin(id, 'keyboard');
        return;
      }
      if (current?.mode !== 'keyboard' || current.id !== id || current.signature !== signature) return;
      const delta = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
      if (delta) { event.preventDefault(); update(move(current, current.order.indexOf(id) + delta)); }
    },
  });
  return { ordered, dragging: valid ? draft : null, announcement, handle,
    pointerHandlers,
    cardRef: id => element => { if (element) cards.current.set(id, element); else cards.current.delete(id); } };
}
