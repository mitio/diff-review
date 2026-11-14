import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

type Cb = (near: boolean) => void;

/** Two shared observers: mount when within NEAR px, unmount when beyond FAR px. */
const NEAR = 1500;
const FAR = 5000;
let root: Element | null = null;
let nearObs: IntersectionObserver | null = null;
let farObs: IntersectionObserver | null = null;
const nearCbs = new Map<Element, Cb>();
const farCbs = new Map<Element, Cb>();

export function setScrollRoot(el: Element | null) {
  if (el === root) return;
  root = el;
  nearObs?.disconnect();
  farObs?.disconnect();
  nearObs = farObs = null;
  if (!el) return;
  nearObs = new IntersectionObserver(es => es.forEach(e => e.isIntersecting && nearCbs.get(e.target)?.(true)), {
    root: el, rootMargin: `${NEAR}px 0px`,
  });
  farObs = new IntersectionObserver(es => es.forEach(e => !e.isIntersecting && farCbs.get(e.target)?.(false)), {
    root: el, rootMargin: `${FAR}px 0px`,
  });
  for (const t of nearCbs.keys()) nearObs.observe(t);
  for (const t of farCbs.keys()) farObs.observe(t);
}

export function Lazy({ estimate, children, eager = false }: { estimate: number; children: () => ReactNode; eager?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(eager);
  const height = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current!;
    nearCbs.set(el, () => setOn(true));
    farCbs.set(el, () => {
      height.current = el.offsetHeight || height.current;
      setOn(false);
    });
    nearObs?.observe(el);
    farObs?.observe(el);
    return () => {
      nearCbs.delete(el);
      farCbs.delete(el);
      nearObs?.unobserve(el);
      farObs?.unobserve(el);
    };
  }, []);

  useLayoutEffect(() => {
    if (on && ref.current) height.current = ref.current.offsetHeight;
  });

  return (
    <div ref={ref} style={on ? undefined : { height: height.current ?? estimate }}>
      {on ? children() : null}
    </div>
  );
}
