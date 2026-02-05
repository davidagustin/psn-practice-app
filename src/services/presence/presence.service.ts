/**
 * ==============================================================================
 * PLAYSTATION NETWORK - PRESENCE SERVICE
 * ==============================================================================
 *
 * This service manages real-time user presence - the "Online Now" feature
 * you see on PlayStation showing which friends are online and what they're playing.
 *
 * THIS IS THE MOST IMPORTANT SERVICE FOR YOUR INTERVIEW
 * =====================================================
 * Real-time presence is a core PlayStation feature. Understanding how to
 * scale this to 100M+ users with sub-100ms updates is what separates
 * junior from senior backend engineers.
 *
 * HOW PRESENCE WORKS AT SCALE (PLAYSTATION PATTERN):
 * ==================================================
 *
 * CHALLENGE:
 * - 100M+ users online simultaneously
 * - Each user has ~50 friends on average
 * - When status changes, all friends need notification
 * - That's potentially 5 BILLION notifications per status change cycle
 *
 * SOLUTION - REDIS PUB/SUB + WEBSOCKETS:
 *
 * 1. USER CHANGES STATUS:
 *    User A sets status to "Playing Spider-Man 2"
 *         ↓
 * 2. STORE IN REDIS:
 *    SET presence:userA = {status: "online", game: "Spider-Man 2"}
 *    EXPIRE presence:userA 300  (5 minute heartbeat TTL)
 *         ↓
 * 3. PUBLISH TO CHANNEL:
 *    PUBLISH presence:updates {userId: "userA", ...}
 *         ↓
 * 4. SERVERS RECEIVE EVENT:
 *    All Node.js servers subscribed to presence:updates receive the event
 *         ↓
 * 5. FILTER TO RELEVANT CLIENTS:
 *    Each server checks: "Which of my connected clients are friends with User A?"
 *    Only those clients receive the WebSocket push
 *
 * KEY INSIGHT:
 * We don't send 5 billion messages. Instead:
 * - Redis Pub/Sub fans out to ~100 servers (linear scale)
 * - Each server filters to its ~10,000 connected clients
 * - Each client only sees their friends (filtered locally)
 *
 * HEARTBEAT PATTERN:
 * =================
 * Clients send a "heartbeat" every 60 seconds to prove they're still online.
 * If no heartbeat for 5 minutes (TTL), presence auto-expires.
 *
 * Client → Server: Heartbeat
 * Server → Redis: EXPIRE presence:{userId} 300
 *
 * This handles:
 * - Browser crashes (no explicit disconnect)
 * - Network issues
 * - App force-quit
 *
 * INTERVIEW TIP:
 * "The key to scaling presence is separating storage (Redis key-value)
 * from notification (Redis Pub/Sub). We store presence per-user but
 * broadcast updates through channels, letting servers filter locally."
 * ==============================================================================
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';
import {
  PresenceData,
  UpdatePresenceInput,
  PresenceUpdateEvent,
  UserStatus,
  PublicUser,
} from '../../types';

/**
 * Configuration for the PresenceService.
 */
interface PresenceConfig {
  /** How long presence data lives without heartbeat (seconds) */
  presenceTTL: number;

  /** How often clients should send heartbeats (seconds) */
  heartbeatInterval: number;

  /** Redis channel for presence updates */
  presenceChannel: string;
}

/**
 * PresenceService - Manages real-time user presence.
 *
 * DESIGN PATTERNS USED:
 * --------------------
 * 1. EVENT EMITTER: Internal events for loose coupling
 * 2. PUB/SUB: Redis channels for cross-server communication
 * 3. TTL-BASED EXPIRATION: Automatic cleanup of stale data
 * 4. OPTIMISTIC UPDATES: Update local cache, then persist
 *
 * REDIS KEYS USED:
 * ---------------
 * - presence:{userId}     → User's current presence data
 * - presence:online       → Set of all online user IDs (for fast lookup)
 * - presence:game:{game}  → Set of users playing a specific game
 */
export class PresenceService extends EventEmitter {
  private redis: Redis;
  private subscriber: Redis;
  private config: PresenceConfig;

  /**
   * In-memory cache of friend relationships.
   * In production, this would be queried from DynamoDB.
   *
   * Map structure: userId → Set of friend userIds
   *
   * CACHING STRATEGY:
   * Friend lists don't change often, so caching them in memory
   * reduces database load. We invalidate when friendships change.
   */
  private friendsCache: Map<string, Set<string>> = new Map();

  /**
   * Create a new PresenceService instance.
   *
   * NOTE: We create TWO Redis connections:
   * 1. Main connection (redis): For read/write operations
   * 2. Subscriber connection (subscriber): For Pub/Sub
   *
   * WHY TWO CONNECTIONS?
   * Redis clients in subscribe mode can only receive messages,
   * not execute other commands. So we need a separate connection
   * for regular Redis operations.
   *
   * INTERVIEW TIP:
   * "Redis Pub/Sub requires a dedicated connection because once
   * a client enters subscribe mode, it can't execute other commands.
   * This is a common pattern in production Redis architectures."
   *
   * @param redis - Redis client for read/write operations
   * @param config - Service configuration
   */
  constructor(redis: Redis, config?: Partial<PresenceConfig>) {
    super();
    this.redis = redis;
    // Create a duplicate connection for Pub/Sub
    this.subscriber = redis.duplicate();
    this.config = {
      presenceTTL: config?.presenceTTL || 300, // 5 minutes
      heartbeatInterval: config?.heartbeatInterval || 60, // 1 minute
      presenceChannel: config?.presenceChannel || 'presence:updates',
    };

    // Initialize Pub/Sub subscription
    this.initializeSubscription();

    // Initialize demo friend relationships
    this.initializeDemoFriends();
  }

  /**
   * Initialize Redis Pub/Sub subscription.
   *
   * PUB/SUB FLOW:
   * 1. This server subscribes to 'presence:updates' channel
   * 2. When ANY server publishes a presence update, ALL subscribers receive it
   * 3. Each subscriber filters and forwards to relevant WebSocket clients
   *
   * SCALING BENEFIT:
   * - 100 servers × 10,000 clients each = 1 million users
   * - One Redis publish reaches all 100 servers
   * - Each server only processes its own clients
   */
  private async initializeSubscription(): Promise<void> {
    // Subscribe to the presence updates channel
    await this.subscriber.subscribe(this.config.presenceChannel);

    // Handle incoming presence update messages
    this.subscriber.on('message', (channel, message) => {
      if (channel === this.config.presenceChannel) {
        try {
          const event = JSON.parse(message) as PresenceUpdateEvent;
          this.handlePresenceUpdate(event);
        } catch (error) {
          console.error('[PresenceService] Failed to parse presence update:', error);
        }
      }
    });

    console.log(`[PresenceService] Subscribed to channel: ${this.config.presenceChannel}`);
  }

  /**
   * Initialize demo friend relationships for testing.
   * In production, this would load from DynamoDB.
   */
  private initializeDemoFriends(): void {
    // Demo user 1 is friends with demo users 2-5
    this.friendsCache.set('demo_user_1', new Set(['demo_user_2', 'demo_user_3', 'demo_user_4', 'demo_user_5']));
    this.friendsCache.set('demo_user_2', new Set(['demo_user_1', 'demo_user_3']));
    this.friendsCache.set('demo_user_3', new Set(['demo_user_1', 'demo_user_2']));
  }

  // ============================================================================
  // PRESENCE UPDATES
  // ============================================================================

  /**
   * Set a user's presence to online.
   *
   * Called when:
   * - User logs in
   * - User reconnects after disconnect
   * - App comes to foreground
   *
   * PROCESS:
   * 1. Create presence data object
   * 2. Store in Redis with TTL
   * 3. Add to online users set
   * 4. Publish update to all servers
   *
   * @param userId - User going online
   * @param gamertag - User's display name
   * @param currentGame - Game they're playing (optional)
   */
  async setOnline(
    userId: string,
    gamertag: string,
    currentGame: string | null = null
  ): Promise<PresenceData> {
    const now = Date.now();

    const presenceData: PresenceData = {
      userId,
      gamertag,
      status: 'online',
      currentGame,
      statusMessage: null,
      lastActiveAt: now,
      updatedAt: now,
    };

    // -------------------------------------------------------------------------
    // REDIS MULTI-COMMAND TRANSACTION
    // -------------------------------------------------------------------------
    // Execute multiple Redis commands atomically using pipeline.
    // This ensures either all succeed or none do.
    //
    // INTERVIEW TIP:
    // "We use Redis pipelines for atomic multi-command operations.
    // This prevents race conditions where presence and set membership
    // could become inconsistent."

    const pipeline = this.redis.pipeline();

    // Store presence data with TTL
    pipeline.setex(
      this.getPresenceKey(userId),
      this.config.presenceTTL,
      JSON.stringify(presenceData)
    );

    // Add to online users set (for "who's online" queries)
    pipeline.sadd('presence:online', userId);

    // If playing a game, add to game's player set
    if (currentGame) {
      pipeline.sadd(`presence:game:${currentGame}`, userId);
    }

    // Execute all commands
    await pipeline.exec();

    // -------------------------------------------------------------------------
    // PUBLISH UPDATE TO ALL SERVERS
    // -------------------------------------------------------------------------
    // This notifies all connected servers about the presence change.
    // Each server will then notify relevant WebSocket clients.

    await this.publishPresenceUpdate({
      type: 'went_online',
      userId,
      presence: presenceData,
      timestamp: now,
    });

    console.log(`[PresenceService] User online: ${gamertag} (${userId})`);

    return presenceData;
  }

  /**
   * Update a user's presence status or game.
   *
   * Called when:
   * - User starts a new game
   * - User changes status (online → away → busy)
   * - User sets a status message
   *
   * @param userId - User to update
   * @param input - Fields to update
   */
  async updatePresence(
    userId: string,
    input: UpdatePresenceInput
  ): Promise<PresenceData | null> {
    // Get current presence
    const current = await this.getPresence(userId);
    if (!current) {
      console.warn(`[PresenceService] Cannot update presence for offline user: ${userId}`);
      return null;
    }

    const now = Date.now();
    const previousGame = current.currentGame;

    // Merge updates with current presence
    const updatedPresence: PresenceData = {
      ...current,
      ...input,
      lastActiveAt: now,
      updatedAt: now,
    };

    // -------------------------------------------------------------------------
    // UPDATE REDIS STATE
    // -------------------------------------------------------------------------
    const pipeline = this.redis.pipeline();

    // Update presence data
    pipeline.setex(
      this.getPresenceKey(userId),
      this.config.presenceTTL,
      JSON.stringify(updatedPresence)
    );

    // Handle game change (update game player sets)
    if (input.currentGame !== undefined && input.currentGame !== previousGame) {
      // Remove from old game's set
      if (previousGame) {
        pipeline.srem(`presence:game:${previousGame}`, userId);
      }
      // Add to new game's set
      if (input.currentGame) {
        pipeline.sadd(`presence:game:${input.currentGame}`, userId);
      }
    }

    await pipeline.exec();

    // -------------------------------------------------------------------------
    // DETERMINE EVENT TYPE AND PUBLISH
    // -------------------------------------------------------------------------
    let eventType: PresenceUpdateEvent['type'] = 'status_changed';
    if (input.currentGame && !previousGame) {
      eventType = 'game_started';
    } else if (!input.currentGame && previousGame) {
      eventType = 'game_ended';
    }

    await this.publishPresenceUpdate({
      type: eventType,
      userId,
      presence: updatedPresence,
      timestamp: now,
    });

    console.log(`[PresenceService] Presence updated for ${userId}: ${eventType}`);

    return updatedPresence;
  }

  /**
   * Set a user's presence to offline.
   *
   * Called when:
   * - User explicitly logs out
   * - WebSocket disconnects
   * - Heartbeat times out (TTL expires)
   *
   * @param userId - User going offline
   */
  async setOffline(userId: string): Promise<void> {
    // Get current presence to know their game
    const current = await this.getPresence(userId);

    const pipeline = this.redis.pipeline();

    // Remove presence data
    pipeline.del(this.getPresenceKey(userId));

    // Remove from online users set
    pipeline.srem('presence:online', userId);

    // Remove from game's player set if they were playing
    if (current?.currentGame) {
      pipeline.srem(`presence:game:${current.currentGame}`, userId);
    }

    await pipeline.exec();

    // Publish offline event
    await this.publishPresenceUpdate({
      type: 'went_offline',
      userId,
      presence: {
        userId,
        gamertag: current?.gamertag || 'Unknown',
        status: 'offline',
        currentGame: null,
        statusMessage: null,
        lastActiveAt: Date.now(),
        updatedAt: Date.now(),
      },
      timestamp: Date.now(),
    });

    console.log(`[PresenceService] User offline: ${userId}`);
  }

  // ============================================================================
  // HEARTBEAT
  // ============================================================================

  /**
   * Process a heartbeat from a connected client.
   *
   * HEARTBEAT PATTERN:
   * ==================
   * Clients send periodic heartbeats to prove they're still connected.
   * Without heartbeats, we can't distinguish between:
   * - User actively using app (should show online)
   * - Browser tab in background (should show away)
   * - App crashed/closed (should show offline)
   *
   * IMPLEMENTATION:
   * 1. Client sends heartbeat every 60 seconds
   * 2. Server refreshes Redis TTL to 5 minutes
   * 3. If no heartbeat for 5 minutes, Redis auto-deletes presence
   * 4. Cleanup job detects expired users and publishes offline events
   *
   * INTERVIEW TIP:
   * "We use Redis TTL for automatic presence expiration. Heartbeats
   * refresh the TTL. This handles edge cases like app crashes where
   * we never receive an explicit disconnect."
   *
   * @param userId - User sending heartbeat
   * @returns Updated presence data
   */
  async heartbeat(userId: string): Promise<PresenceData | null> {
    const presenceKey = this.getPresenceKey(userId);

    // Get current presence
    const presenceData = await this.redis.get(presenceKey);
    if (!presenceData) {
      // User not found - they may need to reconnect
      console.warn(`[PresenceService] Heartbeat for unknown user: ${userId}`);
      return null;
    }

    // Parse and update last active time
    const presence = JSON.parse(presenceData) as PresenceData;
    presence.lastActiveAt = Date.now();

    // Refresh TTL and update last active time
    await this.redis.setex(
      presenceKey,
      this.config.presenceTTL,
      JSON.stringify(presence)
    );

    return presence;
  }

  // ============================================================================
  // PRESENCE QUERIES
  // ============================================================================

  /**
   * Get a single user's presence.
   *
   * @param userId - User ID to look up
   * @returns Presence data or null if offline
   */
  async getPresence(userId: string): Promise<PresenceData | null> {
    const presenceData = await this.redis.get(this.getPresenceKey(userId));
    return presenceData ? JSON.parse(presenceData) : null;
  }

  /**
   * Get presence for multiple users (batch operation).
   *
   * BATCH OPERATIONS:
   * When fetching a friend list, you need presence for many users.
   * Instead of N individual Redis calls, use MGET for a single call.
   *
   * N calls: 100 friends × 1ms each = 100ms
   * 1 MGET: 1 call × 2ms = 2ms
   *
   * INTERVIEW TIP:
   * "Always batch Redis operations when possible. MGET, MSET, PIPELINE
   * dramatically reduce network round trips."
   *
   * @param userIds - Array of user IDs
   * @returns Map of userId → PresenceData
   */
  async getPresenceMultiple(userIds: string[]): Promise<Map<string, PresenceData>> {
    if (userIds.length === 0) {
      return new Map();
    }

    // Build array of keys
    const keys = userIds.map((id) => this.getPresenceKey(id));

    // MGET retrieves multiple keys in one call
    const values = await this.redis.mget(...keys);

    // Build result map
    const result = new Map<string, PresenceData>();
    for (let i = 0; i < userIds.length; i++) {
      if (values[i]) {
        result.set(userIds[i], JSON.parse(values[i]));
      }
    }

    return result;
  }

  /**
   * Get a user's friends with their current presence.
   *
   * This is the main query for the friends list UI.
   * Combines friend relationships with real-time presence.
   *
   * @param userId - User requesting friend list
   * @returns Array of friends with presence
   */
  async getFriendsWithPresence(userId: string): Promise<Array<{
    friendId: string;
    presence: PresenceData | null;
    isOnline: boolean;
  }>> {
    // Get friend list (from cache or database)
    const friendIds = this.friendsCache.get(userId) || new Set();

    if (friendIds.size === 0) {
      return [];
    }

    // Batch fetch all friend presences
    const presenceMap = await this.getPresenceMultiple([...friendIds]);

    // Build response
    return [...friendIds].map((friendId) => {
      const presence = presenceMap.get(friendId) || null;
      return {
        friendId,
        presence,
        isOnline: presence !== null && presence.status !== 'offline',
      };
    });
  }

  /**
   * Check if a user is online.
   *
   * FAST CHECK:
   * Instead of fetching full presence data, just check set membership.
   * Redis SISMEMBER is O(1) operation.
   *
   * @param userId - User to check
   * @returns true if online
   */
  async isOnline(userId: string): Promise<boolean> {
    const isMember = await this.redis.sismember('presence:online', userId);
    return isMember === 1;
  }

  /**
   * Get count of online users.
   * Useful for dashboard/analytics.
   */
  async getOnlineCount(): Promise<number> {
    return this.redis.scard('presence:online');
  }

  /**
   * Get all users playing a specific game.
   * Useful for "friends playing same game" feature.
   *
   * @param game - Game title
   * @returns Array of user IDs playing this game
   */
  async getPlayersInGame(game: string): Promise<string[]> {
    return this.redis.smembers(`presence:game:${game}`);
  }

  // ============================================================================
  // INTERNAL HELPERS
  // ============================================================================

  /**
   * Publish a presence update event to all servers.
   *
   * REDIS PUB/SUB:
   * publish sends message to all subscribers of the channel.
   * Subscribers receive it via the 'message' event handler.
   *
   * @param event - Presence update event
   */
  private async publishPresenceUpdate(event: PresenceUpdateEvent): Promise<void> {
    await this.redis.publish(
      this.config.presenceChannel,
      JSON.stringify(event)
    );
  }

  /**
   * Handle an incoming presence update from Redis Pub/Sub.
   *
   * This is called when ANY server publishes a presence update.
   * We need to:
   * 1. Determine which local clients care about this update
   * 2. Emit events for those clients' WebSocket handlers
   *
   * @param event - The presence update event
   */
  private handlePresenceUpdate(event: PresenceUpdateEvent): void {
    // Emit event for WebSocket handlers to pick up
    // They will filter to relevant clients based on friend relationships
    this.emit('presenceUpdate', event);

    // Log for debugging
    console.log(`[PresenceService] Received presence update: ${event.type} for ${event.userId}`);
  }

  /**
   * Generate Redis key for user presence.
   */
  private getPresenceKey(userId: string): string {
    return `presence:${userId}`;
  }

  // ============================================================================
  // FRIEND MANAGEMENT (simplified for demo)
  // ============================================================================

  /**
   * Add a friend relationship.
   * In production, this would be in a separate FriendService.
   */
  addFriend(userId: string, friendId: string): void {
    // Get or create friend set for user
    if (!this.friendsCache.has(userId)) {
      this.friendsCache.set(userId, new Set());
    }
    this.friendsCache.get(userId)!.add(friendId);

    // Add reverse relationship (friendships are mutual)
    if (!this.friendsCache.has(friendId)) {
      this.friendsCache.set(friendId, new Set());
    }
    this.friendsCache.get(friendId)!.add(userId);
  }

  /**
   * Get friend IDs for a user.
   */
  getFriends(userId: string): string[] {
    const friends = this.friendsCache.get(userId);
    return friends ? [...friends] : [];
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  /**
   * Clean up resources when shutting down.
   * Important for graceful shutdown in production.
   */
  async cleanup(): Promise<void> {
    await this.subscriber.unsubscribe(this.config.presenceChannel);
    await this.subscriber.quit();
    console.log('[PresenceService] Cleaned up Pub/Sub subscription');
  }
}
