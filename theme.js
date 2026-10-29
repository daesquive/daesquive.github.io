(function () {
  "use strict";
  const KEY = "atlas-iberia-theme-v1";
  const root = document.documentElement;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  let theme = "light";
  let storageMessage = "";

  function applyTheme(value) {
    theme = value;
    root.dataset.theme = theme;
    themeColor.content = theme === "dark" ? "#102c29" : "#153f3d";
  }
  function isStorageError(error) {
    return error.name === "SecurityError" || error.name === "QuotaExceededError";
  }

  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "dark" || saved === "light") theme = saved;
    else if (saved !== null) storageMessage = "La preferencia de apariencia no es válida. Se muestra el modo claro; elegí un modo para guardarlo de nuevo.";
  } catch (error) {
    if (!isStorageError(error)) throw error;
    storageMessage = "No se pudo leer la preferencia de apariencia. Podés cambiar el modo para esta visita.";
  }
  applyTheme(theme);

  document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("theme-toggle");
    const status = document.getElementById("theme-status");
    function updateButton() {
      button.textContent = theme === "dark" ? "Modo claro" : "Modo oscuro";
      button.setAttribute("aria-label", `Cambiar a ${button.textContent.toLowerCase()}`);
    }
    updateButton();
    status.textContent = storageMessage;
    button.addEventListener("click", () => {
      applyTheme(theme === "dark" ? "light" : "dark");
      updateButton();
      try {
        localStorage.setItem(KEY, theme);
        status.textContent = `Modo ${theme === "dark" ? "oscuro" : "claro"} activado. Se recordará en este navegador.`;
      } catch (error) {
        if (!isStorageError(error)) throw error;
        status.textContent = "El modo cambió solo para esta visita: no se pudo guardar la preferencia. Revisá los permisos o el espacio del navegador.";
      }
    });
  });
})();
