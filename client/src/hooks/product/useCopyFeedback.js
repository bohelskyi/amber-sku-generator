import { useState } from 'react';

export function useCopyFeedback() {
  const [copyMessage, setCopyMessage] = useState('');

  const handleCopyText = async (text, label) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage(`${label} скопійовано`);
    } catch {
      setCopyMessage('Не вдалося скопіювати');
    }
    setTimeout(() => setCopyMessage(''), 1500);
  };

  return { copyMessage, handleCopyText };
}
