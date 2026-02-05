/**
 * ==============================================================================
 * PRESENCE HOOK AND PROVIDER
 * ==============================================================================
 *
 * Manages real-time presence updates using GraphQL subscriptions.
 *
 * PATTERN: Context + Subscription + Local State
 * - Subscribes to friend presence updates
 * - Maintains local presence map for quick lookups
 * - Updates UI reactively when friends come online/offline
 *
 * WEBSOCKET USAGE:
 * - Subscription established on mount
 * - Automatic reconnection on disconnect
 * - Heartbeat to keep connection alive
 *
 * INTERVIEW TIP:
 * "Real-time presence uses WebSocket subscriptions. We maintain a local
 * map of friend presences for O(1) lookup. The subscription updates
 * trigger React re-renders only when presence actually changes."
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
import { gql, useSubscription, useQuery } from '@apollo/client';
import { useAuth } from './useAuth';

// ============================================================================
// GRAPHQL
// ============================================================================

const PRESENCE_SUBSCRIPTION = gql`
  subscription OnPresenceUpdate($userId: ID!) {
    presenceUpdated(userId: $userId) {
      userId
      gamertag
      status
      currentGame
      statusMessage
      lastActiveAt
    }
  }
`;

const FRIENDS_PRESENCE_QUERY = gql`
  query GetFriendsPresence {
    me {
      friends {
        id
        gamertag
        status
        currentGame
      }
    }
  }
`;

// ============================================================================
// TYPES
// ============================================================================

type UserStatus = 'online' | 'away' | 'busy' | 'offline' | 'invisible';

interface PresenceData {
  userId: string;
  gamertag: string;
  status: UserStatus;
  currentGame: string | null;
  statusMessage: string | null;
  lastActiveAt: number;
}

interface PresenceContextType {
  /** Map of user ID to presence data */
  presenceMap: Map<string, PresenceData>;

  /** Get presence for a specific user */
  getPresence: (userId: string) => PresenceData | undefined;

  /** Check if a user is online */
  isOnline: (userId: string) => boolean;

  /** Count of online friends */
  onlineFriendsCount: number;

  /** Update own presence (status, game, etc.) */
  updatePresence: (update: Partial<PresenceData>) => void;

  /** Connection status */
  isConnected: boolean;
}

// ============================================================================
// CONTEXT
// ============================================================================

const PresenceContext = createContext<PresenceContextType | undefined>(undefined);

// ============================================================================
// PROVIDER
// ============================================================================

interface PresenceProviderProps {
  children: React.ReactNode;
}

export function PresenceProvider({ children }: PresenceProviderProps): JSX.Element {
  const { user, isAuthenticated } = useAuth();
  const [presenceMap, setPresenceMap] = useState<Map<string, PresenceData>>(new Map());
  const [isConnected, setIsConnected] = useState(false);

  // ---------------------------------------------------------------------------
  // INITIAL FRIENDS PRESENCE
  // ---------------------------------------------------------------------------

  const { data: friendsData } = useQuery(FRIENDS_PRESENCE_QUERY, {
    skip: !isAuthenticated,
  });

  /**
   * Initialize presence map with friends data.
   */
  useEffect(() => {
    if (friendsData?.me?.friends) {
      const newMap = new Map<string, PresenceData>();

      for (const friend of friendsData.me.friends) {
        newMap.set(friend.id, {
          userId: friend.id,
          gamertag: friend.gamertag,
          status: friend.status || 'offline',
          currentGame: friend.currentGame,
          statusMessage: null,
          lastActiveAt: Date.now(),
        });
      }

      setPresenceMap(newMap);
      console.log('[Presence] Initialized with', newMap.size, 'friends');
    }
  }, [friendsData]);

  // ---------------------------------------------------------------------------
  // PRESENCE SUBSCRIPTION
  // ---------------------------------------------------------------------------

  const { error: subscriptionError } = useSubscription(PRESENCE_SUBSCRIPTION, {
    variables: { userId: user?.id },
    skip: !isAuthenticated || !user,
    onData: ({ data }) => {
      if (data?.data?.presenceUpdated) {
        const update = data.data.presenceUpdated;

        setPresenceMap((prev) => {
          const newMap = new Map(prev);
          newMap.set(update.userId, {
            userId: update.userId,
            gamertag: update.gamertag,
            status: update.status,
            currentGame: update.currentGame,
            statusMessage: update.statusMessage,
            lastActiveAt: update.lastActiveAt,
          });
          return newMap;
        });

        console.log('[Presence] Update:', update.gamertag, update.status);
      }
    },
  });

  /**
   * Track connection status.
   */
  useEffect(() => {
    setIsConnected(!subscriptionError);
  }, [subscriptionError]);

  // ---------------------------------------------------------------------------
  // HELPER FUNCTIONS
  // ---------------------------------------------------------------------------

  const getPresence = useCallback(
    (userId: string): PresenceData | undefined => {
      return presenceMap.get(userId);
    },
    [presenceMap]
  );

  const isOnline = useCallback(
    (userId: string): boolean => {
      const presence = presenceMap.get(userId);
      return presence?.status === 'online' || presence?.status === 'away' || presence?.status === 'busy';
    },
    [presenceMap]
  );

  const onlineFriendsCount = useMemo(() => {
    let count = 0;
    for (const presence of presenceMap.values()) {
      if (presence.status === 'online' || presence.status === 'away' || presence.status === 'busy') {
        count++;
      }
    }
    return count;
  }, [presenceMap]);

  const updatePresence = useCallback(async (update: Partial<PresenceData>) => {
    // In real implementation, this would call a mutation
    console.log('[Presence] Updating own presence:', update);
  }, []);

  // ---------------------------------------------------------------------------
  // HEARTBEAT
  // ---------------------------------------------------------------------------

  /**
   * Send heartbeat to keep presence active.
   */
  useEffect(() => {
    if (!isAuthenticated) return;

    const interval = setInterval(() => {
      // Send heartbeat mutation
      console.log('[Presence] Heartbeat');
    }, 30000); // Every 30 seconds

    return () => clearInterval(interval);
  }, [isAuthenticated]);

  // ---------------------------------------------------------------------------
  // CONTEXT VALUE
  // ---------------------------------------------------------------------------

  const value = useMemo<PresenceContextType>(
    () => ({
      presenceMap,
      getPresence,
      isOnline,
      onlineFriendsCount,
      updatePresence,
      isConnected,
    }),
    [presenceMap, getPresence, isOnline, onlineFriendsCount, updatePresence, isConnected]
  );

  return (
    <PresenceContext.Provider value={value}>
      {children}
    </PresenceContext.Provider>
  );
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Hook to access presence context.
 */
export function usePresence(): PresenceContextType {
  const context = useContext(PresenceContext);

  if (context === undefined) {
    throw new Error('usePresence must be used within a PresenceProvider');
  }

  return context;
}

/**
 * Hook to get presence for a specific user.
 */
export function useFriendPresence(userId: string): PresenceData | undefined {
  const { getPresence } = usePresence();
  return getPresence(userId);
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { PresenceData, PresenceContextType, UserStatus };
