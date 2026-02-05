/**
 * ==============================================================================
 * PLAYSTATION NETWORK - MAIN APPLICATION COMPONENT
 * ==============================================================================
 *
 * This is the root component of the React application.
 *
 * COMPONENT STRUCTURE:
 * ====================
 *
 * App (this file)
 * ├── Header (navigation)
 * ├── LoginForm (if not authenticated)
 * └── Dashboard (if authenticated)
 *     ├── FriendsList
 *     ├── ChatPanel
 *     └── ProfilePanel
 *
 * STATE MANAGEMENT:
 * =================
 *
 * We're using:
 * - Apollo Client cache for server state (friends, messages, etc.)
 * - React useState for local UI state (which panel is open, etc.)
 * - localStorage for auth token persistence
 *
 * WHY NOT REDUX?
 * Apollo Client already provides:
 * - Normalized cache (like Redux store)
 * - Automatic updates on mutations
 * - Optimistic updates
 * - Subscription handling
 *
 * For most GraphQL apps, Apollo's cache is sufficient.
 *
 * INTERVIEW TIP:
 * "We chose Apollo Client over Redux because Apollo handles both
 * data fetching and caching. Adding Redux would mean managing
 * two caches and keeping them in sync."
 * ==============================================================================
 */

import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useSubscription, gql } from '@apollo/client';
import { setAuthToken, clearAuthToken, isAuthenticated } from './apollo/client';

// ==============================================================================
// GRAPHQL OPERATIONS
// ==============================================================================

/**
 * GRAPHQL FRAGMENTS
 *
 * Fragments are reusable pieces of queries.
 * They prevent duplicating field selections.
 */
const USER_FIELDS = gql`
  fragment UserFields on User {
    id
    gamertag
    avatar
    level
    status
    currentGame
    statusMessage
  }
`;

const PRESENCE_FIELDS = gql`
  fragment PresenceFields on Presence {
    userId
    gamertag
    status
    currentGame
    statusMessage
    lastActiveAt
  }
`;

/**
 * QUERIES
 *
 * Read operations - fetching data from the server.
 */

// Get current user's profile
const ME_QUERY = gql`
  ${USER_FIELDS}
  query Me {
    me {
      ...UserFields
      trophyCount
    }
  }
`;

// Get friends list with presence
const FRIENDS_QUERY = gql`
  ${USER_FIELDS}
  ${PRESENCE_FIELDS}
  query Friends {
    friends {
      user {
        ...UserFields
      }
      presence {
        ...PresenceFields
      }
      isOnline
    }
  }
`;

/**
 * MUTATIONS
 *
 * Write operations - modifying data on the server.
 */

// Login mutation
const LOGIN_MUTATION = gql`
  ${USER_FIELDS}
  mutation Login($input: LoginInput!) {
    login(input: $input) {
      token
      user {
        ...UserFields
      }
      expiresAt
    }
  }
`;

// Register mutation
const REGISTER_MUTATION = gql`
  ${USER_FIELDS}
  mutation Register($input: RegisterInput!) {
    register(input: $input) {
      token
      user {
        ...UserFields
      }
      expiresAt
    }
  }
`;

// Update presence
const UPDATE_PRESENCE_MUTATION = gql`
  ${PRESENCE_FIELDS}
  mutation UpdatePresence($input: UpdatePresenceInput!) {
    updatePresence(input: $input) {
      ...PresenceFields
    }
  }
`;

// Heartbeat to stay online
const HEARTBEAT_MUTATION = gql`
  mutation Heartbeat {
    heartbeat {
      status
    }
  }
`;

// Logout
const LOGOUT_MUTATION = gql`
  mutation Logout {
    logout {
      success
      message
    }
  }
`;

/**
 * SUBSCRIPTIONS
 *
 * Real-time updates pushed from the server.
 */
const FRIEND_PRESENCE_SUBSCRIPTION = gql`
  ${PRESENCE_FIELDS}
  subscription FriendPresenceUpdated {
    friendPresenceUpdated {
      ...PresenceFields
    }
  }
`;

// ==============================================================================
// TYPES
// ==============================================================================

interface User {
  id: string;
  gamertag: string;
  avatar: string;
  level: number;
  status: 'ONLINE' | 'AWAY' | 'BUSY' | 'OFFLINE' | 'INVISIBLE';
  currentGame: string | null;
  statusMessage: string | null;
  trophyCount?: number;
}

interface Presence {
  userId: string;
  gamertag: string;
  status: string;
  currentGame: string | null;
  statusMessage: string | null;
  lastActiveAt: number;
}

interface FriendWithPresence {
  user: User;
  presence: Presence | null;
  isOnline: boolean;
}

// ==============================================================================
// MAIN APP COMPONENT
// ==============================================================================

/**
 * App Component
 *
 * The root component that manages:
 * - Authentication state
 * - Main layout
 * - Route-like behavior (login vs dashboard)
 */
export default function App(): JSX.Element {
  // ---------------------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------------------

  /**
   * Authentication state
   *
   * isLoggedIn tracks whether user is authenticated.
   * We check localStorage on mount and update after login/logout.
   */
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(isAuthenticated());

  // ---------------------------------------------------------------------------
  // EFFECTS
  // ---------------------------------------------------------------------------

  /**
   * HEARTBEAT EFFECT
   *
   * Sends periodic heartbeats to keep the user's presence alive.
   * Without heartbeats, the server considers the user offline after TTL expires.
   */
  const [heartbeat] = useMutation(HEARTBEAT_MUTATION);

  useEffect(() => {
    if (!isLoggedIn) return;

    // Send heartbeat immediately on login
    heartbeat().catch(console.error);

    // Then every 60 seconds
    const interval = setInterval(() => {
      heartbeat().catch(console.error);
    }, 60000); // 60 seconds

    return () => clearInterval(interval);
  }, [isLoggedIn, heartbeat]);

  // ---------------------------------------------------------------------------
  // HANDLERS
  // ---------------------------------------------------------------------------

  /**
   * Handle successful login.
   * Stores token and updates state.
   */
  const handleLoginSuccess = (token: string): void => {
    setAuthToken(token);
    setIsLoggedIn(true);
    console.log('[App] Login successful');
  };

  /**
   * Handle logout.
   * Clears token and updates state.
   */
  const handleLogout = (): void => {
    clearAuthToken();
    setIsLoggedIn(false);
    console.log('[App] Logged out');
  };

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  return (
    <div className="app">
      {/* HEADER - Always visible */}
      <Header isLoggedIn={isLoggedIn} onLogout={handleLogout} />

      {/* MAIN CONTENT - Login or Dashboard */}
      <main className="container" style={{ paddingTop: '2rem', paddingBottom: '2rem' }}>
        {isLoggedIn ? (
          <Dashboard onLogout={handleLogout} />
        ) : (
          <LoginForm onSuccess={handleLoginSuccess} />
        )}
      </main>
    </div>
  );
}

// ==============================================================================
// HEADER COMPONENT
// ==============================================================================

/**
 * Header Component
 *
 * Top navigation bar with logo and user actions.
 *
 * FEATURES:
 * - PlayStation-style branding
 * - User status when logged in
 * - Logout button
 */
interface HeaderProps {
  isLoggedIn: boolean;
  onLogout: () => void;
}

function Header({ isLoggedIn, onLogout }: HeaderProps): JSX.Element {
  const [logout] = useMutation(LOGOUT_MUTATION);

  const handleLogout = async (): Promise<void> => {
    try {
      await logout();
    } catch (error) {
      console.error('[Header] Logout error:', error);
    }
    onLogout();
  };

  return (
    <header className="header">
      <div className="header__content">
        {/* Logo */}
        <div className="header__logo">
          PSN Social
        </div>

        {/* Right side - User actions */}
        {isLoggedIn && (
          <div className="flex items-center gap-4">
            <button
              onClick={handleLogout}
              className="btn btn--secondary"
            >
              Logout
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

// ==============================================================================
// LOGIN FORM COMPONENT
// ==============================================================================

/**
 * LoginForm Component
 *
 * Handles both login and registration.
 *
 * FORM STATE:
 * - Uses controlled inputs (React manages input values)
 * - Validates before submission
 * - Shows loading and error states
 *
 * INTERVIEW TIP:
 * "We use controlled inputs for forms because it gives React full
 * control over the form state. This makes validation, conditional
 * rendering, and form submission more predictable."
 */
interface LoginFormProps {
  onSuccess: (token: string) => void;
}

function LoginForm({ onSuccess }: LoginFormProps): JSX.Element {
  // ---------------------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------------------

  const [isRegistering, setIsRegistering] = useState(false);
  const [identifier, setIdentifier] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // MUTATIONS
  // ---------------------------------------------------------------------------

  const [login, { loading: loginLoading }] = useMutation(LOGIN_MUTATION);
  const [register, { loading: registerLoading }] = useMutation(REGISTER_MUTATION);

  const loading = loginLoading || registerLoading;

  // ---------------------------------------------------------------------------
  // HANDLERS
  // ---------------------------------------------------------------------------

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);

    try {
      if (isRegistering) {
        // REGISTRATION
        const { data } = await register({
          variables: {
            input: {
              gamertag: identifier,
              email,
              password,
            },
          },
        });

        if (data?.register?.token) {
          onSuccess(data.register.token);
        }
      } else {
        // LOGIN
        const { data } = await login({
          variables: {
            input: {
              identifier,
              password,
            },
          },
        });

        if (data?.login?.token) {
          onSuccess(data.login.token);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An error occurred';
      setError(message);
      console.error('[LoginForm] Error:', err);
    }
  };

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  return (
    <div className="flex justify-center items-center" style={{ minHeight: '60vh' }}>
      <div className="card" style={{ width: '100%', maxWidth: '400px' }}>
        <h2 className="text-center mb-4" style={{ fontSize: '1.5rem' }}>
          {isRegistering ? 'Create Account' : 'Welcome Back'}
        </h2>

        {/* Error message */}
        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit}>
          {/* Gamertag / Email field */}
          <div className="form-group">
            <label htmlFor="identifier" className="form-label">
              {isRegistering ? 'Gamertag' : 'Gamertag or Email'}
            </label>
            <input
              id="identifier"
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              className="form-input"
              placeholder={isRegistering ? 'Choose a gamertag' : 'Enter gamertag or email'}
              required
              disabled={loading}
            />
          </div>

          {/* Email field (registration only) */}
          {isRegistering && (
            <div className="form-group">
              <label htmlFor="email" className="form-label">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="form-input"
                placeholder="Enter your email"
                required
                disabled={loading}
              />
            </div>
          )}

          {/* Password field */}
          <div className="form-group">
            <label htmlFor="password" className="form-label">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="form-input"
              placeholder={isRegistering ? 'Create a password' : 'Enter password'}
              required
              disabled={loading}
            />
            {isRegistering && (
              <p className="text-muted" style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                Min 8 characters with a number and special character
              </p>
            )}
          </div>

          {/* Submit button */}
          <button
            type="submit"
            className="btn btn--primary w-full"
            disabled={loading}
          >
            {loading ? (
              <span className="loading-spinner" style={{ width: '20px', height: '20px' }} />
            ) : isRegistering ? (
              'Create Account'
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        {/* Toggle login/register */}
        <div className="text-center mt-4">
          <button
            onClick={() => {
              setIsRegistering(!isRegistering);
              setError(null);
            }}
            className="text-muted"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            {isRegistering
              ? 'Already have an account? Sign in'
              : "Don't have an account? Create one"}
          </button>
        </div>

        {/* Demo login hint */}
        <div
          className="text-center mt-4 text-muted"
          style={{ fontSize: '0.75rem' }}
        >
          Demo: gamertag "DemoPlayer", password "demo123"
        </div>
      </div>
    </div>
  );
}

// ==============================================================================
// DASHBOARD COMPONENT
// ==============================================================================

/**
 * Dashboard Component
 *
 * Main view after login showing:
 * - Current user's status
 * - Friends list with real-time presence
 * - Status update controls
 *
 * REAL-TIME UPDATES:
 * Uses GraphQL subscription to receive friend presence updates.
 * When a friend's status changes, the UI updates automatically.
 */
interface DashboardProps {
  onLogout: () => void;
}

function Dashboard({ onLogout }: DashboardProps): JSX.Element {
  // ---------------------------------------------------------------------------
  // QUERIES
  // ---------------------------------------------------------------------------

  /**
   * ME QUERY
   *
   * Fetches the current user's profile.
   * The result is automatically cached by Apollo.
   */
  const { data: meData, loading: meLoading } = useQuery(ME_QUERY);

  /**
   * FRIENDS QUERY
   *
   * Fetches the friends list with presence.
   *
   * POLLING:
   * We poll every 30 seconds as a backup for subscription updates.
   * Subscriptions are the primary update mechanism.
   */
  const {
    data: friendsData,
    loading: friendsLoading,
    refetch: refetchFriends,
  } = useQuery(FRIENDS_QUERY, {
    pollInterval: 30000, // Backup polling every 30 seconds
  });

  // ---------------------------------------------------------------------------
  // MUTATIONS
  // ---------------------------------------------------------------------------

  const [updatePresence] = useMutation(UPDATE_PRESENCE_MUTATION);

  // ---------------------------------------------------------------------------
  // SUBSCRIPTIONS
  // ---------------------------------------------------------------------------

  /**
   * FRIEND PRESENCE SUBSCRIPTION
   *
   * Listens for real-time presence updates.
   *
   * SUBSCRIPTION FLOW:
   * 1. WebSocket connection established
   * 2. Subscribe to friendPresenceUpdated
   * 3. Server pushes updates when any friend's status changes
   * 4. Apollo cache is updated
   * 5. Component re-renders with new data
   *
   * INTERVIEW TIP:
   * "We use subscriptions for real-time presence because it's more
   * efficient than polling. The server pushes updates only when
   * something changes, rather than the client repeatedly asking."
   */
  useSubscription(FRIEND_PRESENCE_SUBSCRIPTION, {
    onData: ({ data }) => {
      console.log('[Subscription] Friend presence updated:', data);
      // Refetch friends list to get updated presence
      // In a production app, you'd update the cache directly
      refetchFriends();
    },
    onError: (error) => {
      console.error('[Subscription] Error:', error);
    },
  });

  // ---------------------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------------------

  const [selectedGame, setSelectedGame] = useState<string>('');

  // ---------------------------------------------------------------------------
  // HANDLERS
  // ---------------------------------------------------------------------------

  /**
   * Handle status change.
   * Updates the user's presence on the server.
   */
  const handleStatusChange = async (
    status: 'ONLINE' | 'AWAY' | 'BUSY' | 'INVISIBLE'
  ): Promise<void> => {
    try {
      await updatePresence({
        variables: {
          input: {
            status,
          },
        },
      });
      console.log(`[Dashboard] Status changed to: ${status}`);
    } catch (error) {
      console.error('[Dashboard] Failed to update status:', error);
    }
  };

  /**
   * Handle game change.
   * Sets what game the user is playing.
   */
  const handleGameChange = async (): Promise<void> => {
    if (!selectedGame.trim()) return;

    try {
      await updatePresence({
        variables: {
          input: {
            currentGame: selectedGame,
          },
        },
      });
      console.log(`[Dashboard] Now playing: ${selectedGame}`);
    } catch (error) {
      console.error('[Dashboard] Failed to set game:', error);
    }
  };

  // ---------------------------------------------------------------------------
  // RENDER HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Get CSS class for status indicator.
   */
  const getStatusClass = (status: string): string => {
    switch (status.toUpperCase()) {
      case 'ONLINE':
        return 'status-indicator--online pulse';
      case 'AWAY':
        return 'status-indicator--away';
      case 'BUSY':
        return 'status-indicator--busy';
      default:
        return 'status-indicator--offline';
    }
  };

  /**
   * Format status for display.
   */
  const formatStatus = (friend: FriendWithPresence): string => {
    if (!friend.isOnline) {
      return 'Offline';
    }
    if (friend.presence?.currentGame) {
      return `Playing ${friend.presence.currentGame}`;
    }
    return friend.user.status.charAt(0) + friend.user.status.slice(1).toLowerCase();
  };

  // ---------------------------------------------------------------------------
  // LOADING STATE
  // ---------------------------------------------------------------------------

  if (meLoading) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  const currentUser = meData?.me;

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  return (
    <div className="dashboard fade-in">
      {/* User Profile Card */}
      <div className="card mb-4">
        <div className="flex items-center gap-4">
          {/* Avatar */}
          <div className="avatar avatar--lg">
            {currentUser?.avatar || '🎮'}
            <span
              className={`status-indicator ${getStatusClass(currentUser?.status || 'OFFLINE')}`}
            />
          </div>

          {/* User Info */}
          <div className="flex-1">
            <h2 style={{ fontSize: '1.5rem', fontWeight: 600 }}>
              {currentUser?.gamertag || 'Unknown Player'}
            </h2>
            <p className="text-muted">
              Level {currentUser?.level || 1} • {currentUser?.trophyCount || 0} Trophies
            </p>
            {currentUser?.currentGame && (
              <p className="friend-game">
                Playing {currentUser.currentGame}
              </p>
            )}
          </div>

          {/* Status Controls */}
          <div className="flex gap-2">
            <button
              onClick={() => handleStatusChange('ONLINE')}
              className="btn btn--secondary"
              title="Set Online"
            >
              🟢
            </button>
            <button
              onClick={() => handleStatusChange('AWAY')}
              className="btn btn--secondary"
              title="Set Away"
            >
              🟡
            </button>
            <button
              onClick={() => handleStatusChange('BUSY')}
              className="btn btn--secondary"
              title="Set Busy"
            >
              🔴
            </button>
          </div>
        </div>

        {/* Game Selector */}
        <div className="flex gap-2 mt-4">
          <input
            type="text"
            value={selectedGame}
            onChange={(e) => setSelectedGame(e.target.value)}
            placeholder="What are you playing?"
            className="form-input"
            style={{ flex: 1 }}
          />
          <button onClick={handleGameChange} className="btn btn--primary">
            Set Game
          </button>
        </div>
      </div>

      {/* Friends List */}
      <div className="card">
        <h3 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
          Friends {friendsData?.friends && `(${friendsData.friends.length})`}
        </h3>

        {friendsLoading ? (
          <div className="loading">
            <div className="loading-spinner" />
          </div>
        ) : friendsData?.friends?.length > 0 ? (
          <div className="friends-list">
            {friendsData.friends.map((friend: FriendWithPresence) => (
              <div key={friend.user.id} className="friend-item">
                {/* Avatar */}
                <div className="avatar">
                  {friend.user.avatar || '🎮'}
                  <span
                    className={`status-indicator ${getStatusClass(
                      friend.isOnline
                        ? friend.presence?.status || 'online'
                        : 'offline'
                    )}`}
                  />
                </div>

                {/* Friend Info */}
                <div className="friend-info">
                  <div className="friend-name">{friend.user.gamertag}</div>
                  <div className="friend-status">
                    {friend.presence?.currentGame ? (
                      <span className="friend-game">
                        Playing {friend.presence.currentGame}
                      </span>
                    ) : (
                      formatStatus(friend)
                    )}
                  </div>
                </div>

                {/* Level Badge */}
                <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                  Lvl {friend.user.level}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <p>No friends yet</p>
            <p className="text-muted" style={{ fontSize: '0.875rem', marginTop: '0.5rem' }}>
              Add friends to see them here
            </p>
          </div>
        )}
      </div>

      {/* Architecture Info Card (for study purposes) */}
      <div className="card mt-4" style={{ opacity: 0.8 }}>
        <h4 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
          📚 Architecture Notes
        </h4>
        <ul
          className="text-muted"
          style={{
            fontSize: '0.875rem',
            listStyle: 'disc',
            paddingLeft: '1.5rem',
          }}
        >
          <li>Real-time updates via GraphQL Subscriptions (WebSocket)</li>
          <li>Friend presence stored in Redis with TTL for auto-offline</li>
          <li>Heartbeat sent every 60s to keep presence alive</li>
          <li>Apollo Client cache for optimistic updates</li>
          <li>JWT auth token stored in localStorage</li>
        </ul>
      </div>
    </div>
  );
}
