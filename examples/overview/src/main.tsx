import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Deck } from "./deck.js";
import "./base.css";
import "./overview.css";
import "./concepts.css";
import "./slides.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Deck />
  </StrictMode>,
);
