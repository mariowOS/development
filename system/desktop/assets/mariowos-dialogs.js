// mariowOS dialogs: in-page replacements for alert/confirm/prompt.
// Native dialogs in Electron on Windows steal keyboard focus from the page, leaving inputs
// unusable afterwards, and they don't match the OS look. These return Promises:
//   await mDialog.alert("Saved!")             -> undefined
//   await mDialog.confirm("Delete it?")        -> true / false
//   await mDialog.prompt("Password:", { type: "password" }) -> string / null
// window.alert is also replaced, so legacy alert() calls are styled too (non-blocking).
(function () {
  if (window.mDialog) return;

  const css = `
  .mdlg-backdrop { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.45); opacity: 0; transition: opacity 0.18s ease; font-family: 'Poppins', 'Segoe UI', system-ui, sans-serif; }
  .mdlg-backdrop.show { opacity: 1; }
  .mdlg { width: min(380px, calc(100vw - 32px)); background: rgba(28, 30, 38, 0.97); color: #f2f3f7;
    border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 18px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
    padding: 22px 22px 18px; transform: translateY(12px) scale(0.96); transition: transform 0.22s cubic-bezier(0.2, 1.2, 0.4, 1); }
  .mdlg-backdrop.show .mdlg { transform: none; }
  .mdlg-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .mdlg-icon { width: 36px; height: 36px; flex: 0 0 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font-size: 18px; font-weight: 700; }
  .mdlg-icon.info { background: rgba(10, 132, 255, 0.18); color: #0a84ff; }
  .mdlg-icon.success { background: rgba(48, 209, 88, 0.18); color: #30d158; }
  .mdlg-icon.error { background: rgba(255, 69, 58, 0.18); color: #ff453a; }
  .mdlg-icon.warning { background: rgba(255, 159, 10, 0.18); color: #ff9f0a; }
  .mdlg-title { font-size: 16px; font-weight: 600; }
  .mdlg-msg { font-size: 13.5px; line-height: 1.55; color: rgba(242, 243, 247, 0.78); white-space: pre-wrap; word-break: break-word; }
  .mdlg-input { width: 100%; box-sizing: border-box; margin-top: 14px; padding: 10px 12px; border-radius: 10px; font: inherit; font-size: 14px;
    color: #fff; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.14); outline: none; }
  .mdlg-input:focus { border-color: #0a84ff; }
  .mdlg-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  .mdlg-btn { border: none; border-radius: 10px; padding: 8px 16px; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; color: #fff;
    background: rgba(255, 255, 255, 0.1); transition: filter 0.15s ease; }
  .mdlg-btn:hover { filter: brightness(1.2); }
  .mdlg-btn.primary { background: #0a84ff; }
  .mdlg-btn.danger { background: #ff453a; }
  .mdlg-btn:focus-visible { outline: 2px solid rgba(10, 132, 255, 0.7); outline-offset: 2px; }`;

  function injectStyle() {
    if (document.getElementById('mdlg-style')) return;
    const style = document.createElement('style');
    style.id = 'mdlg-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  // Guess a tone from the message so legacy alert("Error: ...") calls still look right.
  function guessKind(message) {
    const m = String(message).toLowerCase();
    if (/(error|failed|could not|cannot|invalid|wrong|incorrect|not match|denied|unable)/.test(m)) return 'error';
    if (/(warning|are you sure|cannot be undone|irreversible)/.test(m)) return 'warning';
    if (/(success|saved|complete|updated|restored|verified|created|set to|cleared|done)/.test(m)) return 'success';
    return 'info';
  }
  const ICONS = { info: 'i', success: '✓', error: '!', warning: '!' };
  const TITLES = { info: 'Notice', success: 'Done', error: 'Something went wrong', warning: 'Are you sure?' };

  const queue = [];
  let open = false;

  function show(opts) {
    return new Promise(resolve => {
      queue.push({ opts, resolve });
      if (!open) next();
    });
  }

  function next() {
    const item = queue.shift();
    if (!item) { open = false; return; }
    open = true;
    render(item.opts, value => { item.resolve(value); setTimeout(next, 0); });
  }

  function render(opts, done) {
    const mount = () => {
      injectStyle();
      const previousFocus = document.activeElement;
      const kind = opts.kind || guessKind(opts.message);
      const backdrop = document.createElement('div');
      backdrop.className = 'mdlg-backdrop';
      backdrop.innerHTML = `
        <div class="mdlg" role="${opts.mode === 'alert' ? 'alertdialog' : 'dialog'}" aria-modal="true">
          <div class="mdlg-head"><div class="mdlg-icon ${kind}"></div><div class="mdlg-title"></div></div>
          <div class="mdlg-msg"></div>
          ${opts.mode === 'prompt' ? '<input class="mdlg-input">' : ''}
          <div class="mdlg-actions"></div>
        </div>`;
      backdrop.querySelector('.mdlg-icon').textContent = ICONS[kind];
      backdrop.querySelector('.mdlg-title').textContent = opts.title || TITLES[kind];
      backdrop.querySelector('.mdlg-msg').textContent = String(opts.message ?? '');

      const input = backdrop.querySelector('.mdlg-input');
      if (input) {
        input.type = opts.type || 'text';
        input.value = opts.defaultValue || '';
        input.placeholder = opts.placeholder || '';
      }

      const actions = backdrop.querySelector('.mdlg-actions');
      const addBtn = (label, cls, value) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mdlg-btn ' + cls;
        b.textContent = label;
        b.addEventListener('click', () => close(typeof value === 'function' ? value() : value));
        actions.appendChild(b);
        return b;
      };
      const cancelValue = opts.mode === 'confirm' ? false : null;
      if (opts.mode !== 'alert') addBtn(opts.cancelText || 'Cancel', '', cancelValue);
      const okBtn = addBtn(opts.okText || 'OK', opts.danger ? 'danger' : 'primary',
        opts.mode === 'prompt' ? () => input.value : opts.mode === 'confirm' ? true : undefined);

      let closed = false;
      function close(value) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        backdrop.classList.remove('show');
        setTimeout(() => {
          backdrop.remove();
          try { if (previousFocus && previousFocus.focus) previousFocus.focus(); } catch (e) {}
          done(value);
        }, 160);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(opts.mode === 'alert' ? undefined : cancelValue); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); okBtn.click(); }
        else if (e.key === 'Tab') {
          const focusables = [...backdrop.querySelectorAll('button, input')];
          const i = focusables.indexOf(document.activeElement);
          e.preventDefault();
          focusables[(i + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length].focus();
        }
      }
      document.addEventListener('keydown', onKey, true);
      backdrop.addEventListener('mousedown', e => {
        if (e.target === backdrop && opts.mode !== 'alert') close(cancelValue);
      });

      document.body.appendChild(backdrop);
      requestAnimationFrame(() => backdrop.classList.add('show'));
      (input || okBtn).focus();
    };
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
  }

  const normalize = (message, options) => (typeof options === 'string' ? { title: options } : (options || {}));

  window.mDialog = {
    alert: (message, options) => show({ ...normalize(message, options), mode: 'alert', message }),
    confirm: (message, options) => show({ kind: 'warning', ...normalize(message, options), mode: 'confirm', message }),
    prompt: (message, options) => show({ kind: 'info', ...normalize(message, options), mode: 'prompt', message })
  };

  // Styled, non-blocking replacement for legacy alert() calls.
  window.alert = message => window.mDialog.alert(message);
})();
