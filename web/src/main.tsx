import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CheckoutPage } from "./CheckoutPage";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CheckoutPage />
  </StrictMode>
);
