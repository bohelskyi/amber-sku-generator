import { useContext, useState } from 'react';
import { createExportViewMemory } from '../../lib/export-view-memory';
import { ExportWorkflowContext } from './useExportWorkflow';

// Only display preferences, in memory for this mounted principal. Never request
// evidence, tokens or an operation descriptor. Isolated tests get a local store.
export function useExportReviewView(key) {
  const workflow = useContext(ExportWorkflowContext);
  const [view] = useState(() => {
    if (!workflow?.exportDisplayMemory) return createExportViewMemory();
    if (!workflow.exportDisplayMemory.has(key)) workflow.exportDisplayMemory.set(key, createExportViewMemory());
    return workflow.exportDisplayMemory.get(key);
  });
  return view;
}
