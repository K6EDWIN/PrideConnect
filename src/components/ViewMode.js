"use client";

import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from "react";

const ViewModeContext = createContext({ mode: "classic", toggle: () => {} });
const STORAGE_KEY = "prideconnect-view-mode";
const CHANGE_EVENT = "prideconnect-view-mode-change";

function subscribe(callback) {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

function getSnapshot() {
  return window.localStorage.getItem(STORAGE_KEY) === "modern" ? "modern" : "classic";
}

function getServerSnapshot() {
  return "classic";
}

function setSavedMode(mode) {
  window.localStorage.setItem(STORAGE_KEY, mode);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function ViewModeProvider({ children }) {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useLayoutEffect(() => {
    document.documentElement.dataset.viewMode = mode;
  }, [mode]);

  return (
    <ViewModeContext.Provider value={{ mode, toggle: () => setSavedMode(mode === "classic" ? "modern" : "classic") }}>
      {children}
    </ViewModeContext.Provider>
  );
}

export function ViewModeToggle({ compact = false }) {
  const { mode, toggle } = useContext(ViewModeContext);
  return (
    <button className={`view-mode-toggle ${compact ? "compact" : ""}`} onClick={toggle} type="button" aria-label={`Switch to ${mode === "classic" ? "modern" : "classic"} view`}>
      <span className={`view-mode-option ${mode === "classic" ? "selected" : ""}`}>Classic</span>
      <span className={`view-mode-option ${mode === "modern" ? "selected" : ""}`}>Modern</span>
    </button>
  );
}
