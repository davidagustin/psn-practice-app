/**
 * ==============================================================================
 * PLAYSTATION NETWORK - FRIEND SERVICE
 * ==============================================================================
 *
 * This service manages all friend-related functionality for the PSN platform:
 * - Sending/accepting/declining friend requests
 * - Removing friends
 * - Blocking/unblocking users
 * - Searching for users by gamertag
 *
 * REDIS DATA STRUCTURES:
 * ======================
 *
 * We use different Redis data structures optimized for each use case:
 *
 * 1. FRIENDS (Set): O(1) membership check, O(n) list all
 *    Key: "user:{userId}:friends"
 *    Members: friendId1, friendId2, ...
 *
 * 2. FRIEND REQUESTS - INCOMING (Sorted Set): Ordered by timestamp
 *    Key: "user:{userId}:friend_requests:incoming"
 *    Score: timestamp (for ordering by recency)
 *    Member: senderId
 *
 * 3. FRIEND REQUESTS - OUTGOING (Sorted Set): Track sent requests
 *    Key: "user:{userId}:friend_requests:outgoing"
 *    Score: timestamp
 *    Member: recipientId
 *
 * 4. BLOCKED USERS (Set): O(1) check if blocked
 *    Key: "user:{userId}:blocked"
 *    Members: blockedUserId1, blockedUserId2, ...
 *
 * INTERVIEW TIP:
 * "We chose Redis Sets for friend relationships because:
 * 1. O(1) SISMEMBER to check if someone is a friend
 * 2. O(1) SADD/SREM for adding/removing friends
 * 3. SMEMBERS returns all friends in one call
 * 4. SINTER can find mutual friends efficiently"
 *
 * BIDIRECTIONAL STORAGE:
 * When user A friends user B, we store:
 * - A in B's friends set
 * - B in A's friends set
 * This allows O(1) lookup from either direction.
 * ==============================================================================
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  FriendRelationship,
  FriendRequest,
  FriendEvent,
} from '../../types';

/**
 * Redis key patterns for friend-related data.
 *
 * KEY NAMING CONVENTION:
 * - Prefix with entity type: "user:"
 * - Include ID: "user:{userId}"
 * - Suffix with data type: ":friends", ":blocked"
 *
 * This makes keys self-documenting and scannable.
 */
const REDIS_KEYS = {
  /** Set of friend user IDs */
  friends: (userId: string) => `user:${userId}:friends`,

  /** Sorted set of incoming friend requests (score = timestamp) */
  incomingRequests: (userId: string) => `user:${userId}:friend_requests:incoming`,

  /** Sorted set of outgoing friend requests (score = timestamp) */
  outgoingRequests: (userId: string) => `user:${userId}:friend_requests:outgoing`,

  /** Set of blocked user IDs */
  blocked: (userId: string) => `user:${userId}:blocked`,

  /** Hash storing friend request details */
  requestDetails: (fromId: string, toId: string) => `friend_request:${fromId}:${toId}`,

  /** Pub/Sub channel for friend events */
  friendEventsChannel: 'friend:events',

  /** User-specific friend events channel */
  userFriendEvents: (userId: string) => `friend:events:${userId}`,
};

/**
 * Configuration for the friend service.
 */
interface FriendServiceConfig {
  /** Maximum number of friends a user can have */
  maxFriends: number;

  /** Maximum number of pending friend requests */
  maxPendingRequests: number;

  /** How long friend requests are valid (in seconds) */
  requestExpirationSeconds: number;
}

const DEFAULT_CONFIG: FriendServiceConfig = {
  maxFriends: 2000, // PlayStation allows up to 2000 friends
  maxPendingRequests: 500,
  requestExpirationSeconds: 30 * 24 * 60 * 60, // 30 days
};

/**
 * FriendService manages all friend-related operations.
 *
 * ARCHITECTURE PATTERN: Service + EventEmitter
 * - Service methods handle business logic
 * - EventEmitter broadcasts changes for real-time updates
 * - Resolvers listen to events and push to subscriptions
 */
export class FriendService extends EventEmitter {
  private redis: Redis;
  private subscriber: Redis;
  private config: FriendServiceConfig;

  constructor(redis: Redis, config: Partial<FriendServiceConfig> = {}) {
    super();
    this.redis = redis;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Create separate Redis connection for Pub/Sub
    // IMPORTANT: Pub/Sub connections can't run other commands
    this.subscriber = redis.duplicate();
    this.setupSubscriber();

    console.log('[FriendService] Initialized with config:', this.config);
  }

  /**
   * Set up Redis Pub/Sub subscriber for friend events.
   *
   * PUB/SUB PATTERN:
   * When a friend event happens on any server instance:
   * 1. That instance publishes to Redis channel
   * 2. All server instances receive the event
   * 3. Each instance notifies relevant WebSocket clients
   *
   * This enables horizontal scaling - events reach all servers.
   */
  private setupSubscriber(): void {
    this.subscriber.subscribe(REDIS_KEYS.friendEventsChannel, (err) => {
      if (err) {
        console.error('[FriendService] Failed to subscribe to friend events:', err);
        return;
      }
      console.log('[FriendService] Subscribed to friend events channel');
    });

    this.subscriber.on('message', (_channel, message) => {
      try {
        const event: FriendEvent = JSON.parse(message);
        // Re-emit event for local GraphQL subscriptions
        this.emit('friendEvent', event);
      } catch (error) {
        console.error('[FriendService] Failed to parse friend event:', error);
      }
    });
  }

  /**
   * Publish a friend event to Redis Pub/Sub.
   *
   * @param event - The friend event to publish
   */
  private async publishEvent(event: FriendEvent): Promise<void> {
    await this.redis.publish(
      REDIS_KEYS.friendEventsChannel,
      JSON.stringify(event)
    );

    // Also publish to user-specific channels for targeted subscriptions
    if (event.toUserId) {
      await this.redis.publish(
        REDIS_KEYS.userFriendEvents(event.toUserId),
        JSON.stringify(event)
      );
    }
    if (event.fromUserId) {
      await this.redis.publish(
        REDIS_KEYS.userFriendEvents(event.fromUserId),
        JSON.stringify(event)
      );
    }
  }

  // ============================================================================
  // FRIEND REQUEST OPERATIONS
  // ============================================================================

  /**
   * Send a friend request from one user to another.
   *
   * VALIDATION CHECKS:
   * 1. Can't friend yourself
   * 2. Can't friend someone who blocked you
   * 3. Can't friend someone you blocked
   * 4. Can't send duplicate request
   * 5. Can't exceed max pending requests
   * 6. Can't exceed max friends
   *
   * @param fromUserId - User sending the request
   * @param toUserId - User receiving the request
   * @param fromGamertag - Gamertag of sender (for notifications)
   * @returns The created friend request
   * @throws Error if validation fails
   */
  async sendFriendRequest(
    fromUserId: string,
    toUserId: string,
    fromGamertag: string
  ): Promise<FriendRequest> {
    console.log(`[FriendService] ${fromUserId} sending friend request to ${toUserId}`);

    // Validation 1: Can't friend yourself
    if (fromUserId === toUserId) {
      throw new Error('Cannot send friend request to yourself');
    }

    // Validation 2: Check if already friends
    const alreadyFriends = await this.areFriends(fromUserId, toUserId);
    if (alreadyFriends) {
      throw new Error('Already friends with this user');
    }

    // Validation 3: Check if blocked (either direction)
    const [blockedByRecipient, blockedBySender] = await Promise.all([
      this.isBlocked(toUserId, fromUserId),
      this.isBlocked(fromUserId, toUserId),
    ]);

    if (blockedByRecipient) {
      throw new Error('Cannot send friend request to this user');
    }

    if (blockedBySender) {
      throw new Error('Unblock this user before sending a friend request');
    }

    // Validation 4: Check if request already exists
    const existingRequest = await this.redis.zscore(
      REDIS_KEYS.outgoingRequests(fromUserId),
      toUserId
    );
    if (existingRequest !== null) {
      throw new Error('Friend request already sent');
    }

    // Validation 5: Check if recipient already sent us a request (auto-accept scenario)
    const reverseRequest = await this.redis.zscore(
      REDIS_KEYS.incomingRequests(fromUserId),
      toUserId
    );
    if (reverseRequest !== null) {
      // Auto-accept: they already sent us a request, so accept it
      console.log('[FriendService] Reverse request found, auto-accepting');
      await this.acceptFriendRequest(fromUserId, toUserId, fromGamertag);

      // Return a "completed" request
      return {
        id: uuidv4(),
        fromUserId,
        toUserId,
        fromGamertag,
        status: 'accepted',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    // Validation 6: Check pending request limits
    const [senderOutgoing, recipientIncoming] = await Promise.all([
      this.redis.zcard(REDIS_KEYS.outgoingRequests(fromUserId)),
      this.redis.zcard(REDIS_KEYS.incomingRequests(toUserId)),
    ]);

    if (senderOutgoing >= this.config.maxPendingRequests) {
      throw new Error('You have too many pending friend requests');
    }

    if (recipientIncoming >= this.config.maxPendingRequests) {
      throw new Error('This user has too many pending friend requests');
    }

    // Create the friend request
    const now = Date.now();
    const requestId = uuidv4();
    const request: FriendRequest = {
      id: requestId,
      fromUserId,
      toUserId,
      fromGamertag,
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };

    // Store request in Redis using a transaction (atomic)
    const pipeline = this.redis.pipeline();

    // Add to sender's outgoing requests
    pipeline.zadd(REDIS_KEYS.outgoingRequests(fromUserId), now, toUserId);

    // Add to recipient's incoming requests
    pipeline.zadd(REDIS_KEYS.incomingRequests(toUserId), now, fromUserId);

    // Store request details
    pipeline.hset(
      REDIS_KEYS.requestDetails(fromUserId, toUserId),
      'id', requestId,
      'fromGamertag', fromGamertag,
      'createdAt', now.toString(),
      'status', 'pending'
    );

    // Set expiration on request details
    pipeline.expire(
      REDIS_KEYS.requestDetails(fromUserId, toUserId),
      this.config.requestExpirationSeconds
    );

    await pipeline.exec();

    // Publish event for real-time notification
    const event: FriendEvent = {
      type: 'friend_request_received',
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      fromUserId,
      toUserId,
      fromGamertag,
      request,
    };
    await this.publishEvent(event);

    console.log(`[FriendService] Friend request sent: ${fromUserId} -> ${toUserId}`);
    return request;
  }

  /**
   * Accept a friend request.
   *
   * PROCESS:
   * 1. Verify request exists
   * 2. Add bidirectional friend relationship
   * 3. Remove request from both users
   * 4. Publish events
   *
   * @param userId - User accepting the request (recipient)
   * @param fromUserId - User who sent the request
   * @param userGamertag - Gamertag of the accepting user
   */
  async acceptFriendRequest(
    userId: string,
    fromUserId: string,
    userGamertag: string
  ): Promise<FriendRelationship> {
    console.log(`[FriendService] ${userId} accepting request from ${fromUserId}`);

    // Verify request exists
    const requestExists = await this.redis.zscore(
      REDIS_KEYS.incomingRequests(userId),
      fromUserId
    );

    if (requestExists === null) {
      throw new Error('Friend request not found');
    }

    // Check friend limits
    const [userFriendCount, senderFriendCount] = await Promise.all([
      this.redis.scard(REDIS_KEYS.friends(userId)),
      this.redis.scard(REDIS_KEYS.friends(fromUserId)),
    ]);

    if (userFriendCount >= this.config.maxFriends) {
      throw new Error('You have reached the maximum number of friends');
    }

    if (senderFriendCount >= this.config.maxFriends) {
      throw new Error('This user has reached the maximum number of friends');
    }

    const now = new Date().toISOString();

    // Create friend relationship (atomic transaction)
    const pipeline = this.redis.pipeline();

    // Add bidirectional friend relationship
    pipeline.sadd(REDIS_KEYS.friends(userId), fromUserId);
    pipeline.sadd(REDIS_KEYS.friends(fromUserId), userId);

    // Remove from pending requests
    pipeline.zrem(REDIS_KEYS.incomingRequests(userId), fromUserId);
    pipeline.zrem(REDIS_KEYS.outgoingRequests(fromUserId), userId);

    // Clean up request details
    pipeline.del(REDIS_KEYS.requestDetails(fromUserId, userId));

    await pipeline.exec();

    const relationship: FriendRelationship = {
      userId,
      friendId: fromUserId,
      status: 'accepted',
      initiatedBy: fromUserId,
      createdAt: now,
      updatedAt: now,
    };

    // Publish event for real-time notification
    const event: FriendEvent = {
      type: 'friend_request_accepted',
      eventId: uuidv4(),
      timestamp: now,
      fromUserId: userId, // The accepter
      toUserId: fromUserId, // The original sender gets notified
      fromGamertag: userGamertag,
    };
    await this.publishEvent(event);

    console.log(`[FriendService] Friend request accepted: ${userId} <-> ${fromUserId}`);
    return relationship;
  }

  /**
   * Decline a friend request.
   *
   * @param userId - User declining the request
   * @param fromUserId - User who sent the request
   */
  async declineFriendRequest(userId: string, fromUserId: string): Promise<void> {
    console.log(`[FriendService] ${userId} declining request from ${fromUserId}`);

    // Verify request exists
    const requestExists = await this.redis.zscore(
      REDIS_KEYS.incomingRequests(userId),
      fromUserId
    );

    if (requestExists === null) {
      throw new Error('Friend request not found');
    }

    // Remove request (atomic transaction)
    const pipeline = this.redis.pipeline();
    pipeline.zrem(REDIS_KEYS.incomingRequests(userId), fromUserId);
    pipeline.zrem(REDIS_KEYS.outgoingRequests(fromUserId), userId);
    pipeline.del(REDIS_KEYS.requestDetails(fromUserId, userId));
    await pipeline.exec();

    console.log(`[FriendService] Friend request declined: ${fromUserId} -> ${userId}`);
  }

  /**
   * Cancel an outgoing friend request.
   *
   * @param userId - User who sent the request
   * @param toUserId - User who was to receive the request
   */
  async cancelFriendRequest(userId: string, toUserId: string): Promise<void> {
    console.log(`[FriendService] ${userId} canceling request to ${toUserId}`);

    // Verify request exists
    const requestExists = await this.redis.zscore(
      REDIS_KEYS.outgoingRequests(userId),
      toUserId
    );

    if (requestExists === null) {
      throw new Error('Friend request not found');
    }

    // Remove request (atomic transaction)
    const pipeline = this.redis.pipeline();
    pipeline.zrem(REDIS_KEYS.outgoingRequests(userId), toUserId);
    pipeline.zrem(REDIS_KEYS.incomingRequests(toUserId), userId);
    pipeline.del(REDIS_KEYS.requestDetails(userId, toUserId));
    await pipeline.exec();

    console.log(`[FriendService] Friend request canceled: ${userId} -> ${toUserId}`);
  }

  /**
   * Get pending friend requests for a user.
   *
   * @param userId - User to get requests for
   * @param type - 'incoming' or 'outgoing'
   * @param limit - Maximum number of requests to return
   * @param offset - Offset for pagination
   */
  async getFriendRequests(
    userId: string,
    type: 'incoming' | 'outgoing',
    limit: number = 50,
    offset: number = 0
  ): Promise<FriendRequest[]> {
    const key = type === 'incoming'
      ? REDIS_KEYS.incomingRequests(userId)
      : REDIS_KEYS.outgoingRequests(userId);

    // Get user IDs with scores (timestamps) in reverse order (newest first)
    const results = await this.redis.zrevrange(
      key,
      offset,
      offset + limit - 1,
      'WITHSCORES'
    );

    // Parse results into FriendRequest objects
    const requests: FriendRequest[] = [];
    for (let i = 0; i < results.length; i += 2) {
      const otherUserId = results[i];
      const timestamp = parseInt(results[i + 1], 10);

      // Get request details
      const fromId = type === 'incoming' ? otherUserId : userId;
      const toId = type === 'incoming' ? userId : otherUserId;
      const details = await this.redis.hgetall(
        REDIS_KEYS.requestDetails(fromId, toId)
      );

      requests.push({
        id: details.id || uuidv4(),
        fromUserId: fromId,
        toUserId: toId,
        fromGamertag: details.fromGamertag || 'Unknown',
        status: 'pending',
        createdAt: new Date(timestamp).toISOString(),
        updatedAt: new Date(timestamp).toISOString(),
      });
    }

    return requests;
  }

  // ============================================================================
  // FRIEND MANAGEMENT
  // ============================================================================

  /**
   * Get all friends for a user.
   *
   * @param userId - User to get friends for
   * @returns Array of friend user IDs
   */
  async getFriends(userId: string): Promise<string[]> {
    return this.redis.smembers(REDIS_KEYS.friends(userId));
  }

  /**
   * Get friend count for a user.
   *
   * @param userId - User to count friends for
   */
  async getFriendCount(userId: string): Promise<number> {
    return this.redis.scard(REDIS_KEYS.friends(userId));
  }

  /**
   * Check if two users are friends.
   *
   * O(1) operation using Redis SISMEMBER.
   *
   * @param userId - First user
   * @param otherUserId - Second user
   */
  async areFriends(userId: string, otherUserId: string): Promise<boolean> {
    const isFriend = await this.redis.sismember(
      REDIS_KEYS.friends(userId),
      otherUserId
    );
    return isFriend === 1;
  }

  /**
   * Get mutual friends between two users.
   *
   * Uses Redis SINTER for efficient set intersection.
   *
   * INTERVIEW TIP:
   * "Redis SINTER computes set intersection server-side,
   * which is much faster than fetching both sets and
   * computing intersection in application code."
   *
   * @param userId - First user
   * @param otherUserId - Second user
   * @returns Array of mutual friend IDs
   */
  async getMutualFriends(userId: string, otherUserId: string): Promise<string[]> {
    return this.redis.sinter(
      REDIS_KEYS.friends(userId),
      REDIS_KEYS.friends(otherUserId)
    );
  }

  /**
   * Remove a friend relationship.
   *
   * Removes bidirectional relationship and publishes event.
   *
   * @param userId - User removing the friend
   * @param friendId - Friend to remove
   */
  async removeFriend(userId: string, friendId: string): Promise<void> {
    console.log(`[FriendService] ${userId} removing friend ${friendId}`);

    // Verify they are friends
    const areFriends = await this.areFriends(userId, friendId);
    if (!areFriends) {
      throw new Error('Not friends with this user');
    }

    // Remove bidirectional relationship
    const pipeline = this.redis.pipeline();
    pipeline.srem(REDIS_KEYS.friends(userId), friendId);
    pipeline.srem(REDIS_KEYS.friends(friendId), userId);
    await pipeline.exec();

    // Publish event
    const event: FriendEvent = {
      type: 'friend_removed',
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      fromUserId: userId,
      toUserId: friendId,
    };
    await this.publishEvent(event);

    console.log(`[FriendService] Friend removed: ${userId} <-/-> ${friendId}`);
  }

  // ============================================================================
  // BLOCKING
  // ============================================================================

  /**
   * Block a user.
   *
   * EFFECTS OF BLOCKING:
   * 1. Blocked user cannot send friend requests
   * 2. Blocked user cannot see your presence
   * 3. Blocked user cannot message you
   * 4. Existing friend relationship is removed
   * 5. Pending requests are canceled
   *
   * @param userId - User doing the blocking
   * @param blockedUserId - User being blocked
   */
  async blockUser(userId: string, blockedUserId: string): Promise<void> {
    console.log(`[FriendService] ${userId} blocking ${blockedUserId}`);

    if (userId === blockedUserId) {
      throw new Error('Cannot block yourself');
    }

    const pipeline = this.redis.pipeline();

    // Add to blocked set
    pipeline.sadd(REDIS_KEYS.blocked(userId), blockedUserId);

    // Remove friend relationship if exists
    pipeline.srem(REDIS_KEYS.friends(userId), blockedUserId);
    pipeline.srem(REDIS_KEYS.friends(blockedUserId), userId);

    // Cancel any pending requests in both directions
    pipeline.zrem(REDIS_KEYS.incomingRequests(userId), blockedUserId);
    pipeline.zrem(REDIS_KEYS.outgoingRequests(userId), blockedUserId);
    pipeline.zrem(REDIS_KEYS.incomingRequests(blockedUserId), userId);
    pipeline.zrem(REDIS_KEYS.outgoingRequests(blockedUserId), userId);

    // Clean up request details
    pipeline.del(REDIS_KEYS.requestDetails(userId, blockedUserId));
    pipeline.del(REDIS_KEYS.requestDetails(blockedUserId, userId));

    await pipeline.exec();

    // Publish event
    const event: FriendEvent = {
      type: 'user_blocked',
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      fromUserId: userId,
      toUserId: blockedUserId,
    };
    await this.publishEvent(event);

    console.log(`[FriendService] User blocked: ${userId} blocked ${blockedUserId}`);
  }

  /**
   * Unblock a user.
   *
   * @param userId - User doing the unblocking
   * @param blockedUserId - User being unblocked
   */
  async unblockUser(userId: string, blockedUserId: string): Promise<void> {
    console.log(`[FriendService] ${userId} unblocking ${blockedUserId}`);

    const wasBlocked = await this.redis.srem(
      REDIS_KEYS.blocked(userId),
      blockedUserId
    );

    if (wasBlocked === 0) {
      throw new Error('User is not blocked');
    }

    // Publish event
    const event: FriendEvent = {
      type: 'user_unblocked',
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      fromUserId: userId,
      toUserId: blockedUserId,
    };
    await this.publishEvent(event);

    console.log(`[FriendService] User unblocked: ${userId} unblocked ${blockedUserId}`);
  }

  /**
   * Check if a user has blocked another user.
   *
   * @param userId - User who might have blocked
   * @param blockedUserId - User who might be blocked
   */
  async isBlocked(userId: string, blockedUserId: string): Promise<boolean> {
    const isBlocked = await this.redis.sismember(
      REDIS_KEYS.blocked(userId),
      blockedUserId
    );
    return isBlocked === 1;
  }

  /**
   * Get all blocked users.
   *
   * @param userId - User to get blocked list for
   */
  async getBlockedUsers(userId: string): Promise<string[]> {
    return this.redis.smembers(REDIS_KEYS.blocked(userId));
  }

  /**
   * Check if either user has blocked the other.
   *
   * Useful for permission checks before actions.
   *
   * @param userId1 - First user
   * @param userId2 - Second user
   */
  async isEitherBlocked(userId1: string, userId2: string): Promise<boolean> {
    const [blocked1, blocked2] = await Promise.all([
      this.isBlocked(userId1, userId2),
      this.isBlocked(userId2, userId1),
    ]);
    return blocked1 || blocked2;
  }

  // ============================================================================
  // SEARCH
  // ============================================================================

  /**
   * Search for users by gamertag.
   *
   * NOTE: This is a simple implementation using Redis KEYS command.
   * In production, use:
   * - Elasticsearch for full-text search
   * - DynamoDB GSI with begins_with for prefix matching
   * - Dedicated search microservice
   *
   * @param query - Search query (gamertag to search for)
   * @param searcherId - ID of user performing search (to filter blocked users)
   * @param limit - Maximum results to return
   */
  async searchUsers(
    query: string,
    searcherId: string,
    limit: number = 20
  ): Promise<string[]> {
    // In a real implementation, this would call an external search service
    // For now, we return an empty array - the AuthService would handle actual search
    console.log(`[FriendService] Search for "${query}" by ${searcherId} (limit: ${limit})`);
    return [];
  }

  // ============================================================================
  // FRIEND SUGGESTIONS
  // ============================================================================

  /**
   * Get friend suggestions based on mutual friends.
   *
   * ALGORITHM:
   * 1. Get all friends of the user
   * 2. For each friend, get their friends
   * 3. Count how many times each non-friend appears
   * 4. Return top suggestions sorted by mutual friend count
   *
   * INTERVIEW TIP:
   * "This is essentially computing 'friends of friends' and ranking by
   * connection strength. It's similar to LinkedIn's 'People You May Know'.
   * For large friend graphs, we'd precompute this periodically rather than
   * in real-time."
   *
   * @param userId - User to get suggestions for
   * @param limit - Maximum suggestions to return
   */
  async getFriendSuggestions(
    userId: string,
    limit: number = 10
  ): Promise<Array<{ userId: string; mutualFriendCount: number }>> {
    const friends = await this.getFriends(userId);

    if (friends.length === 0) {
      return [];
    }

    // Count mutual friends for each potential suggestion
    const mutualCounts = new Map<string, number>();

    for (const friendId of friends) {
      const friendsOfFriend = await this.getFriends(friendId);

      for (const potentialFriend of friendsOfFriend) {
        // Skip if it's the user themselves or already a friend
        if (potentialFriend === userId || friends.includes(potentialFriend)) {
          continue;
        }

        // Check if blocked
        const blocked = await this.isEitherBlocked(userId, potentialFriend);
        if (blocked) {
          continue;
        }

        // Increment mutual friend count
        const currentCount = mutualCounts.get(potentialFriend) || 0;
        mutualCounts.set(potentialFriend, currentCount + 1);
      }
    }

    // Sort by mutual friend count and return top suggestions
    const suggestions = Array.from(mutualCounts.entries())
      .map(([userId, mutualFriendCount]) => ({ userId, mutualFriendCount }))
      .sort((a, b) => b.mutualFriendCount - a.mutualFriendCount)
      .slice(0, limit);

    return suggestions;
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  /**
   * Clean up resources when shutting down.
   */
  async cleanup(): Promise<void> {
    console.log('[FriendService] Cleaning up...');
    await this.subscriber.unsubscribe();
    await this.subscriber.quit();
    console.log('[FriendService] Cleanup complete');
  }
}
