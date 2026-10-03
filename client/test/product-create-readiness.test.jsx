import { expect, it } from 'vitest';
import { createRequirements, isCreateQuestionRequired } from '../src/lib/product-create-readiness';
const config = { productCreateRequirements: { SV: { requiredAnswers: ['size', 'weight'],
  optionalAnswersWhen: { size: { question: 'souvenir', values: ['6'] } },
  automaticName: { question: 'souvenir', values: ['6'] } } } };
it('config keychain exception overrides only the informational size flag and retains other requirements', () => {
  for (const souvenir of [6, '6']) {
    const rules = createRequirements(config, 'SV', { souvenir });
    expect(rules.requiredAnswers).toEqual(['weight']);
    expect(rules.namesRequired).toBe(false);
    expect(isCreateQuestionRequired({ id: 'size', input_type: 'text', include_in_sku: 0, required: 1 }, rules)).toBe(false);
    expect(isCreateQuestionRequired({ id: 'size', input_type: 'options', include_in_sku: 1, required: 1 }, rules)).toBe(true);
    expect(isCreateQuestionRequired({ id: 'weight', input_type: 'text', required: 0 }, rules)).toBe(true);
  }
  for (const souvenir of [1, 5, undefined]) expect(createRequirements(config, 'SV', { souvenir }).requiredAnswers).toEqual(['size', 'weight']);
  expect(isCreateQuestionRequired({ id: 'size', input_type: 'text', required: 1 }, createRequirements(config, 'AR', { souvenir: 6 }))).toBe(true);
});
