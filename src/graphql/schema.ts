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
    """
    friends: [FriendWithPresence!]!

    """
    Get pending friend requests.

    AUTHENTICATION: Required
    """
    friendRequests: [User!]!

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
    Send a friend request.

    AUTHENTICATION: Required
    """
    sendFriendRequest(userId: ID!): OperationResult!

    """
    Accept a friend request.

    AUTHENTICATION: Required
    """
    acceptFriendRequest(userId: ID!): OperationResult!

    """
    Decline a friend request.

    AUTHENTICATION: Required
    """
    declineFriendRequest(userId: ID!): OperationResult!

    """
    Remove a friend.

    AUTHENTICATION: Required
    """
    removeFriend(userId: ID!): OperationResult!

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
    # NOTIFICATION SUBSCRIPTIONS
    # -------------------------------------------------------------------------

    """
    Subscribe to new notifications.

    AUTHENTICATION: Required

    Fires when user receives any notification.
    """
    notificationReceived: Notification!
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
`;
