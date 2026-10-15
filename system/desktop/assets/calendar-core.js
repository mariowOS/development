// mariowOS calendar core - shared by the Calendar app and the desktop tray/reminders,
// so both agree on when an event happens. Dates are "YYYY-MM-DD" strings (floating time).
(function () {
  if (window.CalendarCore) return;
  const pad = n => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return { y, m: m - 1, d }; };
  const addDays = (s, n) => { const { y, m, d } = parseYmd(s); const t = new Date(Date.UTC(y, m, d + n)); return ymd(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()); };
  const daysBetween = (a, b) => { const A = parseYmd(a), B = parseYmd(b); return Math.round((Date.UTC(B.y, B.m, B.d) - Date.UTC(A.y, A.m, A.d)) / 86400000); };
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  // Is `date` the start of an occurrence of `ev`? Handles intervals, an end date,
  // skipped dates, and month ends (an event on the 31st happens on the last day of
  // shorter months; Feb 29 happens on Feb 28 in common years).
  function startsOn(ev, date) {
    if (date < ev.date) return false;
    if (ev.until && date > ev.until) return false;
    if (ev.exdates && ev.exdates.includes(date)) return false;
    if (date === ev.date) return true;
    const repeat = ev.repeat || 'none';
    if (repeat === 'none') return false;
    const n = Math.max(1, ev.interval || 1);
    const a = parseYmd(ev.date), b = parseYmd(date);
    if (repeat === 'daily') return daysBetween(ev.date, date) % n === 0;
    if (repeat === 'weekly') { const diff = daysBetween(ev.date, date); return diff % 7 === 0 && (diff / 7) % n === 0; }
    if (repeat === 'monthly') {
      const months = (b.y - a.y) * 12 + (b.m - a.m);
      if (months % n !== 0) return false;
      return b.d === Math.min(a.d, daysInMonth(b.y, b.m));
    }
    if (repeat === 'yearly') {
      if ((b.y - a.y) % n !== 0 || a.m !== b.m) return false;
      return b.d === Math.min(a.d, daysInMonth(b.y, b.m));
    }
    return false;
  }

  // Number of extra days a single occurrence lasts (0 for one-day events).
  const spanOf = ev => (ev.endDate ? Math.max(0, daysBetween(ev.date, ev.endDate)) : 0);

  // Start date of the occurrence that covers `date`, or null.
  function occurrenceStart(ev, date) {
    const span = spanOf(ev);
    for (let back = 0; back <= span; back++) {
      const start = addDays(date, -back);
      if (start < ev.date) break;
      if (startsOn(ev, start)) return start;
    }
    return null;
  }
  const occursOn = (ev, date) => occurrenceStart(ev, date) !== null;

  window.CalendarCore = { pad, ymd, parseYmd, addDays, daysBetween, daysInMonth, startsOn, occursOn, occurrenceStart, spanOf };
})();
