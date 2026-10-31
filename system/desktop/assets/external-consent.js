// mariowOS: ask once before contacting a third-party service (GDPR / ePrivacy).
// Loading an external service sends the user's IP address (and possibly cookies) to it,
// so it only happens after an explicit choice, which is remembered per service.
//   if (await mwExternalConsent("element", "Element (app.element.io)")) { ...load... }
(function () {
  if (window.mwExternalConsent) return;
  const key = id => "mw_consent_" + id;

  window.mwExternalConsent = async function (id, serviceLabel) {
    try { if (localStorage.getItem(key(id)) === "yes") return true; } catch (e) {}
    const i18n = window.mariowOSI18n;
    const english = "This feature loads content from an external service: {service}.\n\nYour IP address and technical data will be sent to that service, which may also set its own cookies. See the Privacy notice for details.\n\nDo you want to continue?";
    const message = (i18n ? mariowOSI18n.t("consent.message", "This feature loads content from an external service: {service}.\n\nYour IP address and technical data will be sent to that service, which may also set its own cookies. See the Privacy notice for details.\n\nDo you want to continue?") : english)
      .replace("{service}", () => serviceLabel);
    const ok = window.mDialog
      ? await window.mDialog.confirm(message, {
        title: (i18n ? mariowOSI18n.t("consent.title", "External service") : "External service"),
        okText: (i18n ? mariowOSI18n.t("common.continue", "Continue") : "Continue"),
        cancelText: (i18n ? mariowOSI18n.t("common.cancel", "Cancel") : "Cancel"),
        kind: "info"
      })
      : window.confirm(message);
    if (ok) { try { localStorage.setItem(key(id), "yes"); } catch (e) {} }
    return !!ok;
  };

  window.mwRevokeExternalConsents = function () {
    try {
      Object.keys(localStorage).filter(k => k.startsWith("mw_consent_")).forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  };
})();
