/**
 * Shows `title` tooltips at once instead of after the browser's delay. While an element is hovered its title moves to
 * `data-tip`, so the native one never shows; a title React sets meanwhile (e.g. reactors loaded) updates the tip.
 */
export function installTooltips() {
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);
  let owner: Element | null = null;

  const take = (el: Element) => {
    el.setAttribute('data-tip', el.getAttribute('title') ?? '');
    el.removeAttribute('title');
  };
  const place = (el: Element) => {
    const text = el.getAttribute('data-tip') ?? '';
    tip.textContent = text;
    tip.hidden = !text.trim();
    if (tip.hidden) return;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const below = r.bottom + 6 + h <= window.innerHeight - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? r.bottom + 6 : r.top - 6 - h}px`;
  };
  const watch = new MutationObserver(() => {
    if (!owner?.hasAttribute('title')) return;
    take(owner);
    place(owner);
  });
  const hide = () => {
    watch.disconnect();
    tip.hidden = true;
    if (!owner) return;
    if (!owner.hasAttribute('title')) owner.setAttribute('title', owner.getAttribute('data-tip') ?? '');
    owner.removeAttribute('data-tip');
    owner = null;
  };

  document.addEventListener('mouseover', e => {
    const el = (e.target as Element).closest?.('[title], [data-tip]') ?? null;
    if (el === owner) return;
    hide();
    if (!el || !el.getAttribute('title')?.trim()) return;
    owner = el;
    take(el);
    place(el);
    watch.observe(el, { attributes: true, attributeFilter: ['title'] });
  }, true);
  document.documentElement.addEventListener('mouseleave', hide);
  for (const ev of ['mousedown', 'keydown', 'scroll'] as const) window.addEventListener(ev, hide, true);
  window.addEventListener('blur', hide);
}
