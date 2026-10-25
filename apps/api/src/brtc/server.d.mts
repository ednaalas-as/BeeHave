import type { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
export function handleBrtcRequest(req: Readable & {
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  method: string;
  url: string;
}, res: ServerResponse): Promise<void>;
export function initializeBrtc(): Promise<void>;
export function closeBrtc(): Promise<void>;
export const pool: { end(): Promise<void> };
