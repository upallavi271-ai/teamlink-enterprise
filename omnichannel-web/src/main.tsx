import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import { initApiClient } from './app/initApiClient';
import './styles/globals.css';

// Wire the HTTP layer to the stores once, before the app renders.
initApiClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
