// mariowOS translations for system apps. See TRANSLATING.md.
//
// Load it at the top of <head>, after the server-made language data:
//   <script src="/desktop/assets/i18n-data.js"></script>
//   <script src="/desktop/assets/i18n.js"></script>
// Then the translations are ready before any other script runs.
//
// English stays written in the pages and is the fallback; other languages live in
// /desktop/assets/locales/<lang>.json as { "key": "translation" }, and are listed in
// /desktop/assets/locales/languages.json ({ "<lang>": "Native name" }).
//  - HTML: data-i18n="key" (text), data-i18n-placeholder / -title / -aria-label (attributes).
//    Elements added later (innerHTML, templates) are translated automatically.
//  - Scripts: mariowOSI18n.t("key", "English text") or, with values,
//    mariowOSI18n.t("key", "Hello {name}", { name }).
//  - Dates and numbers: pass mariowOSI18n.locale to toLocaleString / Intl.
// The language is Settings › General › Language (default English; "auto" follows the computer).
(function () {
  const ATTRIBUTES = [["placeholder", "placeholder"], ["title", "title"], ["aria-label", "aria-label"]];
  let languages = { en: "English" };
  let dictionary = {};
  let language = "en";

  // English unless the user picked a language; "auto" (opt-in) follows the computer.
  function resolve(preference) {
    if (preference !== "auto") return Object.hasOwn(languages, preference) ? preference : "en";
    const fromSystem = String(navigator.language || "en").toLowerCase();
    if (Object.hasOwn(languages, fromSystem)) return fromSystem;
    const base = fromSystem.split("-")[0];
    return Object.hasOwn(languages, base) ? base : "en";
  }

  function t(key, fallback, params) {
    let text = dictionary[key] !== undefined ? dictionary[key] : (fallback !== undefined ? fallback : key);
    if (params) text = String(text).replace(/\{(\w+)\}/g, (match, name) => (params[name] !== undefined ? params[name] : match));
    return text;
  }

  function translateElement(element) {
    if (element.dataset.i18n !== undefined) {
      if (element.dataset.i18nSource === undefined) element.dataset.i18nSource = element.textContent;
      const text = t(element.dataset.i18n, element.dataset.i18nSource);
      if (element.textContent !== text) element.textContent = text;
    }
    for (const [name, property] of ATTRIBUTES) {
      const key = element.getAttribute(`data-i18n-${name}`);
      if (key === null) continue;
      const sourceAttribute = `data-i18n-source-${name}`;
      if (!element.hasAttribute(sourceAttribute)) element.setAttribute(sourceAttribute, element.getAttribute(property) || "");
      const text = t(key, element.getAttribute(sourceAttribute));
      if (element.getAttribute(property) !== text) element.setAttribute(property, text);
    }
  }

  const SELECTOR = ["[data-i18n]", ...ATTRIBUTES.map(([name]) => `[data-i18n-${name}]`)].join(",");
  function apply(root = document) {
    if (root.nodeType === 1 && root.matches(SELECTOR)) translateElement(root);
    root.querySelectorAll(SELECTOR).forEach(translateElement);
  }

  function useData(data) {
    languages = { en: "English", ...(data.languages || {}) };
    language = Object.hasOwn(languages, data.language) ? data.language : "en";
    dictionary = language === "en" ? {} : (data.dictionary || {});
    document.documentElement.lang = language;
  }

  // Normally the data is already on the page (i18n-data.js); otherwise fetch it.
  async function fetchData() {
    const data = { preference: "en" };
    try { data.languages = await (await fetch("/desktop/assets/locales/languages.json")).json(); } catch (e) {}
    try { data.preference = (await (await fetch("/get-settings")).json()).language || "en"; } catch (e) {}
    languages = { en: "English", ...(data.languages || {}) };
    data.language = resolve(data.preference);
    if (data.language !== "en") {
      try { data.dictionary = await (await fetch(`/desktop/assets/locales/${data.language}.json`)).json(); } catch (e) {}
    }
    useData(data);
  }

  function start() {
    apply(document);
    // Translate whatever the page adds later.
    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) if (node.nodeType === 1) apply(node);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  const preloaded = window.__mariowOSI18nData;
  if (preloaded) useData(preloaded);
  const ready = (preloaded ? Promise.resolve() : fetchData()).then(() => {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
    return language;
  });

  window.mariowOSI18n = Object.freeze({
    ready,
    t,
    apply,
    get languages() { return { ...languages }; },
    get language() { return language; },
    // For toLocaleString / Intl: the chosen language; undefined in English, so dates and
    // numbers keep the computer's own format as before.
    get locale() { return language === "en" ? undefined : language; }
  });
})();
