import express,{
type NextFunction,
type Request,
type Response,
} from "express";
import { z } from "zod";
import { HttpError } from "../types";
export function registerErrorHandlers(app: express.Express) {
  app.use((_req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError)
      return res.status(400).json({
        error: err.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    if (err instanceof HttpError)
      return res.status(err.status).json({ error: err.message });
    if (err instanceof SyntaxError)
      return res.status(400).json({ error: "Invalid JSON body." });
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "23505"
    ) {
      return res.status(409).json({ error: "This record already exists." });
    }
    console.error(err);
    res
      .status(500)
      .json({ error: "The server could not complete this request." });
  });
}
