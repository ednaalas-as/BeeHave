// Normalize the timezone with Date, but retain fractional seconds from the source.
// Keep the existing three-digit representation for millisecond timestamps.
export function canonicalTimestamp(value: string): string {
  const utc = new Date(value).toISOString();
  const fraction = value.match(/\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1];
  if (!fraction || fraction.length <= 3) return utc;
  const precise = fraction.replace(/0+$/, "").padEnd(3, "0");
  return utc.replace(/\.\d{3}Z$/, `.${precise}Z`);
}
