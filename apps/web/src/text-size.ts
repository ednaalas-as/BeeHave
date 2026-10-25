export const textSizes = {
  standard: { label: "Standard", scale: 1 },
  comfortable: { label: "Comfortable", scale: 1.125 },
  larger: { label: "Larger", scale: 1.25 },
} as const;

export type TextSize = keyof typeof textSizes;
const storageKey = "beehave.textSize";

export function readTextSize(): TextSize {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved && Object.hasOwn(textSizes, saved)) return saved as TextSize;
  } catch {
    // Browser storage can be unavailable; the default remains usable.
  }
  return "standard";
}

export function applyTextSize(size: TextSize) {
  document.documentElement.style.setProperty(
    "--text-scale",
    String(textSizes[size].scale),
  );
}

export function saveTextSize(size: TextSize) {
  applyTextSize(size);
  try {
    localStorage.setItem(storageKey, size);
  } catch {
    // Keep the selection active for this visit when storage is unavailable.
  }
}
