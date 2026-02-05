/**
 * ==============================================================================
 * PLAYSTATION NETWORK - GRAPHQL RESOLVERS
 * ==============================================================================
 *
 * Resolvers are functions that determine how to fetch/compute the data
 * for each field in the GraphQL schema. They're the "how" to the schema's "what".
 *
 * RESOLVER STRUCTURE:
 * ===================
 *
 * {
 *   Query: {
 *     fieldName: (parent, args, context, info) => data
 *   },
 *   Mutation: {
 *     fieldName: (parent, args, context, info) => data
 *   },
 *   Subscription: {
 *     fieldName: {
 *       subscribe: (parent, args, context, info) => asyncIterator
 *     }
 *   },
 *   TypeName: {
 *     fieldName: (parent, args, context, info) => data
 *   }
 * }
 *
 * RESOLVER ARGUMENTS:
 * ==================
 *
 * 1. parent (or root):
 *    - The return value of the parent resolver
 *    - For Query/Mutation root, this is undefined
 *    - For nested fields, this is the parent object
 *
 * 2. args:
 *    - Arguments passed to the field
 *    - Defined in the schema
 *
 * 3. context:
 *    - Shared context for all resolvers in a request
 *    - Contains authenticated user, database connections, etc.
 *
 * 4. info:
 *    - Information about the query
 *    - Rarely used except for advanced optimization
 *
 * INTERVIEW TIP:
 * "Resolvers should be thin. They validate input, check authorization,
 * then delegate to service classes. Business logic lives in services,
 * not resolvers."
 * ==============================================================================
 */

import { PubSub } from 'graphql-subscriptions';
import { AuthService } from '../services/auth/auth.service';
import { PresenceService } from '../services/presence/presence.service';
import { ChatService } from '../services/chat/chat.service';
import { FriendService } from '../services/friends/friend.service';
import { GameService } from '../services/game/game.service';
import { ActivityService } from '../services/activity/activity.service';
import { VoiceService } from '../services/voice/voice.service';
import { ProfileService } from '../services/profile/profile.service';
import { GraphQLContext, PublicUser } from '../types';

/**
 * Subscription event names.
 *
 * PUBSUB PATTERN:
 * Subscriptions work by publishing events to named channels.
 * Subscribers listen to these channels and receive updates.
 *
 * Using constants prevents typos and makes refactoring easier.
 */
/**
 * Subscription event names.
 *
 * PUBSUB PATTERN:
 * Subscriptions work by publishing events to named channels.
 * Subscribers listen to these channels and receive updates.
 *
 * Using constants prevents typos and makes refactoring easier.
 *
 * CHANNEL NAMING CONVENTION:
 * - Global events: Simple name (FRIEND_PRESENCE_UPDATED)
 * - User-specific: Name with suffix (.{userId})
 * - Conversation-specific: Name with suffix (.{conversationId})
 */
const EVENTS = {
  // Presence events
  FRIEND_PRESENCE_UPDATED: 'FRIEND_PRESENCE_UPDATED',
  USER_PRESENCE_UPDATED: 'USER_PRESENCE_UPDATED',

  // Chat events
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
  USER_TYPING: 'USER_TYPING',

  // Friend events
  FRIEND_EVENT: 'FRIEND_EVENT',
  FRIEND_REQUEST_RECEIVED: 'FRIEND_REQUEST_RECEIVED',

  // Notification events
  NOTIFICATION_RECEIVED: 'NOTIFICATION_RECEIVED',
};

/**
 * Create resolvers with injected services.
 *
 * WHY FUNCTION THAT RETURNS RESOLVERS?
 * ------------------------------------
 * This pattern allows dependency injection:
 * - Services are created with their dependencies
 * - Resolvers receive services as parameters
 * - Easy to test with mock services
 *
 * INTERVIEW TIP:
 * "Dependency injection makes our resolvers testable. We can inject
 * mock services for unit tests without needing real Redis or databases.
 * It also makes it easy to swap implementations."
 *
 * @param authService - Authentication service
 * @param presenceService - Presence service
 * @param chatService - Chat service
 * @param friendService - Friend management service
 * @param pubsub - PubSub instance for subscriptions
 */
export const createResolvers = (
  authService: AuthService,
  presenceService: PresenceService,
  chatService: ChatService,
  friendService: FriendService,
  gameService: GameService,
  activityService: ActivityService,
  voiceService: VoiceService,
  profileService: ProfileService,
  pubsub: PubSub
) => {
  /**
   * Helper function to require authentication.
   *
   * AUTHENTICATION PATTERN:
   * Call this at the start of any resolver that requires auth.
   * It throws a clear error that GraphQL can return to the client.
   *
   * @param context - GraphQL context with user info
   * @throws Error if user is not authenticated
   */
  const requireAuth = (context: GraphQLContext): void => {
    if (!context.user) {
      throw new Error('Authentication required');
    }
  };

  /**
   * Helper to get authenticated user ID.
   * Throws if not authenticated.
   */
  const getUserId = (context: GraphQLContext): string => {
    requireAuth(context);
    return context.user!.userId;
  };

  // ============================================================================
  // RESOLVER DEFINITION
  // ============================================================================

  return {
    // ==========================================================================
    // QUERY RESOLVERS
    // ==========================================================================

    Query: {
      // ------------------------------------------------------------------------
      // USER QUERIES
      // ------------------------------------------------------------------------

      /**
       * Get the authenticated user's own profile.
       *
       * RESOLVER PATTERN:
       * 1. Check authentication
       * 2. Fetch data from service
       * 3. Return data (GraphQL handles serialization)
       */
      me: async (_: unknown, __: unknown, context: GraphQLContext) => {
        // Step 1: Check auth
        requireAuth(context);

        // Step 2: Fetch from service
        const user = await authService.getUserById(context.user!.userId);

        // Step 3: Return (GraphQL serializes to schema type)
        return user;
      },

      /**
       * Get a user by their ID.
       */
      user: async (
        _: unknown,
        args: { id: string },
        context: GraphQLContext
      ) => {
        requireAuth(context);
        return authService.getUserById(args.id);
      },

      /**
       * Get a user by their gamertag.
       */
      userByGamertag: async (
        _: unknown,
        args: { gamertag: string },
        context: GraphQLContext
      ) => {
        requireAuth(context);
        return authService.getUserByGamertag(args.gamertag);
      },

      /**
       * Search for users by gamertag.
       *
       * SEARCH IMPLEMENTATION NOTE:
       * In production, this would use:
       * - Elasticsearch for full-text search
       * - DynamoDB GSI for prefix matching
       * - Caching for popular searches
       */
      searchUsers: async (
        _: unknown,
        args: { query: string; limit: number },
        context: GraphQLContext
      ): Promise<PublicUser[]> => {
        requireAuth(context);

        // Simple mock search - returns empty for now
        // In production: search service call
        console.log(`[Resolver] searchUsers: "${args.query}" (limit: ${args.limit})`);
        return [];
      },

      // ------------------------------------------------------------------------
      // FRIENDS QUERIES
      // ------------------------------------------------------------------------

      /**
       * Get friend list with presence.
       *
       * N+1 PROBLEM:
       * Naively, this could cause N+1 queries:
       * - 1 query to get friend IDs
       * - N queries to get each friend's profile
       * - N queries to get each friend's presence
       *
       * SOLUTION: Batch fetching
       * - Get all friend IDs at once
       * - Batch fetch all profiles (MGET in Redis, BatchGetItem in DynamoDB)
       * - Batch fetch all presences
       *
       * INTERVIEW TIP:
       * "We solve the N+1 problem by batching. Redis MGET fetches all
       * presence data in one round trip. For profiles, we use DynamoDB's
       * BatchGetItem. This keeps latency constant regardless of friend count."
       */
      friends: async (
        _: unknown,
        args: { limit?: number; offset?: number; onlineOnly?: boolean },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const limit = args.limit || 100;
        const offset = args.offset || 0;
        const onlineOnly = args.onlineOnly || false;

        // Get friend IDs from FriendService
        const friendIds = await friendService.getFriends(userId);

        // Apply pagination
        const paginatedIds = friendIds.slice(offset, offset + limit);

        // Batch fetch user profiles
        const profiles = await authService.getUsersByIds(paginatedIds);
        const profileMap = new Map(profiles.map((p) => [p.id, p]));

        // Batch fetch presence data
        const friendsWithPresence = await presenceService.getFriendsWithPresence(userId);
        const presenceMap = new Map(
          friendsWithPresence.map((f) => [f.friendId, f])
        );

        // Combine profiles with presence
        let results = paginatedIds.map((friendId) => {
          const profile = profileMap.get(friendId);
          const presenceInfo = presenceMap.get(friendId);

          return {
            user: profile || null,
            presence: presenceInfo?.presence || null,
            isOnline: presenceInfo?.isOnline || false,
            lastOnlineAt: presenceInfo?.presence?.lastActiveAt
              ? new Date(presenceInfo.presence.lastActiveAt).toISOString()
              : null,
          };
        });

        // Filter online only if requested
        if (onlineOnly) {
          results = results.filter((f) => f.isOnline);
        }

        // Sort: online first, then by gamertag
        results.sort((a, b) => {
          if (a.isOnline !== b.isOnline) {
            return a.isOnline ? -1 : 1;
          }
          return (a.user?.gamertag || '').localeCompare(b.user?.gamertag || '');
        });

        return results;
      },

      /**
       * Get incoming friend requests.
       */
      incomingFriendRequests: async (
        _: unknown,
        args: { limit?: number; offset?: number },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const requests = await friendService.getFriendRequests(
          userId,
          'incoming',
          args.limit || 50,
          args.offset || 0
        );

        // Enrich with user profiles
        const fromUserIds = requests.map((r) => r.fromUserId);
        const profiles = await authService.getUsersByIds(fromUserIds);
        const profileMap = new Map(profiles.map((p) => [p.id, p]));

        return requests.map((request) => ({
          ...request,
          fromUser: profileMap.get(request.fromUserId),
          toUser: { id: userId }, // Current user
          status: request.status.toUpperCase(),
        }));
      },

      /**
       * Get outgoing friend requests.
       */
      outgoingFriendRequests: async (
        _: unknown,
        args: { limit?: number; offset?: number },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const requests = await friendService.getFriendRequests(
          userId,
          'outgoing',
          args.limit || 50,
          args.offset || 0
        );

        // Enrich with user profiles
        const toUserIds = requests.map((r) => r.toUserId);
        const profiles = await authService.getUsersByIds(toUserIds);
        const profileMap = new Map(profiles.map((p) => [p.id, p]));

        return requests.map((request) => ({
          ...request,
          fromUser: { id: userId, gamertag: context.user!.gamertag },
          toUser: profileMap.get(request.toUserId),
          status: request.status.toUpperCase(),
        }));
      },

      /**
       * Get friend statistics.
       */
      friendStats: async (_: unknown, __: unknown, context: GraphQLContext) => {
        const userId = getUserId(context);

        // Parallel fetch all stats
        const [
          friendCount,
          incomingRequests,
          outgoingRequests,
          blockedUsers,
          friendsWithPresence,
        ] = await Promise.all([
          friendService.getFriendCount(userId),
          friendService.getFriendRequests(userId, 'incoming', 1000, 0),
          friendService.getFriendRequests(userId, 'outgoing', 1000, 0),
          friendService.getBlockedUsers(userId),
          presenceService.getFriendsWithPresence(userId),
        ]);

        const onlineFriendCount = friendsWithPresence.filter((f) => f.isOnline).length;

        return {
          friendCount,
          onlineFriendCount,
          incomingRequestCount: incomingRequests.length,
          outgoingRequestCount: outgoingRequests.length,
          blockedCount: blockedUsers.length,
        };
      },

      /**
       * Get mutual friends between two users.
       */
      mutualFriends: async (
        _: unknown,
        args: { userId: string; limit?: number },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const mutualIds = await friendService.getMutualFriends(userId, args.userId);
        const limitedIds = mutualIds.slice(0, args.limit || 10);
        return authService.getUsersByIds(limitedIds);
      },

      /**
       * Get friend suggestions.
       */
      friendSuggestions: async (
        _: unknown,
        args: { limit?: number },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const suggestions = await friendService.getFriendSuggestions(
          userId,
          args.limit || 10
        );

        // Enrich with user profiles
        const userIds = suggestions.map((s) => s.userId);
        const profiles = await authService.getUsersByIds(userIds);
        const profileMap = new Map(profiles.map((p) => [p.id, p]));

        return suggestions.map((suggestion) => ({
          user: profileMap.get(suggestion.userId),
          mutualFriendCount: suggestion.mutualFriendCount,
          mutualFriendNames: [], // Would need another query to get names
        }));
      },

      /**
       * Check if two users are friends.
       */
      isFriend: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return friendService.areFriends(userId, args.userId);
      },

      /**
       * Check if user is blocked.
       */
      isBlocked: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return friendService.isBlocked(userId, args.userId);
      },

      /**
       * Get blocked users.
       */
      blockedUsers: async (_: unknown, __: unknown, context: GraphQLContext) => {
        const userId = getUserId(context);
        const blockedIds = await friendService.getBlockedUsers(userId);
        return authService.getUsersByIds(blockedIds);
      },

      /**
       * Get pending friend requests (deprecated).
       */
      friendRequests: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ): Promise<PublicUser[]> => {
        const userId = getUserId(context);
        const requests = await friendService.getFriendRequests(userId, 'incoming', 50, 0);
        const fromUserIds = requests.map((r) => r.fromUserId);
        return authService.getUsersByIds(fromUserIds);
      },

      // ------------------------------------------------------------------------
      // PRESENCE QUERIES
      // ------------------------------------------------------------------------

      /**
       * Get presence for a specific user.
       */
      presence: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        requireAuth(context);
        return presenceService.getPresence(args.userId);
      },

      /**
       * Get count of online users.
       */
      onlineCount: async (_: unknown, __: unknown, context: GraphQLContext) => {
        requireAuth(context);
        return presenceService.getOnlineCount();
      },

      /**
       * Get users playing a specific game.
       */
      playersInGame: async (
        _: unknown,
        args: { game: string },
        context: GraphQLContext
      ) => {
        requireAuth(context);

        const playerIds = await presenceService.getPlayersInGame(args.game);
        return authService.getUsersByIds(playerIds);
      },

      // ------------------------------------------------------------------------
      // CHAT QUERIES
      // ------------------------------------------------------------------------

      /**
       * Get user's conversations.
       */
      conversations: async (
        _: unknown,
        args: { limit: number; offset: number },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return chatService.getUserConversations(userId, args.limit, args.offset);
      },

      /**
       * Get a specific conversation.
       */
      conversation: async (
        _: unknown,
        args: { id: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return chatService.getConversation(args.id, userId);
      },

      /**
       * Get messages from a conversation.
       */
      messages: async (
        _: unknown,
        args: { conversationId: string; limit: number; before?: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return chatService.getMessages(
          args.conversationId,
          userId,
          args.limit,
          args.before
        );
      },

      // ------------------------------------------------------------------------
      // NOTIFICATION QUERIES
      // ------------------------------------------------------------------------

      /**
       * Get user's notifications.
       */
      notifications: async (
        _: unknown,
        _args: { limit: number; unreadOnly: boolean },
        context: GraphQLContext
      ) => {
        requireAuth(context);
        // Mock: return empty array
        return [];
      },

      /**
       * Get unread notification count.
       */
      unreadNotificationCount: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ) => {
        requireAuth(context);
        return 0;
      },

      // ------------------------------------------------------------------------
      // GAME QUERIES
      // ------------------------------------------------------------------------

      /**
       * Get a game by ID.
       */
      game: async (_: unknown, args: { id: string }) => {
        return gameService.getGame(args.id);
      },

      /**
       * Search for games.
       */
      searchGames: async (
        _: unknown,
        args: { query: string; limit?: number }
      ) => {
        return gameService.searchGames(args.query, args.limit || 20);
      },

      /**
       * Get popular games.
       */
      popularGames: async (_: unknown, args: { limit?: number }) => {
        return gameService.getPopularGames(args.limit || 10);
      },

      /**
       * Get games by genre.
       */
      gamesByGenre: async (
        _: unknown,
        args: { genre: string; limit?: number }
      ) => {
        return gameService.getGamesByGenre(args.genre, args.limit || 20);
      },

      /**
       * Get user's game library.
       */
      myGameLibrary: async (
        _: unknown,
        args: { limit?: number; offset?: number },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return gameService.getUserLibrary(userId, args.limit || 50, args.offset || 0);
      },

      /**
       * Get specific game from user's library.
       */
      myGame: async (
        _: unknown,
        args: { gameId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return gameService.getUserGame(userId, args.gameId);
      },

      /**
       * Get achievements for a game.
       */
      gameAchievements: async (_: unknown, args: { gameId: string }) => {
        return gameService.getGameAchievements(args.gameId);
      },

      /**
       * Get user's unlocked achievements for a game.
       */
      myAchievements: async (
        _: unknown,
        args: { gameId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return gameService.getUserAchievements(userId, args.gameId);
      },

      /**
       * Get user's trophy summary.
       */
      myTrophySummary: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return gameService.getTrophySummary(userId);
      },

      /**
       * Get user's active play session.
       */
      myActiveSession: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return gameService.getActiveSession(userId);
      },

      /**
       * Get joinable sessions for a game.
       */
      joinableSessions: async (_: unknown, args: { gameId: string }) => {
        return gameService.getJoinableSessions(args.gameId);
      },

      /**
       * Get pending game invites.
       */
      pendingGameInvites: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const invites = await gameService.getPendingInvites(userId);

        // Enrich with user and game data
        return Promise.all(invites.map(async (invite) => {
          const fromUser = await authService.getUserById(invite.fromUserId);
          const game = await gameService.getGame(invite.gameId);
          return {
            ...invite,
            fromUser,
            game,
            status: invite.status.toUpperCase(),
          };
        }));
      },

      // ------------------------------------------------------------------------
      // ACTIVITY FEED QUERIES
      // ------------------------------------------------------------------------

      /**
       * Get activity feed.
       */
      activityFeed: async (
        _: unknown,
        args: { limit?: number; offset?: number },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const activities = await activityService.getFeed(
          userId,
          args.limit || 50,
          args.offset || 0
        );

        // Enrich with user and game data
        return Promise.all(activities.map(async (activity) => {
          const user = await authService.getUserById(activity.userId);
          const game = activity.gameId
            ? await gameService.getGame(activity.gameId)
            : null;

          return {
            ...activity,
            user,
            game,
            type: activity.type.toUpperCase(),
          };
        }));
      },

      /**
       * Get activities for a specific user.
       */
      userActivities: async (
        _: unknown,
        args: { userId: string; limit?: number },
        context: GraphQLContext
      ) => {
        const viewerId = getUserId(context);
        return activityService.getUserActivities(
          args.userId,
          viewerId,
          args.limit || 20
        );
      },

      // ------------------------------------------------------------------------
      // VOICE CHAT QUERIES
      // ------------------------------------------------------------------------

      /**
       * Get available voice rooms.
       */
      voiceRooms: async (_: unknown, __: unknown, context: GraphQLContext) => {
        requireAuth(context);
        const rooms = await voiceService.getAvailableRooms();

        // Enrich with host and participant data
        return Promise.all(rooms.map(async (room) => {
          const host = await authService.getUserById(room.hostId);
          const participants = await voiceService.getParticipants(room.id);
          const game = room.gameId ? await gameService.getGame(room.gameId) : null;

          return {
            ...room,
            host,
            participants: participants.map(p => ({
              ...p,
              user: { id: p.userId, gamertag: p.gamertag, avatar: p.avatar },
              state: p.state.toUpperCase(),
            })),
            game,
            state: room.state.toUpperCase(),
          };
        }));
      },

      /**
       * Get a specific voice room.
       */
      voiceRoom: async (
        _: unknown,
        args: { id: string },
        context: GraphQLContext
      ) => {
        requireAuth(context);
        const room = await voiceService.getRoom(args.id);
        if (!room) return null;

        const host = await authService.getUserById(room.hostId);
        const participants = await voiceService.getParticipants(room.id);
        const game = room.gameId ? await gameService.getGame(room.gameId) : null;

        return {
          ...room,
          host,
          participants: participants.map(p => ({
            ...p,
            user: { id: p.userId, gamertag: p.gamertag, avatar: p.avatar },
            state: p.state.toUpperCase(),
          })),
          game,
          state: room.state.toUpperCase(),
        };
      },

      /**
       * Get user's current voice room.
       */
      myVoiceRoom: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const room = await voiceService.getUserRoom(userId);
        if (!room) return null;

        const host = await authService.getUserById(room.hostId);
        const participants = await voiceService.getParticipants(room.id);

        return {
          ...room,
          host,
          participants: participants.map(p => ({
            ...p,
            user: { id: p.userId, gamertag: p.gamertag, avatar: p.avatar },
            state: p.state.toUpperCase(),
          })),
          state: room.state.toUpperCase(),
        };
      },

      // ------------------------------------------------------------------------
      // PROFILE QUERIES
      // ------------------------------------------------------------------------

      /**
       * Get user profile.
       */
      userProfile: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        const viewerId = getUserId(context);
        const isFriend = await friendService.areFriends(viewerId, args.userId);
        return profileService.getProfile(args.userId, viewerId, isFriend);
      },

      /**
       * Get own profile.
       */
      myProfile: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return profileService.getOwnProfile(userId);
      },

      /**
       * Get user stats.
       */
      userStats: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        const viewerId = getUserId(context);
        const isFriend = await friendService.areFriends(viewerId, args.userId);
        return profileService.getStats(args.userId, viewerId, isFriend);
      },
    },

    // ==========================================================================
    // MUTATION RESOLVERS
    // ==========================================================================

    Mutation: {
      // ------------------------------------------------------------------------
      // AUTHENTICATION MUTATIONS
      // ------------------------------------------------------------------------

      /**
       * Register a new user.
       *
       * NO AUTH REQUIRED - this is the entry point for new users.
       */
      register: async (
        _: unknown,
        args: { input: { gamertag: string; email: string; password: string } }
      ) => {
        const { gamertag, email, password } = args.input;
        return authService.register({ gamertag, email, password });
      },

      /**
       * Log in with existing credentials.
       */
      login: async (
        _: unknown,
        args: { input: { identifier: string; password: string } }
      ) => {
        return authService.login(args.input);
      },

      /**
       * Log out the current user.
       */
      logout: async (_: unknown, __: unknown, context: GraphQLContext) => {
        const userId = getUserId(context);

        // Set presence to offline
        await presenceService.setOffline(userId);

        // Destroy session
        return authService.logout(userId);
      },

      // ------------------------------------------------------------------------
      // PRESENCE MUTATIONS
      // ------------------------------------------------------------------------

      /**
       * Update user's presence.
       *
       * MUTATION PATTERN:
       * 1. Validate auth
       * 2. Validate input
       * 3. Perform operation
       * 4. Publish event for subscriptions
       * 5. Return result
       */
      updatePresence: async (
        _: unknown,
        args: {
          input: {
            status?: string;
            currentGame?: string;
            statusMessage?: string;
          };
        },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);

        // Update presence
        const presence = await presenceService.updatePresence(userId, {
          status: args.input.status as any,
          currentGame: args.input.currentGame || null,
          statusMessage: args.input.statusMessage || null,
        });

        if (!presence) {
          throw new Error('Failed to update presence');
        }

        // Publish to subscriptions
        // This notifies all friends watching this user's status
        pubsub.publish(EVENTS.FRIEND_PRESENCE_UPDATED, {
          friendPresenceUpdated: presence,
        });

        pubsub.publish(`${EVENTS.USER_PRESENCE_UPDATED}.${userId}`, {
          userPresenceUpdated: presence,
        });

        return presence;
      },

      /**
       * Send heartbeat to keep presence alive.
       */
      heartbeat: async (_: unknown, __: unknown, context: GraphQLContext) => {
        const userId = getUserId(context);
        return presenceService.heartbeat(userId);
      },

      /**
       * Set user as offline.
       */
      goOffline: async (_: unknown, __: unknown, context: GraphQLContext) => {
        const userId = getUserId(context);
        await presenceService.setOffline(userId);

        // Publish offline event
        pubsub.publish(EVENTS.FRIEND_PRESENCE_UPDATED, {
          friendPresenceUpdated: {
            userId,
            status: 'offline',
            updatedAt: Date.now(),
          },
        });

        return { success: true, message: 'Now offline' };
      },

      // ------------------------------------------------------------------------
      // FRIEND MUTATIONS
      // ------------------------------------------------------------------------

      /**
       * Send a friend request.
       *
       * FLOW:
       * 1. Validate user isn't blocked, already friends, etc.
       * 2. Check for reverse request (auto-accept if exists)
       * 3. Create request in Redis
       * 4. Publish event for real-time notification
       */
      sendFriendRequest: async (
        _: unknown,
        args: { userId: string; message?: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const gamertag = context.user!.gamertag;

        const request = await friendService.sendFriendRequest(
          userId,
          args.userId,
          gamertag
        );

        // Publish event for real-time notification
        pubsub.publish(`${EVENTS.FRIEND_REQUEST_RECEIVED}.${args.userId}`, {
          friendRequestReceived: {
            ...request,
            fromUser: { id: userId, gamertag },
            toUser: { id: args.userId },
            status: request.status.toUpperCase(),
          },
        });

        pubsub.publish(`${EVENTS.FRIEND_EVENT}.${args.userId}`, {
          friendEventReceived: {
            type: 'FRIEND_REQUEST_RECEIVED',
            fromUser: { id: userId, gamertag },
            request: {
              ...request,
              fromUser: { id: userId, gamertag },
              toUser: { id: args.userId },
              status: request.status.toUpperCase(),
            },
            timestamp: request.createdAt,
          },
        });

        // Return enriched request
        const toUser = await authService.getUserById(args.userId);
        return {
          ...request,
          fromUser: { id: userId, gamertag },
          toUser,
          status: request.status.toUpperCase(),
        };
      },

      /**
       * Accept a friend request.
       *
       * FLOW:
       * 1. Verify request exists
       * 2. Create bidirectional friend relationship
       * 3. Remove pending requests
       * 4. Publish event for real-time notification
       * 5. Return new friend with presence
       */
      acceptFriendRequest: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const gamertag = context.user!.gamertag;

        await friendService.acceptFriendRequest(userId, args.userId, gamertag);

        // Also register in presence service for presence tracking
        presenceService.addFriend(userId, args.userId);

        // Publish event to notify the original sender
        pubsub.publish(`${EVENTS.FRIEND_EVENT}.${args.userId}`, {
          friendEventReceived: {
            type: 'FRIEND_REQUEST_ACCEPTED',
            fromUser: { id: userId, gamertag },
            timestamp: new Date().toISOString(),
          },
        });

        // Get the new friend's profile and presence
        const [friendProfile, presence] = await Promise.all([
          authService.getUserById(args.userId),
          presenceService.getPresence(args.userId),
        ]);

        return {
          user: friendProfile,
          presence,
          isOnline: presence?.status !== 'offline',
          lastOnlineAt: presence?.lastActiveAt
            ? new Date(presence.lastActiveAt).toISOString()
            : null,
        };
      },

      /**
       * Decline a friend request.
       *
       * NOTE: The sender is NOT notified to prevent harassment.
       * Their request will just disappear from their outgoing list.
       */
      declineFriendRequest: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        await friendService.declineFriendRequest(userId, args.userId);
        return { success: true, message: 'Friend request declined' };
      },

      /**
       * Cancel an outgoing friend request.
       */
      cancelFriendRequest: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        await friendService.cancelFriendRequest(userId, args.userId);
        return { success: true, message: 'Friend request canceled' };
      },

      /**
       * Remove a friend.
       *
       * Removes the bidirectional relationship.
       * The other user is NOT explicitly notified.
       */
      removeFriend: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        await friendService.removeFriend(userId, args.userId);

        // Also remove from presence service
        presenceService.removeFriend(userId, args.userId);

        return { success: true, message: 'Friend removed' };
      },

      /**
       * Block a user.
       *
       * Removes friendship, cancels requests, and prevents future interaction.
       */
      blockUser: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        await friendService.blockUser(userId, args.userId);

        // Also remove from presence service
        presenceService.removeFriend(userId, args.userId);

        return { success: true, message: 'User blocked' };
      },

      /**
       * Unblock a user.
       */
      unblockUser: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        await friendService.unblockUser(userId, args.userId);
        return { success: true, message: 'User unblocked' };
      },

      // ------------------------------------------------------------------------
      // CHAT MUTATIONS
      // ------------------------------------------------------------------------

      /**
       * Create a new conversation.
       */
      createConversation: async (
        _: unknown,
        args: {
          input: {
            participantIds: string[];
            type: 'DIRECT' | 'GROUP';
            name?: string;
          };
        },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);

        // Ensure current user is a participant
        const participantIds = args.input.participantIds.includes(userId)
          ? args.input.participantIds
          : [userId, ...args.input.participantIds];

        return chatService.createConversation(
          participantIds,
          args.input.type.toLowerCase() as 'direct' | 'group',
          args.input.name || null
        );
      },

      /**
       * Send a message.
       */
      sendMessage: async (
        _: unknown,
        args: {
          input: {
            conversationId: string;
            content: string;
            type?: string;
          };
        },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);

        const message = await chatService.sendMessage(userId, {
          conversationId: args.input.conversationId,
          content: args.input.content,
          type: (args.input.type?.toLowerCase() as any) || 'text',
        });

        // Publish to subscriptions
        pubsub.publish(`${EVENTS.MESSAGE_RECEIVED}.${args.input.conversationId}`, {
          messageReceived: message,
        });

        return message;
      },

      /**
       * Mark conversation as read.
       */
      markConversationAsRead: async (
        _: unknown,
        args: { conversationId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        await chatService.markAsRead(args.conversationId, userId);
        return { success: true, message: 'Marked as read' };
      },

      /**
       * Set typing indicator.
       */
      setTyping: async (
        _: unknown,
        args: { conversationId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        await chatService.setTyping(args.conversationId, userId);

        // Publish typing event
        pubsub.publish(`${EVENTS.USER_TYPING}.${args.conversationId}`, {
          userTyping: {
            conversationId: args.conversationId,
            userId,
            gamertag: context.user!.gamertag,
            isTyping: true,
          },
        });

        return { success: true, message: 'Typing indicator set' };
      },

      // ------------------------------------------------------------------------
      // NOTIFICATION MUTATIONS
      // ------------------------------------------------------------------------

      /**
       * Mark a notification as read.
       */
      markNotificationAsRead: async (
        _: unknown,
        _args: { notificationId: string },
        context: GraphQLContext
      ) => {
        requireAuth(context);
        return { success: true, message: 'Notification marked as read' };
      },

      /**
       * Mark all notifications as read.
       */
      markAllNotificationsAsRead: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ) => {
        requireAuth(context);
        return { success: true, message: 'All notifications marked as read' };
      },

      // ------------------------------------------------------------------------
      // GAME MUTATIONS
      // ------------------------------------------------------------------------

      /**
       * Add a game to user's library.
       */
      addGameToLibrary: async (
        _: unknown,
        args: { gameId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return gameService.addGameToLibrary(userId, args.gameId);
      },

      /**
       * Start a play session.
       */
      startPlaySession: async (
        _: unknown,
        args: {
          input: {
            gameId: string;
            activity?: string;
            isJoinable?: boolean;
            maxPartySize?: number;
            platform?: string;
          };
        },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const gamertag = context.user!.gamertag;
        return gameService.startSession(userId, gamertag, args.input.gameId, {
          activity: args.input.activity,
          isJoinable: args.input.isJoinable,
          maxPartySize: args.input.maxPartySize,
          platform: args.input.platform,
        });
      },

      /**
       * Heartbeat to keep session alive.
       */
      heartbeatSession: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return gameService.heartbeatSession(userId);
      },

      /**
       * Update session activity.
       */
      updateSessionActivity: async (
        _: unknown,
        args: { activity: string; isJoinable?: boolean; partySize?: number },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return gameService.updateSessionActivity(userId, args.activity, {
          isJoinable: args.isJoinable,
          partySize: args.partySize,
        });
      },

      /**
       * End play session.
       */
      endPlaySession: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const success = await gameService.endSession(userId);
        return {
          success,
          message: success ? 'Session ended' : 'No active session',
        };
      },

      /**
       * Unlock an achievement.
       */
      unlockAchievement: async (
        _: unknown,
        args: { achievementId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const gamertag = context.user!.gamertag;
        return gameService.unlockAchievement(userId, args.achievementId, gamertag);
      },

      /**
       * Send a game invite.
       */
      sendGameInvite: async (
        _: unknown,
        args: { input: { toUserId: string; message?: string } },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const gamertag = context.user!.gamertag;

        // Get current session
        const session = await gameService.getActiveSession(userId);
        if (!session) {
          throw new Error('You must be in an active session to send invites');
        }

        const invite = await gameService.sendGameInvite(
          userId,
          gamertag,
          args.input.toUserId,
          session.id,
          args.input.message
        );

        const fromUser = await authService.getUserById(userId);
        const game = await gameService.getGame(invite.gameId);

        return {
          ...invite,
          fromUser,
          game,
          status: invite.status.toUpperCase(),
        };
      },

      /**
       * Accept a game invite.
       */
      acceptGameInvite: async (
        _: unknown,
        args: { inviteId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const invite = await gameService.acceptInvite(userId, args.inviteId);

        const fromUser = await authService.getUserById(invite.fromUserId);
        const game = await gameService.getGame(invite.gameId);

        return {
          ...invite,
          fromUser,
          game,
          status: invite.status.toUpperCase(),
        };
      },

      /**
       * Decline a game invite.
       */
      declineGameInvite: async (
        _: unknown,
        args: { inviteId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const invite = await gameService.declineInvite(userId, args.inviteId);

        const fromUser = await authService.getUserById(invite.fromUserId);
        const game = await gameService.getGame(invite.gameId);

        return {
          ...invite,
          fromUser,
          game,
          status: invite.status.toUpperCase(),
        };
      },

      // ------------------------------------------------------------------------
      // ACTIVITY MUTATIONS
      // ------------------------------------------------------------------------

      /**
       * Like an activity.
       */
      likeActivity: async (
        _: unknown,
        args: { activityId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const activity = await activityService.likeActivity(args.activityId, userId);

        if (!activity) {
          throw new Error('Activity not found');
        }

        const user = await authService.getUserById(activity.userId);
        const game = activity.gameId
          ? await gameService.getGame(activity.gameId)
          : null;

        return {
          ...activity,
          user,
          game,
          type: activity.type.toUpperCase(),
        };
      },

      /**
       * Unlike an activity.
       */
      unlikeActivity: async (
        _: unknown,
        args: { activityId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const activity = await activityService.unlikeActivity(args.activityId, userId);

        if (!activity) {
          throw new Error('Activity not found');
        }

        const user = await authService.getUserById(activity.userId);
        const game = activity.gameId
          ? await gameService.getGame(activity.gameId)
          : null;

        return {
          ...activity,
          user,
          game,
          type: activity.type.toUpperCase(),
        };
      },

      // ------------------------------------------------------------------------
      // VOICE CHAT MUTATIONS
      // ------------------------------------------------------------------------

      /**
       * Create a voice room.
       */
      createVoiceRoom: async (
        _: unknown,
        args: {
          input: {
            name: string;
            maxParticipants?: number;
            isPrivate?: boolean;
            gameId?: string;
          };
        },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const gamertag = context.user!.gamertag;

        const room = await voiceService.createRoom({
          name: args.input.name,
          hostId: userId,
          hostGamertag: gamertag,
          maxParticipants: args.input.maxParticipants,
          isPrivate: args.input.isPrivate,
          gameId: args.input.gameId,
          gameTitle: args.input.gameId
            ? (await gameService.getGame(args.input.gameId))?.title
            : undefined,
        });

        const host = await authService.getUserById(room.hostId);
        const participants = await voiceService.getParticipants(room.id);

        return {
          ...room,
          host,
          participants: participants.map(p => ({
            ...p,
            user: { id: p.userId, gamertag: p.gamertag, avatar: p.avatar },
            state: p.state.toUpperCase(),
          })),
          state: room.state.toUpperCase(),
        };
      },

      /**
       * Join a voice room.
       */
      joinVoiceRoom: async (
        _: unknown,
        args: { roomId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const gamertag = context.user!.gamertag;

        const room = await voiceService.joinRoom(
          args.roomId,
          userId,
          gamertag,
          '🎮'
        );

        const host = await authService.getUserById(room.hostId);
        const participants = await voiceService.getParticipants(room.id);

        return {
          ...room,
          host,
          participants: participants.map(p => ({
            ...p,
            user: { id: p.userId, gamertag: p.gamertag, avatar: p.avatar },
            state: p.state.toUpperCase(),
          })),
          state: room.state.toUpperCase(),
        };
      },

      /**
       * Leave voice room.
       */
      leaveVoiceRoom: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const success = await voiceService.leaveRoom(userId);
        return {
          success,
          message: success ? 'Left voice room' : 'Not in a voice room',
        };
      },

      /**
       * Toggle mute.
       */
      toggleMute: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const participant = await voiceService.toggleMute(userId);
        return {
          ...participant,
          user: { id: participant.userId, gamertag: participant.gamertag, avatar: participant.avatar },
          state: participant.state.toUpperCase(),
        };
      },

      /**
       * Toggle deafen.
       */
      toggleDeafen: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        const participant = await voiceService.toggleDeafen(userId);
        return {
          ...participant,
          user: { id: participant.userId, gamertag: participant.gamertag, avatar: participant.avatar },
          state: participant.state.toUpperCase(),
        };
      },

      // ------------------------------------------------------------------------
      // PROFILE MUTATIONS
      // ------------------------------------------------------------------------

      /**
       * Update profile.
       */
      updateProfile: async (
        _: unknown,
        args: {
          input: {
            backgroundUrl?: string;
            themeColor?: string;
            bio?: string;
            region?: string;
            languages?: string[];
          };
        },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return profileService.updateProfile(userId, args.input);
      },

      /**
       * Update privacy settings.
       */
      updatePrivacy: async (
        _: unknown,
        args: { input: Record<string, any> },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);
        return profileService.updatePrivacySettings(userId, args.input);
      },

      /**
       * Update trophy showcase.
       */
      updateTrophyShowcase: async (
        _: unknown,
        args: { achievementIds: string[] },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);

        // Get achievement details for each ID
        const achievements = [];
        for (const achievementId of args.achievementIds) {
          // Find the achievement across all games
          for (const [_gameId, gameAchievements] of Object.entries(
            await Promise.all(
              Array.from({ length: 5 }, (_, i) => gameService.getGameAchievements(`game_${i}`))
            )
          )) {
            const found = gameAchievements.find(a => a.id === achievementId);
            if (found) {
              const game = await gameService.getGame(found.gameId);
              achievements.push({
                achievementId: found.id,
                achievementName: found.name,
                gameId: found.gameId,
                gameTitle: game?.title || 'Unknown',
                trophyType: found.trophyType as any,
                rarity: found.rarity as any,
                iconUrl: found.iconUrl,
                unlockedAt: new Date().toISOString(),
              });
              break;
            }
          }
        }

        const showcase = await profileService.updateTrophyShowcase(userId, achievements);
        return showcase.slots.filter(s => s !== null);
      },
    },

    // ==========================================================================
    // SUBSCRIPTION RESOLVERS
    // ==========================================================================

    /**
     * SUBSCRIPTION RESOLVERS:
     *
     * Unlike Query/Mutation resolvers that return data directly,
     * Subscription resolvers return an AsyncIterator that yields
     * values over time.
     *
     * FLOW:
     * 1. Client subscribes (calls subscribe function)
     * 2. Server returns AsyncIterator
     * 3. When pubsub.publish() is called, iterator yields value
     * 4. Server pushes value to client over WebSocket
     *
     * FILTERING:
     * Use withFilter() to only send events to relevant clients.
     * For example, only send friend presence updates to actual friends.
     */
    Subscription: {
      /**
       * Subscribe to friend presence updates.
       *
       * FILTERING EXAMPLE:
       * In production, you'd filter to only friends:
       *
       * friendPresenceUpdated: {
       *   subscribe: withFilter(
       *     () => pubsub.asyncIterator([EVENTS.FRIEND_PRESENCE_UPDATED]),
       *     (payload, variables, context) => {
       *       const friendIds = presenceService.getFriends(context.user.userId);
       *       return friendIds.includes(payload.friendPresenceUpdated.userId);
       *     }
       *   )
       * }
       */
      friendPresenceUpdated: {
        subscribe: () => pubsub.asyncIterator([EVENTS.FRIEND_PRESENCE_UPDATED]),
      },

      /**
       * Subscribe to a specific user's presence.
       */
      userPresenceUpdated: {
        subscribe: (_: unknown, args: { userId: string }) => {
          return pubsub.asyncIterator([
            `${EVENTS.USER_PRESENCE_UPDATED}.${args.userId}`,
          ]);
        },
      },

      /**
       * Subscribe to messages in a conversation.
       */
      messageReceived: {
        subscribe: (_: unknown, args: { conversationId: string }) => {
          return pubsub.asyncIterator([
            `${EVENTS.MESSAGE_RECEIVED}.${args.conversationId}`,
          ]);
        },
      },

      /**
       * Subscribe to typing indicators.
       */
      userTyping: {
        subscribe: (_: unknown, args: { conversationId: string }) => {
          return pubsub.asyncIterator([
            `${EVENTS.USER_TYPING}.${args.conversationId}`,
          ]);
        },
      },

      /**
       * Subscribe to notifications.
       */
      notificationReceived: {
        subscribe: () => pubsub.asyncIterator([EVENTS.NOTIFICATION_RECEIVED]),
      },

      /**
       * Subscribe to new messages across all conversations.
       */
      newMessageNotification: {
        subscribe: () => pubsub.asyncIterator([EVENTS.MESSAGE_RECEIVED]),
      },

      // -----------------------------------------------------------------------
      // FRIEND SUBSCRIPTIONS
      // -----------------------------------------------------------------------

      /**
       * Subscribe to all friend events for the authenticated user.
       *
       * FILTERING:
       * Events are published to user-specific channels:
       * FRIEND_EVENT.{userId}
       *
       * This ensures users only receive their own events, even when
       * multiple users share the same server instance.
       */
      friendEventReceived: {
        subscribe: (_: unknown, __: unknown, context: GraphQLContext) => {
          const userId = context.user?.userId;
          if (!userId) {
            throw new Error('Authentication required for friend events');
          }
          return pubsub.asyncIterator([`${EVENTS.FRIEND_EVENT}.${userId}`]);
        },
      },

      /**
       * Subscribe to incoming friend requests only.
       *
       * Useful for:
       * - Showing notification badge on friends icon
       * - Toast notifications for new requests
       */
      friendRequestReceived: {
        subscribe: (_: unknown, __: unknown, context: GraphQLContext) => {
          const userId = context.user?.userId;
          if (!userId) {
            throw new Error('Authentication required for friend request events');
          }
          return pubsub.asyncIterator([`${EVENTS.FRIEND_REQUEST_RECEIVED}.${userId}`]);
        },
      },

      // -----------------------------------------------------------------------
      // GAME SUBSCRIPTIONS
      // -----------------------------------------------------------------------

      /**
       * Subscribe to game invites.
       */
      gameInviteReceived: {
        subscribe: (_: unknown, __: unknown, context: GraphQLContext) => {
          const userId = context.user?.userId;
          if (!userId) {
            throw new Error('Authentication required for game invites');
          }
          return pubsub.asyncIterator([`GAME_INVITE_RECEIVED.${userId}`]);
        },
      },

      /**
       * Subscribe to friend session updates.
       */
      friendSessionUpdated: {
        subscribe: () => pubsub.asyncIterator(['FRIEND_SESSION_UPDATED']),
      },

      /**
       * Subscribe to friend achievement unlocks.
       */
      friendAchievementUnlocked: {
        subscribe: () => pubsub.asyncIterator(['FRIEND_ACHIEVEMENT_UNLOCKED']),
      },

      // -----------------------------------------------------------------------
      // ACTIVITY FEED SUBSCRIPTIONS
      // -----------------------------------------------------------------------

      /**
       * Subscribe to new activities from friends.
       */
      newActivity: {
        subscribe: (_: unknown, __: unknown, context: GraphQLContext) => {
          const userId = context.user?.userId;
          if (!userId) {
            throw new Error('Authentication required for activity feed');
          }
          return pubsub.asyncIterator([`NEW_ACTIVITY.${userId}`]);
        },
      },

      // -----------------------------------------------------------------------
      // VOICE CHAT SUBSCRIPTIONS
      // -----------------------------------------------------------------------

      /**
       * Subscribe to voice room updates.
       */
      voiceRoomUpdated: {
        subscribe: (_: unknown, args: { roomId: string }) => {
          return pubsub.asyncIterator([`VOICE_ROOM_UPDATED.${args.roomId}`]);
        },
      },

      /**
       * Subscribe to voice participant updates.
       */
      voiceParticipantUpdated: {
        subscribe: (_: unknown, args: { roomId: string }) => {
          return pubsub.asyncIterator([`VOICE_PARTICIPANT_UPDATED.${args.roomId}`]);
        },
      },
    },

    // ==========================================================================
    // TYPE RESOLVERS
    // ==========================================================================

    /**
     * Type resolvers handle fields on custom types.
     *
     * WHEN DO YOU NEED TYPE RESOLVERS?
     * --------------------------------
     * 1. Field doesn't exist on parent object
     * 2. Field needs transformation
     * 3. Field needs additional data fetching
     *
     * EXAMPLE:
     * Conversation.participants needs to fetch User objects
     * from participant IDs.
     */
    Conversation: {
      /**
       * Resolve participants from participantIds.
       *
       * N+1 PROBLEM SOLVED:
       * Instead of N queries for N participants,
       * we batch fetch all at once.
       */
      participants: async (parent: any, _: unknown, _context: GraphQLContext) => {
        return authService.getUsersByIds(parent.participantIds);
      },

      /**
       * Get unread count for the authenticated user.
       */
      unreadCount: (parent: any, _: unknown, context: GraphQLContext) => {
        const userId = context.user?.userId;
        if (!userId) return 0;
        return parent.unreadCounts?.[userId] || 0;
      },
    },

    /**
     * User type resolver for computed fields.
     */
    User: {
      // All User fields come directly from the service
      // No additional resolvers needed for basic fields
    },

    /**
     * Presence type resolver.
     */
    Presence: {
      // Map backend snake_case to GraphQL camelCase if needed
    },
  };
};
