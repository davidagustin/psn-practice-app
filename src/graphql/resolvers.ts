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
import { GraphQLContext, PresenceData, PublicUser } from '../types';

/**
 * Subscription event names.
 *
 * PUBSUB PATTERN:
 * Subscriptions work by publishing events to named channels.
 * Subscribers listen to these channels and receive updates.
 *
 * Using constants prevents typos and makes refactoring easier.
 */
const EVENTS = {
  FRIEND_PRESENCE_UPDATED: 'FRIEND_PRESENCE_UPDATED',
  USER_PRESENCE_UPDATED: 'USER_PRESENCE_UPDATED',
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
  USER_TYPING: 'USER_TYPING',
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
 * @param authService - Authentication service
 * @param presenceService - Presence service
 * @param chatService - Chat service
 * @param pubsub - PubSub instance for subscriptions
 */
export const createResolvers = (
  authService: AuthService,
  presenceService: PresenceService,
  chatService: ChatService,
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
       */
      friends: async (_: unknown, __: unknown, context: GraphQLContext) => {
        const userId = getUserId(context);

        // Get friends with presence (batched internally)
        const friendsWithPresence = await presenceService.getFriendsWithPresence(userId);

        // Batch fetch user profiles
        const friendIds = friendsWithPresence.map((f) => f.friendId);
        const profiles = await authService.getUsersByIds(friendIds);

        // Combine profiles with presence
        const profileMap = new Map(profiles.map((p) => [p.id, p]));

        return friendsWithPresence.map((f) => ({
          user: profileMap.get(f.friendId) || null,
          presence: f.presence,
          isOnline: f.isOnline,
          lastOnlineAt: f.presence?.lastActiveAt
            ? new Date(f.presence.lastActiveAt).toISOString()
            : null,
        }));
      },

      /**
       * Get pending friend requests.
       */
      friendRequests: async (
        _: unknown,
        __: unknown,
        context: GraphQLContext
      ): Promise<PublicUser[]> => {
        requireAuth(context);
        // Mock: return empty array
        return [];
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
        args: { limit: number; unreadOnly: boolean },
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
       */
      sendFriendRequest: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        requireAuth(context);
        // Mock implementation
        return { success: true, message: 'Friend request sent' };
      },

      /**
       * Accept a friend request.
       */
      acceptFriendRequest: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        const userId = getUserId(context);

        // Add friend relationship
        presenceService.addFriend(userId, args.userId);

        return { success: true, message: 'Friend request accepted' };
      },

      /**
       * Decline a friend request.
       */
      declineFriendRequest: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        requireAuth(context);
        return { success: true, message: 'Friend request declined' };
      },

      /**
       * Remove a friend.
       */
      removeFriend: async (
        _: unknown,
        args: { userId: string },
        context: GraphQLContext
      ) => {
        requireAuth(context);
        return { success: true, message: 'Friend removed' };
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
        args: { notificationId: string },
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
      participants: async (parent: any, _: unknown, context: GraphQLContext) => {
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
