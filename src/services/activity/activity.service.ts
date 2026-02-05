/**
 * ==============================================================================
 * PLAYSTATION NETWORK - ACTIVITY FEED SERVICE
 * ==============================================================================
 *
 * This service manages the activity feed, similar to PlayStation's "What's New"
 * feature that shows friend activities like game sessions, trophies, etc.
 *
 * ACTIVITY FEED ARCHITECTURE:
 * ===========================
 *
 * FEED DISTRIBUTION STRATEGY: Fan-Out on Write
 *
 * When a user performs an action:
 * 1. Create activity record
 * 2. Push to all friends' feeds (fan-out)
 * 3. Publish real-time event
 *
 * WHY FAN-OUT ON WRITE?
 * - Read-heavy workload (users read feed constantly)
 * - Fewer friends per user (avg 100-200)
 * - Need for real-time updates
 *
 * ALTERNATIVE: Fan-Out on Read
 * - Pull from each friend's activity list at read time
 * - Better for users with many followers (celebrities)
 * - Higher read latency
 *
 * HYBRID APPROACH (Production):
 * - Fan-out on write for active users
 * - Lazy loading for inactive users
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                         ACTIVITY FLOW                                    │
 * │                                                                          │
 * │  User Action ──▶ Create Activity ──▶ Fan-Out to Friends ──▶ Pub/Sub    │
 * │                                                                          │
 * │  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                │
 * │  │  Friend 1   │     │  Friend 2   │     │  Friend N   │                │
 * │  │    Feed     │     │    Feed     │     │    Feed     │                │
 * │  └─────────────┘     └─────────────┘     └─────────────┘                │
 * │         │                  │                  │                          │
 * │         └──────────────────┼──────────────────┘                          │
 * │                            │                                             │
 * │                     ┌──────▼──────┐                                      │
 * │                     │  WebSocket  │                                      │
 * │                     │   Clients   │                                      │
 * │                     └─────────────┘                                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * REDIS DATA STRUCTURES:
 * ======================
 *
 * User's Activity Feed:
 * - Key: activity:feed:{userId}
 * - Type: Sorted Set (score = timestamp)
 * - Members: Activity IDs
 * - TTL: 7 days for inactive users
 *
 * Activity Data:
 * - Key: activity:data:{activityId}
 * - Type: Hash
 * - Fields: type, userId, title, gameId, etc.
 *
 * Activity Likes:
 * - Key: activity:likes:{activityId}
 * - Type: Set
 * - Members: User IDs who liked
 *
 * User's Own Activities (for profile):
 * - Key: activity:user:{userId}
 * - Type: Sorted Set
 * - Members: Activity IDs created by user
 *
 * INTERVIEW TIP:
 * "The activity feed uses fan-out on write for low-latency reads.
 * When a user unlocks a trophy, we write to all their friends' feeds
 * in parallel. This trades write amplification for read performance,
 * which is ideal for a read-heavy social feed."
 * ==============================================================================
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Activity, ActivityType } from '../../types';

/**
 * Service configuration.
 */
interface ActivityServiceConfig {
  /** Maximum activities per feed */
  maxFeedSize: number;

  /** Activity expiry in seconds (7 days) */
  activityTTLSeconds: number;

  /** Key prefix for Redis */
  keyPrefix: string;

  /** Maximum friends to fan-out to (for rate limiting) */
  maxFanOutSize: number;
}

/**
 * Input for creating a new activity.
 */
interface CreateActivityInput {
  type: ActivityType;
  userId: string;
  gamertag: string;
  avatar: string;
  title: string;
  description?: string;
  gameId?: string;
  gameTitle?: string;
  gameCoverUrl?: string;
  achievementId?: string;
  achievementName?: string;
  trophyType?: 'bronze' | 'silver' | 'gold' | 'platinum';
}

/**
 * Activity event for Pub/Sub.
 */
interface ActivityEvent {
  type: 'new_activity' | 'activity_liked' | 'activity_unliked';
  activity: Activity;
  toUserIds: string[];
  timestamp: string;
}

// ============================================================================
// ACTIVITY SERVICE IMPLEMENTATION
// ============================================================================

/**
 * ActivityService - Manages activity feeds and social interactions.
 *
 * DESIGN PATTERNS:
 * ----------------
 * 1. Fan-Out on Write: Distribute activities to friends at write time
 * 2. Observer Pattern: EventEmitter for real-time updates
 * 3. CQRS: Separate write (create) and read (get) paths
 */
export class ActivityService extends EventEmitter {
  private redis: Redis;
  private config: ActivityServiceConfig;

  /** Cache of user friend lists for fan-out */
  private friendsCache: Map<string, string[]> = new Map();

  constructor(redis: Redis, config?: Partial<ActivityServiceConfig>) {
    super();
    this.redis = redis;
    this.config = {
      maxFeedSize: config?.maxFeedSize || 500,
      activityTTLSeconds: config?.activityTTLSeconds || 604800, // 7 days
      keyPrefix: config?.keyPrefix || 'activity:',
      maxFanOutSize: config?.maxFanOutSize || 1000,
    };
  }

  // ============================================================================
  // ACTIVITY CREATION
  // ============================================================================

  /**
   * Create a new activity and fan-out to friends.
   *
   * FAN-OUT PROCESS:
   * 1. Create activity record
   * 2. Add to user's own activity list
   * 3. Get user's friend list
   * 4. Add to each friend's feed (parallel)
   * 5. Publish real-time event
   *
   * @param input - Activity data
   * @param friendIds - List of friend IDs to fan-out to
   * @returns Created activity
   */
  async createActivity(
    input: CreateActivityInput,
    friendIds: string[]
  ): Promise<Activity> {
    const now = Date.now();
    const activityId = `act_${uuidv4()}`;

    const activity: Activity = {
      id: activityId,
      type: input.type,
      userId: input.userId,
      gamertag: input.gamertag,
      avatar: input.avatar,
      title: input.title,
      description: input.description,
      gameId: input.gameId,
      gameTitle: input.gameTitle,
      gameCoverUrl: input.gameCoverUrl,
      achievementId: input.achievementId,
      achievementName: input.achievementName,
      trophyType: input.trophyType,
      createdAt: new Date(now).toISOString(),
      likeCount: 0,
      commentCount: 0,
      isLiked: false,
    };

    // -------------------------------------------------------------------------
    // STEP 1: Store activity data
    // -------------------------------------------------------------------------
    const activityKey = this.getActivityKey(activityId);
    await this.redis.hset(activityKey, activity as any);
    await this.redis.expire(activityKey, this.config.activityTTLSeconds);

    // -------------------------------------------------------------------------
    // STEP 2: Add to user's own activity list
    // -------------------------------------------------------------------------
    await this.redis.zadd(
      this.getUserActivitiesKey(input.userId),
      now,
      activityId
    );

    // Trim to max size
    await this.redis.zremrangebyrank(
      this.getUserActivitiesKey(input.userId),
      0,
      -(this.config.maxFeedSize + 1)
    );

    // -------------------------------------------------------------------------
    // STEP 3: Fan-out to friends' feeds
    // -------------------------------------------------------------------------
    // Limit fan-out size for rate limiting
    const targetFriends = friendIds.slice(0, this.config.maxFanOutSize);

    // Fan-out in parallel using pipeline
    const pipeline = this.redis.pipeline();

    for (const friendId of targetFriends) {
      // Add to friend's feed
      pipeline.zadd(this.getFeedKey(friendId), now, activityId);

      // Trim old activities
      pipeline.zremrangebyrank(
        this.getFeedKey(friendId),
        0,
        -(this.config.maxFeedSize + 1)
      );
    }

    await pipeline.exec();

    console.log(
      `[ActivityService] Created activity ${activityId} (${input.type}), ` +
      `fan-out to ${targetFriends.length} friends`
    );

    // -------------------------------------------------------------------------
    // STEP 4: Publish real-time event
    // -------------------------------------------------------------------------
    const event: ActivityEvent = {
      type: 'new_activity',
      activity,
      toUserIds: targetFriends,
      timestamp: activity.createdAt,
    };
    this.emit('activityEvent', event);

    return activity;
  }

  /**
   * Create activity for game session start.
   */
  async createGameStartActivity(
    userId: string,
    gamertag: string,
    avatar: string,
    gameId: string,
    gameTitle: string,
    gameCoverUrl: string,
    friendIds: string[]
  ): Promise<Activity> {
    return this.createActivity(
      {
        type: 'game_started',
        userId,
        gamertag,
        avatar,
        title: `Started playing ${gameTitle}`,
        gameId,
        gameTitle,
        gameCoverUrl,
      },
      friendIds
    );
  }

  /**
   * Create activity for achievement unlock.
   */
  async createAchievementActivity(
    userId: string,
    gamertag: string,
    avatar: string,
    gameId: string,
    gameTitle: string,
    achievementId: string,
    achievementName: string,
    trophyType: 'bronze' | 'silver' | 'gold' | 'platinum',
    friendIds: string[]
  ): Promise<Activity> {
    const trophyEmoji =
      trophyType === 'platinum' ? '🏆' :
      trophyType === 'gold' ? '🥇' :
      trophyType === 'silver' ? '🥈' : '🥉';

    return this.createActivity(
      {
        type: 'achievement_unlocked',
        userId,
        gamertag,
        avatar,
        title: `${trophyEmoji} Earned "${achievementName}"`,
        description: `In ${gameTitle}`,
        gameId,
        gameTitle,
        achievementId,
        achievementName,
        trophyType,
      },
      friendIds
    );
  }

  /**
   * Create activity for friend added.
   */
  async createFriendAddedActivity(
    userId: string,
    gamertag: string,
    avatar: string,
    _newFriendId: string,
    newFriendGamertag: string,
    friendIds: string[]
  ): Promise<Activity> {
    return this.createActivity(
      {
        type: 'friend_added',
        userId,
        gamertag,
        avatar,
        title: `Became friends with ${newFriendGamertag}`,
      },
      friendIds
    );
  }

  /**
   * Create activity for trophy milestone.
   */
  async createTrophyMilestoneActivity(
    userId: string,
    gamertag: string,
    avatar: string,
    milestone: number,
    friendIds: string[]
  ): Promise<Activity> {
    return this.createActivity(
      {
        type: 'trophy_milestone',
        userId,
        gamertag,
        avatar,
        title: `Reached ${milestone} trophies! 🎮`,
        description: 'Trophy collector extraordinaire',
      },
      friendIds
    );
  }

  // ============================================================================
  // FEED RETRIEVAL
  // ============================================================================

  /**
   * Get activity feed for a user.
   *
   * FEED RETRIEVAL:
   * 1. Get activity IDs from user's feed (sorted set)
   * 2. Batch fetch activity data
   * 3. Filter out expired/deleted activities
   * 4. Enrich with like status for current user
   *
   * @param userId - User requesting their feed
   * @param limit - Maximum activities to return
   * @param offset - Pagination offset
   * @returns Array of activities
   */
  async getFeed(
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<Activity[]> {
    // Get activity IDs from feed (newest first)
    const activityIds = await this.redis.zrevrange(
      this.getFeedKey(userId),
      offset,
      offset + limit - 1
    );

    if (activityIds.length === 0) {
      return [];
    }

    // Batch fetch activity data
    return this.getActivitiesByIds(activityIds, userId);
  }

  /**
   * Get activities created by a specific user.
   */
  async getUserActivities(
    userId: string,
    viewerId: string,
    limit: number = 20
  ): Promise<Activity[]> {
    const activityIds = await this.redis.zrevrange(
      this.getUserActivitiesKey(userId),
      0,
      limit - 1
    );

    if (activityIds.length === 0) {
      return [];
    }

    return this.getActivitiesByIds(activityIds, viewerId);
  }

  /**
   * Get a single activity by ID.
   */
  async getActivity(
    activityId: string,
    viewerId: string
  ): Promise<Activity | null> {
    const activities = await this.getActivitiesByIds([activityId], viewerId);
    return activities[0] || null;
  }

  /**
   * Batch fetch activities by IDs with like status.
   */
  private async getActivitiesByIds(
    activityIds: string[],
    viewerId: string
  ): Promise<Activity[]> {
    const pipeline = this.redis.pipeline();

    // Fetch all activity data
    for (const id of activityIds) {
      pipeline.hgetall(this.getActivityKey(id));
    }

    // Check if viewer has liked each activity
    for (const id of activityIds) {
      pipeline.sismember(this.getLikesKey(id), viewerId);
    }

    const results = await pipeline.exec();
    if (!results) return [];

    const activities: Activity[] = [];
    const halfLength = activityIds.length;

    for (let i = 0; i < halfLength; i++) {
      const dataResult = results[i];
      const likeResult = results[i + halfLength];

      if (!dataResult || !dataResult[1]) continue;

      const data = dataResult[1] as Record<string, string>;
      if (!data.id) continue;

      const isLiked = likeResult?.[1] === 1;

      activities.push({
        id: data.id,
        type: data.type as ActivityType,
        userId: data.userId,
        gamertag: data.gamertag,
        avatar: data.avatar,
        title: data.title,
        description: data.description || undefined,
        gameId: data.gameId || undefined,
        gameTitle: data.gameTitle || undefined,
        gameCoverUrl: data.gameCoverUrl || undefined,
        achievementId: data.achievementId || undefined,
        achievementName: data.achievementName || undefined,
        trophyType: data.trophyType as any || undefined,
        createdAt: data.createdAt,
        likeCount: parseInt(data.likeCount || '0'),
        commentCount: parseInt(data.commentCount || '0'),
        isLiked,
      });
    }

    return activities;
  }

  // ============================================================================
  // SOCIAL INTERACTIONS
  // ============================================================================

  /**
   * Like an activity.
   *
   * LIKE OPERATION:
   * 1. Add user to likes set
   * 2. Increment like count
   * 3. Emit event for notifications
   */
  async likeActivity(
    activityId: string,
    userId: string
  ): Promise<Activity | null> {
    const likesKey = this.getLikesKey(activityId);
    const activityKey = this.getActivityKey(activityId);

    // Check if activity exists
    const exists = await this.redis.exists(activityKey);
    if (!exists) {
      return null;
    }

    // Check if already liked
    const alreadyLiked = await this.redis.sismember(likesKey, userId);
    if (alreadyLiked) {
      return this.getActivity(activityId, userId);
    }

    // Add like and increment count
    await this.redis.sadd(likesKey, userId);
    await this.redis.hincrby(activityKey, 'likeCount', 1);

    // Get updated activity
    const activity = await this.getActivity(activityId, userId);

    if (activity) {
      // Emit event for activity owner notification
      const event: ActivityEvent = {
        type: 'activity_liked',
        activity,
        toUserIds: [activity.userId],
        timestamp: new Date().toISOString(),
      };
      this.emit('activityEvent', event);
    }

    console.log(`[ActivityService] User ${userId} liked activity ${activityId}`);

    return activity;
  }

  /**
   * Unlike an activity.
   */
  async unlikeActivity(
    activityId: string,
    userId: string
  ): Promise<Activity | null> {
    const likesKey = this.getLikesKey(activityId);
    const activityKey = this.getActivityKey(activityId);

    // Check if activity exists
    const exists = await this.redis.exists(activityKey);
    if (!exists) {
      return null;
    }

    // Check if actually liked
    const wasLiked = await this.redis.sismember(likesKey, userId);
    if (!wasLiked) {
      return this.getActivity(activityId, userId);
    }

    // Remove like and decrement count
    await this.redis.srem(likesKey, userId);
    await this.redis.hincrby(activityKey, 'likeCount', -1);

    console.log(`[ActivityService] User ${userId} unliked activity ${activityId}`);

    return this.getActivity(activityId, userId);
  }

  /**
   * Get users who liked an activity.
   */
  async getActivityLikes(activityId: string): Promise<string[]> {
    return this.redis.smembers(this.getLikesKey(activityId));
  }

  /**
   * Get like count for an activity.
   */
  async getLikeCount(activityId: string): Promise<number> {
    return this.redis.scard(this.getLikesKey(activityId));
  }

  // ============================================================================
  // FEED MANAGEMENT
  // ============================================================================

  /**
   * Add friends to cache for efficient fan-out.
   */
  setFriendsCache(userId: string, friendIds: string[]): void {
    this.friendsCache.set(userId, friendIds);
  }

  /**
   * Get friends from cache.
   */
  getFriendsFromCache(userId: string): string[] | undefined {
    return this.friendsCache.get(userId);
  }

  /**
   * Clear user's feed (useful for blocking).
   */
  async clearFeed(userId: string): Promise<void> {
    await this.redis.del(this.getFeedKey(userId));
  }

  /**
   * Remove activities from a specific user from feed.
   * Called when blocking someone.
   */
  async removeUserFromFeed(
    feedOwnerId: string,
    blockedUserId: string
  ): Promise<number> {
    // Get all activities in feed
    const activityIds = await this.redis.zrange(
      this.getFeedKey(feedOwnerId),
      0,
      -1
    );

    if (activityIds.length === 0) {
      return 0;
    }

    let removedCount = 0;

    // Check each activity and remove if from blocked user
    for (const activityId of activityIds) {
      const activityUserId = await this.redis.hget(
        this.getActivityKey(activityId),
        'userId'
      );

      if (activityUserId === blockedUserId) {
        await this.redis.zrem(this.getFeedKey(feedOwnerId), activityId);
        removedCount++;
      }
    }

    console.log(
      `[ActivityService] Removed ${removedCount} activities from ` +
      `${feedOwnerId}'s feed (blocked ${blockedUserId})`
    );

    return removedCount;
  }

  /**
   * Delete an activity.
   */
  async deleteActivity(activityId: string, userId: string): Promise<boolean> {
    // Verify ownership
    const activityUserId = await this.redis.hget(
      this.getActivityKey(activityId),
      'userId'
    );

    if (activityUserId !== userId) {
      return false;
    }

    // Delete activity data and likes
    await this.redis.del(this.getActivityKey(activityId));
    await this.redis.del(this.getLikesKey(activityId));

    // Remove from user's activities
    await this.redis.zrem(this.getUserActivitiesKey(userId), activityId);

    // Note: We don't remove from friends' feeds (expensive)
    // The feed retrieval handles missing activities gracefully

    console.log(`[ActivityService] Deleted activity ${activityId}`);

    return true;
  }

  // ============================================================================
  // AGGREGATION HELPERS
  // ============================================================================

  /**
   * Aggregate similar activities (e.g., "John and 3 others are playing...")
   *
   * ACTIVITY AGGREGATION:
   * Groups similar activities to reduce feed clutter.
   * E.g., "5 friends are playing Helldivers 2"
   *
   * This is typically done at read time for flexibility.
   */
  async getAggregatedFeed(
    userId: string,
    limit: number = 50
  ): Promise<Activity[]> {
    // Get raw feed
    const activities = await this.getFeed(userId, limit * 2);

    // Group by game_started activities by gameId
    const gameGroups = new Map<string, Activity[]>();
    const otherActivities: Activity[] = [];

    for (const activity of activities) {
      if (activity.type === 'game_started' && activity.gameId) {
        const existing = gameGroups.get(activity.gameId) || [];
        existing.push(activity);
        gameGroups.set(activity.gameId, existing);
      } else {
        otherActivities.push(activity);
      }
    }

    // Create aggregated activities for games with multiple players
    const aggregatedActivities: Activity[] = [];

    for (const [_gameId, gameActivities] of gameGroups.entries()) {
      if (gameActivities.length > 2) {
        // Create aggregated activity
        const first = gameActivities[0];
        const otherCount = gameActivities.length - 1;

        aggregatedActivities.push({
          ...first,
          title: `${first.gamertag} and ${otherCount} others are playing ${first.gameTitle}`,
          description: gameActivities.map(a => a.gamertag).join(', '),
        });
      } else {
        // Keep individual activities
        aggregatedActivities.push(...gameActivities);
      }
    }

    // Combine and sort by timestamp
    const allActivities = [...aggregatedActivities, ...otherActivities];
    allActivities.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return allActivities.slice(0, limit);
  }

  // ============================================================================
  // KEY HELPERS
  // ============================================================================

  private getFeedKey(userId: string): string {
    return `${this.config.keyPrefix}feed:${userId}`;
  }

  private getUserActivitiesKey(userId: string): string {
    return `${this.config.keyPrefix}user:${userId}`;
  }

  private getActivityKey(activityId: string): string {
    return `${this.config.keyPrefix}data:${activityId}`;
  }

  private getLikesKey(activityId: string): string {
    return `${this.config.keyPrefix}likes:${activityId}`;
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  async cleanup(): Promise<void> {
    console.log('[ActivityService] Cleaned up');
  }
}
