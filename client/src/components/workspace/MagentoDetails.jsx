import { useState } from 'react';

// Closed diagnostics must not mount their potentially large contents.
export default function MagentoDetails({ summary = 'Технічні деталі', children }) {
  const [open, setOpen] = useState(false);
  return <details className="magento-details" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{summary}</summary>
    {open && <div className="mt-3 min-w-0">{typeof children === 'function' ? children() : children}</div>}
  </details>;
}
