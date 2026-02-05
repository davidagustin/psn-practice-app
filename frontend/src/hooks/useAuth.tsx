/**
 * ==============================================================================
 * AUTHENTICATION HOOK AND PROVIDER
 * ==============================================================================
 *
 * Manages authentication state, login/logout, and token storage.
 *
 * PATTERN: React Context + Custom Hook
 * - AuthProvider wraps the app and manages state
 * - useAuth hook provides access to auth state and functions
 *
 * TOKEN STORAGE:
 * - localStorage for persistence across sessions
 * - State for reactive updates
 * - Token refreshed before expiry (not implemented here)
 *
 * INTERVIEW TIP:
 * "We store JWT in localStorage for simplicity, but for maximum security
 * you could use HttpOnly cookies to prevent XSS access to tokens."
 * ==============================================================================
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import { gql, useMutation } from '@apollo/client';

// ============================================================================
// GRAPHQL MUTATIONS
// ============================================================================

const LOGIN_MUTATION = gql`
  mutation Login($identifier: String!, $password: String!) {
    login(identifier: $identifier, password: $password) {
      token
      user {
        id
        gamertag
        avatar
        level
        trophyCount
      }
      expiresAt
    }
  }
`;

const REGISTER_MUTATION = gql`
  mutation Register($gamertag: String!, $email: String!, $password: String!) {
    register(gamertag: $gamertag, email: $email, password: $password) {
      token
      user {
        id
        gamertag
        avatar
        level
        trophyCount
      }
      expiresAt
    }
  }
`;

// ============================================================================
// TYPES
// ============================================================================

interface User {
  id: string;
  gamertag: string;
  avatar: string;
  level: number;
  trophyCount: number;
}

interface AuthContextType {
  /** Current user (null if not authenticated) */
  user: User | null;

  /** JWT token (null if not authenticated) */
  token: string | null;

  /** Whether auth state is being loaded */
  isLoading: boolean;

  /** Whether user is authenticated */
  isAuthenticated: boolean;

  /** Login with email/gamertag and password */
  login: (identifier: string, password: string) => Promise<void>;

  /** Register a new account */
  register: (gamertag: string, email: string, password: string) => Promise<void>;

  /** Logout and clear session */
  logout: () => void;

  /** Login error message */
  error: string | null;
}

// ============================================================================
// CONTEXT
// ============================================================================

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_KEY = 'psn_auth_token';
const USER_KEY = 'psn_user';

// ============================================================================
// PROVIDER
// ============================================================================

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps): JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // GraphQL mutations (only available after Apollo is mounted)
  // For initial load, we'll check localStorage directly

  // ---------------------------------------------------------------------------
  // INITIALIZATION
  // ---------------------------------------------------------------------------

  /**
   * Load saved authentication on mount.
   */
  useEffect(() => {
    const loadSavedAuth = () => {
      try {
        const savedToken = localStorage.getItem(TOKEN_KEY);
        const savedUser = localStorage.getItem(USER_KEY);

        if (savedToken && savedUser) {
          // Verify token isn't expired
          const payload = JSON.parse(atob(savedToken.split('.')[1]));
          const expiresAt = payload.exp * 1000;

          if (Date.now() < expiresAt) {
            setToken(savedToken);
            setUser(JSON.parse(savedUser));
          } else {
            // Token expired, clear storage
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
          }
        }
      } catch (err) {
        console.error('[Auth] Error loading saved auth:', err);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      } finally {
        setIsLoading(false);
      }
    };

    loadSavedAuth();
  }, []);

  // ---------------------------------------------------------------------------
  // AUTH FUNCTIONS
  // ---------------------------------------------------------------------------

  /**
   * Login with credentials.
   */
  const login = useCallback(async (identifier: string, password: string): Promise<void> => {
    setError(null);
    setIsLoading(true);

    try {
      // In real implementation, this would use the mutation
      // For now, simulate the login
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });

      if (!response.ok) {
        throw new Error('Invalid credentials');
      }

      const data = await response.json();

      // Save to state and storage
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));

      console.log('[Auth] Login successful:', data.user.gamertag);
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Register new account.
   */
  const register = useCallback(
    async (gamertag: string, email: string, password: string): Promise<void> => {
      setError(null);
      setIsLoading(true);

      try {
        const response = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gamertag, email, password }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Registration failed');
        }

        const data = await response.json();

        // Save to state and storage
        setToken(data.token);
        setUser(data.user);
        localStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(USER_KEY, JSON.stringify(data.user));

        console.log('[Auth] Registration successful:', data.user.gamertag);
      } catch (err: any) {
        setError(err.message);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  /**
   * Logout and clear session.
   */
  const logout = useCallback((): void => {
    setToken(null);
    setUser(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    console.log('[Auth] Logged out');
  }, []);

  // ---------------------------------------------------------------------------
  // CONTEXT VALUE
  // ---------------------------------------------------------------------------

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      token,
      isLoading,
      isAuthenticated: !!token && !!user,
      login,
      register,
      logout,
      error,
    }),
    [user, token, isLoading, login, register, logout, error]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Hook to access auth context.
 *
 * @throws If used outside of AuthProvider
 */
export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);

  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { User, AuthContextType };
