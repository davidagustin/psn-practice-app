/**
 * ==============================================================================
 * REACT APPLICATION ENTRY POINT
 * ==============================================================================
 *
 * This is the starting point of the React application.
 *
 * REACT 18 CHANGES:
 * - createRoot replaces ReactDOM.render
 * - Concurrent features enabled by default
 * - Automatic batching for better performance
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ApolloProvider } from '@apollo/client';
import { apolloClient } from './apollo/client';
import App from './App';
import './styles/global.css';

/**
 * REACT 18 ROOT API
 *
 * createRoot is the new way to render React apps.
 * It enables concurrent features like:
 * - Automatic batching
 * - Transitions
 * - Suspense for data fetching
 */
const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

/**
 * APPLICATION STRUCTURE
 *
 * React.StrictMode:
 * - Highlights potential problems
 * - Double-invokes some lifecycle methods in development
 * - Helps prepare for future React versions
 *
 * ApolloProvider:
 * - Makes Apollo Client available throughout the app
 * - All child components can use useQuery, useMutation, etc.
 */
root.render(
  <React.StrictMode>
    <ApolloProvider client={apolloClient}>
      <App />
    </ApolloProvider>
  </React.StrictMode>
);
