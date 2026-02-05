/**
 * ==============================================================================
 * PLAYSTATION NETWORK - USER PROFILE SERVICE
 * ==============================================================================
 *
 * This service manages extended user profiles, gaming statistics,
 * privacy settings, and trophy showcases - similar to PlayStation's
 * PSN Profile system.
 *
 * PROFILE DATA ARCHITECTURE:
 * ==========================
 *
 * USER DATA LAYERS:
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  LAYER 1: Core User (AuthService)                                       │
 * │  - id, gamertag, email, passwordHash, level, trophyCount               │
 * │  - Stored in DynamoDB/Redis                                             │
 * │  - Changes rarely                                                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *                                    │
 *                                    ▼
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  LAYER 2: Extended Profile (ProfileService)                             │
 * │  - bio, backgroundUrl, themeColor, region, languages                   │
 * │  - Privacy settings                                                     │
 * │  - Trophy showcase                                                      │
 * │  - Stored in Redis Hash                                                 │
 * │  - User-controlled, changes occasionally                               │
 * └─────────────────────────────────────────────────────────────────────────┘
 *                                    │
 *                                    ▼
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  LAYER 3: Statistics (Computed)                                         │
 * │  - Total playtime, trophy breakdown, game completion                   │
 * │  - Aggregated from GameService data                                    │
 * │  - Cached with TTL, recomputed periodically                            │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * PRIVACY MODEL:
 * ==============
 *
 * Each data type has visibility settings:
 * - public: Anyone can see
 * - friends: Only friends can see
 * - private: Only the user can see
 *
 * REDIS DATA STRUCTURES:
 * ======================
 *
 * Profile Data:
 * - Key: profile:user:{userId}
 * - Type: Hash
 * - Fields: bio, backgroundUrl, themeColor, region, etc.
 *
 * Privacy Settings:
 * - Key: profile:privacy:{userId}
 * - Type: Hash
 * - Fields: activityVisibility, libraryVisibility, etc.
 *
 * Trophy Showcase:
 * - Key: profile:showcase:{userId}
 * - Type: List (ordered)
 * - Values: Achievement IDs
 *
 * Stats Cache:
 * - Key: profile:stats:{userId}
 * - Type: Hash
 * - TTL: 5 minutes
 *
 * INTERVIEW TIP:
 * "User profiles have different access patterns than transactional data.
 * We separate profile data into layers: core (auth), extended (profile),
 * and computed (stats). This allows independent caching strategies and
 * privacy controls per data type."
 * ==============================================================================
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';
import {
  UserProfile,
  UserPrivacySettings,
  UserStats,
  TrophyShowcase,
  TrophyType,
  AchievementRarity,
} from '../../types';

/**
 * Service configuration.
 */
interface ProfileServiceConfig {
  /** Stats cache TTL in seconds */
  statsCacheTTLSeconds: number;

  /** Maximum showcase slots */
  maxShowcaseSlots: number;

  /** Key prefix for Redis */
  keyPrefix: string;
}

/**
 * Default privacy settings for new users.
 */
const DEFAULT_PRIVACY: UserPrivacySettings = {
  activityVisibility: 'friends',
  libraryVisibility: 'friends',
  trophyVisibility: 'public',
  friendRequestsFrom: 'anyone',
  gameInvitesFrom: 'friends',
  messagesFrom: 'friends',
  showOnlineStatus: true,
  showCurrentGame: true,
};

/**
 * Profile update input.
 */
interface UpdateProfileInput {
  backgroundUrl?: string;
  themeColor?: string;
  bio?: string;
  region?: string;
  languages?: string[];
}

/**
 * Privacy update input.
 */
type UpdatePrivacyInput = Partial<UserPrivacySettings>;

// ============================================================================
// PROFILE SERVICE IMPLEMENTATION
// ============================================================================

/**
 * ProfileService - Manages user profiles, stats, and privacy.
 */
export class ProfileService extends EventEmitter {
  private redis: Redis;
  private config: ProfileServiceConfig;

  constructor(redis: Redis, config?: Partial<ProfileServiceConfig>) {
    super();
    this.redis = redis;
    this.config = {
      statsCacheTTLSeconds: config?.statsCacheTTLSeconds || 300, // 5 minutes
      maxShowcaseSlots: config?.maxShowcaseSlots || 6,
      keyPrefix: config?.keyPrefix || 'profile:',
    };
  }

  // ============================================================================
  // PROFILE RETRIEVAL
  // ============================================================================

  /**
   * Get a user's full profile.
   *
   * PRIVACY CHECK FLOW:
   * 1. Get profile data
   * 2. Get privacy settings
   * 3. Check viewer's relationship to profile owner
   * 4. Filter data based on privacy settings
   *
   * @param userId - Profile owner
   * @param viewerId - User viewing the profile
   * @param isFriend - Whether viewer is a friend
   * @returns Filtered profile based on privacy
   */
  async getProfile(
    userId: string,
    viewerId: string,
    _isFriend: boolean
  ): Promise<UserProfile | null> {
    // Get profile data
    const profileData = await this.redis.hgetall(
      this.getProfileKey(userId)
    );

    // Get privacy settings
    const privacy = await this.getPrivacySettings(userId);

    // Get base user info (would come from AuthService)
    // For now, construct from profile data
    // Determine status based on privacy settings
    const showOnline = privacy.showOnlineStatus || viewerId === userId;
    const userStatus: 'online' | 'offline' = showOnline ? 'online' : 'offline';

    const user = {
      id: userId,
      gamertag: profileData.gamertag || `User_${userId.slice(-4)}`,
      avatar: profileData.avatar || '🎮',
      level: parseInt(profileData.level || '1'),
      trophyCount: parseInt(profileData.trophyCount || '0'),
      status: userStatus,
      currentGame: null,
      statusMessage: null,
    };

    return {
      user,
      memberSince: profileData.memberSince || new Date().toISOString(),
      backgroundUrl: profileData.backgroundUrl || undefined,
      themeColor: profileData.themeColor || undefined,
      bio: profileData.bio || undefined,
      region: profileData.region || undefined,
      languages: profileData.languages ? JSON.parse(profileData.languages) : [],
      privacy: viewerId === userId ? privacy : this.sanitizePrivacyForViewer(privacy),
    };
  }

  /**
   * Get profile for the owner (no privacy filtering).
   */
  async getOwnProfile(userId: string): Promise<UserProfile> {
    return this.getProfile(userId, userId, true) as Promise<UserProfile>;
  }

  /**
   * Update profile information.
   */
  async updateProfile(
    userId: string,
    updates: UpdateProfileInput
  ): Promise<UserProfile> {
    const profileKey = this.getProfileKey(userId);

    // Prepare updates
    const redisUpdates: Record<string, string> = {};

    if (updates.backgroundUrl !== undefined) {
      redisUpdates.backgroundUrl = updates.backgroundUrl;
    }
    if (updates.themeColor !== undefined) {
      redisUpdates.themeColor = updates.themeColor;
    }
    if (updates.bio !== undefined) {
      redisUpdates.bio = updates.bio;
    }
    if (updates.region !== undefined) {
      redisUpdates.region = updates.region;
    }
    if (updates.languages !== undefined) {
      redisUpdates.languages = JSON.stringify(updates.languages);
    }

    redisUpdates.updatedAt = new Date().toISOString();

    // Update in Redis
    await this.redis.hset(profileKey, redisUpdates);

    console.log(`[ProfileService] Updated profile for ${userId}`);

    return this.getOwnProfile(userId);
  }

  // ============================================================================
  // PRIVACY SETTINGS
  // ============================================================================

  /**
   * Get privacy settings for a user.
   */
  async getPrivacySettings(userId: string): Promise<UserPrivacySettings> {
    const data = await this.redis.hgetall(this.getPrivacyKey(userId));

    if (!data || Object.keys(data).length === 0) {
      // Return defaults for new users
      return { ...DEFAULT_PRIVACY };
    }

    return {
      activityVisibility: (data.activityVisibility as any) || DEFAULT_PRIVACY.activityVisibility,
      libraryVisibility: (data.libraryVisibility as any) || DEFAULT_PRIVACY.libraryVisibility,
      trophyVisibility: (data.trophyVisibility as any) || DEFAULT_PRIVACY.trophyVisibility,
      friendRequestsFrom: (data.friendRequestsFrom as any) || DEFAULT_PRIVACY.friendRequestsFrom,
      gameInvitesFrom: (data.gameInvitesFrom as any) || DEFAULT_PRIVACY.gameInvitesFrom,
      messagesFrom: (data.messagesFrom as any) || DEFAULT_PRIVACY.messagesFrom,
      showOnlineStatus: data.showOnlineStatus !== 'false',
      showCurrentGame: data.showCurrentGame !== 'false',
    };
  }

  /**
   * Update privacy settings.
   */
  async updatePrivacySettings(
    userId: string,
    updates: UpdatePrivacyInput
  ): Promise<UserPrivacySettings> {
    const privacyKey = this.getPrivacyKey(userId);
    const currentSettings = await this.getPrivacySettings(userId);

    // Merge updates with current settings
    const newSettings: UserPrivacySettings = {
      ...currentSettings,
      ...updates,
    };

    // Convert to Redis format
    const redisData: Record<string, string> = {
      activityVisibility: newSettings.activityVisibility,
      libraryVisibility: newSettings.libraryVisibility,
      trophyVisibility: newSettings.trophyVisibility,
      friendRequestsFrom: newSettings.friendRequestsFrom,
      gameInvitesFrom: newSettings.gameInvitesFrom,
      messagesFrom: newSettings.messagesFrom,
      showOnlineStatus: String(newSettings.showOnlineStatus),
      showCurrentGame: String(newSettings.showCurrentGame),
    };

    await this.redis.hset(privacyKey, redisData);

    console.log(`[ProfileService] Updated privacy for ${userId}`);

    return newSettings;
  }

  /**
   * Check if viewer can see a specific data type.
   */
  async canView(
    profileUserId: string,
    viewerId: string,
    dataType: 'activity' | 'library' | 'trophy',
    isFriend: boolean
  ): Promise<boolean> {
    // Owner can always see their own data
    if (profileUserId === viewerId) {
      return true;
    }

    const privacy = await this.getPrivacySettings(profileUserId);
    const settingKey = `${dataType}Visibility` as keyof UserPrivacySettings;
    const visibility = privacy[settingKey] as string;

    switch (visibility) {
      case 'public':
        return true;
      case 'friends':
        return isFriend;
      case 'private':
        return false;
      default:
        return false;
    }
  }

  /**
   * Sanitize privacy settings for non-owner viewers.
   * Hides some settings that shouldn't be visible to others.
   */
  private sanitizePrivacyForViewer(
    privacy: UserPrivacySettings
  ): UserPrivacySettings {
    return {
      ...privacy,
      // Hide who can send requests/messages from others
      friendRequestsFrom: 'anyone',
      gameInvitesFrom: 'anyone',
      messagesFrom: 'anyone',
    };
  }

  // ============================================================================
  // STATISTICS
  // ============================================================================

  /**
   * Get user statistics.
   *
   * CACHING STRATEGY:
   * Stats are expensive to compute (aggregate across all games).
   * We cache them with a short TTL and recompute when expired.
   *
   * @param userId - Profile owner
   * @param viewerId - User viewing
   * @param isFriend - Whether viewer is a friend
   * @returns User statistics
   */
  async getStats(
    userId: string,
    _viewerId: string,
    _isFriend: boolean
  ): Promise<UserStats> {
    // Check cache first
    const cached = await this.getCachedStats(userId);
    if (cached) {
      return cached;
    }

    // Compute fresh stats
    const stats = await this.computeStats(userId);

    // Cache the result
    await this.cacheStats(userId, stats);

    return stats;
  }

  /**
   * Get cached stats if available.
   */
  private async getCachedStats(userId: string): Promise<UserStats | null> {
    const data = await this.redis.hgetall(this.getStatsKey(userId));

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      totalGames: parseInt(data.totalGames || '0'),
      totalPlaytimeHours: parseFloat(data.totalPlaytimeHours || '0'),
      totalTrophies: parseInt(data.totalTrophies || '0'),
      trophies: {
        bronze: parseInt(data.trophiesBronze || '0'),
        silver: parseInt(data.trophiesSilver || '0'),
        gold: parseInt(data.trophiesGold || '0'),
        platinum: parseInt(data.trophiesPlatinum || '0'),
      },
      trophyLevel: parseInt(data.trophyLevel || '1'),
      trophyLevelProgress: parseFloat(data.trophyLevelProgress || '0'),
      rarestTrophy: data.rarestTrophy ? JSON.parse(data.rarestTrophy) : undefined,
      mostPlayedGame: data.mostPlayedGame ? JSON.parse(data.mostPlayedGame) : undefined,
      recentActivity: {
        gamesPlayedLast30Days: parseInt(data.recentGames || '0'),
        trophiesEarnedLast30Days: parseInt(data.recentTrophies || '0'),
        playtimeHoursLast30Days: parseFloat(data.recentPlaytime || '0'),
      },
      friendCount: parseInt(data.friendCount || '0'),
    };
  }

  /**
   * Compute stats from game data.
   *
   * In production, this would aggregate from GameService.
   * For demo, we generate plausible stats.
   */
  private async computeStats(_userId: string): Promise<UserStats> {
    // Demo stats - would aggregate from GameService in production
    const totalGames = Math.floor(Math.random() * 50) + 10;
    const totalPlaytimeHours = Math.floor(Math.random() * 500) + 50;

    // Random trophy distribution
    const bronze = Math.floor(Math.random() * 200) + 50;
    const silver = Math.floor(Math.random() * 100) + 20;
    const gold = Math.floor(Math.random() * 50) + 10;
    const platinum = Math.floor(Math.random() * 10) + 1;
    const totalTrophies = bronze + silver + gold + platinum;

    // Calculate trophy level (PSN formula approximation)
    const points = bronze * 15 + silver * 30 + gold * 90 + platinum * 180;
    const trophyLevel = Math.floor(Math.sqrt(points / 100)) + 1;
    const currentLevelPoints = (trophyLevel - 1) ** 2 * 100;
    const nextLevelPoints = trophyLevel ** 2 * 100;
    const trophyLevelProgress =
      ((points - currentLevelPoints) / (nextLevelPoints - currentLevelPoints)) * 100;

    return {
      totalGames,
      totalPlaytimeHours,
      totalTrophies,
      trophies: { bronze, silver, gold, platinum },
      trophyLevel,
      trophyLevelProgress: Math.min(100, trophyLevelProgress),
      rarestTrophy: {
        name: 'Legendary Champion',
        gameTitle: 'God of War Ragnarok',
        unlockPercentage: 0.3,
        unlockedAt: new Date(Date.now() - 86400000 * 30).toISOString(),
      },
      mostPlayedGame: {
        gameId: 'game_helldivers2',
        title: 'Helldivers 2',
        playtimeHours: Math.floor(Math.random() * 100) + 50,
      },
      recentActivity: {
        gamesPlayedLast30Days: Math.floor(Math.random() * 10) + 1,
        trophiesEarnedLast30Days: Math.floor(Math.random() * 30) + 5,
        playtimeHoursLast30Days: Math.floor(Math.random() * 50) + 10,
      },
      friendCount: Math.floor(Math.random() * 100) + 10,
    };
  }

  /**
   * Cache computed stats.
   */
  private async cacheStats(userId: string, stats: UserStats): Promise<void> {
    const statsKey = this.getStatsKey(userId);

    await this.redis.hset(statsKey, {
      totalGames: String(stats.totalGames),
      totalPlaytimeHours: String(stats.totalPlaytimeHours),
      totalTrophies: String(stats.totalTrophies),
      trophiesBronze: String(stats.trophies.bronze),
      trophiesSilver: String(stats.trophies.silver),
      trophiesGold: String(stats.trophies.gold),
      trophiesPlatinum: String(stats.trophies.platinum),
      trophyLevel: String(stats.trophyLevel),
      trophyLevelProgress: String(stats.trophyLevelProgress),
      rarestTrophy: JSON.stringify(stats.rarestTrophy),
      mostPlayedGame: JSON.stringify(stats.mostPlayedGame),
      recentGames: String(stats.recentActivity.gamesPlayedLast30Days),
      recentTrophies: String(stats.recentActivity.trophiesEarnedLast30Days),
      recentPlaytime: String(stats.recentActivity.playtimeHoursLast30Days),
      friendCount: String(stats.friendCount),
    });

    await this.redis.expire(statsKey, this.config.statsCacheTTLSeconds);
  }

  /**
   * Invalidate stats cache (call after trophy unlock, game played, etc.).
   */
  async invalidateStatsCache(userId: string): Promise<void> {
    await this.redis.del(this.getStatsKey(userId));
    console.log(`[ProfileService] Invalidated stats cache for ${userId}`);
  }

  // ============================================================================
  // TROPHY SHOWCASE
  // ============================================================================

  /**
   * Get user's trophy showcase.
   *
   * SHOWCASE FEATURE:
   * Users can feature up to 6 trophies on their profile.
   * Like PlayStation's "Featured Trophies".
   */
  async getTrophyShowcase(
    userId: string,
    viewerId: string,
    isFriend: boolean,
    privacy?: UserPrivacySettings
  ): Promise<TrophyShowcase> {
    // Check privacy
    const privacySettings = privacy || await this.getPrivacySettings(userId);

    if (privacySettings.trophyVisibility === 'private' && viewerId !== userId) {
      return { slots: [] };
    }

    if (
      privacySettings.trophyVisibility === 'friends' &&
      viewerId !== userId &&
      !isFriend
    ) {
      return { slots: [] };
    }

    // Get showcase data
    const showcaseData = await this.redis.lrange(
      this.getShowcaseKey(userId),
      0,
      this.config.maxShowcaseSlots - 1
    );

    const slots: TrophyShowcase['slots'] = [];

    for (let i = 0; i < this.config.maxShowcaseSlots; i++) {
      if (i < showcaseData.length && showcaseData[i]) {
        const slotData = JSON.parse(showcaseData[i]);
        slots.push({
          position: i,
          ...slotData,
        });
      } else {
        slots.push(null);
      }
    }

    return { slots };
  }

  /**
   * Update trophy showcase.
   *
   * @param userId - User updating their showcase
   * @param achievementIds - Ordered list of achievement IDs to feature
   */
  async updateTrophyShowcase(
    userId: string,
    achievements: Array<{
      achievementId: string;
      achievementName: string;
      gameId: string;
      gameTitle: string;
      trophyType: TrophyType;
      rarity: AchievementRarity;
      iconUrl: string;
      unlockedAt: string;
    }>
  ): Promise<TrophyShowcase> {
    const showcaseKey = this.getShowcaseKey(userId);

    // Limit to max slots
    const limitedAchievements = achievements.slice(0, this.config.maxShowcaseSlots);

    // Clear existing and set new
    await this.redis.del(showcaseKey);

    if (limitedAchievements.length > 0) {
      const items = limitedAchievements.map((a) => JSON.stringify(a));
      await this.redis.rpush(showcaseKey, ...items);
    }

    console.log(
      `[ProfileService] Updated showcase for ${userId} with ${limitedAchievements.length} items`
    );

    return this.getTrophyShowcase(userId, userId, true);
  }

  /**
   * Add a trophy to showcase.
   */
  async addToShowcase(
    userId: string,
    achievement: {
      achievementId: string;
      achievementName: string;
      gameId: string;
      gameTitle: string;
      trophyType: TrophyType;
      rarity: AchievementRarity;
      iconUrl: string;
      unlockedAt: string;
    }
  ): Promise<TrophyShowcase> {
    const showcaseKey = this.getShowcaseKey(userId);

    // Check current count
    const currentCount = await this.redis.llen(showcaseKey);
    if (currentCount >= this.config.maxShowcaseSlots) {
      throw new Error(`Showcase is full (max ${this.config.maxShowcaseSlots} slots)`);
    }

    // Add to showcase
    await this.redis.rpush(showcaseKey, JSON.stringify(achievement));

    return this.getTrophyShowcase(userId, userId, true);
  }

  /**
   * Remove a trophy from showcase.
   */
  async removeFromShowcase(
    userId: string,
    achievementId: string
  ): Promise<TrophyShowcase> {
    const showcaseKey = this.getShowcaseKey(userId);

    // Get current items
    const items = await this.redis.lrange(showcaseKey, 0, -1);

    // Filter out the achievement
    const filtered = items.filter((item) => {
      const data = JSON.parse(item);
      return data.achievementId !== achievementId;
    });

    // Clear and reset
    await this.redis.del(showcaseKey);
    if (filtered.length > 0) {
      await this.redis.rpush(showcaseKey, ...filtered);
    }

    return this.getTrophyShowcase(userId, userId, true);
  }

  // ============================================================================
  // KEY HELPERS
  // ============================================================================

  private getProfileKey(userId: string): string {
    return `${this.config.keyPrefix}user:${userId}`;
  }

  private getPrivacyKey(userId: string): string {
    return `${this.config.keyPrefix}privacy:${userId}`;
  }

  private getStatsKey(userId: string): string {
    return `${this.config.keyPrefix}stats:${userId}`;
  }

  private getShowcaseKey(userId: string): string {
    return `${this.config.keyPrefix}showcase:${userId}`;
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  async cleanup(): Promise<void> {
    console.log('[ProfileService] Cleaned up');
  }
}
