import { Notice, ConfirmDialog as SharedConfirmDialog } from '../ui/index.js';

export function ConfirmDialog({ changedCount, manualCount, onCancel, onConfirm, pending }) {
  return <SharedConfirmDialog open title="Застосувати переоцінку?"
    description={`Amber змінить ціну для ${changedCount} товарів одним атомарним застосуванням.`}
    confirmLabel="Застосувати переоцінку" busy={pending} onClose={onCancel} onConfirm={onConfirm}>
    {manualCount > 0 && <Notice tone="warning">Ручних цін у підготовленому результаті: {manualCount}.</Notice>}
  </SharedConfirmDialog>;
}

export function RollbackDialog({ batch, onCancel, onConfirm, pending }) {
  return <SharedConfirmDialog open title="Відкотити переоцінку?"
    description={`Для ${batch.changed_count} товарів буде повернуто ціни, які були до партії #${batch.id}.`}
    confirmLabel="Відкотити переоцінку" tone="danger" busy={pending} onClose={onCancel} onConfirm={onConfirm}>
    <Notice tone="warning">Сервер ще раз перевірить точний стан усіх товарів. Якщо хоча б один товар пізніше змінювали, відкат не буде застосовано.</Notice>
  </SharedConfirmDialog>;
}

export function DiscardDraftDialog({ onCancel, onConfirm, pending }) {
  return <SharedConfirmDialog open title="Відкинути чернетку?"
    description="Збережені ручні ціни та позначки перевірки буде видалено. Товари й цінові матриці не зміняться."
    confirmLabel="Відкинути чернетку" tone="danger" busy={pending} onClose={onCancel} onConfirm={onConfirm} />;
}
