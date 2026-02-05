/**
 * ==============================================================================
 * APOLLO CLIENT CONFIGURATION
 * ==============================================================================
 *
 * Apollo Client is the GraphQL client that:
 * - Executes queries and mutations
 * - Manages local cache
 * - Handles subscriptions via WebSocket
 *
 * This file sets up Apollo Client to work with both:
 * - HTTP (for queries and mutations)
 * - WebSocket (for subscriptions/real-time updates)
 *
 * APOLLO CLIENT ARCHITECTURE:
 * ===========================
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │                     APOLLO CLIENT                           │
 * │  ┌──────────────────────────────────────────────────────┐  │
 * │  │                    CACHE                              │  │
 * │  │  - Normalized store of all fetched data              │  │
 * │  │  - Automatic updates after mutations                 │  │
 * │  │  - Optimistic updates for instant UI                 │  │
 * │  └──────────────────────────────────────────────────────┘  │
 * │  ┌──────────────────────────────────────────────────────┐  │
 * │  │                    LINK CHAIN                        │  │
 * │  │  ┌────────┐  ┌────────┐  ┌────────────────────────┐  │  │
 * │  │  │ Error  │→ │  Auth  │→ │  HTTP / WebSocket      │  │  │
 * │  │  │  Link  │  │  Link  │  │  (split by operation)  │  │  │
 * │  │  └────────┘  └────────┘  └────────────────────────┘  │  │
 * │  └──────────────────────────────────────────────────────┘  │
 * └─────────────────────────────────────────────────────────────┘
 *
 * LINK CHAIN EXPLANATION:
 * ----------------------
 * Links are middleware that process requests before they're sent.
 *
 * 1. ERROR LINK: Handles errors, logs them, retries if needed
 * 2. AUTH LINK: Adds authentication token to requests
 * 3. SPLIT LINK: Routes subscriptions to WebSocket, others to HTTP
 *
 * INTERVIEW TIP:
 * "Apollo's link chain is like Express middleware for GraphQL.
 * Each link can modify the request, handle errors, or add headers.
 * This gives us a clean way to separate concerns like auth and logging."
 * ==============================================================================
 */

import {
  ApolloClient,
  InMemoryCache,
  createHttpLink,
  split,
  ApolloLink,
} from '@apollo/client';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { getMainDefinition } from '@apollo/client/utilities';
import { createClient } from 'graphql-ws';
import { onError } from '@apollo/client/link/error';

// ==============================================================================
// CONFIGURATION
// ==============================================================================

/**
 * API ENDPOINTS
 *
 * In development, Vite proxies these to localhost:4000
 * In production, these would be your actual API URLs
 */
const HTTP_URI = '/graphql';
const WS_URI = `ws://${window.location.host}/graphql`;

/**
 * Get the auth token from storage.
 *
 * STORAGE OPTIONS:
 * - localStorage: Persists across sessions
 * - sessionStorage: Cleared when browser closes
 * - Memory: Lost on page refresh (most secure, worst UX)
 *
 * SECURITY NOTE:
 * localStorage is vulnerable to XSS attacks.
 * For high-security apps, consider httpOnly cookies.
 */
const getAuthToken = (): string | null => {
  return localStorage.getItem('psn_auth_token');
};

// ==============================================================================
// HTTP LINK
// ==============================================================================

/**
 * HTTP LINK
 *
 * Handles query and mutation requests over HTTP.
 *
 * FEATURES:
 * - Uses fetch API under the hood
 * - Supports batching (multiple queries in one request)
 * - Can be configured with custom headers
 */
const httpLink = createHttpLink({
  uri: HTTP_URI,
  // Include credentials for cookies (if using)
  credentials: 'same-origin',
});

// ==============================================================================
// WEBSOCKET LINK
// ==============================================================================

/**
 * WEBSOCKET LINK
 *
 * Handles subscription requests over WebSocket.
 *
 * GRAPHQL-WS PROTOCOL:
 * This uses the modern graphql-ws protocol, not the deprecated
 * subscriptions-transport-ws protocol.
 *
 * CONNECTION LIFECYCLE:
 * 1. Client opens WebSocket connection
 * 2. Client sends connection_init with auth token
 * 3. Server validates and sends connection_ack
 * 4. Client sends subscribe for each subscription
 * 5. Server sends next for each update
 * 6. Connection stays open until client disconnects
 */
const wsLink = new GraphQLWsLink(
  createClient({
    url: WS_URI,

    /**
     * CONNECTION PARAMS
     *
     * Sent when WebSocket connects.
     * Used for authentication since HTTP headers aren't available.
     *
     * IMPORTANT: This is a function, so it's called each time
     * a connection is established. This ensures fresh tokens.
     */
    connectionParams: () => {
      const token = getAuthToken();
      return {
        authorization: token ? `Bearer ${token}` : '',
      };
    },

    /**
     * RECONNECTION STRATEGY
     *
     * If connection drops, automatically reconnect.
     * Important for mobile apps and flaky networks.
     */
    shouldRetry: () => true,

    /**
     * LAZY CONNECTION
     *
     * Don't connect until first subscription.
     * Saves resources if user never uses real-time features.
     */
    lazy: true,

    /**
     * CONNECTION LIFECYCLE CALLBACKS
     *
     * Useful for:
     * - Logging
     * - UI indicators (connected/disconnected)
     * - Retry logic
     */
    on: {
      connected: () => {
        console.log('[WebSocket] Connected to server');
      },
      closed: () => {
        console.log('[WebSocket] Connection closed');
      },
      error: (error) => {
        console.error('[WebSocket] Connection error:', error);
      },
    },
  })
);

// ==============================================================================
// AUTH LINK
// ==============================================================================

/**
 * AUTH LINK
 *
 * Adds authentication header to every HTTP request.
 *
 * FLOW:
 * 1. Get token from storage
 * 2. Add to Authorization header
 * 3. Pass request to next link
 *
 * WHY A SEPARATE LINK?
 * - Separation of concerns
 * - Easy to modify auth logic
 * - Can be reused across different transports
 */
const authLink = new ApolloLink((operation, forward) => {
  // Get the auth token
  const token = getAuthToken();

  // Add to headers
  operation.setContext(({ headers = {} }) => ({
    headers: {
      ...headers,
      authorization: token ? `Bearer ${token}` : '',
    },
  }));

  // Continue to next link
  return forward(operation);
});

// ==============================================================================
// ERROR LINK
// ==============================================================================

/**
 * ERROR LINK
 *
 * Handles errors from GraphQL operations.
 *
 * ERROR TYPES:
 * - graphQLErrors: Errors returned in response (validation, auth, etc.)
 * - networkError: Network failed (no response received)
 *
 * COMMON PATTERNS:
 * - Log errors for debugging
 * - Show user-friendly messages
 * - Redirect to login on auth errors
 * - Retry on network errors
 */
const errorLink = onError(({ graphQLErrors, networkError, operation }) => {
  // Handle GraphQL errors (from the server)
  if (graphQLErrors) {
    graphQLErrors.forEach(({ message, locations, path, extensions }) => {
      console.error(
        `[GraphQL Error] Message: ${message}`,
        `\n  Path: ${path?.join('.')}`,
        `\n  Code: ${extensions?.code}`,
        `\n  Operation: ${operation.operationName}`
      );

      // Handle authentication errors
      if (extensions?.code === 'UNAUTHENTICATED') {
        // Clear stored token
        localStorage.removeItem('psn_auth_token');

        // In a real app, redirect to login
        console.log('[Auth] Session expired, please login again');
      }
    });
  }

  // Handle network errors (couldn't reach server)
  if (networkError) {
    console.error(
      `[Network Error] ${networkError.message}`,
      `\n  Operation: ${operation.operationName}`
    );

    // Could implement retry logic here
    // or show offline indicator
  }
});

// ==============================================================================
// SPLIT LINK
// ==============================================================================

/**
 * SPLIT LINK
 *
 * Routes operations to the appropriate transport:
 * - Subscriptions → WebSocket
 * - Queries/Mutations → HTTP
 *
 * WHY SPLIT?
 * - HTTP is stateless and works well for one-off requests
 * - WebSocket maintains connection for real-time updates
 * - Using the right transport for each operation is more efficient
 *
 * HOW IT WORKS:
 * The split function takes:
 * 1. A test function (returns true for WebSocket)
 * 2. Link for true case (WebSocket)
 * 3. Link for false case (HTTP)
 */
const splitLink = split(
  // Test function: Is this a subscription?
  ({ query }) => {
    const definition = getMainDefinition(query);
    return (
      definition.kind === 'OperationDefinition' &&
      definition.operation === 'subscription'
    );
  },
  // True: Use WebSocket for subscriptions
  wsLink,
  // False: Use HTTP for queries/mutations (with auth)
  authLink.concat(httpLink)
);

// ==============================================================================
// CACHE CONFIGURATION
// ==============================================================================

/**
 * IN-MEMORY CACHE
 *
 * Apollo's cache provides:
 * - Normalized storage (no duplicate data)
 * - Automatic updates after mutations
 * - Optimistic updates for instant UI
 * - Local state management
 *
 * NORMALIZATION:
 * All objects are stored by their ID and __typename.
 * References link related data.
 *
 * Example: User { id: "1", gamertag: "Player1" }
 * Stored as: { "User:1": { __typename: "User", id: "1", gamertag: "Player1" } }
 *
 * WHY NORMALIZE?
 * - When data updates, it updates everywhere it's used
 * - No duplicate data in memory
 * - Efficient cache updates
 */
const cache = new InMemoryCache({
  /**
   * TYPE POLICIES
   *
   * Configure how types are stored and merged.
   *
   * keyFields: How to uniquely identify objects
   * merge: How to combine old and new data
   * read: Custom read logic (e.g., computed fields)
   */
  typePolicies: {
    User: {
      // Users are identified by their 'id' field
      keyFields: ['id'],
    },

    Conversation: {
      keyFields: ['id'],
      fields: {
        // Configure how messages field is handled
        messages: {
          // Don't separate cached messages by query args
          // (so all message queries share the same cache)
          keyArgs: false,

          // When fetching more messages, merge with existing
          merge(existing = [], incoming) {
            return [...existing, ...incoming];
          },
        },
      },
    },

    Query: {
      fields: {
        // Configure friends list caching
        friends: {
          // Always use fresh data, don't cache
          merge(existing, incoming) {
            return incoming;
          },
        },
      },
    },
  },
});

// ==============================================================================
// CREATE APOLLO CLIENT
// ==============================================================================

/**
 * APOLLO CLIENT INSTANCE
 *
 * This is the main client used throughout the app.
 * Exported for use in ApolloProvider.
 */
export const apolloClient = new ApolloClient({
  // Chain: errorLink → splitLink (→ wsLink or authLink → httpLink)
  link: errorLink.concat(splitLink),

  // Normalized cache
  cache,

  /**
   * DEFAULT OPTIONS
   *
   * Set defaults for all queries/mutations.
   */
  defaultOptions: {
    watchQuery: {
      // Fetch from cache first, then update from network
      fetchPolicy: 'cache-and-network',

      // Return partial data while loading
      returnPartialData: true,
    },
    query: {
      // Fetch from network, update cache
      fetchPolicy: 'network-only',

      // Show errors in result (don't throw)
      errorPolicy: 'all',
    },
    mutate: {
      // Show errors in result (don't throw)
      errorPolicy: 'all',
    },
  },

  /**
   * CONNECT TO DEVTOOLS
   *
   * Apollo DevTools browser extension shows:
   * - Cache contents
   * - Query/mutation history
   * - GraphQL schema
   *
   * Install from: https://www.apollographql.com/docs/react/development-testing/developer-tooling/
   */
  connectToDevTools: true,
});

// ==============================================================================
// HELPER FUNCTIONS
// ==============================================================================

/**
 * Save auth token after login/register.
 */
export const setAuthToken = (token: string): void => {
  localStorage.setItem('psn_auth_token', token);
};

/**
 * Clear auth token on logout.
 */
export const clearAuthToken = (): void => {
  localStorage.removeItem('psn_auth_token');
};

/**
 * Check if user is authenticated.
 */
export const isAuthenticated = (): boolean => {
  return !!getAuthToken();
};
