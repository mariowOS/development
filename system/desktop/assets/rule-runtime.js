// mariowOS builder note: This file is part of the runtime that powers the OS. It defines how the desktop, login flow, or app behavior is built for contributors.

(() => {
  // This file is the rule engine heartbeat for the desktop shell.
  // It continuously asks the backend if there are any enabled rules, then triggers
  // notifications, startup launches, and battery-based actions in a very lightweight way.
  let polling = false;
  let batteryPromise = null;
  let startupRulesLoaded = false;
  const pendingStartupApps = new Set();

  async function postTrigger(rule, details) {
    const response = await fetch('/api/rules/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: rule.id, ...details })
    });
    if (!response.ok) return null;
    return response.json();
  }

  function launchReadyApps() {
    // When startup-triggered apps are approved by the backend, this function opens them
    // the moment the desktop is ready. It keeps the app launch sequence safe and avoids
    // trying to open something before the shell has created the element in the DOM.
    if (typeof window.openPopup !== 'function') return;
    pendingStartupApps.forEach(appId => {
      if (!document.getElementById(appId)) return;
      window.openPopup(appId);
      pendingStartupApps.delete(appId);
    });
  }

  async function pollRuleRuntime() {
    if (polling) return;
    polling = true;

    try {
      launchReadyApps();
      const [rulesResponse, enabledResponse] = await Promise.all([
        fetch('/api/rules', { cache: 'no-store' }),
        fetch('/api/rules/enabled', { cache: 'no-store' })
      ]);
      if (!rulesResponse.ok || !enabledResponse.ok) return;

      const rules = await rulesResponse.json();
      const { enabled } = await enabledResponse.json();
      if (enabled) {
        if (!startupRulesLoaded) {
          startupRulesLoaded = true;
          const startupRules = rules.filter(rule => rule.enabled && rule.trigger === 'startup' && rule.action === 'launch-app');
          for (const rule of startupRules) {
            const startupKey = `rule-startup-${rule.id}`;
            if (sessionStorage.getItem(startupKey)) continue;
            sessionStorage.setItem(startupKey, 'requested');
            const result = await postTrigger(rule, { trigger: 'startup' });
            if (!result || result.retry) {
              sessionStorage.removeItem(startupKey);
              startupRulesLoaded = false;
              break;
            }
            if (result.fired && result.appId) {
              pendingStartupApps.add(result.appId);
            }
          }
        }

        if (rules.some(rule => rule.enabled && rule.trigger === 'battery') && typeof navigator.getBattery === 'function') {
          batteryPromise ||= navigator.getBattery();
          const battery = await batteryPromise;
          const level = Math.round(battery.level * 100);
          for (const rule of rules) {
            if (rule.enabled && rule.trigger === 'battery' && rule.action === 'notify') {
              await postTrigger(rule, { trigger: 'battery', level });
            }
          }
        }
      }

      launchReadyApps();
      const notificationsResponse = await fetch('/api/rules/notifications', { cache: 'no-store' });
      if (notificationsResponse.ok && typeof window.showNotification === 'function') {
        const notifications = await notificationsResponse.json();
        notifications.forEach(item => window.showNotification(item.title, item.msg, item.icon));
      }
    } catch (error) {
      console.error('Rule runtime error:', error);
    } finally {
      polling = false;
    }
  }

  setInterval(pollRuleRuntime, 10000);
  window.addEventListener('online', pollRuleRuntime);
  pollRuleRuntime();
})();
