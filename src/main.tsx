import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AIProvider } from './ai';
import { AuthGate } from './auth';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><AuthGate><AIProvider><App /></AIProvider></AuthGate></React.StrictMode>);
