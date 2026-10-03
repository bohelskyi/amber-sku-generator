import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../ui/index.js';

export function WorkspaceDirectory({ title, description, items }) {
  return <main className="app-page"><div className="workspace-directory">
    <PageHeader title={title} description={description} />
    <div className="workspace-directory-list">
      {items.map((item) => <Link key={item.to} to={item.to} className="workspace-directory-link">
        <span><strong>{item.label}</strong><span>{item.description}</span></span>
        <ArrowRight size={17} aria-hidden="true" />
      </Link>)}
    </div>
  </div></main>;
}
