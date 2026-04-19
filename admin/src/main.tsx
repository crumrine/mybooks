import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { installGlobalErrorHandlers } from './errorReporting';
import './index.css';

installGlobalErrorHandlers();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter basename="/admin">
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
