/**
 * ==============================================================================
 * PLAYSTATION NETWORK - TYPE DEFINITIONS
 * ==============================================================================
 *
 * This file contains all TypeScript interfaces and types used throughout
 * the application. Well-defined types are crucial for:
 *
 * 1. DEVELOPER EXPERIENCE: IDE autocomplete and error detection
 * 2. DOCUMENTATION: Types serve as living documentation
 * 3. REFACTORING SAFETY: TypeScript catches breaking changes
 * 4. TEAM COLLABORATION: Everyone understands data shapes
 *
 * INTERVIEW TIP:
 * "Strong typing with TypeScript helps us catch bugs at compile time
 * rather than runtime, which is especially important for real-time
 * systems where errors can cascade quickly."
 * ==============================================================================
 */

// ==============================================================================
// USER TYPES
// ==============================================================================

/**
 * Represents the possible online statuses for a PSN user.
 *
 * DESIGN DECISION:
 * Using a union type instead of an enum because:
 * - TypeScript unions are simpler and have better type inference
 * - Enums add runtime overhead (they compile to objects)
 * - GraphQL schema can easily map to string literals
 *
 * STATUS MEANINGS:
 * - 'online': User is active and available
 * - 'away': User is logged in but idle (no input for X minutes)
 * - 'busy': User is in a game session, do not disturb
 * - 'offline': User is not connected
 * - 'invisible': User appears offline but can see others (privacy feature)
 */
export type UserStatus = 'online' | 'away' | 'busy' | 'offline' | 'invisible';

/**
 * Core user profile as stored in the database.
 *
 * This is the CANONICAL user representation - all other user-related
 * types derive from or relate to this interface.
 *
 * DATABASE MAPPING (DynamoDB):
 * - PK (Partition Key): "USER#{id}"
 * - SK (Sort Key): "PROFILE"
 *
 * INTERVIEW TIP:
 * "We separate the user profile from session data because profiles
 * are relatively static (change rarely) while session data is highly
 * dynamic (changes every request). This allows different caching strategies."
 */
export interface User {
  /** Unique identifier, typically a UUID */
  id: string;

  /** Display name shown to other players (must be unique) */
  gamertag: string;

  /** Hashed password - NEVER store plain text passwords */
  passwordHash: string;

  /** Email for account recovery and notifications */
  email: string;

  /** URL or identifier for the user's avatar image */
  avatar: string;

  /** Experience level (like PlayStation's profile level) */
  level: number;

  /** Total trophies earned across all games */
  trophyCount: number;

  /** Current online status */
  status: UserStatus;

  /** Game currently being played (null if not in a game) */
  currentGame: string | null;

  /** Brief status message set by the user */
  statusMessage: string | null;

  /** ISO 8601 timestamp of account creation */
  createdAt: string;

  /** ISO 8601 timestamp of last profile update */
  updatedAt: string;

  /** ISO 8601 timestamp of last login */
  lastLoginAt: string;
}

/**
 * User data safe to expose publicly (excludes sensitive fields).
 *
 * SECURITY PATTERN:
 * Always create a "public" version of sensitive types that excludes:
 * - Passwords (obviously)
 * - Email (privacy)
 * - Internal IDs that could be exploited
 *
 * This type is used for:
 * - Friend lists
 * - Search results
 * - Public profiles
 */
export interface PublicUser {
  id: string;
  gamertag: string;
  avatar: string;
  level: number;
  trophyCount: number;
  status: UserStatus;
  currentGame: string | null;
  statusMessage: string | null;
}

/**
 * Data required to create a new user account.
 *
 * INPUT VALIDATION TIP:
 * Always validate input at the API boundary:
 * - gamertag: 3-16 characters, alphanumeric + underscores
 * - email: Valid email format
 * - password: Minimum 8 characters, complexity requirements
 */
export interface CreateUserInput {
  gamertag: string;
  email: string;
  password: string;
}

/**
 * Data that can be updated on a user profile.
 *
 * Using Partial<> makes all fields optional, which is perfect
 * for update operations where you only send changed fields.
 */
export interface UpdateUserInput {
  avatar?: string;
  statusMessage?: string;
  status?: UserStatus;
}

// ==============================================================================
// AUTHENTICATION TYPES
// ==============================================================================

/**
 * JWT token payload - the data encoded inside the token.
 *
 * JWT STRUCTURE:
 * A JWT has three parts: Header.Payload.Signature
 *
 * WHAT WE STORE IN PAYLOAD:
 * - userId: To identify who the token belongs to
 * - gamertag: For quick access without database lookup
 * - iat: Issued at (automatic)
 * - exp: Expiration time (automatic)
 *
 * INTERVIEW TIP:
 * "We keep JWT payloads small because they're sent with every request.
 * Only include data that's needed for authorization decisions."
 */
export interface JWTPayload {
  /** User's unique identifier */
  userId: string;

  /** User's display name (for convenience) */
  gamertag: string;

  /** Issued at timestamp (added automatically by jsonwebtoken) */
  iat?: number;

  /** Expiration timestamp (added automatically by jsonwebtoken) */
  exp?: number;
}

/**
 * Session data stored in Redis for active users.
 *
 * WHY REDIS FOR SESSIONS?
 * 1. Speed: Sub-millisecond reads/writes
 * 2. TTL: Automatic expiration
 * 3. Atomic operations: Safe concurrent access
 * 4. Pub/Sub: Can notify on session changes
 *
 * REDIS KEY PATTERN: "session:{userId}"
 * TTL: 1 hour (configurable via SESSION_TTL)
 */
export interface UserSession {
  /** User's unique identifier */
  userId: string;

  /** User's display name */
  gamertag: string;

  /** Current online status */
  status: UserStatus;

  /** Device/client information */
  deviceInfo: string;

  /** IP address of the session (for security) */
  ipAddress: string;

  /** When this session was created */
  createdAt: string;

  /** When the user last made a request */
  lastActivityAt: string;
}

/**
 * Response returned after successful authentication.
 */
export interface AuthResponse {
  /** JWT token for subsequent requests */
  token: string;

  /** Public user profile */
  user: PublicUser;

  /** When the token expires (ISO 8601) */
  expiresAt: string;
}

/**
 * Login credentials input.
 */
export interface LoginInput {
  /** Can be gamertag or email */
  identifier: string;

  /** Plain text password (will be compared against hash) */
  password: string;
}

// ==============================================================================
// PRESENCE TYPES
// ==============================================================================

/**
 * Real-time presence data for a user.
 *
 * PRESENCE SYSTEM OVERVIEW:
 * The presence system tracks who's online, what they're playing,
 * and notifies friends in real-time.
 *
 * DATA FLOW:
 * 1. User logs in → Presence set to "online" in Redis
 * 2. User starts game → Presence updated with game title
 * 3. Friends subscribed via GraphQL → Get real-time updates via WebSocket
 * 4. User goes idle → Presence changes to "away"
 * 5. User closes app → Presence changes to "offline"
 *
 * REDIS KEY PATTERN: "presence:{userId}"
 * TTL: 5 minutes (requires heartbeat to stay online)
 */
export interface PresenceData {
  /** User's unique identifier */
  userId: string;

  /** User's display name */
  gamertag: string;

  /** Current status */
  status: UserStatus;

  /** Game currently being played */
  currentGame: string | null;

  /** Custom status message */
  statusMessage: string | null;

  /** Unix timestamp of last activity */
  lastActiveAt: number;

  /** Unix timestamp when presence was last updated */
  updatedAt: number;
}

/**
 * Input for updating user's presence.
 */
export interface UpdatePresenceInput {
  status?: UserStatus;
  currentGame?: string | null;
  statusMessage?: string | null;
}

/**
 * Presence update event published via Redis Pub/Sub.
 *
 * REAL-TIME FLOW:
 * 1. User changes presence
 * 2. PresenceService publishes to Redis channel "presence:updates"
 * 3. All connected servers receive the event
 * 4. Servers push to relevant WebSocket clients
 */
export interface PresenceUpdateEvent {
  /** Type of presence change */
  type: 'status_changed' | 'game_started' | 'game_ended' | 'went_online' | 'went_offline';

  /** User whose presence changed */
  userId: string;

  /** Updated presence data */
  presence: PresenceData;

  /** When this event occurred */
  timestamp: number;
}

// ==============================================================================
// FRIEND TYPES
// ==============================================================================

/**
 * Represents a friend relationship between two users.
 *
 * FRIEND SYSTEM DESIGN:
 * - Friendships are bidirectional (mutual)
 * - Stored twice in DynamoDB for efficient queries from either side
 *
 * DynamoDB KEY PATTERNS:
 * - PK: "USER#{userId}", SK: "FRIEND#{friendId}"
 * - PK: "USER#{friendId}", SK: "FRIEND#{userId}"
 *
 * WHY STORE TWICE?
 * To efficiently query "all friends of user X" without a scan.
 * This is a common DynamoDB pattern for many-to-many relationships.
 */
export interface FriendRelationship {
  /** ID of the user */
  userId: string;

  /** ID of the friend */
  friendId: string;

  /** Status of the friendship */
  status: 'pending' | 'accepted' | 'blocked';

  /** Who sent the friend request */
  initiatedBy: string;

  /** When the friendship was created */
  createdAt: string;

  /** When the status was last updated */
  updatedAt: string;
}

/**
 * Friend with their current presence information.
 *
 * This is what you'd see in the PSN friends list - combining
 * the friend's profile with their real-time status.
 */
export interface FriendWithPresence extends PublicUser {
  /** Real-time presence data (may be null if offline) */
  presence: PresenceData | null;

  /** Whether this friend is currently online */
  isOnline: boolean;

  /** When this friend was last online (if offline) */
  lastOnlineAt: string | null;
}

// ==============================================================================
// CHAT / MESSAGING TYPES
// ==============================================================================

/**
 * Represents a chat message between users.
 *
 * MESSAGE STORAGE STRATEGY:
 * - Recent messages: Redis (fast access, limited history)
 * - Historical messages: DynamoDB (permanent storage)
 *
 * REDIS KEY: "chat:{conversationId}:messages" (list)
 * DYNAMODB KEY: PK: "CONV#{conversationId}", SK: "MSG#{timestamp}#{messageId}"
 */
export interface ChatMessage {
  /** Unique message identifier */
  id: string;

  /** ID of the conversation this message belongs to */
  conversationId: string;

  /** ID of the user who sent the message */
  senderId: string;

  /** Gamertag of sender (denormalized for performance) */
  senderGamertag: string;

  /** Message content */
  content: string;

  /** Type of message */
  type: 'text' | 'image' | 'game_invite' | 'system';

  /** ISO 8601 timestamp */
  createdAt: string;

  /** Whether the message has been read by recipient */
  readAt: string | null;

  /** Additional metadata (e.g., game invite details) */
  metadata?: Record<string, unknown>;
}

/**
 * A conversation between two or more users.
 *
 * CONVERSATION TYPES:
 * - 'direct': One-on-one chat
 * - 'group': Multiple participants (like PS Party Chat)
 */
export interface Conversation {
  /** Unique conversation identifier */
  id: string;

  /** Type of conversation */
  type: 'direct' | 'group';

  /** IDs of all participants */
  participantIds: string[];

  /** Group name (for group chats) */
  name: string | null;

  /** Most recent message preview */
  lastMessage: ChatMessage | null;

  /** Unread message count per participant */
  unreadCounts: Record<string, number>;

  /** When the conversation was created */
  createdAt: string;

  /** When the last message was sent */
  updatedAt: string;
}

/**
 * Input for sending a new message.
 */
export interface SendMessageInput {
  conversationId: string;
  content: string;
  type?: 'text' | 'image' | 'game_invite';
  metadata?: Record<string, unknown>;
}

// ==============================================================================
// NOTIFICATION TYPES
// ==============================================================================

/**
 * User notification (friend requests, game invites, achievements).
 *
 * NOTIFICATION DELIVERY:
 * 1. Event occurs (friend request, achievement, etc.)
 * 2. Notification created and stored
 * 3. If user online: Push via WebSocket immediately
 * 4. If user offline: Delivered on next connection
 *
 * STORAGE:
 * - Redis for recent (last 24 hours)
 * - DynamoDB for historical
 */
export interface Notification {
  /** Unique notification ID */
  id: string;

  /** User who receives this notification */
  userId: string;

  /** Type of notification */
  type: 'friend_request' | 'friend_accepted' | 'game_invite' | 'achievement' | 'message' | 'system';

  /** Notification title */
  title: string;

  /** Notification body text */
  body: string;

  /** Related entity (user ID, game ID, etc.) */
  relatedId: string | null;

  /** Whether the notification has been read */
  read: boolean;

  /** ISO 8601 timestamp */
  createdAt: string;

  /** Additional data specific to notification type */
  data?: Record<string, unknown>;
}

// ==============================================================================
// GRAPHQL CONTEXT TYPE
// ==============================================================================

/**
 * Context object available in all GraphQL resolvers.
 *
 * CONTEXT FLOW:
 * 1. Request comes in with Authorization header
 * 2. Middleware validates JWT token
 * 3. User data attached to context
 * 4. All resolvers can access authenticated user
 *
 * INTERVIEW TIP:
 * "The GraphQL context is how we pass request-scoped data to resolvers.
 * It's where we put the authenticated user, database connections,
 * and service instances."
 */
export interface GraphQLContext {
  /** Authenticated user (null if not authenticated) */
  user: JWTPayload | null;

  /** User's session data from Redis */
  session: UserSession | null;

  /** Client IP address (for rate limiting, logging) */
  clientIp: string;

  /** Unique request ID for tracing */
  requestId: string;
}

// ==============================================================================
// EVENT TYPES (FOR KAFKA)
// ==============================================================================

/**
 * Base interface for all Kafka events.
 *
 * EVENT-DRIVEN ARCHITECTURE:
 * Instead of services calling each other directly, they emit events.
 * This provides:
 * - Loose coupling: Services don't know about each other
 * - Reliability: Events persist if consumers are down
 * - Scalability: Add consumers without changing producers
 */
export interface BaseEvent {
  /** Event type identifier */
  type: string;

  /** Unique event ID */
  eventId: string;

  /** ISO 8601 timestamp */
  timestamp: string;

  /** Service that produced this event */
  source: string;
}

/**
 * Event emitted when a user's presence changes.
 */
export interface PresenceChangedEvent extends BaseEvent {
  type: 'presence.changed';
  payload: {
    userId: string;
    previousStatus: UserStatus;
    newStatus: UserStatus;
    currentGame: string | null;
  };
}

/**
 * Event emitted when a user unlocks an achievement.
 */
export interface AchievementUnlockedEvent extends BaseEvent {
  type: 'achievement.unlocked';
  payload: {
    userId: string;
    gameId: string;
    achievementId: string;
    achievementName: string;
    rarity: 'common' | 'rare' | 'ultra_rare' | 'legendary';
  };
}

/**
 * Event emitted when a friend request is sent.
 */
export interface FriendRequestEvent extends BaseEvent {
  type: 'friend.request_sent' | 'friend.request_accepted' | 'friend.removed';
  payload: {
    fromUserId: string;
    toUserId: string;
  };
}

/**
 * Union type of all possible Kafka events.
 * Use this for type-safe event handling.
 */
export type KafkaEvent =
  | PresenceChangedEvent
  | AchievementUnlockedEvent
  | FriendRequestEvent;
