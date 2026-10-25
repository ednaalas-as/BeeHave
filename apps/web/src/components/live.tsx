import { ago, healthFresh, healthReportedAt, type Device } from "@beehave/shared";
import type { ReactNode } from "react";

export const NOT_REPORTED = "Not reported by device";

/** Values the device must confirm read Unknown when its report is not current; the last
 * reported value stays visible as history, never as the current state. */
export function liveValue(device: Device) {
  const fresh = healthFresh(device);
  const reportedAt = healthReportedAt(device);
  return (value: ReactNode | undefined): ReactNode =>
    value === undefined || value === "" ? NOT_REPORTED
    : fresh ? value
    : (
      <span className="stale-value">
        Unknown
        <small>Last reported {reportedAt ? ago(reportedAt).toLowerCase() : ""}: {value}</small>
      </span>
    );
}
