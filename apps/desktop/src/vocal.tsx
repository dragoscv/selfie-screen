import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "./components/error-boundary.js";
import { VocalWindow } from "./components/vocal/vocal-window.js";
import "./i18n/index.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from vocal.html");

declare global {
    interface Window {
        __tikseeVocalRoot?: ReturnType<typeof createRoot>;
    }
}

const root = (window.__tikseeVocalRoot ??= createRoot(container));

root.render(
    <StrictMode>
        <ErrorBoundary>
            <VocalWindow />
        </ErrorBoundary>
    </StrictMode>,
);
