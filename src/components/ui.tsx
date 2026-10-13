import { useId } from 'react';
import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { X, Info, Check, AlertTriangle } from 'lucide-react';
import { cn } from '../lib';

export function NumberField({ label, value, onChange, min = 0, max = 450, step = 0.1, unit = 'mm', description, disabled = false }: {
  label: string; value: number; onChange: (value: number) => void; min?: number; max?: number;
  step?: number; unit?: string; description?: string; disabled?: boolean;
}) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label><div className="number-wrap"><input id={id} type="number" value={value} min={min} max={max} step={step} disabled={disabled}
    aria-describedby={description ? `${id}-hint` : undefined} aria-invalid={value < min || value > max || undefined}
    onChange={e => { const next = e.target.valueAsNumber; if (Number.isFinite(next)) onChange(next); }} onBlur={e => { const n = e.target.valueAsNumber; if (Number.isFinite(n) && (n < min || n > max)) onChange(Math.max(min, Math.min(max, n))); }} /><span>{unit}</span></div>
    {description && <small id={`${id}-hint`}>{description}</small>}</div>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' }) {
  return <span className={cn('badge', tone === 'success' && 'badge-success', tone === 'warning' && 'badge-warning')}>{children}</span>;
}

export function Note({ children, warning = false }: { children: ReactNode; warning?: boolean }) {
  return <div className={cn('note', warning && 'note-warning')}>{warning ? <AlertTriangle size={15} /> : <Info size={15} />}<p>{children}</p></div>;
}

export function Modal({ open, onOpenChange, title, description, children, returnFocusTo }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode; returnFocusTo?: HTMLElement | null }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="modal-overlay" /><Dialog.Content className="modal-content" onCloseAutoFocus={returnFocusTo ? event => { event.preventDefault(); returnFocusTo.focus(); } : undefined}>
    <Dialog.Title className="text-balance text-xl font-semibold">{title}</Dialog.Title><Dialog.Description className="mt-2 text-pretty text-sm text-slate-500">{description}</Dialog.Description>
    <Dialog.Close className="icon-button modal-close" aria-label="关闭对话框"><X size={18} /></Dialog.Close>{children}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function Confirm({ open, onOpenChange, title, description, action, onConfirm }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; action: string; onConfirm: () => void }) {
  return <AlertDialog.Root open={open} onOpenChange={onOpenChange}><AlertDialog.Portal><AlertDialog.Overlay className="modal-overlay" /><AlertDialog.Content className="modal-content">
    <AlertDialog.Title className="text-balance text-xl font-semibold">{title}</AlertDialog.Title><AlertDialog.Description className="mt-3 text-pretty text-sm leading-6 text-slate-600">{description}</AlertDialog.Description>
    <div className="mt-7 flex justify-end gap-3"><AlertDialog.Cancel className="button">取消</AlertDialog.Cancel><AlertDialog.Action className="button button-danger" onClick={onConfirm}>{action}</AlertDialog.Action></div>
  </AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>;
}

export function CheckItem({ checked, children }: { checked: boolean; children: ReactNode }) {
  return <div className="check-item"><span className={cn('check-icon', checked && 'is-checked')}>{checked && <Check size={12} />}</span><span>{children}</span></div>;
}
