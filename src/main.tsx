import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App, Home } from './ui/App.tsx';
import { startRouter, useRoute } from './ui/router.ts';
import { installTooltips } from './ui/tooltips.ts';

startRouter();
installTooltips();

function Root() {
  const ref = useRoute(s => s.ref);
  return ref ? <App reviewRef={ref} /> : <Home />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><Root /></StrictMode>,
);
