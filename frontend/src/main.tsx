import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { Home } from "./pages/Home";
import { RoomPage } from "./pages/Room";
import { ResultsPage } from "./pages/Results";
import { AboutPage } from "./pages/About";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/results/:roomId" element={<ResultsPage />} />
        <Route path="/:code" element={<RoomPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
