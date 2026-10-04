import { at } from './export-template-presentation.js';
import { replaceAt } from './export-template-editor.js';

export const hasControlCharacter = (value) => [...value].some((character) => character.charCodeAt(0) < 32);

// Append only. Preserve opaque branches, shared references, errors and other rows.
export function appendPlacement(definition, cellPath, path, sourceId, valueId) {
  const existing = at(definition, cellPath);
  if (!existing || typeof path !== 'string' || !path.includes('/') || path.split('/').some((part) => !part.trim() || part !== part.trim()) || path.includes(',') || hasControlCharacter(path)) throw new Error('Оберіть однозначний розділ магазину.');
  let addition = { op: 'literal', value: path };
  if (sourceId) {
    const source = definition.sources[sourceId];
    const group = definition.groups[cellPath[1]];
    if (source?.kind !== 'semantic' || source.category !== group.route || typeof valueId !== 'string' || !valueId) throw new Error('Оберіть характеристику та її значення.');
    addition = { op: 'when', if: { op: 'eq', left: { op: 'semanticKey', input: { op: 'source', id: sourceId } }, right: { op: 'literal', value: valueId } }, then: addition, else: { op: 'literal', value: '' } };
  }
  return replaceAt(definition, cellPath, { op: 'join', items: [structuredClone(existing), addition], delimiter: ',', omitEmpty: true });
}
