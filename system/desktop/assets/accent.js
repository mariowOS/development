// mariowOS accent color, shared by the desktop and every system app. See Settings › Wallpaper & Style.
//
// Load it in <head>, right after i18n.js, so the first paint already has the right colors.
// It sets these on :root, and keeps them updated when the accent changes:
//  --sys-accent       fills: buttons, selected items, progress bars
//  --sys-accent-on    text and icons placed on top of a --sys-accent fill
//  --sys-accent-text  text, icons and thin marks placed on dark surfaces
// Any accent can be picked, including very dark or very light ones, so never use --sys-accent
// directly for text, and never put white text on it: that is what the other two are for.
(function () {
  const DEFAULT_ACCENT = '#0a84ff';
  // Above this perceived lightness white text stops being comfortable and black takes over.
  const BLACK_TEXT_FROM = 0.72;
  const DARK_SURFACE = [46, 48, 56];

  const toRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const luminance = rgb => {
    const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  // OKLab lightness. Luminance contrast alone would put black text on saturated colors like
  // the default blue or pink, where white reads better.
  const perceivedLightness = rgb => {
    const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    const l = Math.cbrt(0.4122 * r + 0.5363 * g + 0.0514 * b);
    const m = Math.cbrt(0.2119 * r + 0.6807 * g + 0.1074 * b);
    const s = Math.cbrt(0.0883 * r + 0.2817 * g + 0.6300 * b);
    return 0.2105 * l + 0.7936 * m - 0.0041 * s;
  };

  function derive(value) {
    const accent = /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_ACCENT;
    const rgb = toRgb(accent);
    const on = perceivedLightness(rgb) < BLACK_TEXT_FROM ? '#ffffff' : '#000000';
    let text = '#ffffff';
    for (let t = 0; t <= 1; t += 0.05) {
      const mixed = rgb.map(v => Math.round(v + (255 - v) * t));
      if (contrast(luminance(mixed), luminance(DARK_SURFACE)) >= 4.5) { text = `rgb(${mixed.join(', ')})`; break; }
    }
    return { accent, on, text };
  }

  function apply() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('desktopStyle') || '{}').accent; } catch (e) {}
    const { accent, on, text } = derive(saved);
    const root = document.documentElement.style;
    root.setProperty('--sys-accent', accent);
    root.setProperty('--sys-accent-on', on);
    root.setProperty('--sys-accent-text', text);
    document.documentElement.dataset.accentOn = on === '#ffffff' ? 'light' : 'dark';
  }

  // Checkboxes, sliders and progress bars, unless a page styles its own.
  const controls = new CSSStyleSheet();
  controls.replaceSync(':where(input, progress) { accent-color: var(--sys-accent-text); }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, controls];

  apply();
  window.addEventListener('storage', e => { if (e.key === 'desktopStyle' || e.key === null) apply(); });
  window.mariowOSAccent = { derive, apply };
})();
