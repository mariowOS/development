// mariowOS: ask once before contacting a third-party service (GDPR / ePrivacy).
// Loading an external service sends the user's IP address (and possibly cookies) to it,
// so it only happens after an explicit choice, which is remembered per service.
//   if (await mwExternalConsent("element", "Element (app.element.io)")) { ...load... }
(function () {
  if (window.mwExternalConsent) return;
  const key = id => "mw_consent_" + id;

  window.mwExternalConsent = async function (id, serviceLabel) {
    try { if (localStorage.getItem(key(id)) === "yes") return true; } catch (e) {}
    const message = `This feature loads content from an external service: ${serviceLabel}.\n\n` +
      "Your IP address and technical data will be sent to that service, which may also set its own cookies. " +
      "See the Privacy notice for details.\n\nDo you want to continue?";
    const ok = window.mDialog
      ? await window.mDialog.confirm(message, { title: "External service", okText: "Continue", cancelText: "Cancel", kind: "info" })
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
