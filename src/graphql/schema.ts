/**
 * ==============================================================================
 * PLAYSTATION NETWORK - GRAPHQL SCHEMA
 * ==============================================================================
 *
 * This file defines the GraphQL schema using SDL (Schema Definition Language).
 * The schema is the contract between the client and server - it defines:
 * - What data can be queried
 * - What mutations can be performed
 * - What subscriptions are available for real-time updates
 *
 * GRAPHQL OVERVIEW:
 * =================
 *
 * WHY GRAPHQL OVER REST FOR PLAYSTATION?
 * -------------------------------------
 * 1. EFFICIENT DATA FETCHING: Get exactly what you need in one request
 *    - REST: Multiple endpoints (/friends, /presence, /games) = multiple roundtrips
 *    - GraphQL: One query gets friends + presence + games together
 *
 * 2. REAL-TIME BUILT-IN: Subscriptions for presence updates
 *    - REST: Would need separate WebSocket implementation
 *    - GraphQL: Subscriptions are part of the specification
 *
 * 3. TYPE SAFETY: Schema is strongly typed
 *    - Clients can generate type-safe code from schema
 *    - Errors caught at compile time, not runtime
 *
 * 4. VERSIONING: No version numbers in URLs
 *    - Add new fields without breaking existing clients
 *    - Deprecate old fields with clear warnings
 *
 * GRAPHQL OPERATIONS:
 * ==================
 *
 * QUERY (Read operations):
 * - Like GET in REST
 * - Cannot modify data
 * - Example: Get friend list, get messages
 *
 * MUTATION (Write operations):
 * - Like POST/PUT/DELETE in REST
 * - Modifies data on server
 * - Example: Send message, update status
 *
 * SUBSCRIPTION (Real-time):
 * - Server pushes updates to client
 * - Uses WebSocket under the hood
 * - Example: Friend came online, new message received
 *
 * INTERVIEW TIP:
 * "We chose GraphQL because PlayStation's mobile app needs different
 * data than the console UI, but they share the same backend. GraphQL
 * lets each client request exactly what it needs without multiple
 * endpoint versions."
 * ==============================================================================
 */

/**
 * The complete GraphQL schema definition.
 *
 * SCHEMA ORGANIZATION:
 * -------------------
 * 1. Scalar types (ID, String, etc.) are built-in
 * 2. Object types define the shape of data
 * 3. Input types define the shape of arguments
 * 4. Query type defines read operations
 * 5. Mutation type defines write operations
 * 6. Subscription type defines real-time events
 */
export const typeDefs = `#graphql
  # ===========================================================================
  # SCALAR TYPES
  # ===========================================================================
  # Custom scalars can be added for specific data formats
  # For example: DateTime, JSON, Upload
  # We're using String for timestamps for simplicity

  # ===========================================================================
  # ENUMS
  # ===========================================================================
  # Enums restrict a field to a specific set of values.
  # This provides type safety and self-documentation.

  """
  Possible online status values for a user.

  IMPORTANT: These map directly to the TypeScript UserStatus type.
  Keep them in sync!
  """
  enum UserStatus {
    """User is active and available"""
    ONLINE
    """User is logged in but idle"""
    AWAY
    """User is in a game session, do not disturb"""
    BUSY
    """User is not connected"""
    OFFLINE
    """User appears offline but can see others"""
    INVISIBLE
  }

  """
  Types of messages that can be sent.
  """
  enum MessageType {
    """Regular text message"""
    TEXT
    """Image/media message"""
    IMAGE
    """Game invite"""
    GAME_INVITE
    """System-generated message"""
    SYSTEM
  }

  """
  Types of conversations.
  """
  enum ConversationType {
    """One-on-one direct message"""
    DIRECT
    """Group chat with multiple participants"""
    GROUP
  }

  """
  Types of notifications.
  """
  enum NotificationType {
    FRIEND_REQUEST
    FRIEND_ACCEPTED
    GAME_INVITE
    ACHIEVEMENT
    MESSAGE
    SYSTEM
  }

  """
  Status of a friend request.

  LIFECYCLE:
  pending -> accepted (friendship created)
  pending -> declined (request removed)
  pending -> canceled (by sender)
  """
  enum FriendRequestStatus {
    """Request is waiting for response"""
    PENDING
    """Request was accepted, users are now friends"""
    ACCEPTED
    """Request was declined by recipient"""
    DECLINED
    """Request was canceled by sender"""
    CANCELED
  }

  """
  Types of friend events for real-time updates.
  """
  enum FriendEventType {
    """Someone sent you a friend request"""
    FRIEND_REQUEST_RECEIVED
    """Your friend request was accepted"""
    FRIEND_REQUEST_ACCEPTED
    """Your friend request was declined"""
    FRIEND_REQUEST_DECLINED
    """A friend removed you"""
    FRIEND_REMOVED
    """Someone blocked you (limited info for privacy)"""
    USER_BLOCKED
    """Someone unblocked you"""
    USER_UNBLOCKED
  }

  # ===========================================================================
  # OBJECT TYPES
  # ===========================================================================
  # These define the shape of data returned by queries.

  """
  A user on the PlayStation Network.

  This is the PUBLIC user profile - sensitive fields like email and
  password hash are never exposed through GraphQL.

  INTERVIEW TIP:
  "We expose different fields based on the relationship. You see more
  data for yourself (me query) than for other users (user query)."
  """
  type User {
    """Unique user identifier (UUID)"""
    id: ID!

    """Display name shown to other players"""
    gamertag: String!

    """Avatar emoji or image URL"""
    avatar: String!

    """Experience level (1-100+)"""
    level: Int!

    """Total trophies earned"""
    trophyCount: Int!

    """Current online status"""
    status: UserStatus!

    """Game currently being played (null if not in game)"""
    currentGame: String

    """Custom status message"""
    statusMessage: String
  }

  """
  Real-time presence information for a user.

  Presence is separate from User because:
  1. It changes frequently (every heartbeat)
  2. It's stored in Redis, not the main database
  3. It has different TTL/expiration logic
  """
  type Presence {
    """User this presence belongs to"""
    userId: ID!

    """User's display name"""
    gamertag: String!

    """Current status"""
    status: UserStatus!

    """Game being played"""
    currentGame: String

    """Custom status message"""
    statusMessage: String

    """Unix timestamp of last activity"""
    lastActiveAt: Float!

    """Unix timestamp of last update"""
    updatedAt: Float!
  }

  """
  A friend with their current presence information.

  This is the main type used in the friends list UI.
  Combines user profile with real-time presence.
  """
  type FriendWithPresence {
    """The friend's user profile"""
    user: User!

    """Real-time presence data (null if offline)"""
    presence: Presence

    """Convenience flag for UI"""
    isOnline: Boolean!

    """When friend was last online (if offline)"""
    lastOnlineAt: String
  }

  """
  A friend request between two users.

  INTERVIEW TIP:
  "Friend requests are stored in Redis Sorted Sets with timestamp as score.
  This allows efficient pagination and automatic expiration of old requests."
  """
  type FriendRequest {
    """Unique request identifier"""
    id: ID!

    """User who sent the request"""
    fromUser: User!

    """User who receives the request"""
    toUser: User!

    """Current status of the request"""
    status: FriendRequestStatus!

    """When the request was sent"""
    createdAt: String!

    """When the request was last updated"""
    updatedAt: String!

    """Optional message from sender"""
    message: String
  }

  """
  A friend suggestion based on mutual connections.
  """
  type FriendSuggestion {
    """Suggested user to friend"""
    user: User!

    """Number of mutual friends"""
    mutualFriendCount: Int!

    """Some mutual friend names for context"""
    mutualFriendNames: [String!]!
  }

  """
  Real-time friend event for subscriptions.
  """
  type FriendEvent {
    """Type of friend event"""
    type: FriendEventType!

    """User who initiated the action"""
    fromUser: User

    """Friend request (if applicable)"""
    request: FriendRequest

    """When the event occurred"""
    timestamp: String!
  }

  """
  Statistics about a user's friend network.
  """
  type FriendStats {
    """Total number of friends"""
    friendCount: Int!

    """Number of friends currently online"""
    onlineFriendCount: Int!

    """Number of pending incoming requests"""
    incomingRequestCount: Int!

    """Number of pending outgoing requests"""
    outgoingRequestCount: Int!

    """Number of blocked users"""
    blockedCount: Int!
  }

  """
  A chat message in a conversation.
  """
  type Message {
    """Unique message identifier"""
    id: ID!

    """Conversation this message belongs to"""
    conversationId: ID!

    """User who sent the message"""
    senderId: ID!

    """Sender's gamertag (denormalized for performance)"""
    senderGamertag: String!

    """Message content"""
    content: String!

    """Type of message"""
    type: MessageType!

    """When the message was sent (ISO 8601)"""
    createdAt: String!

    """When the message was read (null if unread)"""
    readAt: String
  }

  """
  A conversation between users.
  """
  type Conversation {
    """Unique conversation identifier"""
    id: ID!

    """Type of conversation"""
    type: ConversationType!

    """IDs of all participants"""
    participantIds: [ID!]!

    """Participant user profiles"""
    participants: [User!]!

    """Group name (for group chats)"""
    name: String

    """Most recent message"""
    lastMessage: Message

    """Unread message count for current user"""
    unreadCount: Int!

    """When conversation was created"""
    createdAt: String!

    """When last message was sent"""
    updatedAt: String!
  }

  """
  A notification for the user.
  """
  type Notification {
    """Unique notification identifier"""
    id: ID!

    """Type of notification"""
    type: NotificationType!

    """Notification title"""
    title: String!

    """Notification body"""
    body: String!

    """Related entity ID (user, game, etc.)"""
    relatedId: String

    """Whether notification has been read"""
    read: Boolean!

    """When notification was created"""
    createdAt: String!
  }

  # ===========================================================================
  # RESPONSE TYPES
  # ===========================================================================
  # These wrap responses with metadata for error handling and pagination.

  """
  Authentication response after login/register.
  """
  type AuthResponse {
    """JWT token for subsequent requests"""
    token: String!

    """Authenticated user's profile"""
    user: User!

    """When the token expires (ISO 8601)"""
    expiresAt: String!
  }

  """
  Generic success/failure response.
  """
  type OperationResult {
    """Whether the operation succeeded"""
    success: Boolean!

    """Human-readable message"""
    message: String!
  }

  # ===========================================================================
  # INPUT TYPES
  # ===========================================================================
  # These define the shape of arguments for mutations.
  # Using input types keeps mutation signatures clean.

  """
  Input for user registration.
  """
  input RegisterInput {
    """Desired gamertag (3-16 chars, alphanumeric)"""
    gamertag: String!

    """Email address"""
    email: String!

    """Password (min 8 chars with number and special char)"""
    password: String!
  }

  """
  Input for user login.
  """
  input LoginInput {
    """Gamertag or email"""
    identifier: String!

    """Password"""
    password: String!
  }

  """
  Input for updating presence.
  """
  input UpdatePresenceInput {
    """New status"""
    status: UserStatus

    """Current game being played"""
    currentGame: String

    """Custom status message"""
    statusMessage: String
  }

  """
  Input for sending a message.
  """
  input SendMessageInput {
    """Conversation to send to"""
    conversationId: ID!

    """Message content"""
    content: String!

    """Message type (defaults to TEXT)"""
    type: MessageType
  }

  """
  Input for creating a conversation.
  """
  input CreateConversationInput {
    """User IDs to include"""
    participantIds: [ID!]!

    """Type of conversation"""
    type: ConversationType!

    """Group name (for GROUP type)"""
    name: String
  }

  # ===========================================================================
  # QUERY TYPE
  # ===========================================================================
  # All read operations. These should be idempotent (same result each call).

  """
  Query root - all read operations.

  NAMING CONVENTION:
  - Singular nouns for single items: user, conversation
  - Plural nouns for lists: friends, conversations
  - Prefixes for specific lookups: userById, conversationByParticipants
  """
  type Query {
    # -------------------------------------------------------------------------
    # USER QUERIES
    # -------------------------------------------------------------------------

    """
    Get the currently authenticated user's profile.

    AUTHENTICATION: Required

    This returns more data than the user() query because you're
    viewing your own profile.
    """
    me: User

    """
    Get a user by their ID.

    AUTHENTICATION: Required
    """
    user(id: ID!): User

    """
    Get a user by their gamertag.

    AUTHENTICATION: Required
    """
    userByGamertag(gamertag: String!): User

    """
    Search for users by gamertag.

    AUTHENTICATION: Required

    Returns users whose gamertag contains the search term.
    Limited to 20 results for performance.
    """
    searchUsers(query: String!, limit: Int = 20): [User!]!

    # -------------------------------------------------------------------------
    # FRIENDS QUERIES
    # -------------------------------------------------------------------------

    """
    Get the authenticated user's friend list with presence.

    AUTHENTICATION: Required

    Returns friends sorted by online status (online first),
    then by gamertag alphabetically.

    INTERVIEW TIP:
    "We batch fetch presence data for all friends in one Redis MGET call
    to avoid N+1 queries. This keeps the friends list fast even with
    thousands of friends."
    """
    friends(
      """Maximum number of friends to return"""
      limit: Int = 100
      """Offset for pagination"""
      offset: Int = 0
      """Filter by online status"""
      onlineOnly: Boolean = false
    ): [FriendWithPresence!]!

    """
    Get incoming friend requests (requests sent TO the current user).

    AUTHENTICATION: Required

    Returns requests sorted by most recent first.
    """
    incomingFriendRequests(
      """Maximum number of requests to return"""
      limit: Int = 50
      """Offset for pagination"""
      offset: Int = 0
    ): [FriendRequest!]!

    """
    Get outgoing friend requests (requests sent BY the current user).

    AUTHENTICATION: Required
    """
    outgoingFriendRequests(
      """Maximum number of requests to return"""
      limit: Int = 50
      """Offset for pagination"""
      offset: Int = 0
    ): [FriendRequest!]!

    """
    Get friend statistics for the authenticated user.

    AUTHENTICATION: Required
    """
    friendStats: FriendStats!

    """
    Get mutual friends between the authenticated user and another user.

    AUTHENTICATION: Required

    Useful for showing "X mutual friends" on profile pages.
    """
    mutualFriends(
      """User to find mutual friends with"""
      userId: ID!
      """Maximum number of mutual friends to return"""
      limit: Int = 10
    ): [User!]!

    """
    Get friend suggestions based on mutual connections.

    AUTHENTICATION: Required

    ALGORITHM:
    Finds users who are friends with your friends but not your friends.
    Ranked by number of mutual connections.
    """
    friendSuggestions(
      """Maximum number of suggestions to return"""
      limit: Int = 10
    ): [FriendSuggestion!]!

    """
    Check if the authenticated user is friends with another user.

    AUTHENTICATION: Required
    """
    isFriend(userId: ID!): Boolean!

    """
    Check if the authenticated user has blocked another user.

    AUTHENTICATION: Required
    """
    isBlocked(userId: ID!): Boolean!

    """
    Get the list of users blocked by the authenticated user.

    AUTHENTICATION: Required
    """
    blockedUsers: [User!]!

    """
    Get pending friend requests (deprecated, use incomingFriendRequests).

    AUTHENTICATION: Required
    """
    friendRequests: [User!]! @deprecated(reason: "Use incomingFriendRequests instead")

    # -------------------------------------------------------------------------
    # PRESENCE QUERIES
    # -------------------------------------------------------------------------

    """
    Get presence for a specific user.

    AUTHENTICATION: Required

    Returns null if user is offline.
    """
    presence(userId: ID!): Presence

    """
    Get count of online users (for dashboard).

    AUTHENTICATION: Required
    """
    onlineCount: Int!

    """
    Get users currently playing a specific game.

    AUTHENTICATION: Required
    """
    playersInGame(game: String!): [User!]!

    # -------------------------------------------------------------------------
    # CHAT QUERIES
    # -------------------------------------------------------------------------

    """
    Get the authenticated user's conversations.

    AUTHENTICATION: Required

    Returns conversations sorted by most recent activity.
    """
    conversations(limit: Int = 20, offset: Int = 0): [Conversation!]!

    """
    Get a specific conversation.

    AUTHENTICATION: Required

    Returns null if conversation doesn't exist or user isn't a participant.
    """
    conversation(id: ID!): Conversation

    """
    Get messages from a conversation.

    AUTHENTICATION: Required

    Returns messages in reverse chronological order (newest first).
    Use 'before' for pagination to get older messages.
    """
    messages(
      conversationId: ID!
      limit: Int = 50
      before: ID
    ): [Message!]!

    # -------------------------------------------------------------------------
    # NOTIFICATION QUERIES
    # -------------------------------------------------------------------------

    """
    Get the authenticated user's notifications.

    AUTHENTICATION: Required
    """
    notifications(limit: Int = 20, unreadOnly: Boolean = false): [Notification!]!

    """
    Get count of unread notifications.

    AUTHENTICATION: Required
    """
    unreadNotificationCount: Int!

    # -------------------------------------------------------------------------
    # GAME QUERIES
    # -------------------------------------------------------------------------

    """
    Get a game by ID.
    """
    game(id: ID!): Game

    """
    Search for games.
    """
    searchGames(query: String!, limit: Int = 20): [Game!]!

    """
    Get popular games.
    """
    popularGames(limit: Int = 10): [Game!]!

    """
    Get games by genre.
    """
    gamesByGenre(genre: String!, limit: Int = 20): [Game!]!

    """
    Get the authenticated user's game library.

    AUTHENTICATION: Required
    """
    myGameLibrary(limit: Int = 50, offset: Int = 0): [UserGame!]!

    """
    Get a specific game from user's library.

    AUTHENTICATION: Required
    """
    myGame(gameId: ID!): UserGame

    """
    Get achievements for a game.
    """
    gameAchievements(gameId: ID!): [Achievement!]!

    """
    Get user's unlocked achievements for a game.

    AUTHENTICATION: Required
    """
    myAchievements(gameId: ID!): [UserAchievement!]!

    """
    Get user's trophy summary.

    AUTHENTICATION: Required
    """
    myTrophySummary: TrophySummary!

    """
    Get user's active play session.

    AUTHENTICATION: Required
    """
    myActiveSession: PlaySession

    """
    Get joinable sessions for a game.
    """
    joinableSessions(gameId: ID!): [PlaySession!]!

    """
    Get pending game invites.

    AUTHENTICATION: Required
    """
    pendingGameInvites: [GameInvite!]!

    # -------------------------------------------------------------------------
    # ACTIVITY FEED QUERIES
    # -------------------------------------------------------------------------

    """
    Get activity feed for authenticated user.

    AUTHENTICATION: Required

    Returns activities from friends, sorted by most recent.
    """
    activityFeed(limit: Int = 50, offset: Int = 0): [Activity!]!

    """
    Get activities for a specific user.

    AUTHENTICATION: Required
    """
    userActivities(userId: ID!, limit: Int = 20): [Activity!]!

    # -------------------------------------------------------------------------
    # VOICE CHAT QUERIES
    # -------------------------------------------------------------------------

    """
    Get available voice rooms.

    AUTHENTICATION: Required
    """
    voiceRooms: [VoiceRoom!]!

    """
    Get a specific voice room.

    AUTHENTICATION: Required
    """
    voiceRoom(id: ID!): VoiceRoom

    """
    Get user's current voice room.

    AUTHENTICATION: Required
    """
    myVoiceRoom: VoiceRoom

    # -------------------------------------------------------------------------
    # PROFILE QUERIES
    # -------------------------------------------------------------------------

    """
    Get extended profile for a user.

    AUTHENTICATION: Required
    """
    userProfile(userId: ID!): UserProfile

    """
    Get authenticated user's profile.

    AUTHENTICATION: Required
    """
    myProfile: UserProfile

    """
    Get user statistics.

    AUTHENTICATION: Required
    """
    userStats(userId: ID!): UserStats
  }

  # ===========================================================================
  # MUTATION TYPE
  # ===========================================================================
  # All write operations. These modify data on the server.

  """
  Mutation root - all write operations.

  NAMING CONVENTION:
  - Verb + Noun: sendMessage, createConversation
  - Use action verbs: send, create, update, delete, mark
  - Be specific: markAsRead vs setRead
  """
  type Mutation {
    # -------------------------------------------------------------------------
    # AUTHENTICATION MUTATIONS
    # -------------------------------------------------------------------------

    """
    Register a new user account.

    AUTHENTICATION: Not required

    Creates a new user and returns auth token.
    """
    register(input: RegisterInput!): AuthResponse!

    """
    Log in with existing credentials.

    AUTHENTICATION: Not required

    Returns auth token on success.
    """
    login(input: LoginInput!): AuthResponse!

    """
    Log out the current user.

    AUTHENTICATION: Required

    Invalidates the current session.
    """
    logout: OperationResult!

    # -------------------------------------------------------------------------
    # PRESENCE MUTATIONS
    # -------------------------------------------------------------------------

    """
    Update the authenticated user's presence.

    AUTHENTICATION: Required

    Use this when changing status, starting a game, etc.
    """
    updatePresence(input: UpdatePresenceInput!): Presence!

    """
    Send a heartbeat to keep presence alive.

    AUTHENTICATION: Required

    Call this every 60 seconds to prevent auto-offline.
    """
    heartbeat: Presence

    """
    Set user as offline.

    AUTHENTICATION: Required

    Call this when closing the app.
    """
    goOffline: OperationResult!

    # -------------------------------------------------------------------------
    # FRIEND MUTATIONS
    # -------------------------------------------------------------------------

    """
    Send a friend request to another user.

    AUTHENTICATION: Required

    VALIDATION:
    - Cannot friend yourself
    - Cannot friend someone who blocked you
    - Cannot friend someone you blocked
    - Cannot send duplicate request
    - Maximum 500 pending outgoing requests
    - Target user must have less than 500 pending incoming requests

    AUTO-ACCEPT:
    If the target user already sent you a request, this will
    automatically accept their request instead (mutual intent).

    INTERVIEW TIP:
    "We use Redis transactions (MULTI/EXEC) to atomically update
    both users' request lists, preventing race conditions."
    """
    sendFriendRequest(
      """ID of user to send request to"""
      userId: ID!
      """Optional message to include with request"""
      message: String
    ): FriendRequest!

    """
    Accept a friend request from another user.

    AUTHENTICATION: Required

    Creates a bidirectional friend relationship.
    Notifies the sender via real-time subscription.
    """
    acceptFriendRequest(
      """ID of user who sent the request"""
      userId: ID!
    ): FriendWithPresence!

    """
    Decline a friend request from another user.

    AUTHENTICATION: Required

    The sender is NOT notified to avoid harassment.
    """
    declineFriendRequest(
      """ID of user who sent the request"""
      userId: ID!
    ): OperationResult!

    """
    Cancel an outgoing friend request.

    AUTHENTICATION: Required

    Use this to withdraw a request you sent.
    """
    cancelFriendRequest(
      """ID of user the request was sent to"""
      userId: ID!
    ): OperationResult!

    """
    Remove a friend from your friends list.

    AUTHENTICATION: Required

    This removes the friendship for both users.
    The other user is NOT notified (they'll just see you're gone).
    """
    removeFriend(
      """ID of friend to remove"""
      userId: ID!
    ): OperationResult!

    """
    Block a user.

    AUTHENTICATION: Required

    EFFECTS:
    - Removes existing friendship (if any)
    - Cancels pending friend requests (both directions)
    - Prevents future friend requests
    - Hides your presence from the blocked user
    - Prevents messaging between you

    PRIVACY:
    The blocked user is NOT explicitly notified.
    They may notice they can't interact with you.
    """
    blockUser(
      """ID of user to block"""
      userId: ID!
    ): OperationResult!

    """
    Unblock a user.

    AUTHENTICATION: Required

    After unblocking, you can send/receive friend requests again.
    Does NOT restore the previous friendship.
    """
    unblockUser(
      """ID of user to unblock"""
      userId: ID!
    ): OperationResult!

    # -------------------------------------------------------------------------
    # CHAT MUTATIONS
    # -------------------------------------------------------------------------

    """
    Create a new conversation.

    AUTHENTICATION: Required

    For DIRECT conversations, returns existing conversation if one exists.
    """
    createConversation(input: CreateConversationInput!): Conversation!

    """
    Send a message to a conversation.

    AUTHENTICATION: Required
    """
    sendMessage(input: SendMessageInput!): Message!

    """
    Mark a conversation as read.

    AUTHENTICATION: Required

    Resets unread count and publishes read receipt.
    """
    markConversationAsRead(conversationId: ID!): OperationResult!

    """
    Indicate user is typing in a conversation.

    AUTHENTICATION: Required

    Call every few seconds while typing.
    """
    setTyping(conversationId: ID!): OperationResult!

    # -------------------------------------------------------------------------
    # NOTIFICATION MUTATIONS
    # -------------------------------------------------------------------------

    """
    Mark a notification as read.

    AUTHENTICATION: Required
    """
    markNotificationAsRead(notificationId: ID!): OperationResult!

    """
    Mark all notifications as read.

    AUTHENTICATION: Required
    """
    markAllNotificationsAsRead: OperationResult!

    # -------------------------------------------------------------------------
    # GAME MUTATIONS
    # -------------------------------------------------------------------------

    """
    Add a game to user's library.

    AUTHENTICATION: Required
    """
    addGameToLibrary(gameId: ID!): UserGame!

    """
    Start a play session.

    AUTHENTICATION: Required
    """
    startPlaySession(input: StartSessionInput!): PlaySession!

    """
    Send heartbeat to keep session alive.

    AUTHENTICATION: Required
    """
    heartbeatSession: PlaySession

    """
    Update session activity.

    AUTHENTICATION: Required
    """
    updateSessionActivity(
      activity: String!
      isJoinable: Boolean
      partySize: Int
    ): PlaySession

    """
    End the current play session.

    AUTHENTICATION: Required
    """
    endPlaySession: OperationResult!

    """
    Unlock an achievement.

    AUTHENTICATION: Required
    """
    unlockAchievement(achievementId: ID!): UserAchievement

    """
    Send a game invite.

    AUTHENTICATION: Required
    """
    sendGameInvite(input: SendGameInviteInput!): GameInvite!

    """
    Accept a game invite.

    AUTHENTICATION: Required
    """
    acceptGameInvite(inviteId: ID!): GameInvite!

    """
    Decline a game invite.

    AUTHENTICATION: Required
    """
    declineGameInvite(inviteId: ID!): GameInvite!

    # -------------------------------------------------------------------------
    # ACTIVITY MUTATIONS
    # -------------------------------------------------------------------------

    """
    Like an activity.

    AUTHENTICATION: Required
    """
    likeActivity(activityId: ID!): Activity!

    """
    Unlike an activity.

    AUTHENTICATION: Required
    """
    unlikeActivity(activityId: ID!): Activity!

    # -------------------------------------------------------------------------
    # VOICE CHAT MUTATIONS
    # -------------------------------------------------------------------------

    """
    Create a voice room.

    AUTHENTICATION: Required
    """
    createVoiceRoom(input: CreateVoiceRoomInput!): VoiceRoom!

    """
    Join a voice room.

    AUTHENTICATION: Required
    """
    joinVoiceRoom(roomId: ID!): VoiceRoom!

    """
    Leave the current voice room.

    AUTHENTICATION: Required
    """
    leaveVoiceRoom: OperationResult!

    """
    Toggle mute in voice room.

    AUTHENTICATION: Required
    """
    toggleMute: VoiceParticipant!

    """
    Toggle deafen in voice room.

    AUTHENTICATION: Required
    """
    toggleDeafen: VoiceParticipant!

    # -------------------------------------------------------------------------
    # PROFILE MUTATIONS
    # -------------------------------------------------------------------------

    """
    Update user profile.

    AUTHENTICATION: Required
    """
    updateProfile(input: UpdateProfileInput!): UserProfile!

    """
    Update privacy settings.

    AUTHENTICATION: Required
    """
    updatePrivacy(input: UpdatePrivacyInput!): UserPrivacy!

    """
    Update trophy showcase.

    AUTHENTICATION: Required
    """
    updateTrophyShowcase(achievementIds: [ID!]!): [TrophyShowcaseSlot]!
  }

  # ===========================================================================
  # SUBSCRIPTION TYPE
  # ===========================================================================
  # Real-time event streams. Uses WebSocket under the hood.

  """
  Subscription root - all real-time events.

  WEBSOCKET FLOW:
  1. Client connects with auth token
  2. Client subscribes to specific events
  3. Server pushes updates as they happen
  4. Connection stays open until client disconnects

  INTERVIEW TIP:
  "GraphQL subscriptions use WebSocket transport. Each subscription
  creates a long-lived connection. We use Redis Pub/Sub on the backend
  to fan out events to all server instances."
  """
  type Subscription {
    # -------------------------------------------------------------------------
    # PRESENCE SUBSCRIPTIONS
    # -------------------------------------------------------------------------

    """
    Subscribe to friend presence updates.

    AUTHENTICATION: Required

    Fires when any friend's status changes.
    The server filters to only friends of the authenticated user.
    """
    friendPresenceUpdated: Presence!

    """
    Subscribe to a specific user's presence.

    AUTHENTICATION: Required

    Useful for viewing a profile page in real-time.
    """
    userPresenceUpdated(userId: ID!): Presence!

    # -------------------------------------------------------------------------
    # CHAT SUBSCRIPTIONS
    # -------------------------------------------------------------------------

    """
    Subscribe to new messages in a conversation.

    AUTHENTICATION: Required

    Fires when any participant sends a message.
    """
    messageReceived(conversationId: ID!): Message!

    """
    Subscribe to typing indicators in a conversation.

    AUTHENTICATION: Required

    Fires when someone starts or stops typing.
    """
    userTyping(conversationId: ID!): TypingIndicator!

    """
    Subscribe to new messages across all conversations.

    AUTHENTICATION: Required

    Useful for showing notification badges.
    """
    newMessageNotification: Message!

    # -------------------------------------------------------------------------
    # FRIEND SUBSCRIPTIONS
    # -------------------------------------------------------------------------

    """
    Subscribe to friend events (requests, accepts, removes).

    AUTHENTICATION: Required

    Fires when:
    - Someone sends you a friend request
    - Someone accepts your friend request
    - Someone removes you as a friend

    INTERVIEW TIP:
    "We use Redis Pub/Sub to broadcast friend events to all server instances.
    Each instance then filters and pushes to the relevant WebSocket clients.
    This enables horizontal scaling of real-time features."
    """
    friendEventReceived: FriendEvent!

    """
    Subscribe to incoming friend requests only.

    AUTHENTICATION: Required

    Useful for showing a notification badge on the friends icon.
    """
    friendRequestReceived: FriendRequest!

    # -------------------------------------------------------------------------
    # NOTIFICATION SUBSCRIPTIONS
    # -------------------------------------------------------------------------

    """
    Subscribe to new notifications.

    AUTHENTICATION: Required

    Fires when user receives any notification.
    """
    notificationReceived: Notification!

    # -------------------------------------------------------------------------
    # GAME SUBSCRIPTIONS
    # -------------------------------------------------------------------------

    """
    Subscribe to game invites.

    AUTHENTICATION: Required
    """
    gameInviteReceived: GameInvite!

    """
    Subscribe to friend game sessions.

    AUTHENTICATION: Required

    Fires when a friend starts or ends a game session.
    """
    friendSessionUpdated: PlaySession!

    """
    Subscribe to achievement unlocks.

    AUTHENTICATION: Required

    Fires when a friend unlocks an achievement.
    """
    friendAchievementUnlocked: UserAchievement!

    # -------------------------------------------------------------------------
    # ACTIVITY FEED SUBSCRIPTIONS
    # -------------------------------------------------------------------------

    """
    Subscribe to new activities from friends.

    AUTHENTICATION: Required
    """
    newActivity: Activity!

    # -------------------------------------------------------------------------
    # VOICE CHAT SUBSCRIPTIONS
    # -------------------------------------------------------------------------

    """
    Subscribe to voice room updates.

    AUTHENTICATION: Required
    """
    voiceRoomUpdated(roomId: ID!): VoiceRoom!

    """
    Subscribe to participant updates in a voice room.

    AUTHENTICATION: Required
    """
    voiceParticipantUpdated(roomId: ID!): VoiceParticipant!
  }

  """
  Typing indicator event.
  """
  type TypingIndicator {
    """Conversation where typing is happening"""
    conversationId: ID!

    """User who is typing"""
    userId: ID!

    """User's gamertag"""
    gamertag: String!

    """Whether user is typing (true) or stopped (false)"""
    isTyping: Boolean!
  }

  # ===========================================================================
  # GAME TYPES
  # ===========================================================================

  """
  Trophy type matching PlayStation's system.
  """
  enum TrophyType {
    BRONZE
    SILVER
    GOLD
    PLATINUM
  }

  """
  Achievement rarity based on unlock percentage.
  """
  enum AchievementRarity {
    COMMON
    RARE
    ULTRA_RARE
    LEGENDARY
  }

  """
  Game invite status.
  """
  enum GameInviteStatus {
    PENDING
    ACCEPTED
    DECLINED
    EXPIRED
  }

  """
  A game in the PlayStation catalog.
  """
  type Game {
    """Unique game identifier"""
    id: ID!

    """Game title"""
    title: String!

    """Publisher/developer name"""
    publisher: String!

    """Primary genre"""
    genre: String!

    """Additional tags"""
    tags: [String!]!

    """Release date (ISO 8601)"""
    releaseDate: String!

    """Cover art URL"""
    coverUrl: String!

    """Background art URL"""
    backgroundUrl: String!

    """Short description"""
    description: String!

    """Average rating (1-5)"""
    rating: Float!

    """Total number of ratings"""
    ratingCount: Int!

    """Maximum players for multiplayer"""
    maxPlayers: Int!

    """Supported platforms"""
    platforms: [String!]!

    """Total achievements available"""
    totalAchievements: Int!

    """Estimated playtime in hours"""
    estimatedPlaytime: Int!
  }

  """
  A game in a user's library with their progress.
  """
  type UserGame {
    """Game details"""
    game: Game!

    """When the user acquired this game"""
    purchasedAt: String!

    """Total playtime in minutes"""
    playtimeMinutes: Int!

    """When the user last played"""
    lastPlayedAt: String

    """Number of achievements unlocked"""
    achievementsUnlocked: Int!

    """Completion percentage (achievements)"""
    completionPercent: Float!

    """Whether currently playing"""
    isPlaying: Boolean!
  }

  """
  A game achievement/trophy.
  """
  type Achievement {
    """Unique achievement identifier"""
    id: ID!

    """Game this achievement belongs to"""
    gameId: ID!

    """Achievement name"""
    name: String!

    """Description of how to unlock"""
    description: String!

    """Icon URL"""
    iconUrl: String!

    """Trophy type"""
    trophyType: TrophyType!

    """Rarity based on unlock percentage"""
    rarity: AchievementRarity!

    """Percentage of players who have unlocked this"""
    unlockPercentage: Float!

    """Points value"""
    points: Int!

    """Whether this is a hidden/secret achievement"""
    isHidden: Boolean!
  }

  """
  An unlocked achievement for a user.
  """
  type UserAchievement {
    """The achievement"""
    achievement: Achievement!

    """When it was unlocked"""
    unlockedAt: String!

    """Screenshot taken at unlock (optional)"""
    screenshotUrl: String
  }

  """
  Trophy summary for a user.
  """
  type TrophySummary {
    bronze: Int!
    silver: Int!
    gold: Int!
    platinum: Int!
    total: Int!
  }

  """
  An active play session.
  """
  type PlaySession {
    """Unique session identifier"""
    id: ID!

    """User playing"""
    userId: ID!

    """User's gamertag"""
    gamertag: String!

    """Game being played"""
    gameId: ID!

    """Game title"""
    gameTitle: String!

    """When the session started"""
    startedAt: String!

    """Current activity (e.g., "Story Mode", "Online Match")"""
    activity: String!

    """Whether session is joinable"""
    isJoinable: Boolean!

    """Current party size if multiplayer"""
    partySize: Int!

    """Maximum party size"""
    maxPartySize: Int!

    """Platform (PS5, PC, etc.)"""
    platform: String!
  }

  """
  A game invite from one user to another.
  """
  type GameInvite {
    """Unique invite identifier"""
    id: ID!

    """User who sent the invite"""
    fromUser: User!

    """User receiving the invite"""
    toUserId: ID!

    """Game to join"""
    game: Game!

    """Session to join"""
    sessionId: ID!

    """When the invite was sent"""
    createdAt: String!

    """When the invite expires"""
    expiresAt: String!

    """Invite status"""
    status: GameInviteStatus!

    """Optional message"""
    message: String
  }

  # ===========================================================================
  # ACTIVITY FEED TYPES
  # ===========================================================================

  """
  Types of activities in the feed.
  """
  enum ActivityType {
    GAME_STARTED
    GAME_ENDED
    ACHIEVEMENT_UNLOCKED
    GAME_COMPLETED
    FRIEND_ADDED
    STATUS_CHANGED
    TROPHY_MILESTONE
  }

  """
  An activity item in the feed.
  """
  type Activity {
    """Unique activity identifier"""
    id: ID!

    """Type of activity"""
    type: ActivityType!

    """User who performed the action"""
    user: User!

    """Activity title"""
    title: String!

    """Optional description"""
    description: String

    """Game if game-related"""
    game: Game

    """Achievement if achievement-related"""
    achievement: Achievement

    """When the activity occurred"""
    createdAt: String!

    """Number of likes"""
    likeCount: Int!

    """Number of comments"""
    commentCount: Int!

    """Whether current user liked this"""
    isLiked: Boolean!
  }

  # ===========================================================================
  # VOICE CHAT TYPES
  # ===========================================================================

  """
  Voice room state.
  """
  enum VoiceRoomState {
    WAITING
    ACTIVE
    ENDED
  }

  """
  Participant connection state.
  """
  enum VoiceParticipantState {
    CONNECTING
    CONNECTED
    MUTED
    DEAFENED
    DISCONNECTED
  }

  """
  A voice chat room (PlayStation Party).
  """
  type VoiceRoom {
    """Unique room identifier"""
    id: ID!

    """Room name"""
    name: String!

    """User who created the room"""
    host: User!

    """Current room state"""
    state: VoiceRoomState!

    """Maximum participants allowed"""
    maxParticipants: Int!

    """Current participants"""
    participants: [VoiceParticipant!]!

    """Whether the room is private"""
    isPrivate: Boolean!

    """Associated game"""
    game: Game

    """When the room was created"""
    createdAt: String!
  }

  """
  A participant in a voice room.
  """
  type VoiceParticipant {
    """User"""
    user: User!

    """Connection state"""
    state: VoiceParticipantState!

    """Whether mic is muted"""
    isMuted: Boolean!

    """Whether audio is deafened"""
    isDeafened: Boolean!

    """Whether currently speaking"""
    isSpeaking: Boolean!

    """When the user joined"""
    joinedAt: String!
  }

  # ===========================================================================
  # USER PROFILE & STATS TYPES
  # ===========================================================================

  """
  Visibility setting for privacy.
  """
  enum VisibilitySetting {
    PUBLIC
    FRIENDS
    PRIVATE
  }

  """
  Who can send requests/messages.
  """
  enum AllowSetting {
    ANYONE
    FRIENDS
    FRIENDS_OF_FRIENDS
    NOBODY
  }

  """
  User privacy settings.
  """
  type UserPrivacy {
    activityVisibility: VisibilitySetting!
    libraryVisibility: VisibilitySetting!
    trophyVisibility: VisibilitySetting!
    friendRequestsFrom: AllowSetting!
    gameInvitesFrom: AllowSetting!
    messagesFrom: AllowSetting!
    showOnlineStatus: Boolean!
    showCurrentGame: Boolean!
  }

  """
  Extended user profile with gaming statistics.
  """
  type UserProfile {
    """Basic user info"""
    user: User!

    """Account creation date"""
    memberSince: String!

    """Profile background image URL"""
    backgroundUrl: String

    """Profile theme color"""
    themeColor: String

    """User's bio"""
    bio: String

    """Country/region"""
    region: String

    """Languages spoken"""
    languages: [String!]!

    """Privacy settings"""
    privacy: UserPrivacy!

    """Gaming statistics"""
    stats: UserStats!

    """Trophy showcase"""
    trophyShowcase: [TrophyShowcaseSlot]!
  }

  """
  User gaming statistics.
  """
  type UserStats {
    """Total games in library"""
    totalGames: Int!

    """Total playtime in hours"""
    totalPlaytimeHours: Float!

    """Trophy level"""
    trophyLevel: Int!

    """Progress to next level (0-100)"""
    trophyLevelProgress: Float!

    """Trophy counts by type"""
    trophies: TrophySummary!

    """Most played game"""
    mostPlayedGame: UserGame

    """Friend count"""
    friendCount: Int!
  }

  """
  A slot in the trophy showcase.
  """
  type TrophyShowcaseSlot {
    position: Int!
    achievement: Achievement!
    game: Game!
    unlockedAt: String!
  }

  # ===========================================================================
  # INPUT TYPES FOR GAMES
  # ===========================================================================

  """
  Input for starting a play session.
  """
  input StartSessionInput {
    """Game to play"""
    gameId: ID!

    """Current activity description"""
    activity: String

    """Whether session is joinable"""
    isJoinable: Boolean

    """Maximum party size"""
    maxPartySize: Int

    """Platform"""
    platform: String
  }

  """
  Input for sending a game invite.
  """
  input SendGameInviteInput {
    """User to invite"""
    toUserId: ID!

    """Optional message"""
    message: String
  }

  """
  Input for creating a voice room.
  """
  input CreateVoiceRoomInput {
    """Room name"""
    name: String!

    """Maximum participants"""
    maxParticipants: Int

    """Whether room is private"""
    isPrivate: Boolean

    """Associated game ID"""
    gameId: ID
  }

  """
  Input for updating profile.
  """
  input UpdateProfileInput {
    """Background image URL"""
    backgroundUrl: String

    """Theme color"""
    themeColor: String

    """Bio text"""
    bio: String

    """Region"""
    region: String

    """Languages"""
    languages: [String!]
  }

  """
  Input for updating privacy settings.
  """
  input UpdatePrivacyInput {
    activityVisibility: VisibilitySetting
    libraryVisibility: VisibilitySetting
    trophyVisibility: VisibilitySetting
    friendRequestsFrom: AllowSetting
    gameInvitesFrom: AllowSetting
    messagesFrom: AllowSetting
    showOnlineStatus: Boolean
    showCurrentGame: Boolean
  }
`;
