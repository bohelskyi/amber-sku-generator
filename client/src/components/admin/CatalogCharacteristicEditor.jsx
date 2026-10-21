import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useAdminPanel } from '../../hooks/useAdminPanel';
import { isNativeCatalog } from '../../lib/catalog-workflow';
import { getApiError } from '../../lib/http-error';
import { Button, ConfirmDialog, LoadingState, Notice, StatusBadge } from '../ui/index.js';
import { CategoryForm, OptionForm, QuestionForm } from './AdminCatalogForms';
import './admin.css';
import './catalog-characteristic-editor.css';

const enabled = (value) => value === true || value === 1;

function useEditorBoundary({ onDirtyChange, onBusyChange, onClose, onDiscard }) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [pending, setPending] = useState(null);
  const report = useEffectEvent(() => { onDirtyChange?.(dirty); onBusyChange?.(busy); });
  const clear = useEffectEvent(() => { onDirtyChange?.(false); onBusyChange?.(false); });
  useEffect(() => { report(); }, [dirty, busy]);
  useEffect(() => () => clear(), []);
  useEffect(() => {
    if (!dirty && !busy) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);
  const request = (action) => {
    if (busyRef.current) return;
    if (dirty) setPending(() => action); else action();
  };
  return { dirty, setDirty, busy, busyRef,
    setBusy: (value) => { busyRef.current = value; setBusy(value); onBusyChange?.(value); },
    change: (setter) => (value) => { setDirty(true); setter(value); },
    request, close: () => request(() => onClose?.()),
    prompt: <ConfirmDialog open={Boolean(pending)} title="Відкинути незбережені зміни?"
      description="Збережені дані каталогу залишаться. Буде втрачено лише зміни у відкритій формі."
      confirmLabel="Відкинути зміни" onClose={() => setPending(null)} onConfirm={() => {
        const action = pending; setPending(null); setDirty(false); onDiscard?.(); action?.();
      }} />,
  };
}

function CatalogReadState({ admin }) {
  if (!admin.canViewCatalog) return <Notice tone="warning" title="Немає доступу до каталогу" />;
  if (admin.configError) return <Notice tone="error" title="Не вдалося завантажити каталог"
    actions={<Button onClick={admin.retryConfig}>Спробувати ще раз</Button>}>{admin.configError}</Notice>;
  return <LoadingState label="Завантажуємо каталог…" compact />;
}

function Feedback({ feedback }) {
  return feedback && <Notice tone={feedback.tone} title={feedback.title}>{feedback.message}</Notice>;
}

// Embedded body: the owning workspace controls its dialog and navigation guard.
// Local commands remain independent of Magento reads and mutations.
export function CatalogCharacteristicEditor({ categoryCode, questionKey = null,
  initialAction = 'edit-question', optionValue, optionId, onSaved, onClose, onDirtyChange, onBusyChange, onConnect }) {
  const admin = useAdminPanel({ mode: 'catalog', returnMutationReceipts: true, loadSchema: false });
  const boundary = useEditorBoundary({ onDirtyChange, onBusyChange, onClose, onDiscard: admin.discardLocalChanges });
  const initialized = useRef(false);
  const [mode, setMode] = useState(questionKey ? initialAction : 'new-question');
  const [receipt, setReceipt] = useState(null);
  const [handoffError, setHandoffError] = useState('');
  const [optionSearch, setOptionSearch] = useState('');
  const [optionPage, setOptionPage] = useState(0);
  const activeKey = receipt?.questionKey || questionKey;
  const category = admin.config?.categories?.[categoryCode];
  const questions = admin.config?.questions?.[categoryCode] || [];
  const question = questions.find((item) => item.id === activeKey);
  const requestedOptions = (question?.options || []).filter((item) => String(item.id) === String(optionValue)
    && (optionId == null || String(item.db_id) === String(optionId)));
  const requestedOption = requestedOptions.length === 1 ? requestedOptions[0] : null;
  const orderedOptions = requestedOption ? [requestedOption, ...(question.options || []).filter((option) => option.db_id !== requestedOption.db_id)] : question?.options || [];
  const filteredOptions = orderedOptions.filter((option) => `${option.label} ${option.label_en || ''}`.toLocaleLowerCase('uk').includes(optionSearch.trim().toLocaleLowerCase('uk')));
  const currentOptionPage = Math.min(optionPage, Math.max(0, Math.ceil(filteredOptions.length / 25) - 1));

  const initialize = useEffectEvent(() => {
    if (initialized.current || !admin.config || !category) return;
    initialized.current = true;
    admin.handleSelectCategory(category);
    if (question) admin.handleSelectQuestion(question);
    if (initialAction === 'edit-option' && requestedOption) admin.beginOptionEdit(requestedOption);
  });
  useEffect(() => { initialize(); }, [admin.config]);

  const run = async (command) => {
    if (boundary.busyRef.current || !admin.canManageCatalog) return;
    boundary.setBusy(true); setHandoffError('');
    try {
      const result = await command();
      if (!result || typeof result !== 'object' || !result.kind) return;
      setReceipt(result); boundary.setDirty(false); setMode('summary');
      try { await onSaved?.(result); }
      catch (error) { setHandoffError(`Дані збережено в каталозі. Не вдалося оновити робочий простір: ${getApiError(error)}`); }
    } finally { boundary.setBusy(false); }
  };
  const connect = (valueId) => boundary.request(async () => {
    if (!activeKey || !onConnect) return;
    setHandoffError(''); boundary.setBusy(true);
    try { await onConnect({ questionKey: activeKey, ...(valueId == null ? {} : { valueId }) }); }
    catch (error) { setHandoffError(`Налаштування магазину недоступні. Збережені дані каталогу залишилися: ${getApiError(error)}`); }
    finally { boundary.setBusy(false); }
  });
  const openQuestion = () => boundary.request(() => { admin.handleSelectQuestion(question); setMode('edit-question'); });
  const openOption = (option) => boundary.request(() => {
    admin.handleSelectQuestion(question); admin.beginOptionEdit(option); setMode('edit-option');
  });
  const newOption = () => boundary.request(() => {
    admin.handleSelectQuestion(question); admin.setNewOpt({ value_id: '', sku_code: '', label: '', label_en: '', visible_if_json: '', hidden_if_json: '', archived: false }); setMode('new-option');
  });
  const cancelForm = () => boundary.request(() => {
    admin.discardLocalChanges();
    if (!question) onClose?.(); else setMode('summary');
  });

  if (!admin.canViewCatalog || !admin.config) return <CatalogReadState admin={admin} />;
  if (!category) return <Notice tone="warning" title="Категорію не знайдено">Оновіть каталог і виберіть категорію ще раз.</Notice>;
  if (activeKey && !question && !receipt) return <Notice tone="warning" title="Характеристику не знайдено">Жодної зміни не виконано.</Notice>;
  if (mode === 'edit-option' && !admin.editOpt.id && !requestedOption) return <Notice tone="warning" title="Значення не знайдено">Жодної зміни не виконано.</Notice>;

  return <div className="catalog-characteristic-editor admin-page">
    <Feedback feedback={admin.feedback} />
    {handoffError && <Notice tone="warning" title="Каталог збережено окремо від магазину">{handoffError}</Notice>}
    <fieldset disabled={boundary.busy || !admin.canManageCatalog} className="catalog-embedded-form">
      {mode === 'new-question' && <QuestionForm config={admin.config} currentCatQuestions={questions} isNew
        question={admin.newQuest} onChange={boundary.change(admin.setNewQuest)} onSave={() => run(admin.addQuestion)} onCancel={cancelForm} />}
      {mode === 'edit-question' && question && admin.selectedQuestion && <QuestionForm config={admin.config}
        currentCatQuestions={questions} excludeQuestionId={question.id} question={admin.editQuestion}
        onChange={boundary.change(admin.setEditQuestion)} onSave={() => run(admin.updateQuestion)} onCancel={cancelForm} />}
      {mode === 'new-option' && question && <OptionForm config={admin.config} currentCatQuestions={questions}
        excludeQuestionId={question.id} isNew option={admin.newOpt} onChange={boundary.change(admin.setNewOpt)}
        onSave={() => run(admin.addOption)} onCancel={cancelForm} />}
      {mode === 'edit-option' && admin.editOpt.id && <OptionForm config={admin.config} currentCatQuestions={questions}
        excludeQuestionId={question?.id} option={admin.editOpt} onChange={boundary.change(admin.setEditOpt)}
        onSave={() => run(admin.updateOption)} onCancel={cancelForm} />}
    </fieldset>
    {mode === 'summary' && <section className="catalog-embedded-summary">
      <div className="catalog-embedded-heading"><h3>{question?.label || 'Характеристику збережено'}</h3>
        {question && <StatusBadge tone={enabled(question.archived) ? 'neutral' : 'success'}>{enabled(question.archived) ? 'В архіві' : 'У каталозі'}</StatusBadge>}
      </div>
      {question && <>
        <p>{question.input_type === 'text' ? 'Текстове або числове поле' : 'Вибір зі списку значень'} · {enabled(question.required) ? 'Обов’язкова' : 'Необов’язкова'}</p>
        {admin.canManageCatalog && <div className="catalog-embedded-actions">
          <Button disabled={boundary.busy} onClick={openQuestion}>Редагувати характеристику</Button>
          <Button disabled={boundary.busy} onClick={() => run(() => admin.archiveQuestion(question, !enabled(question.archived)))}>{enabled(question.archived) ? 'Відновити характеристику' : 'Архівувати характеристику'}</Button>
        </div>}
        {question.input_type !== 'text' && <section aria-label="Значення характеристики">
          <div className="catalog-embedded-heading"><h4>Можливі значення</h4>
            {admin.canManageCatalog && <Button disabled={boundary.busy || enabled(question.archived)} onClick={newOption}>Додати значення</Button>}
          </div>
          {!question.options?.length && <p>Додайте перше значення для цієї характеристики.</p>}
          {question.options?.length > 0 && <>
            <label className="catalog-option-search">Пошук значення<input type="search" className="input" value={optionSearch} onChange={(event) => { setOptionSearch(event.target.value); setOptionPage(0); }} /></label>
            <div className="catalog-options-scroll"><table className="catalog-options-table"><thead><tr><th>Українською</th><th>Англійською</th><th>Дії</th></tr></thead><tbody>
              {filteredOptions.slice(currentOptionPage * 25, (currentOptionPage + 1) * 25).map((option) => <tr key={option.db_id}>
                <th scope="row">{option.label}{enabled(option.archived) && <StatusBadge>В архіві</StatusBadge>}</th><td>{option.label_en || '—'}</td>
                <td><div className="catalog-embedded-actions">{admin.canManageCatalog && <Button aria-label={`Редагувати ${option.label}`} disabled={boundary.busy} onClick={() => openOption(option)}>Редагувати</Button>}
                  {(admin.canManageCatalog || onConnect && !enabled(question.archived) && !enabled(option.archived)) && <details className="catalog-option-actions"><summary aria-label={`Інші дії: ${option.label}`}>Інші дії</summary>
                    {onConnect && !enabled(question.archived) && !enabled(option.archived) && <Button disabled={boundary.busy} onClick={() => connect(option.id)}>Зіставити {option.label}</Button>}
                    {admin.canManageCatalog && <Button disabled={boundary.busy} onClick={() => run(() => admin.archiveOption(option, !enabled(option.archived)))}>{enabled(option.archived) ? 'Відновити' : 'Архівувати'} {option.label}</Button>}
                  </details>}
                </div></td>
              </tr>)}
            </tbody></table></div>
            {!filteredOptions.length && <p>Значень за цим пошуком немає.</p>}
            {filteredOptions.length > 25 && <nav className="catalog-embedded-actions" aria-label="Сторінки значень характеристики"><Button disabled={!currentOptionPage} onClick={() => setOptionPage(currentOptionPage - 1)}>Назад</Button><span>{currentOptionPage + 1} / {Math.ceil(filteredOptions.length / 25)}</span><Button disabled={(currentOptionPage + 1) * 25 >= filteredOptions.length} onClick={() => setOptionPage(currentOptionPage + 1)}>Далі</Button></nav>}
          </>}
        </section>}
      </>}
      {!question && <Notice title="Оновіть дані каталогу" actions={<Button onClick={admin.retryConfig}>Оновити каталог</Button>}>Збереження завершено. Для наступного редагування потрібні актуальні дані.</Notice>}
    </section>}
    <section className="catalog-embedded-delivery" aria-label="Передавання в магазин">
      <h3>Передавання в магазин</h3>
      <p>Характеристика доступна в Менеджері. За потреби підключіть її до магазину.</p>
      {onConnect && activeKey && !enabled(question?.archived) && <Button disabled={boundary.busy}
        onClick={() => connect(receipt?.kind === 'option' && !['archived', 'restored'].includes(receipt.action) ? receipt.valueId : undefined)}>Налаштувати передавання</Button>}
      {!activeKey && <p>Спочатку збережіть характеристику.</p>}
    </section>
    <Button disabled={boundary.busy} onClick={boundary.close}>Готово</Button>
    {boundary.prompt}
  </div>;
}

export function CatalogCategoryEditor({ categoryCode = null, onSaved, onClose, onDirtyChange, onBusyChange }) {
  const admin = useAdminPanel({ mode: 'catalog', returnMutationReceipts: true, loadSchema: false });
  const boundary = useEditorBoundary({ onDirtyChange, onBusyChange, onClose, onDiscard: admin.discardLocalChanges });
  const initialized = useRef(false);
  const [receipt, setReceipt] = useState(null);
  const [refreshError, setRefreshError] = useState('');
  const activeCode = receipt?.categoryCode || categoryCode;
  const category = admin.config?.categories?.[activeCode];
  const initialize = useEffectEvent(() => {
    if (initialized.current || !admin.config || (categoryCode && !category)) return;
    initialized.current = true;
    if (category) admin.handleSelectCategory(category);
  });
  useEffect(() => { initialize(); }, [admin.config]);
  const save = async () => {
    if (boundary.busyRef.current || !admin.canManageCatalog) return;
    boundary.setBusy(true); setRefreshError('');
    try {
      const result = await (categoryCode ? admin.updateCategory() : admin.addCategory());
      if (!result || typeof result !== 'object' || !result.kind) return;
      setReceipt(result); boundary.setDirty(false);
      try { await onSaved?.(result); }
      catch (error) { setRefreshError(getApiError(error)); }
    } finally { boundary.setBusy(false); }
  };
  if (!admin.canViewCatalog || !admin.config) return <CatalogReadState admin={admin} />;
  if (categoryCode && !category && !receipt) return <Notice tone="warning" title="Категорію не знайдено" />;
  return <div className="catalog-characteristic-editor admin-page">
    <Feedback feedback={admin.feedback} />
    {refreshError && <Notice tone="warning" title="Категорію збережено, але робочий простір не оновлено">{refreshError}</Notice>}
    {receipt ? <><p>Категорію збережено в каталозі. Характеристики, ціни та передавання в магазин налаштовуються окремо.</p><Button onClick={boundary.close} disabled={boundary.busy}>Готово</Button></>
      : <fieldset disabled={boundary.busy || !admin.canManageCatalog} className="catalog-embedded-form">
        <CategoryForm native={isNativeCatalog(admin.config)} isEdit={Boolean(categoryCode)} category={categoryCode ? admin.editCat : admin.newCat}
          onChange={boundary.change(categoryCode ? admin.setEditCat : admin.setNewCat)} onSave={save} onCancel={boundary.close} />
      </fieldset>}
    {boundary.prompt}
  </div>;
}
