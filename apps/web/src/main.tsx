import { colors } from "@beehave/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { queryClient } from "./query-client";
import { applyTextSize, readTextSize } from "./text-size";
import "./styles.css";

applyTextSize(readTextSize());

for (const [key, value] of Object.entries(colors)) {
  document.documentElement.style.setProperty(
    "--" + key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()),
    value,
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <App />
        </HashRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
