import { Copy } from 'lucide-react';
import { copyPlainText } from '../../lib/clipboard';

export function CopyButton({ label, value, size = 14 }) {
  return (
    <button
      type="button"
      className="btn btn-outline btn-icon"
      onClick={() => copyPlainText(value)}
      title={label}
      aria-label={label}
    >
      <Copy size={size} aria-hidden="true" />
    </button>
  );
}
