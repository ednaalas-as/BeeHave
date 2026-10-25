import { classificationOptions } from "@beehave/shared";
import { useSearchParams } from "react-router-dom";
import { periodRange } from "../api";
import { notCredential } from "../autofill";
import { DateInput } from "./DateInput";

export function useRecordFilters() {
  const [search, setSearch] = useSearchParams();
  const date = search.get("date");
  const range = periodRange(30);
  const from = search.get("from") ?? date ?? range.from;
  const to = search.get("to") ?? date ?? range.to;
  const order = search.get("order") ?? "newest";
  const species = search.get("species") ?? "";
  const page = Math.max(1, Number(search.get("page") ?? 1));
  const sizeValue = Number(search.get("size") ?? 20);
  const size = [10, 20, 50, 100].includes(sizeValue) ? sizeValue : 20;
  function update(key: string, value: string) {
    const next = new URLSearchParams(search);
    next.delete("date");
    if (date) {
      next.set("from", date);
      next.set("to", date);
    }
    next.set(key, value);
    if (key !== "page") next.set("page", "1");
    setSearch(next);
  }
  return { from, to, order, species, page, size, update };
}

export function Filters({
  f,
  classification = false,
}: {
  f: ReturnType<typeof useRecordFilters>;
  classification?: boolean;
}) {
  return (
    <div className="filters card">
      <DateInput
        label="From"
        value={f.from}
        max={f.to}
        onCommit={(value) => f.update("from", value)}
      />
      <DateInput
        label="To"
        value={f.to}
        min={f.from}
        onCommit={(value) => f.update("to", value)}
      />
      {classification && (
        <label>
          Classification
          <select
            {...notCredential}
            value={f.species}
            onChange={(e) => f.update("species", e.target.value)}
          >
            {classificationOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Sort by
        <select
          {...notCredential}
          value={f.order}
          onChange={(e) => f.update("order", e.target.value)}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </label>
    </div>
  );
}

