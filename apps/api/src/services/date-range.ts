import { manilaDate } from "@beehave/shared";
import { type Request } from "express";
import { z } from "zod";
import { HttpError } from "../types";
export function range(req: Request, defaultDays = 1) {
  const day = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (v) =>
        !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v),
    );
  const to = day.parse(req.query.to ?? manilaDate());
  const from = day.parse(
    req.query.from ??
      manilaDate(
        new Date(
          Date.parse(`${to}T00:00:00+08:00`) - (defaultDays - 1) * 86400000,
        ),
      ),
  );
  if (from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000)
    throw new HttpError(400, "Choose a date range of up to 367 days.");
  return {
    from,
    to,
    start: new Date(`${from}T00:00:00+08:00`).toISOString(),
    end: new Date(Date.parse(`${to}T00:00:00+08:00`) + 86400000).toISOString(),
  };
}
