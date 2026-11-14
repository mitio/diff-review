import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { parsePrUrl } from './lib/github.ts';
import { App, Home } from './ui/App.tsx';

const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
const ref = m ? parsePrUrl(`${m[1]}/${m[2]}/pull/${m[3]}`) : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>{ref ? <App prRef={ref} /> : <Home />}</StrictMode>,
);
