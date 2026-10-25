import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

// Escape closes only the topmost dialog, e.g. a confirmation above Advanced settings.
const open: object[] = [];

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const self = {};
    open.push(self);
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open[open.length - 1] === self) close.current();
    };
    document.addEventListener("keydown", key);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      open.splice(open.indexOf(self), 1);
      if (!open.length) document.body.style.overflow = "";
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className={`modal${wide ? " wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p className="muted">{description}</p>}
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

// Disruptive actions never run on the first click; they need this explicit confirmation.
export function ConfirmDialog({
  title,
  text,
  confirmLabel,
  onConfirm,
  onCancel,
  confirmClass = "warning",
}: {
  title: string;
  text: string;
  confirmLabel: string;
  // Destructive actions keep the red "warning" style; others pass their own.
  confirmClass?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button onClick={onCancel}>Cancel</button>
          <button className={confirmClass} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="confirm-text">{text}</p>
    </Modal>
  );
}
