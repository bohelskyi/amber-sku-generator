import { useEffect, useRef, useState } from 'react';

export function useCopyFeedback() {
  const [copyMessage, setCopyMessage] = useState('');
  const mounted = useRef(false);
  const request = useRef(0);
  const resetTimer = useRef(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    };
  }, []);

  const handleCopyText = async (text, label) => {
    if (!text || !mounted.current) return;
    const ticket = ++request.current;
    clearTimeout(resetTimer.current);
    resetTimer.current = null;
    let message;
    try {
      await navigator.clipboard.writeText(text);
      message = `${label} скопійовано`;
    } catch {
      message = 'Не вдалося скопіювати';
    }
    if (!mounted.current || ticket !== request.current) return;
    setCopyMessage(message);
    resetTimer.current = setTimeout(() => {
      if (!mounted.current || ticket !== request.current) return;
      resetTimer.current = null;
      setCopyMessage('');
    }, 1500);
  };

  return { copyMessage, handleCopyText };
}
