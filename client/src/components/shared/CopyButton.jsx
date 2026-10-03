import { CopyAction } from '../ui/index.js';

export function CopyButton({ label, value, size = 14 }) {
  return <CopyAction label={label} value={value} iconSize={size} compact />;
}
