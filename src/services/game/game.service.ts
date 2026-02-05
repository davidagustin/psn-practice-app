/**
 * ==============================================================================
 * PLAYSTATION NETWORK - GAME SERVICE
 * ==============================================================================
 *
 * This service handles all game-related features similar to PlayStation's
 * game library, achievements, and play session tracking.
 *
 * GAME SYSTEM ARCHITECTURE:
 * =========================
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                         GAME DATA FLOW                                   │
 * │                                                                          │
 * │  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                │
 * │  │  Game DB    │────▶│ Game Cache  │────▶│   Clients   │                │
 * │  │ (DynamoDB)  │     │   (Redis)   │     │             │                │
 * │  └─────────────┘     └─────────────┘     └─────────────┘                │
 * │                                                                          │
 * │  ┌─────────────────────────────────────────────────────────────────┐    │
 * │  │                     USER GAME DATA                               │    │
 * │  │                                                                  │    │
 * │  │  Library ──▶ Games user owns                                     │    │
 * │  │  Achievements ──▶ Unlocked trophies per game                     │    │
 * │  │  Sessions ──▶ Active play sessions (who's playing what)         │    │
 * │  │  Stats ──▶ Playtime, completion %, last played                  │    │
 * │  └─────────────────────────────────────────────────────────────────┘    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * REDIS DATA STRUCTURES:
 * ======================
 *
 * Game Catalog:
 * - Key: game:{gameId}
 * - Type: Hash
 * - Fields: title, publisher, genre, releaseDate, coverUrl, etc.
 *
 * User's Game Library:
 * - Key: user:{userId}:games
 * - Type: Sorted Set (score = purchase date timestamp)
 * - Members: gameId values
 *
 * User's Achievements per Game:
 * - Key: user:{userId}:achievements:{gameId}
 * - Type: Set
 * - Members: achievementId values
 *
 * Active Play Sessions:
 * - Key: session:game:{gameId}
 * - Type: Hash
 * - Fields: {userId: sessionData}
 *
 * Game Invites:
 * - Key: user:{userId}:game_invites
 * - Type: Sorted Set (score = timestamp)
 *
 * INTERVIEW TIP:
 * "The game service demonstrates several key patterns:
 * 1. Two-tier caching (Redis + DynamoDB)
 * 2. Event sourcing for play sessions
 * 3. Achievement rarity calculations with aggregation
 * 4. Real-time game invites via Pub/Sub"
 * ==============================================================================
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Represents a game in the PlayStation catalog.
 *
 * This is the master record for a game, containing
 * metadata that's the same for all users.
 */
export interface Game {
  /** Unique game identifier */
  id: string;

  /** Game title */
  title: string;

  /** Publisher/developer name */
  publisher: string;

  /** Primary genre */
  genre: string;

  /** Additional genres/tags */
  tags: string[];

  /** Release date (ISO 8601) */
  releaseDate: string;

  /** Cover art URL */
  coverUrl: string;

  /** Background art URL */
  backgroundUrl: string;

  /** Short description */
  description: string;

  /** Average rating (1-5) */
  rating: number;

  /** Total number of ratings */
  ratingCount: number;

  /** Maximum players for multiplayer */
  maxPlayers: number;

  /** Supported platforms */
  platforms: string[];

  /** Total achievements available */
  totalAchievements: number;

  /** Estimated playtime in hours */
  estimatedPlaytime: number;
}

/**
 * Represents a user's relationship with a game.
 *
 * This tracks user-specific data like ownership,
 * playtime, and progress.
 */
export interface UserGame {
  /** User ID */
  userId: string;

  /** Game ID */
  gameId: string;

  /** Game details (denormalized for performance) */
  game: Game;

  /** When the user acquired this game */
  purchasedAt: string;

  /** Total playtime in minutes */
  playtimeMinutes: number;

  /** When the user last played */
  lastPlayedAt: string | null;

  /** Number of achievements unlocked */
  achievementsUnlocked: number;

  /** Completion percentage (achievements) */
  completionPercent: number;

  /** Whether currently playing */
  isPlaying: boolean;
}

/**
 * Represents a game achievement/trophy.
 *
 * ACHIEVEMENT RARITY SYSTEM (like PlayStation trophies):
 * - common: > 50% of players have this
 * - rare: 10-50% of players have this
 * - ultra_rare: 1-10% of players have this
 * - legendary: < 1% of players have this
 */
export interface Achievement {
  /** Unique achievement identifier */
  id: string;

  /** Game this achievement belongs to */
  gameId: string;

  /** Achievement name */
  name: string;

  /** Description of how to unlock */
  description: string;

  /** Icon URL */
  iconUrl: string;

  /** Trophy type (like PlayStation) */
  trophyType: 'bronze' | 'silver' | 'gold' | 'platinum';

  /** Rarity based on unlock percentage */
  rarity: 'common' | 'rare' | 'ultra_rare' | 'legendary';

  /** Percentage of players who have unlocked this */
  unlockPercentage: number;

  /** Points value */
  points: number;

  /** Whether this is a hidden/secret achievement */
  isHidden: boolean;
}

/**
 * Represents an unlocked achievement for a user.
 */
export interface UserAchievement {
  /** User who unlocked it */
  userId: string;

  /** The achievement */
  achievement: Achievement;

  /** When it was unlocked */
  unlockedAt: string;

  /** Screenshot taken at unlock (optional) */
  screenshotUrl?: string;
}

/**
 * Represents an active play session.
 *
 * PLAY SESSION TRACKING:
 * - Tracks who's playing what game in real-time
 * - Enables "join session" functionality
 * - Powers "friends playing" features
 *
 * INTERVIEW TIP:
 * "Sessions are stored in Redis with TTL for automatic cleanup.
 * If a client disconnects without explicitly ending the session,
 * it expires after the heartbeat timeout."
 */
export interface PlaySession {
  /** Unique session identifier */
  id: string;

  /** User playing */
  userId: string;

  /** User's gamertag */
  gamertag: string;

  /** Game being played */
  gameId: string;

  /** Game title (denormalized) */
  gameTitle: string;

  /** When the session started */
  startedAt: string;

  /** Last heartbeat timestamp */
  lastHeartbeatAt: string;

  /** Current activity (e.g., "Story Mode", "Online Match") */
  activity: string;

  /** Whether session is joinable */
  isJoinable: boolean;

  /** Current party size if multiplayer */
  partySize: number;

  /** Maximum party size */
  maxPartySize: number;

  /** Platform (PS5, PC, etc.) */
  platform: string;
}

/**
 * Represents a game invite from one user to another.
 */
export interface GameInvite {
  /** Unique invite identifier */
  id: string;

  /** User who sent the invite */
  fromUserId: string;

  /** Sender's gamertag */
  fromGamertag: string;

  /** User receiving the invite */
  toUserId: string;

  /** Game to join */
  gameId: string;

  /** Game title */
  gameTitle: string;

  /** Session to join */
  sessionId: string;

  /** When the invite was sent */
  createdAt: string;

  /** When the invite expires */
  expiresAt: string;

  /** Invite status */
  status: 'pending' | 'accepted' | 'declined' | 'expired';

  /** Optional message */
  message?: string;
}

/**
 * Game-related events for Pub/Sub.
 */
export type GameEventType =
  | 'session_started'
  | 'session_ended'
  | 'achievement_unlocked'
  | 'game_invite_received'
  | 'game_invite_accepted'
  | 'friend_started_game';

export interface GameEvent {
  type: GameEventType;
  userId: string;
  gamertag?: string;
  gameId?: string;
  gameTitle?: string;
  achievement?: Achievement;
  invite?: GameInvite;
  session?: PlaySession;
  timestamp: string;
}

/**
 * Service configuration.
 */
interface GameServiceConfig {
  /** Session timeout in seconds (default: 5 minutes) */
  sessionTimeoutSeconds: number;

  /** Invite expiry in seconds (default: 5 minutes) */
  inviteExpirySeconds: number;

  /** Key prefix for Redis */
  keyPrefix: string;
}

// ============================================================================
// GAME SERVICE IMPLEMENTATION
// ============================================================================

/**
 * GameService - Manages games, achievements, sessions, and invites.
 *
 * DESIGN PATTERNS:
 * ----------------
 * 1. Repository Pattern: Abstracts data access
 * 2. Event Sourcing: Track all game events for activity feed
 * 3. Observer Pattern: EventEmitter for real-time updates
 */
export class GameService extends EventEmitter {
  private redis: Redis;
  private subscriber: Redis;
  private config: GameServiceConfig;

  /** In-memory game catalog cache */
  private gameCache: Map<string, Game> = new Map();

  /** In-memory achievement catalog */
  private achievementCache: Map<string, Achievement[]> = new Map();

  constructor(redis: Redis, config?: Partial<GameServiceConfig>) {
    super();
    this.redis = redis;
    this.subscriber = redis.duplicate();
    this.config = {
      sessionTimeoutSeconds: config?.sessionTimeoutSeconds || 300,
      inviteExpirySeconds: config?.inviteExpirySeconds || 300,
      keyPrefix: config?.keyPrefix || 'game:',
    };

    // Initialize demo data
    this.initializeDemoData();

    // Set up session cleanup interval
    this.startSessionCleanup();
  }

  // ============================================================================
  // DEMO DATA INITIALIZATION
  // ============================================================================

  /**
   * Initialize demo games and achievements for testing.
   *
   * INTERVIEW TIP:
   * "In production, this data would come from a game catalog service
   * or DynamoDB. Demo data lets us test without external dependencies."
   */
  private initializeDemoData(): void {
    const games: Game[] = [
      {
        id: 'game_godofwar',
        title: 'God of War Ragnarok',
        publisher: 'Sony Interactive Entertainment',
        genre: 'Action-Adventure',
        tags: ['Action', 'Adventure', 'Norse Mythology', 'Story Rich'],
        releaseDate: '2022-11-09',
        coverUrl: 'https://example.com/gow-cover.jpg',
        backgroundUrl: 'https://example.com/gow-bg.jpg',
        description: 'Embark on an epic journey with Kratos and Atreus.',
        rating: 4.9,
        ratingCount: 125000,
        maxPlayers: 1,
        platforms: ['PS5', 'PS4', 'PC'],
        totalAchievements: 36,
        estimatedPlaytime: 40,
      },
      {
        id: 'game_spiderman2',
        title: 'Marvel\'s Spider-Man 2',
        publisher: 'Sony Interactive Entertainment',
        genre: 'Action-Adventure',
        tags: ['Action', 'Open World', 'Superhero', 'Marvel'],
        releaseDate: '2023-10-20',
        coverUrl: 'https://example.com/sm2-cover.jpg',
        backgroundUrl: 'https://example.com/sm2-bg.jpg',
        description: 'Peter Parker and Miles Morales return for an epic adventure.',
        rating: 4.8,
        ratingCount: 89000,
        maxPlayers: 1,
        platforms: ['PS5'],
        totalAchievements: 42,
        estimatedPlaytime: 25,
      },
      {
        id: 'game_helldivers2',
        title: 'Helldivers 2',
        publisher: 'PlayStation Publishing',
        genre: 'Third-Person Shooter',
        tags: ['Shooter', 'Co-op', 'Action', 'Multiplayer'],
        releaseDate: '2024-02-08',
        coverUrl: 'https://example.com/hd2-cover.jpg',
        backgroundUrl: 'https://example.com/hd2-bg.jpg',
        description: 'Spread managed democracy across the galaxy.',
        rating: 4.7,
        ratingCount: 156000,
        maxPlayers: 4,
        platforms: ['PS5', 'PC'],
        totalAchievements: 38,
        estimatedPlaytime: 50,
      },
      {
        id: 'game_ff7rebirth',
        title: 'Final Fantasy VII Rebirth',
        publisher: 'Square Enix',
        genre: 'RPG',
        tags: ['RPG', 'JRPG', 'Action', 'Story Rich'],
        releaseDate: '2024-02-29',
        coverUrl: 'https://example.com/ff7r-cover.jpg',
        backgroundUrl: 'https://example.com/ff7r-bg.jpg',
        description: 'Continue the epic remake of the legendary RPG.',
        rating: 4.9,
        ratingCount: 78000,
        maxPlayers: 1,
        platforms: ['PS5'],
        totalAchievements: 59,
        estimatedPlaytime: 80,
      },
      {
        id: 'game_gtaonline',
        title: 'GTA Online',
        publisher: 'Rockstar Games',
        genre: 'Action',
        tags: ['Action', 'Open World', 'Multiplayer', 'Crime'],
        releaseDate: '2013-10-01',
        coverUrl: 'https://example.com/gta-cover.jpg',
        backgroundUrl: 'https://example.com/gta-bg.jpg',
        description: 'The ever-evolving online experience.',
        rating: 4.2,
        ratingCount: 450000,
        maxPlayers: 30,
        platforms: ['PS5', 'PS4', 'Xbox', 'PC'],
        totalAchievements: 78,
        estimatedPlaytime: 500,
      },
    ];

    // Cache games
    for (const game of games) {
      this.gameCache.set(game.id, game);
    }

    // Create demo achievements for each game
    const trophyTypes: Array<'bronze' | 'silver' | 'gold' | 'platinum'> = [
      'bronze', 'silver', 'gold', 'platinum'
    ];
    const rarities: Array<'common' | 'rare' | 'ultra_rare' | 'legendary'> = [
      'common', 'rare', 'ultra_rare', 'legendary'
    ];

    for (const game of games) {
      const achievements: Achievement[] = [];
      const count = game.totalAchievements;

      for (let i = 0; i < count; i++) {
        const trophyType = i === count - 1
          ? 'platinum'
          : trophyTypes[Math.floor(Math.random() * 3)];

        const rarity = rarities[Math.floor(Math.random() * 4)];
        const unlockPercentage =
          rarity === 'legendary' ? Math.random() * 1 :
          rarity === 'ultra_rare' ? Math.random() * 9 + 1 :
          rarity === 'rare' ? Math.random() * 40 + 10 :
          Math.random() * 50 + 50;

        achievements.push({
          id: `ach_${game.id}_${i}`,
          gameId: game.id,
          name: `Achievement ${i + 1}`,
          description: `Complete objective ${i + 1} in ${game.title}`,
          iconUrl: 'https://example.com/trophy.png',
          trophyType,
          rarity,
          unlockPercentage: parseFloat(unlockPercentage.toFixed(1)),
          points: trophyType === 'platinum' ? 180 :
                  trophyType === 'gold' ? 90 :
                  trophyType === 'silver' ? 30 : 15,
          isHidden: Math.random() > 0.8,
        });
      }

      this.achievementCache.set(game.id, achievements);
    }

    console.log(`[GameService] Initialized ${games.length} demo games with achievements`);
  }

  // ============================================================================
  // GAME CATALOG OPERATIONS
  // ============================================================================

  /**
   * Get a game by ID.
   */
  async getGame(gameId: string): Promise<Game | null> {
    // Check cache first
    const cached = this.gameCache.get(gameId);
    if (cached) return cached;

    // In production: query DynamoDB
    // const result = await dynamodb.get({ TableName: 'Games', Key: { id: gameId } });
    // return result.Item as Game;

    return null;
  }

  /**
   * Get multiple games by IDs.
   *
   * BATCH FETCHING:
   * Uses Redis MGET for O(1) batch retrieval.
   * In production, use DynamoDB BatchGetItem.
   */
  async getGames(gameIds: string[]): Promise<Game[]> {
    const games: Game[] = [];
    for (const id of gameIds) {
      const game = await this.getGame(id);
      if (game) games.push(game);
    }
    return games;
  }

  /**
   * Search games by title or tags.
   */
  async searchGames(query: string, limit: number = 20): Promise<Game[]> {
    const queryLower = query.toLowerCase();
    const results: Game[] = [];

    for (const game of this.gameCache.values()) {
      if (
        game.title.toLowerCase().includes(queryLower) ||
        game.tags.some(tag => tag.toLowerCase().includes(queryLower)) ||
        game.genre.toLowerCase().includes(queryLower)
      ) {
        results.push(game);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  /**
   * Get popular games (by rating count).
   */
  async getPopularGames(limit: number = 10): Promise<Game[]> {
    const games = Array.from(this.gameCache.values());
    return games
      .sort((a, b) => b.ratingCount - a.ratingCount)
      .slice(0, limit);
  }

  /**
   * Get games by genre.
   */
  async getGamesByGenre(genre: string, limit: number = 20): Promise<Game[]> {
    const games = Array.from(this.gameCache.values());
    return games
      .filter(g => g.genre.toLowerCase() === genre.toLowerCase())
      .slice(0, limit);
  }

  // ============================================================================
  // USER GAME LIBRARY
  // ============================================================================

  /**
   * Add a game to user's library.
   *
   * REDIS STORAGE:
   * - Sorted set: user:{userId}:games with score = purchase timestamp
   * - Hash: user:{userId}:game:{gameId} for game-specific data
   */
  async addGameToLibrary(
    userId: string,
    gameId: string
  ): Promise<UserGame | null> {
    const game = await this.getGame(gameId);
    if (!game) {
      throw new Error(`Game not found: ${gameId}`);
    }

    const now = Date.now();
    const userGameKey = this.getUserGameKey(userId, gameId);

    // Check if already owned
    const existing = await this.redis.exists(userGameKey);
    if (existing) {
      return this.getUserGame(userId, gameId);
    }

    // Add to library sorted set
    await this.redis.zadd(
      this.getUserLibraryKey(userId),
      now,
      gameId
    );

    // Store user-game specific data
    const userData = {
      userId,
      gameId,
      purchasedAt: new Date(now).toISOString(),
      playtimeMinutes: 0,
      lastPlayedAt: null,
      achievementsUnlocked: 0,
    };

    await this.redis.hset(userGameKey, userData);

    console.log(`[GameService] Added ${game.title} to ${userId}'s library`);

    return {
      ...userData,
      game,
      completionPercent: 0,
      isPlaying: false,
      lastPlayedAt: null,
    };
  }

  /**
   * Get user's game library.
   *
   * PAGINATION:
   * Uses ZREVRANGE for efficient pagination of sorted set.
   * Returns newest games first.
   */
  async getUserLibrary(
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<UserGame[]> {
    const gameIds = await this.redis.zrevrange(
      this.getUserLibraryKey(userId),
      offset,
      offset + limit - 1
    );

    if (gameIds.length === 0) return [];

    const userGames: UserGame[] = [];
    for (const gameId of gameIds) {
      const userGame = await this.getUserGame(userId, gameId);
      if (userGame) userGames.push(userGame);
    }

    return userGames;
  }

  /**
   * Get specific user-game data.
   */
  async getUserGame(userId: string, gameId: string): Promise<UserGame | null> {
    const game = await this.getGame(gameId);
    if (!game) return null;

    const userGameKey = this.getUserGameKey(userId, gameId);
    const data = await this.redis.hgetall(userGameKey);

    if (!data || Object.keys(data).length === 0) return null;

    const achievementsUnlocked = parseInt(data.achievementsUnlocked || '0');
    const completionPercent = game.totalAchievements > 0
      ? (achievementsUnlocked / game.totalAchievements) * 100
      : 0;

    // Check if currently playing
    const session = await this.getActiveSession(userId);
    const isPlaying = session?.gameId === gameId;

    return {
      userId,
      gameId,
      game,
      purchasedAt: data.purchasedAt,
      playtimeMinutes: parseInt(data.playtimeMinutes || '0'),
      lastPlayedAt: data.lastPlayedAt || null,
      achievementsUnlocked,
      completionPercent: parseFloat(completionPercent.toFixed(1)),
      isPlaying,
    };
  }

  /**
   * Get count of games in user's library.
   */
  async getLibraryCount(userId: string): Promise<number> {
    return this.redis.zcard(this.getUserLibraryKey(userId));
  }

  /**
   * Check if user owns a game.
   */
  async ownsGame(userId: string, gameId: string): Promise<boolean> {
    const score = await this.redis.zscore(
      this.getUserLibraryKey(userId),
      gameId
    );
    return score !== null;
  }

  // ============================================================================
  // ACHIEVEMENTS / TROPHIES
  // ============================================================================

  /**
   * Get all achievements for a game.
   */
  async getGameAchievements(gameId: string): Promise<Achievement[]> {
    return this.achievementCache.get(gameId) || [];
  }

  /**
   * Get user's unlocked achievements for a game.
   */
  async getUserAchievements(
    userId: string,
    gameId: string
  ): Promise<UserAchievement[]> {
    const achievements = await this.getGameAchievements(gameId);
    if (achievements.length === 0) return [];

    const unlockedIds = await this.redis.smembers(
      this.getUserAchievementsKey(userId, gameId)
    );

    const unlockedSet = new Set(unlockedIds);
    const userAchievements: UserAchievement[] = [];

    for (const achievement of achievements) {
      if (unlockedSet.has(achievement.id)) {
        // Get unlock timestamp
        const unlockData = await this.redis.hget(
          `${this.config.keyPrefix}achievement_unlock:${userId}:${achievement.id}`,
          'unlockedAt'
        );

        userAchievements.push({
          userId,
          achievement,
          unlockedAt: unlockData || new Date().toISOString(),
        });
      }
    }

    return userAchievements;
  }

  /**
   * Unlock an achievement for a user.
   *
   * ACHIEVEMENT UNLOCK FLOW:
   * 1. Verify achievement exists
   * 2. Check not already unlocked
   * 3. Add to user's unlocked set
   * 4. Update user-game stats
   * 5. Emit event for activity feed and notifications
   */
  async unlockAchievement(
    userId: string,
    achievementId: string,
    gamertag: string
  ): Promise<UserAchievement | null> {
    // Find the achievement
    let achievement: Achievement | null = null;
    for (const [_gameId, achievements] of this.achievementCache.entries()) {
      const found = achievements.find(a => a.id === achievementId);
      if (found) {
        achievement = found;
        break;
      }
    }

    if (!achievement) {
      throw new Error(`Achievement not found: ${achievementId}`);
    }

    const userAchievementsKey = this.getUserAchievementsKey(
      userId,
      achievement.gameId
    );

    // Check if already unlocked
    const alreadyUnlocked = await this.redis.sismember(
      userAchievementsKey,
      achievementId
    );

    if (alreadyUnlocked) {
      console.log(`[GameService] Achievement ${achievementId} already unlocked for ${userId}`);
      return null;
    }

    const now = new Date().toISOString();

    // Add to unlocked set
    await this.redis.sadd(userAchievementsKey, achievementId);

    // Store unlock details
    await this.redis.hset(
      `${this.config.keyPrefix}achievement_unlock:${userId}:${achievementId}`,
      'unlockedAt', now
    );

    // Update user-game achievement count
    await this.redis.hincrby(
      this.getUserGameKey(userId, achievement.gameId),
      'achievementsUnlocked',
      1
    );

    console.log(`[GameService] ${gamertag} unlocked "${achievement.name}"`);

    // Emit event
    const event: GameEvent = {
      type: 'achievement_unlocked',
      userId,
      gamertag,
      gameId: achievement.gameId,
      gameTitle: (await this.getGame(achievement.gameId))?.title,
      achievement,
      timestamp: now,
    };
    this.emit('gameEvent', event);

    return {
      userId,
      achievement,
      unlockedAt: now,
    };
  }

  /**
   * Get user's trophy summary (counts by type).
   */
  async getTrophySummary(userId: string): Promise<{
    bronze: number;
    silver: number;
    gold: number;
    platinum: number;
    total: number;
  }> {
    const summary = { bronze: 0, silver: 0, gold: 0, platinum: 0, total: 0 };

    // Get all games in library
    const gameIds = await this.redis.zrange(
      this.getUserLibraryKey(userId),
      0,
      -1
    );

    for (const gameId of gameIds) {
      const userAchievements = await this.getUserAchievements(userId, gameId);
      for (const ua of userAchievements) {
        summary[ua.achievement.trophyType]++;
        summary.total++;
      }
    }

    return summary;
  }

  // ============================================================================
  // PLAY SESSIONS
  // ============================================================================

  /**
   * Start a play session.
   *
   * SESSION LIFECYCLE:
   * 1. Create session with unique ID
   * 2. Store in Redis with TTL
   * 3. Require heartbeat to keep alive
   * 4. End explicitly or expire automatically
   */
  async startSession(
    userId: string,
    gamertag: string,
    gameId: string,
    options?: {
      activity?: string;
      isJoinable?: boolean;
      maxPartySize?: number;
      platform?: string;
    }
  ): Promise<PlaySession> {
    const game = await this.getGame(gameId);
    if (!game) {
      throw new Error(`Game not found: ${gameId}`);
    }

    // End any existing session
    await this.endSession(userId);

    const now = new Date().toISOString();
    const session: PlaySession = {
      id: `session_${uuidv4()}`,
      userId,
      gamertag,
      gameId,
      gameTitle: game.title,
      startedAt: now,
      lastHeartbeatAt: now,
      activity: options?.activity || 'Playing',
      isJoinable: options?.isJoinable ?? (game.maxPlayers > 1),
      partySize: 1,
      maxPartySize: options?.maxPartySize || game.maxPlayers,
      platform: options?.platform || 'PS5',
    };

    // Store session
    const sessionKey = this.getSessionKey(userId);
    await this.redis.hset(sessionKey, session as any);
    await this.redis.expire(sessionKey, this.config.sessionTimeoutSeconds);

    // Track in game's active players
    await this.redis.sadd(
      this.getGamePlayersKey(gameId),
      userId
    );

    // Update last played timestamp
    await this.redis.hset(
      this.getUserGameKey(userId, gameId),
      'lastPlayedAt', now
    );

    console.log(`[GameService] ${gamertag} started playing ${game.title}`);

    // Emit event
    const event: GameEvent = {
      type: 'session_started',
      userId,
      gamertag,
      gameId,
      gameTitle: game.title,
      session,
      timestamp: now,
    };
    this.emit('gameEvent', event);

    return session;
  }

  /**
   * Send heartbeat to keep session alive.
   */
  async heartbeatSession(userId: string): Promise<PlaySession | null> {
    const sessionKey = this.getSessionKey(userId);
    const exists = await this.redis.exists(sessionKey);

    if (!exists) {
      return null;
    }

    const now = new Date().toISOString();
    await this.redis.hset(sessionKey, 'lastHeartbeatAt', now);
    await this.redis.expire(sessionKey, this.config.sessionTimeoutSeconds);

    return this.getActiveSession(userId);
  }

  /**
   * Update session activity.
   */
  async updateSessionActivity(
    userId: string,
    activity: string,
    options?: {
      isJoinable?: boolean;
      partySize?: number;
    }
  ): Promise<PlaySession | null> {
    const sessionKey = this.getSessionKey(userId);
    const exists = await this.redis.exists(sessionKey);

    if (!exists) {
      return null;
    }

    const updates: Record<string, string> = {
      activity,
      lastHeartbeatAt: new Date().toISOString(),
    };

    if (options?.isJoinable !== undefined) {
      updates.isJoinable = String(options.isJoinable);
    }

    if (options?.partySize !== undefined) {
      updates.partySize = String(options.partySize);
    }

    await this.redis.hset(sessionKey, updates);
    await this.redis.expire(sessionKey, this.config.sessionTimeoutSeconds);

    return this.getActiveSession(userId);
  }

  /**
   * End a play session.
   */
  async endSession(userId: string): Promise<boolean> {
    const session = await this.getActiveSession(userId);
    if (!session) {
      return false;
    }

    const sessionKey = this.getSessionKey(userId);

    // Calculate playtime
    const startTime = new Date(session.startedAt).getTime();
    const endTime = Date.now();
    const playtimeMinutes = Math.floor((endTime - startTime) / 60000);

    // Update total playtime
    await this.redis.hincrby(
      this.getUserGameKey(userId, session.gameId),
      'playtimeMinutes',
      playtimeMinutes
    );

    // Remove from game's active players
    await this.redis.srem(
      this.getGamePlayersKey(session.gameId),
      userId
    );

    // Delete session
    await this.redis.del(sessionKey);

    console.log(`[GameService] ${session.gamertag} stopped playing ${session.gameTitle} (${playtimeMinutes} min)`);

    // Emit event
    const event: GameEvent = {
      type: 'session_ended',
      userId,
      gamertag: session.gamertag,
      gameId: session.gameId,
      gameTitle: session.gameTitle,
      session,
      timestamp: new Date().toISOString(),
    };
    this.emit('gameEvent', event);

    return true;
  }

  /**
   * Get user's active session.
   */
  async getActiveSession(userId: string): Promise<PlaySession | null> {
    const sessionKey = this.getSessionKey(userId);
    const data = await this.redis.hgetall(sessionKey);

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      id: data.id,
      userId: data.userId,
      gamertag: data.gamertag,
      gameId: data.gameId,
      gameTitle: data.gameTitle,
      startedAt: data.startedAt,
      lastHeartbeatAt: data.lastHeartbeatAt,
      activity: data.activity,
      isJoinable: data.isJoinable === 'true',
      partySize: parseInt(data.partySize || '1'),
      maxPartySize: parseInt(data.maxPartySize || '1'),
      platform: data.platform,
    };
  }

  /**
   * Get users currently playing a specific game.
   */
  async getPlayersInGame(gameId: string): Promise<string[]> {
    return this.redis.smembers(this.getGamePlayersKey(gameId));
  }

  /**
   * Get joinable sessions for a game.
   */
  async getJoinableSessions(gameId: string): Promise<PlaySession[]> {
    const playerIds = await this.getPlayersInGame(gameId);
    const sessions: PlaySession[] = [];

    for (const userId of playerIds) {
      const session = await this.getActiveSession(userId);
      if (session && session.isJoinable && session.partySize < session.maxPartySize) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  // ============================================================================
  // GAME INVITES
  // ============================================================================

  /**
   * Send a game invite to another user.
   */
  async sendGameInvite(
    fromUserId: string,
    fromGamertag: string,
    toUserId: string,
    sessionId: string,
    message?: string
  ): Promise<GameInvite> {
    // Get the sender's session
    const session = await this.getActiveSession(fromUserId);
    if (!session || session.id !== sessionId) {
      throw new Error('Session not found or does not match');
    }

    if (!session.isJoinable) {
      throw new Error('Session is not joinable');
    }

    if (session.partySize >= session.maxPartySize) {
      throw new Error('Session is full');
    }

    const now = Date.now();
    const expiresAt = new Date(now + this.config.inviteExpirySeconds * 1000);

    const invite: GameInvite = {
      id: `invite_${uuidv4()}`,
      fromUserId,
      fromGamertag,
      toUserId,
      gameId: session.gameId,
      gameTitle: session.gameTitle,
      sessionId,
      createdAt: new Date(now).toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'pending',
      message,
    };

    // Store invite
    const inviteKey = this.getInviteKey(invite.id);
    await this.redis.hset(inviteKey, invite as any);
    await this.redis.expire(inviteKey, this.config.inviteExpirySeconds);

    // Add to recipient's invite list
    await this.redis.zadd(
      this.getUserInvitesKey(toUserId),
      now,
      invite.id
    );

    console.log(`[GameService] ${fromGamertag} invited user to ${session.gameTitle}`);

    // Emit event
    const event: GameEvent = {
      type: 'game_invite_received',
      userId: toUserId,
      invite,
      timestamp: invite.createdAt,
    };
    this.emit('gameEvent', event);

    return invite;
  }

  /**
   * Get pending invites for a user.
   */
  async getPendingInvites(userId: string): Promise<GameInvite[]> {
    // Clean up expired invites first
    const now = Date.now();
    await this.redis.zremrangebyscore(
      this.getUserInvitesKey(userId),
      0,
      now - this.config.inviteExpirySeconds * 1000
    );

    const inviteIds = await this.redis.zrevrange(
      this.getUserInvitesKey(userId),
      0,
      -1
    );

    const invites: GameInvite[] = [];
    for (const inviteId of inviteIds) {
      const data = await this.redis.hgetall(this.getInviteKey(inviteId));
      if (data && Object.keys(data).length > 0 && data.status === 'pending') {
        invites.push(data as unknown as GameInvite);
      }
    }

    return invites;
  }

  /**
   * Accept a game invite.
   */
  async acceptInvite(userId: string, inviteId: string): Promise<GameInvite> {
    const inviteKey = this.getInviteKey(inviteId);
    const invite = await this.redis.hgetall(inviteKey) as unknown as GameInvite;

    if (!invite || !invite.id) {
      throw new Error('Invite not found');
    }

    if (invite.toUserId !== userId) {
      throw new Error('This invite is not for you');
    }

    if (invite.status !== 'pending') {
      throw new Error(`Invite is already ${invite.status}`);
    }

    // Check if session still exists
    const session = await this.getActiveSession(invite.fromUserId);
    if (!session || session.id !== invite.sessionId) {
      await this.redis.hset(inviteKey, 'status', 'expired');
      throw new Error('Session no longer available');
    }

    // Update invite status
    await this.redis.hset(inviteKey, 'status', 'accepted');

    // Remove from user's invite list
    await this.redis.zrem(this.getUserInvitesKey(userId), inviteId);

    // Emit event
    const event: GameEvent = {
      type: 'game_invite_accepted',
      userId: invite.fromUserId,
      invite: { ...invite, status: 'accepted' },
      timestamp: new Date().toISOString(),
    };
    this.emit('gameEvent', event);

    return { ...invite, status: 'accepted' };
  }

  /**
   * Decline a game invite.
   */
  async declineInvite(userId: string, inviteId: string): Promise<GameInvite> {
    const inviteKey = this.getInviteKey(inviteId);
    const invite = await this.redis.hgetall(inviteKey) as unknown as GameInvite;

    if (!invite || !invite.id) {
      throw new Error('Invite not found');
    }

    if (invite.toUserId !== userId) {
      throw new Error('This invite is not for you');
    }

    await this.redis.hset(inviteKey, 'status', 'declined');
    await this.redis.zrem(this.getUserInvitesKey(userId), inviteId);

    return { ...invite, status: 'declined' };
  }

  // ============================================================================
  // SESSION CLEANUP
  // ============================================================================

  /**
   * Start background cleanup of expired sessions.
   */
  private startSessionCleanup(): void {
    // Run every minute
    setInterval(async () => {
      try {
        await this.cleanupExpiredSessions();
      } catch (error) {
        console.error('[GameService] Session cleanup error:', error);
      }
    }, 60000);
  }

  /**
   * Clean up expired sessions.
   * Redis TTL handles most of this, but we need to clean up
   * the game player sets.
   */
  private async cleanupExpiredSessions(): Promise<void> {
    // For each game with active players
    const gameIds = Array.from(this.gameCache.keys());

    for (const gameId of gameIds) {
      const playerIds = await this.redis.smembers(
        this.getGamePlayersKey(gameId)
      );

      for (const userId of playerIds) {
        const session = await this.getActiveSession(userId);
        if (!session) {
          // Session expired, remove from game players
          await this.redis.srem(this.getGamePlayersKey(gameId), userId);
        }
      }
    }
  }

  // ============================================================================
  // KEY HELPERS
  // ============================================================================

  private getUserLibraryKey(userId: string): string {
    return `${this.config.keyPrefix}user:${userId}:games`;
  }

  private getUserGameKey(userId: string, gameId: string): string {
    return `${this.config.keyPrefix}user:${userId}:game:${gameId}`;
  }

  private getUserAchievementsKey(userId: string, gameId: string): string {
    return `${this.config.keyPrefix}user:${userId}:achievements:${gameId}`;
  }

  private getSessionKey(userId: string): string {
    return `${this.config.keyPrefix}session:${userId}`;
  }

  private getGamePlayersKey(gameId: string): string {
    return `${this.config.keyPrefix}players:${gameId}`;
  }

  private getInviteKey(inviteId: string): string {
    return `${this.config.keyPrefix}invite:${inviteId}`;
  }

  private getUserInvitesKey(userId: string): string {
    return `${this.config.keyPrefix}user:${userId}:invites`;
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  async cleanup(): Promise<void> {
    await this.subscriber.quit();
    console.log('[GameService] Cleaned up');
  }
}
