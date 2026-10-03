import { TechnicalDisclosure } from '../ui/index.js';

// Closed diagnostics must not mount their potentially large contents.
export default function MagentoDetails({ summary = 'Технічні деталі', children }) {
  return <TechnicalDisclosure summary={summary} className="magento-details">{children}</TechnicalDisclosure>;
}
