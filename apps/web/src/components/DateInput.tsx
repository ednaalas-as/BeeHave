import { useEffect, useRef } from "react";
import { notCredential } from "../autofill";

/**
 * A native date field the user can type into freely. The browser owns the text while it is
 * being edited, so partial dates, cursor moves and deletions are never reset; a complete date
 * within min/max is committed as it is typed or picked, and anything else reverts on blur.
 */
export function DateInput({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onCommit: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const accepts = (date: string) =>
    isDate(date) && (!min || date >= min) && (!max || date <= max);
  // Follow changes made elsewhere (links, the other bound) without touching a field in use.
  useEffect(() => {
    const element = input.current;
    if (element && document.activeElement !== element && element.value !== value)
      element.value = value;
  }, [value]);
  return (
    <label className="date-input">
      {label}
      <input
        {...notCredential}
        ref={input}
        type="date"
        defaultValue={value}
        min={min}
        max={max}
        onChange={(e) => {
          const date = e.target.value;
          // Years still being typed ("0002", "0020") are valid dates; wait for all four digits.
          if (accepts(date) && !date.startsWith("0") && date !== value) onCommit(date);
        }}
        onBlur={(e) => {
          // Leaving the field always shows the committed date; incomplete or out-of-range edits revert.
          if (e.target.value !== value) e.target.value = value;
        }}
      />
    </label>
  );
}

function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  );
}
