import React from "react";
import ReactDOM from "react-dom/client";
import { FrostProvider } from "@rialo/frost";
import { frostConfig } from "./frost.config";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FrostProvider config={frostConfig}>
      <App />
    </FrostProvider>
  </React.StrictMode>,
);
