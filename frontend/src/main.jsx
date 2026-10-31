import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './app/App.jsx';
import {AppearanceProvider, readAppearance} from './lib/appearance.jsx';

document.documentElement.dataset.theme = readAppearance();

const appRoot = document.getElementById('app');
createRoot(appRoot).render(<AppearanceProvider><App/></AppearanceProvider>);
appRoot?.setAttribute('aria-busy', 'false');
