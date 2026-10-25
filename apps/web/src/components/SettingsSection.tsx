import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

/** One collapsible settings group. Collapsing only hides the content: it stays mounted, so a form
 * someone is part-way through keeps what they typed when the group is opened again. */
export function SettingsSection({ title, defaultOpen = false, children }: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className={`card settings-section${open ? " open" : ""}`}>
      <h2>
        <button
          type="button"
          className="settings-section-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          {title}
          <ChevronDown size={18} aria-hidden="true" className="settings-chevron" />
        </button>
      </h2>
      <div id={id} className="settings-section-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/** A titled part of a settings group, divided from the next by a thin line, never another card. */
export function SettingsBlock({ title, action, className, children }: {
  title?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`settings-block${className ? ` ${className}` : ""}`}>
      {(title || action) && (
        <div className="settings-block-header">
          {title && <h3>{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
