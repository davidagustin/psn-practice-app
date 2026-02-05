# GraphQL Design - PlayStation Network Backend

Comprehensive guide to GraphQL schema design, resolver patterns, and real-time subscriptions for the PSN backend.

## Table of Contents

1. [Why GraphQL for PSN](#why-graphql-for-psn)
2. [Schema Design Philosophy](#schema-design-philosophy)
3. [Type System](#type-system)
4. [Query Patterns](#query-patterns)
5. [Mutation Design](#mutation-design)
6. [Subscription Patterns](#subscription-patterns)
7. [Authentication & Authorization](#authentication--authorization)
8. [Error Handling](#error-handling)
9. [Federation for Microservices](#federation-for-microservices)
10. [Performance Optimization](#performance-optimization)
11. [Interview Questions](#interview-questions)

---

## Why GraphQL for PSN?

### REST vs GraphQL Trade-offs

**REST Approach (Problems):**
```
GET /api/friends                 // Fetch friend IDs
GET /api/users/id1, id2, ...    // Fetch profiles (multiple requests)
GET /api/presence/id1, id2, ... // Fetch presence data
GET /api/games/game1, game2     // Fetch games they're playing
Total: 4+ API calls per screen
```

**GraphQL Approach (Solution):**
```graphql
query GetFriendsWithStatus {
  friends(limit: 50) {
    user { id gamertag level }
    presence { status currentGame }
    isOnline
  }
}
# Single request with exact data needed
```

### PSN-Specific Benefits

| Benefit | Why It Matters |
|---------|----------------|
| **Mobile/Console Flexibility** | Mobile app needs less data than web dashboard. GraphQL lets each client request exactly what it needs without multiple API versions |
| **Real-time Built-in** | Subscriptions are first-class citizens, not bolted-on WebSockets |
| **Type Safety** | Clients can generate TypeScript types from schema. Break API = compile errors, not runtime errors |
| **No Over-fetching** | Mobile app on 4G saves bandwidth by not fetching unused fields |
| **Introspection** | Game developers can explore API via GraphQL playground without documentation |

---

## Schema Design Philosophy

### 1. Domain-Driven Design

The schema mirrors the domain model, not the database:

```typescript
// WRONG: Database-centric
type Query {
  getUsersTable(limit: Int): [UserRow!]!  // Exposes implementation
  getUserSessionsTable: [SessionRow!]!
}

// RIGHT: Domain-centric
type Query {
  friends(limit: Int): [FriendWithPresence!]!
  me: User!
  user(id: ID!): User
}
```

**Interview Tip:** "We define the GraphQL schema around the business domain (friends, presence, games) not the database schema. This shields clients from database changes."

### 2. Separation of Concerns

Separate types for different concerns:

```graphql
# User profile - relatively static
type User {
  id: ID!
  gamertag: String!
  level: Int!
  trophyCount: Int!
}

# Presence - highly dynamic, different TTL
type Presence {
  userId: ID!
  status: UserStatus!
  currentGame: String
  updatedAt: Float!
}

# Combined view for convenience
type FriendWithPresence {
  user: User!
  presence: Presence
  isOnline: Boolean!
}
```

**Why:** Different data has different characteristics:
- User profiles: Rarely change, cached long
- Presence: Changes constantly, short TTL
- Relationships: Moderate change frequency

### 3. Nullable vs Non-nullable

```graphql
# GOOD: Clear intent
type FriendWithPresence {
  user: User!              # Always present
  presence: Presence       # May be null if offline
  isOnline: Boolean!       # Convenience field
}

# BAD: Unclear what can be null
type FriendWithPresence {
  user: User
  presence: Presence
  isOnline: Boolean
}
```

**Pattern:**
- `!` (non-null) for data that's always present
- nullable for optional data
- Add comments explaining when null happens

---

## Type System

### Core Types Overview

```graphql
enum UserStatus {
  ONLINE      # Active and available
  AWAY        # Logged in but idle (>5 min no input)
  BUSY        # In game, do not disturb
  OFFLINE     # Not connected
  INVISIBLE   # Appears offline but can see others
}

type User {
  id: ID!
  gamertag: String!
  avatar: String!
  level: Int!
  trophyCount: Int!
  status: UserStatus!
  currentGame: String
  statusMessage: String
}

type Presence {
  userId: ID!
  gamertag: String!
  status: UserStatus!
  currentGame: String
  statusMessage: String
  lastActiveAt: Float!  # Unix timestamp for calculations
  updatedAt: Float!
}

type FriendWithPresence {
  user: User!
  presence: Presence    # null if offline
  isOnline: Boolean!
  lastOnlineAt: String  # ISO 8601 if offline
}
```

### Friend Request Types

```graphql
enum FriendRequestStatus {
  PENDING    # Waiting for response
  ACCEPTED   # Friendship created
  DECLINED   # Rejected by recipient
  CANCELED   # Withdrawn by sender
}

type FriendRequest {
  id: ID!
  fromUser: User!
  toUser: User!
  status: FriendRequestStatus!
  createdAt: String!  # ISO 8601
  updatedAt: String!
  message: String     # Optional sender message
}

type FriendStats {
  friendCount: Int!
  onlineFriendCount: Int!
  incomingRequestCount: Int!
  outgoingRequestCount: Int!
  blockedCount: Int!
}
```

### Message & Conversation Types

```graphql
enum MessageType {
  TEXT        # Regular text
  IMAGE       # Media file
  GAME_INVITE # Game invite embedded
  SYSTEM      # System-generated
}

enum ConversationType {
  DIRECT  # 1-on-1
  GROUP   # Multiple users
}

type Message {
  id: ID!
  conversationId: ID!
  senderId: ID!
  senderGamertag: String!  # Denormalized for speed
  content: String!
  type: MessageType!
  createdAt: String!
  readAt: String           # null = unread
}

type Conversation {
  id: ID!
  type: ConversationType!
  participantIds: [ID!]!
  participants: [User!]!   # Field resolver fetches users
  name: String             # For group chats
  lastMessage: Message
  unreadCount: Int!        # Per authenticated user
  createdAt: String!
  updatedAt: String!
}
```

### Input Types

```graphql
# Input for mutations should be specific, not general
input RegisterInput {
  gamertag: String!      # 3-16 chars, alphanumeric
  email: String!         # Valid email
  password: String!      # Min 8 chars, complexity
}

input LoginInput {
  identifier: String!    # Can be gamertag or email
  password: String!
}

input UpdatePresenceInput {
  status: UserStatus
  currentGame: String    # null to clear
  statusMessage: String
}

input SendMessageInput {
  conversationId: ID!
  content: String!
  type: MessageType      # Defaults to TEXT
}

input CreateConversationInput {
  participantIds: [ID!]!
  type: ConversationType!
  name: String           # Required for GROUP
}
```

---

## Query Patterns

### 1. The N+1 Problem

**What it is:** A common performance trap in GraphQL.

```graphql
# This looks innocent but causes problems
query GetFriends {
  friends(limit: 100) {          # 1 query
    user { id gamertag }         # Triggers 100 queries! (N+1)
    presence { status }          # Another 100 queries!
  }
}
```

### How Resolvers Cause It

```typescript
// WRONG: N+1 problem
async friends(parent, args, context) {
  const friendIds = await friendService.getFriends(userId);

  // Each map iteration is a separate query
  return friendIds.map(id => ({
    user: await authService.getUserById(id),      // 100 queries
    presence: await presenceService.get(id),       // 100 more
  }));
}

// RIGHT: Batch fetching
async friends(parent, args, context) {
  const friendIds = await friendService.getFriends(userId);

  // Batch fetch all at once
  const [users, presences] = await Promise.all([
    authService.getUsersByIds(friendIds),          // 1 query
    presenceService.getByIds(friendIds),           // 1 query
  ]);

  // Combine results
  return friendIds.map(id => ({
    user: users[id],
    presence: presences[id],
  }));
}
```

### 2. DataLoader for Batching

For nested types accessed multiple times in a query:

```typescript
// PROBLEM: Multiple queries for same data
query GetConversations {
  conversations {
    participants { id gamertag }      # 5 conversations × 4 participants = 20 queries!
  }
}
```

**Solution with DataLoader:**

```typescript
import DataLoader from 'dataloader';

// Create a DataLoader that batches requests
const userLoader = new DataLoader(async (userIds) => {
  // Called once with all requested IDs
  return authService.getUsersByIds(userIds);
});

// In resolver
Conversation: {
  participants: async (parent, args, context) => {
    // Each user fetched through loader
    return Promise.all(
      parent.participantIds.map(id => userLoader.load(id))
    );
  }
}
```

**How DataLoader Works:**
1. Request comes in for user #5
2. DataLoader queues it instead of querying
3. Request comes in for user #6
4. After all synchronous code runs, DataLoader batches: getUsersByIds([5, 6])
5. Returns results to requesters

### 3. Pagination Strategies

**Offset-based (Simple):**
```graphql
query {
  conversations(limit: 20, offset: 0) {
    id lastMessage { content }
  }
}
```

Pros: Simple, familiar from REST
Cons: Inefficient for large datasets, unstable with real-time data

**Cursor-based (Recommended):**
```graphql
query {
  conversations(first: 20, after: "cursor:123") {
    edges {
      cursor
      node { id lastMessage }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

Pros: Efficient, stable with real-time data, handles deletes
Cons: Slightly more complex

**Implementation Example:**

```typescript
type MessageConnection {
  edges: [MessageEdge!]!
  pageInfo: PageInfo!
}

type MessageEdge {
  cursor: String!
  node: Message!
}

type PageInfo {
  hasNextPage: Boolean!
  endCursor: String
}

type Query {
  messages(
    conversationId: ID!
    first: Int = 50
    after: String
  ): MessageConnection!
}
```

Resolver:
```typescript
messages: async (_, args, context) => {
  const { conversationId, first = 50, after } = args;

  // Decode cursor to get offset
  let offset = 0;
  if (after) {
    offset = parseInt(Buffer.from(after, 'base64').toString(), 10);
  }

  // Fetch one extra to know if more exist
  const messages = await chatService.getMessages(
    conversationId,
    offset,
    first + 1
  );

  const hasNextPage = messages.length > first;
  const pageMessages = messages.slice(0, first);

  return {
    edges: pageMessages.map((msg, idx) => ({
      cursor: Buffer.from((offset + idx).toString()).toString('base64'),
      node: msg,
    })),
    pageInfo: {
      hasNextPage,
      endCursor: pageMessages.length > 0
        ? Buffer.from((offset + pageMessages.length - 1).toString()).toString('base64')
        : null,
    },
  };
}
```

### 4. Fragment Reusability

```graphql
# Define once, use everywhere
fragment UserFields on User {
  id
  gamertag
  avatar
  level
}

query GetFriends {
  friends(limit: 50) {
    user { ...UserFields }
    presence { status currentGame }
  }
}

query GetSearchResults {
  searchUsers(query: "pro") {
    ...UserFields
  }
}
```

### 5. Query Examples from Schema

**Get friends with presence:**
```graphql
query GetFriends {
  friends(limit: 100, onlineOnly: true) {
    user {
      id gamertag avatar level
    }
    presence {
      status currentGame lastActiveAt
    }
    isOnline
  }
}
```

**Get friend suggestions with mutual friends:**
```graphql
query GetSuggestions {
  friendSuggestions(limit: 10) {
    user {
      id gamertag avatar
    }
    mutualFriendCount
    mutualFriendNames
  }
}
```

**Get activity feed:**
```graphql
query GetFeed {
  activityFeed(limit: 50, offset: 0) {
    id
    type          # GAME_STARTED, ACHIEVEMENT_UNLOCKED, etc.
    user { id gamertag avatar }
    title
    game { id title coverUrl }
    achievement { id name trophyType }
    createdAt
    likeCount
    isLiked
  }
}
```

---

## Mutation Design

### Naming Conventions

```graphql
# Good mutation names
sendFriendRequest(userId: ID!): FriendRequest!  # Clear action verb
acceptFriendRequest(userId: ID!): FriendWithPresence!
declineFriendRequest(userId: ID!): OperationResult!
removeFriend(userId: ID!): OperationResult!

# Avoid ambiguous names
# BAD: setFriendRequest, handleFriend, updateRequest

type Mutation {
  # Describe what each mutation does and returns
  sendMessage(input: SendMessageInput!): Message!
  markConversationAsRead(conversationId: ID!): OperationResult!
}
```

### Return Types Matter

```graphql
# Pattern 1: Return the modified object
mutation {
  sendMessage(input: { ... }) {
    id content createdAt      # Client knows mutation worked
  }
}

# Pattern 2: Return success/error
mutation {
  markConversationAsRead(conversationId: ID!) {
    success Boolean!          # Client knows if it worked
    message String!           # Can show error message
  }
}

# Pattern 3: Return union for complex cases
union MutationResult = Success | ValidationError | AuthError
mutation {
  acceptFriendRequest(userId: ID!): MutationResult
}
```

### Common Mutation Patterns

**Friend Request Flow:**

```typescript
// SEND FRIEND REQUEST
sendFriendRequest: async (_, args: { userId, message? }, context) => {
  const currentUserId = context.user.userId;

  // Validation
  if (currentUserId === args.userId) {
    throw new Error("Cannot friend yourself");
  }

  const isBlocked = await friendService.isBlocked(currentUserId, args.userId);
  if (isBlocked) {
    throw new Error("You have blocked this user");
  }

  // Check for reverse request (auto-accept)
  const reverseRequest = await friendService.getRequest(args.userId, currentUserId);
  if (reverseRequest?.status === 'PENDING') {
    // Auto-accept mutual intent
    await friendService.acceptRequest(currentUserId, args.userId);

    // Publish events
    pubsub.publish(`FRIEND_REQUEST_ACCEPTED.${args.userId}`, {
      friendRequestReceived: { /* ... */ }
    });
  } else {
    // Create new request
    await friendService.createRequest(currentUserId, args.userId, message);

    // Publish event to recipient
    pubsub.publish(`FRIEND_REQUEST_RECEIVED.${args.userId}`, {
      friendRequestReceived: { /* ... */ }
    });
  }

  return friendRequest;
}

// ACCEPT FRIEND REQUEST
acceptFriendRequest: async (_, args: { userId }, context) => {
  const currentUserId = context.user.userId;

  // Verify request exists
  const request = await friendService.getRequest(args.userId, currentUserId);
  if (!request) {
    throw new Error("No friend request from this user");
  }

  // Create bidirectional relationship
  await friendService.acceptRequest(currentUserId, args.userId);

  // Notify sender of acceptance
  pubsub.publish(`FRIEND_REQUEST_ACCEPTED.${args.userId}`, {
    friendEventReceived: {
      type: 'FRIEND_REQUEST_ACCEPTED',
      fromUser: { id: currentUserId, gamertag: context.user.gamertag },
    }
  });

  // Return new friend with presence
  const friendProfile = await authService.getUserById(args.userId);
  const presence = await presenceService.getPresence(args.userId);

  return {
    user: friendProfile,
    presence,
    isOnline: presence?.status !== 'OFFLINE',
  };
}
```

**Message Sending with Validation:**

```typescript
sendMessage: async (_, args: { input }, context) => {
  const userId = context.user.userId;
  const { conversationId, content } = args.input;

  // Validate conversation exists and user is participant
  const conversation = await chatService.getConversation(conversationId);
  if (!conversation) {
    throw new Error("Conversation not found");
  }
  if (!conversation.participantIds.includes(userId)) {
    throw new Error("Not a participant in this conversation");
  }

  // Validate message content
  if (!content || content.trim().length === 0) {
    throw new Error("Message cannot be empty");
  }
  if (content.length > 2000) {
    throw new Error("Message too long (max 2000 chars)");
  }

  // Check rate limits
  const recentMessageCount = await chatService.getRecentMessageCount(
    userId,
    conversationId,
    60000  // 1 minute
  );
  if (recentMessageCount >= 50) {
    throw new Error("Too many messages. Try again later");
  }

  // Create and store message
  const message = await chatService.createMessage({
    conversationId,
    senderId: userId,
    senderGamertag: context.user.gamertag,
    content,
    type: 'TEXT',
  });

  // Publish to subscribers
  pubsub.publish(`MESSAGE_RECEIVED.${conversationId}`, {
    messageReceived: message
  });

  // Update conversation timestamp
  await chatService.updateConversationTimestamp(conversationId);

  return message;
}
```

---

## Subscription Patterns

### 1. How Subscriptions Work

```
┌─────────────────────────────────────────────────────────────┐
│ GraphQL Subscription Flow                                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ 1. Client initiates WebSocket connection with auth token    │
│    ws://localhost:4000/graphql                             │
│                                                              │
│ 2. Client subscribes to event:                             │
│    subscription { friendPresenceUpdated { status } }       │
│                                                              │
│ 3. Server returns AsyncIterator from pubsub                │
│    pubsub.asyncIterator(['FRIEND_PRESENCE_UPDATED'])       │
│                                                              │
│ 4. When mutation publishes event:                          │
│    pubsub.publish('FRIEND_PRESENCE_UPDATED', { ... })     │
│                                                              │
│ 5. Server pushes to all subscribed clients over WebSocket  │
│                                                              │
│ 6. Client receives message and updates UI                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 2. Subscription Resolver Pattern

```typescript
Subscription: {
  // Simple subscription to global event
  friendPresenceUpdated: {
    subscribe: () => pubsub.asyncIterator(['FRIEND_PRESENCE_UPDATED'])
  },

  // Parameterized subscription (user-specific)
  userPresenceUpdated: {
    subscribe: (_, args: { userId }) => {
      return pubsub.asyncIterator([`USER_PRESENCE_UPDATED.${args.userId}`]);
    }
  },

  // Filtered subscription (only relevant events)
  friendRequestReceived: {
    subscribe: (_, __, context) => {
      const userId = context.user?.userId;
      if (!userId) {
        throw new Error('Authentication required');
      }
      // Only this user gets their own friend requests
      return pubsub.asyncIterator([`FRIEND_REQUEST.${userId}`]);
    }
  }
}
```

### 3. Publishing Events

From mutations:

```typescript
updatePresence: async (_, args: { input }, context) => {
  const userId = context.user.userId;

  // Update presence
  const presence = await presenceService.updatePresence(userId, {
    status: args.input.status,
    currentGame: args.input.currentGame,
  });

  // Publish to multiple channels
  pubsub.publish('FRIEND_PRESENCE_UPDATED', {
    friendPresenceUpdated: presence,
  });

  pubsub.publish(`USER_PRESENCE_UPDATED.${userId}`, {
    userPresenceUpdated: presence,
  });

  return presence;
}
```

### 4. Common Subscription Patterns

**Presence Updates:**
```graphql
subscription {
  friendPresenceUpdated {
    userId
    status
    currentGame
    updatedAt
  }
}

# With user-specific filter
subscription {
  userPresenceUpdated(userId: "alice-123") {
    status
    currentGame
  }
}
```

**Message Arrival:**
```graphql
subscription {
  messageReceived(conversationId: "conv-456") {
    id
    senderId
    senderGamertag
    content
    createdAt
  }
}
```

**Typing Indicators:**
```graphql
subscription {
  userTyping(conversationId: "conv-456") {
    userId
    gamertag
    isTyping  # true when typing, false when stopped
  }
}
```

**Friend Events:**
```graphql
subscription {
  friendEventReceived {
    type  # FRIEND_REQUEST_RECEIVED, FRIEND_ACCEPTED, etc.
    fromUser { gamertag }
    timestamp
  }
}
```

### 5. WebSocket Lifecycle

```typescript
// Apollo Server WebSocket configuration
const server = new ApolloServer({
  schema,
  plugins: {
    // Called when WebSocket connects
    async serverWillStart() {
      return {
        async drainServer() {
          // Called during shutdown - clean up subscriptions
          await wsServer.close();
        }
      };
    }
  }
});

// Context for WebSocket connections
context: async ({ req, connection }) => {
  // For HTTP requests
  if (req) {
    const token = req.headers.authorization?.split('Bearer ')[1];
    const user = validateToken(token);
    return { user };
  }

  // For WebSocket connections
  if (connection) {
    const token = connection.context.Authorization?.split('Bearer ')[1];
    const user = validateToken(token);
    return { user };
  }

  return { user: null };
}
```

### 6. Subscription with withFilter (Advanced)

For filtering events to specific clients:

```typescript
import { withFilter } from 'graphql-subscriptions';

Subscription: {
  // Only send presence updates for friends
  friendPresenceUpdated: {
    subscribe: withFilter(
      () => pubsub.asyncIterator(['FRIEND_PRESENCE_UPDATED']),

      // Filter function runs for each event
      async (payload, _, context) => {
        const userId = context.user?.userId;
        const friendIds = await friendService.getFriends(userId);

        // Only send if the presence update is for a friend
        return friendIds.includes(payload.friendPresenceUpdated.userId);
      }
    )
  },

  // Only send messages to conversation participants
  messageReceived: {
    subscribe: withFilter(
      (_, args) => pubsub.asyncIterator([
        `MESSAGE_RECEIVED.${args.conversationId}`
      ]),

      (payload, args, context) => {
        // Only send to conversation participants
        const userId = context.user?.userId;
        const conversation = payload.messageReceived.conversation;
        return conversation.participantIds.includes(userId);
      }
    )
  }
}
```

---

## Authentication & Authorization

### 1. Context Setup with JWT

```typescript
// In server setup
interface GraphQLContext {
  user: JWTPayload | null;    // null if unauthenticated
  session: UserSession | null;
  clientIp: string;
}

const server = new ApolloServer<GraphQLContext>({
  schema,
  context: async ({ req }) => {
    const token = req.headers.authorization?.split('Bearer ')[1];

    let user = null;
    if (token) {
      try {
        user = jwt.verify(token, process.env.JWT_SECRET);
      } catch (err) {
        // Invalid or expired token - user is null
      }
    }

    return {
      user,
      session: user ? await redis.get(`session:${user.userId}`) : null,
      clientIp: req.ip,
    };
  }
});
```

### 2. Auth Directives

```graphql
directive @auth on FIELD_DEFINITION
directive @authRole(role: String!) on FIELD_DEFINITION

type Query {
  me: User @auth                    # Requires authentication

  adminStats: [Stat!]!
    @authRole(role: "ADMIN")        # Requires admin role
}

type Mutation {
  sendMessage(input: SendMessageInput!): Message! @auth
}

type Subscription {
  notificationReceived: Notification! @auth
}
```

Directive implementation:

```typescript
const authDirective = {
  name: 'auth',
  visits: {
    FIELD_DEFINITION(field) {
      const originalResolve = field.resolve;

      field.resolve = async (source, args, context, info) => {
        if (!context.user) {
          throw new Error('Authentication required');
        }
        return originalResolve(source, args, context, info);
      };
    }
  }
};

const authRoleDirective = {
  name: 'authRole',
  visits: {
    FIELD_DEFINITION(field, details) {
      const role = details.args.role;
      const originalResolve = field.resolve;

      field.resolve = async (source, args, context, info) => {
        if (!context.user) {
          throw new Error('Authentication required');
        }

        if (context.user.role !== role) {
          throw new Error(`Requires ${role} role`);
        }

        return originalResolve(source, args, context, info);
      };
    }
  }
};
```

### 3. Field-Level Authorization

Authorization isn't just about existence - it's about visibility:

```typescript
// In resolvers
userProfile: async (_, args, context) => {
  const viewerId = context.user?.userId;
  const targetUserId = args.userId;

  if (!viewerId) {
    throw new Error('Authentication required');
  }

  // Check if viewer has permission to see target's profile
  const isFriend = await friendService.areFriends(viewerId, targetUserId);
  const isOwner = viewerId === targetUserId;

  if (!isOwner && !isFriend) {
    // Could return null, throw error, or partial data
    throw new Error('Cannot view this profile');
  }

  return profileService.getProfile(targetUserId, viewerId);
}
```

Different visibility levels:

```typescript
// Return different data based on relationship
type UserProfile {
  # Always visible
  user: User!

  # Only visible to self and friends
  email: String

  # Only visible to self
  phoneNumber: String

  # Visible based on privacy settings
  activityFeed: [Activity!]
}

UserProfile: {
  email: (parent, _, context) => {
    if (context.user?.userId === parent.user.id) {
      return parent.email;  // Can see own email
    }
    return null;  // Others can't see
  },

  activityFeed: async (parent, _, context) => {
    const privacy = parent.privacySettings.activityVisibility;

    if (privacy === 'PRIVATE') {
      // Only show to self
      if (context.user?.userId !== parent.user.id) return [];
    } else if (privacy === 'FRIENDS') {
      // Only show to friends and self
      const isFriend = await friendService.areFriends(
        context.user?.userId,
        parent.user.id
      );
      if (!isFriend && context.user?.userId !== parent.user.id) return [];
    }
    // privacy === 'PUBLIC': show to everyone

    return activityService.getFeed(parent.user.id);
  }
}
```

---

## Error Handling

### 1. GraphQL Errors vs Validation Errors

```graphql
# GraphQL Error - something wrong with the query itself
query {
  invalidField  # Field doesn't exist
}
# Returns: "Cannot query field 'invalidField'"

# Validation Error - data is invalid
mutation {
  sendMessage(input: { conversationId: "", content: "" })
}
# Should throw: "Message cannot be empty"
```

### 2. Structured Error Responses

```typescript
// Schema
type ValidationError {
  field: String!    # Which field has error
  message: String!  # What's wrong
}

union MutationResult =
  | Success
  | ValidationError
  | AuthenticationError

# In resolver
sendMessage: async (_, args, context) => {
  const { conversationId, content } = args.input;

  // Validate
  const errors = [];

  if (!conversationId) {
    errors.push({ field: 'conversationId', message: 'Required' });
  }

  if (!content?.trim()) {
    errors.push({ field: 'content', message: 'Cannot be empty' });
  }

  if (content.length > 2000) {
    errors.push({ field: 'content', message: 'Max 2000 characters' });
  }

  if (errors.length > 0) {
    return { type: 'VALIDATION_ERROR', errors };
  }

  // Rest of logic...
}
```

### 3. Error Logging and Tracing

```typescript
const server = new ApolloServer({
  schema,

  // Called when GraphQL errors occur
  formatError: (error, context) => {
    console.error(`GraphQL Error [${context.requestId}]:`, {
      message: error.message,
      path: error.path,
      query: context.query,
      variables: context.variables,
    });

    // Don't leak internal details to client
    if (error.message.includes('database')) {
      return { message: 'Internal server error' };
    }

    return error;
  },

  plugins: {
    async didEncounterErrors(context) {
      // Track errors
      for (const err of context.errors) {
        console.error(err);
      }
    }
  }
});
```

---

## Federation for Microservices

### Why Federation?

When you have multiple independent services (Auth, Games, Chat), you need a way to:
1. Combine their schemas into one unified API
2. Reference types across services
3. Resolve fields that require cross-service data

```
┌──────────────────────┐
│  API Gateway         │
│  (Apollo Gateway)    │
│                      │
│  Unified Schema      │
└──────────────────────┘
         ↓
    ┌────┴────┐
    ↓         ↓
┌────────┐  ┌────────┐
│Friends │  │ Games  │
│Service │  │Service │
└────────┘  └────────┘
```

### 2. Entity Resolution

In each subgraph service:

```typescript
// In friends-service subgraph
const friendsSchema = buildSubgraphSchema([
  {
    typeDefs: `
      extend schema
        @link(url: "https://specs.apollo.dev/federation/v2.0")

      type User @key(fields: "id") {
        id: ID!
        gamertag: String!
        friends: [User!]!
      }

      type Query {
        user(id: ID!): User
      }
    `
  }
]);

// Entity resolver handles references from other services
const resolveUserReference = async (user) => {
  return authService.getUserById(user.id);
};
```

In another service that needs User data:

```typescript
// In games-service subgraph
const gamesSchema = buildSubgraphSchema([
  {
    typeDefs: `
      extend schema
        @link(url: "https://specs.apollo.dev/federation/v2.0")

      extend type User @key(fields: "id") {
        id: ID! @external
        totalGamesPlayed: Int!
      }

      type Game {
        id: ID!
        title: String!
      }

      type Query {
        game(id: ID!): Game
      }
    `
  }
]);

// This extends User from another service
User: {
  totalGamesPlayed: async (user) => {
    return gameService.getUserGameCount(user.id);
  }
}
```

### 3. Subgraph Composition

```typescript
// Apollo Gateway orchestrates all subgraphs
const gateway = new ApolloGatewayWithManagedFederation({
  buildService({ url }) {
    return new DataSource({ url });
  }
});

const server = new ApolloServer({
  gateway,
  context: async ({ req }) => {
    return {
      user: validateToken(req.headers.authorization),
    };
  }
});
```

---

## Performance Optimization

### 1. Query Complexity Analysis

Prevent expensive queries:

```typescript
import { depthLimit, createComplexityLimitRule } from 'graphql-depth-limit';

const server = new ApolloServer({
  schema,
  validationRules: [
    // Limit query depth (prevent circular queries)
    depthLimit(8),

    // Limit complexity score
    createComplexityLimitRule({
      maxComplexity: 1000,
      variables: {},
      onComplete: (complexity) => {
        console.log('Query complexity:', complexity);
      },
      estimators: [
        // Friends: complexity 2 (one query to get friends + one to get profiles)
        (field) => {
          if (field.name === 'friends') return 2;
          // Messages: complexity = limit * depth
          if (field.name === 'messages') return 5; // typical limit is 50
          return 1;  // Default
        }
      ]
    })
  ]
});
```

### 2. Caching Strategies

```typescript
const server = new ApolloServer({
  cache: new BaseRedisCache({
    client: redisClient,
  }),

  typeDefs: `
    type User {
      id: ID!
      gamertag: String!  # Cache 1 hour
      level: Int!       # Cache 1 hour
    }

    type Presence {
      userId: ID!
      status: String!   # Cache 30 seconds (changes frequently)
      updatedAt: Float!
    }
  `,

  resolvers: {
    Query: {
      user: (_, args) => {
        // Cache-control directives control HTTP caching
        // Cache 1 hour for logged-out users, 5 min for logged-in
        return authService.getUserById(args.id);
      }
    }
  }
});
```

### 3. Response Size Limiting

```typescript
const server = new ApolloServer({
  plugins: {
    didResolveOperation(context) {
      // Estimate response size
      const complexity = estimateQueryComplexity(context.document);

      if (complexity > 50000) {  // 50KB limit
        throw new Error('Query response too large');
      }
    }
  }
});
```

### 4. Request Timeout

```typescript
const server = new ApolloServer({
  context: () => {
    return {
      timeout: setTimeout(() => {
        throw new Error('Request timeout');
      }, 5000)  // 5 second limit
    };
  }
});
```

---

## Interview Questions

### Question 1: N+1 Problem

**Q: Explain the N+1 problem in GraphQL. How do you solve it?**

**A:** "The N+1 problem occurs when a query makes one initial request, then N additional requests for related data.

Example - fetching 100 friends and their presence:
```
1 query: Get 100 friend IDs
100 queries: Get each friend's profile
100 queries: Get each friend's presence
Total: 201 queries (1 + N + N)
```

**Solutions:**
1. **Batch Fetching:** Fetch all related data at once
   - Use `Promise.all([getUsersByIds(ids), getPresenceByIds(ids)])`
   - Reduces to 3 queries: friends + profiles + presence

2. **DataLoader:** Automatically batch requests within a GraphQL execution
   - Queues duplicate requests
   - Batches them after synchronous code completes
   - Library handles ordering

3. **Field Selectors:** Let resolvers see what fields are requested
   - Don't fetch presence if it's not in the query
   - Use `info.fieldNodes` to inspect requested fields

4. **Fragments:** Reuse query patterns
   - Define once, use everywhere
   - Ensures consistent data fetching

I solved it in the friends resolver by batching user profiles and presence in parallel."

---

### Question 2: Subscription Architecture

**Q: How do you implement real-time presence updates using subscriptions?**

**A:** "Subscriptions use a three-layer architecture:

**Layer 1: Client Subscription**
```graphql
subscription {
  friendPresenceUpdated {
    userId status currentGame
  }
}
```

**Layer 2: Server Subscription Resolver**
```typescript
Subscription: {
  friendPresenceUpdated: {
    subscribe: () => pubsub.asyncIterator(['FRIEND_PRESENCE_UPDATED'])
  }
}
```

**Layer 3: Publishing from Mutations**
When presence changes, we publish:
```typescript
pubsub.publish('FRIEND_PRESENCE_UPDATED', {
  friendPresenceUpdated: newPresence
});
```

**Data Flow:**
1. User opens app → WebSocket connects with auth token
2. Client subscribes → Server holds AsyncIterator
3. User changes status → Mutation updates presence + publishes
4. All connected clients receive update via WebSocket

**Scaling Considerations:**
- Single-server: In-memory PubSub works
- Multi-server: Use Redis Pub/Sub so all servers receive events
- Filtering: Use `withFilter()` to only send relevant updates
  - Only send friend presence to users who have them as friends
  - Only send messages to conversation participants

**Common Gotchas:**
- Users won't get events published before they subscribed
- Subscriptions don't persist - lost on disconnect
- Need manual reconnection logic on client"

---

### Question 3: Authentication in GraphQL

**Q: How do you handle authentication in GraphQL?**

**A:** "Authentication happens in three places:

**1. Context Creation** (per request)
```typescript
context: async ({ req }) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  let user = null;

  if (token) {
    try {
      user = jwt.verify(token, SECRET);
    } catch (err) {
      // Invalid token - let it fail in resolver
    }
  }

  return { user };
}
```

**2. Resolver-Level Checks**
```typescript
me: async (_, __, context) => {
  if (!context.user) {
    throw new Error('Authentication required');
  }
  return authService.getUserById(context.user.userId);
}
```

**3. Schema-Level Directives**
```graphql
type Query {
  me: User @auth              # Requires any authentication
  adminStats: Stat @admin     # Requires admin role
}
```

**Differences from REST:**
- **REST:** Usually hidden behind HTTP middleware (all endpoints protected)
- **GraphQL:** Single endpoint, must protect per-field

**JWT Token Content:**
```typescript
interface JWTPayload {
  userId: string;        // Quick user ID lookup
  gamertag: string;      // For display without DB query
  role?: string;         // For authorization checks
  iat: number;           // Issued at
  exp: number;           // Expiration (typically 24 hours)
}
```

**Token Lifecycle:**
1. User logs in → Generate JWT with 24h expiration
2. Client sends token in `Authorization: Bearer <token>` header
3. Server verifies signature and expiration
4. If expired → 401 response, client must refresh
5. Optional: Use refresh tokens for long-lived sessions

**Security Best Practices:**
- Store JWT in httpOnly cookies (not localStorage for web)
- Include CSRF token for state-changing operations
- Validate token expiration on every request
- Use strong secret (minimum 32 characters)
- Rotate secrets periodically"

---

### Question 4: Mutation Design

**Q: What makes a well-designed GraphQL mutation?**

**A:** "Good mutations have four characteristics:

**1. Clear Intent**
```graphql
# Good: Verb + noun clearly indicates action
sendFriendRequest(userId: ID!): FriendRequest!
acceptFriendRequest(userId: ID!): FriendWithPresence!

# Bad: Vague or overloaded
manageFriendRequest(userId: ID!, action: String!): Result
updateFriendRequest(userId: ID!, data: JSON!): Result
```

**2. Explicit Input Objects**
```graphql
# Good: Structured input type
mutation {
  sendMessage(input: SendMessageInput!) { id }
}

input SendMessageInput {
  conversationId: ID!
  content: String!
  type: MessageType
}

# Bad: Too many parameters
mutation {
  sendMessage(
    conversationId: ID!
    content: String!
    type: String
    metadata: String
    attachments: String
  ) { id }
}
```

**3. Meaningful Return Type**
```graphql
# Pattern 1: Return modified object
mutation {
  sendMessage(input: {...}) {
    id content createdAt  # Client sees what was created
  }
}

# Pattern 2: Return success + object
mutation {
  sendMessage(input: {...}) {
    success Boolean!
    message: Message
  }
}

# Pattern 3: Return result union for complex errors
union SendMessageResult = Message | ValidationError | RateLimitError
```

**4. Atomic Operations**
- One mutation = one business operation
- Either fully succeeds or fully fails
- Use transactions in databases when needed

```typescript
// Good: One mutation handles entire flow
acceptFriendRequest: async (_, args, context) => {
  // 1. Verify request exists
  // 2. Create friendship bidirectionally
  // 3. Update stats
  // 4. Notify both users
  // All in one transaction or careful error handling
}

// Bad: Mutation leaves inconsistent state
acceptFriendRequest: async (_, args, context) => {
  // Updates only one side of friendship
  // Notification published before DB updated
  // Race conditions possible
}
```

**Error Handling:**
- Throw meaningful errors that help clients know what failed
- Include error codes for programmatic handling
- Don't leak internal database errors to clients"

---

### Question 5: Pagination at Scale

**Q: A user has 50,000 friends. How would you paginate their friend list efficiently?**

**A:** "Offset-based pagination breaks down at scale:

**Problem with Offset:**
```
users = all_friends.slice(offset=40000, limit=20)
```
- Must skip/iterate through 40,000 records
- Slow as offset increases
- Becomes inconsistent with real-time deletions

**Solution: Cursor-based Pagination**

**Schema:**
```graphql
type FriendConnection {
  edges: [FriendEdge!]!
  pageInfo: PageInfo!
}

type FriendEdge {
  cursor: String!
  node: FriendWithPresence!
}

type PageInfo {
  hasNextPage: Boolean!
  endCursor: String
  hasPreviousPage: Boolean!
  startCursor: String
}
```

**Implementation:**
```typescript
friends: async (_, args, context) => {
  const userId = context.user.userId;

  // Decode cursor (base64 encoded offset)
  let offset = 0;
  if (args.after) {
    offset = parseInt(Buffer.from(args.after, 'base64').toString());
  }

  // Fetch one extra to determine hasNextPage
  const limit = args.first || 50;
  const friends = await friendService.getFriends(
    userId,
    offset,
    limit + 1
  );

  const hasNextPage = friends.length > limit;
  const pageItems = friends.slice(0, limit);

  return {
    edges: pageItems.map((friend, idx) => ({
      cursor: Buffer.from((offset + idx).toString()).toString('base64'),
      node: friend
    })),
    pageInfo: {
      hasNextPage,
      endCursor: pageItems.length > 0
        ? Buffer.from((offset + pageItems.length - 1).toString()).toString('base64')
        : null
    }
  };
}
```

**Why Cursors Win:**
1. **Performance:** O(1) lookup by cursor, not O(n) skip
2. **Consistency:** Works correctly even if items are deleted
3. **Stability:** Results don't shift when data changes
4. **Efficiency:** Only fetch what you need

**For 50,000 Friends at Scale:**
- Redis Sorted Set with friend ID as member, join timestamp as score
- `ZRANGE user:123:friends offset, offset+limit` is O(log(n) + k)
- Even at 50M friends, latency is milliseconds
- With Redis Cluster, shard by user ID for parallel access"

---

### Question 6: Real-time Presence System Design

**Q: Design a presence system that updates friends when someone goes online/offline. What are the challenges?**

**A:** "**Requirements:**
1. Sub-second updates (feel instant)
2. Handle 100M+ users efficiently
3. Survive server failures
4. Support multiple devices

**Architecture:**

```
┌─────────────────────────────────────────┐
│ User Opens App on Mobile                │
├─────────────────────────────────────────┤
│ 1. WebSocket connects with auth token   │
│ 2. Presence service receives connection │
│ 3. Sets presence in Redis: ONLINE       │
│    Key: presence:user:123               │
│    TTL: 5 minutes (requires heartbeat)  │
│ 4. Publishes to Redis Pub/Sub           │
│    Channel: presence:updates            │
│ 5. All server instances receive event   │
│ 6. Filter: Find who has user as friend  │
│ 7. Push via WebSocket to those clients  │
└─────────────────────────────────────────┘
```

**Data Structure in Redis:**
```
presence:user:123456 = {
  userId: "123456",
  gamertag: "ProGamer",
  status: "ONLINE",
  currentGame: "Elden Ring",
  lastActiveAt: 1706000000,
  updatedAt: 1706000010
}
TTL: 300 seconds (5 minutes)
```

**Heartbeat Mechanism:**
```typescript
// Client heartbeats every 60 seconds
setInterval(() => {
  client.send({
    type: 'heartbeat'
  });
}, 60000);

// Server receives heartbeat
onHeartbeat: async (userId) => {
  // Refresh Redis key TTL
  await redis.expire(`presence:${userId}`, 300);

  // Don't need to republish (no status change)
}
```

**Going Offline:**
```
Option 1: Heartbeat expires (after 5 min inactivity)
Option 2: User closes app → send explicit offline
Option 3: Connection drop → server detects in 60 sec

Event published: presence:updates
Subscribers notified → Friends see offline
```

**Challenges & Solutions:**

| Challenge | Solution |
|-----------|----------|
| User with 100k friends online → Don't publish to everyone, filter to actual friends | Use withFilter() in subscription, check friendIds in memory |
| Network lag → Status change seen 500ms later | Acceptable for this use case (human perception threshold ~200ms) |
| Server down → Presence lost | Can recover from DynamoDB (slower) |
| Multiple devices → Which one is actual status? | Last-active wins. Device ID in presence data |
| Presence storms (many users online at same time) → Redis overload | Batch updates, rate limit presences |

**Scaling to 100M Users:**
- Redis Cluster with consistent hashing
- Shard by userId: hash(userId) % shardCount
- Each shard handles ~10M users
- Pub/Sub distributes across all shards
- Server instances subscribe to all shards"

---

### Question 7: Message Ordering Guarantees

**Q: How do you guarantee message ordering in chat? What if Server A and Server B both process a message?**

**A:** "**The Problem:**

```
Server A receives Message 1 from User A → Publishes
Server B receives Message 2 from User A → Publishes
                                         ↓
Clients receive in wrong order (depends on network)
```

**Solutions:**

**1. Database Ordering (Gold Standard)**
```typescript
// Message stored with:
{
  id: UUID,                      // Unique per message
  conversationId: "conv-123",
  sequenceNumber: 42,            // Ordered per conversation!
  senderId: "user-123",
  content: "Hello",
  createdAt: 1706000000000       // Precise timestamp
}
```

**Per-conversation sequence number:**
```typescript
sendMessage: async (_, args, context) => {
  const message = await db.transaction(async (txn) => {
    // Get next sequence number atomically
    const nextSeq = await txn
      .table('messages')
      .filter({ conversationId })
      .count() + 1;

    // Create message with sequence
    return txn.table('messages').insert({
      ...message,
      sequenceNumber: nextSeq
    });
  });

  return message;
}
```

**Client Sorts by Sequence:**
```typescript
messages.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
```

**Why This Works:**
- Sequence number is per-conversation (scoped)
- Atomic - database guarantees uniqueness
- Works even if messages arrive out of order
- Can detect missing messages (gaps in sequence)

**2. Timestamp Ordering (Secondary)**
- If servers have synchronized clocks (NTP)
- Sort by createdAt, then by ID for ties
- Less reliable than sequence numbers

**3. Redis Streams (For High Throughput)**
```typescript
// Redis maintains order inherently
redis.xadd(`stream:conv:${convId}`, '*', {
  userId: senderId,
  content: messageContent,
  timestamp: Date.now()
});

// Client retrieves in order
messages = redis.xrange(`stream:conv:${convId}`, '-', '+');
```

**Complete Flow with Guarantees:**
```
1. Message arrives at Server A
2. Database transaction generates sequence
3. Message stored with seq=42
4. Published to Redis Pub/Sub
5. Server B's client subscription receives
6. Client inserts message into conversation
7. UI re-sorts by sequence number
8. User sees correct order regardless of timing
```

**Edge Cases:**
- **Deleted message:** Keep seq number, show as [deleted]
- **Edited message:** Sequence doesn't change, only content
- **Lost message:** Client can detect gaps in sequence"

---

### Question 8: Rate Limiting in GraphQL

**Q: How would you rate limit GraphQL mutations to prevent abuse?**

**A:** "**Multi-Level Approach:**

**Level 1: Operation Type**
```typescript
// Mutations are riskier than queries
const limits = {
  queries: { perMinute: 1000, perHour: 10000 },
  mutations: { perMinute: 100, perHour: 1000 },
  subscriptions: { concurrent: 10 }
}
```

**Level 2: Specific Mutation Limits**
```typescript
const mutationLimits = {
  sendMessage: { perMinute: 50 },       // Can send 50 msgs/min
  sendFriendRequest: { perDay: 100 },   // Can send 100 requests/day
  updatePresence: { perSecond: 10 }     // Can update 10x per sec
}
```

**Level 3: Implementation with Redis**
```typescript
import { RateLimiterRedis } from 'rate-limiter-flexible';

const limiter = new RateLimiterRedis({
  storeClient: redisClient,
  points: 100,               // 100 points per window
  duration: 60,              // 1 minute window
  blockDurationSeconds: 60   // Block for 1 minute if exceeded
});

// In resolver
sendMessage: async (_, args, context) => {
  const userId = context.user.userId;

  try {
    // Consume 1 point from this user's limit
    await limiter.consume(userId, 1);
  } catch (rejRes) {
    const secondsToRetry = Math.round(rejRes.msBeforeNext / 1000);
    throw new Error(
      `Too many messages. Retry in ${secondsToRetry} seconds`
    );
  }

  // Process mutation...
  return chatService.sendMessage(...);
}
```

**Advanced: Query Complexity Limiting**
```typescript
// Prevent expensive queries (like fetching 10k friends)
const getComplexity = (query) => {
  let complexity = 1;

  // Each friend takes 2 points (user + presence)
  if (query.includes('friends')) complexity += args.limit * 2;

  // Each message takes 1 point
  if (query.includes('messages')) complexity += args.limit * 1;

  return complexity;
};

// Enforce complexity limit per second
const complexityLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  points: 5000,      // 5000 complexity points per second
  duration: 1
});

didResolveOperation: async (context) => {
  const complexity = getComplexity(context.document);
  await complexityLimiter.consume(context.userId, complexity);
}
```

**Progressive Backoff:**
```typescript
// First violation: Warn
// Second violation: 1 minute block
// Third violation: 1 hour block

const userViolations = await redis.incr(`violations:${userId}`);
const violations = userViolations;

const blockDuration = {
  1: 60,           // 1 minute
  2: 3600,         // 1 hour
  3: 86400         // 1 day
}[violations] || 86400;

await redis.expire(`violations:${userId}`, blockDuration);
```

**Handling Rate Limit in Apollo Client:**
```typescript
new ApolloClient({
  link: new HttpLink({
    uri: 'http://localhost:4000/graphql',
    credentials: 'include',
    fetch: async (...args) => {
      const response = await fetch(...args);

      if (response.status === 429) {  // Too Many Requests
        // Exponential backoff
        const delay = Math.pow(2, retries) * 1000;
        setTimeout(() => retry(), delay);
      }

      return response;
    }
  })
});
```"

---

### Question 9: Schema Versioning

**Q: How do you evolve a GraphQL schema without breaking clients?**

**A:** "GraphQL's strength is that you can add fields without versioning:

**Adding Fields (Safe):**
```graphql
# Before
type User {
  id: ID!
  gamertag: String!
}

# After (Just add)
type User {
  id: ID!
  gamertag: String!
  level: Int!           # New field - old clients work fine
  trophyCount: Int!     # New field
}
```

Old clients ignore new fields. New clients can request them.

**Removing Fields (Breaking):**
```graphql
# Need deprecation period first
type User {
  id: ID!
  gamertag: String!
  email: String! @deprecated(reason: "Use userProfile.email instead")
}
```

**Deprecation Process:**
1. Mark field as `@deprecated`
2. Client should migrate (6-12 months)
3. Monitor deprecation usage via logging
4. Remove field once usage drops below threshold

**Changing Field Type (Breaking):**
```graphql
# Before
type User {
  level: Int!
}

# Can't directly change to String

# Solution: Add new field, deprecate old
type User {
  level: Int! @deprecated(reason: "Use levelV2")
  levelV2: UserLevel!
}

type UserLevel {
  current: Int!
  progress: Float!  # Can have more data now
}
```

**Renaming Field (Breaking):**
```graphql
# Solution: Add alias
type User {
  gamertag: String!
  username: String!  # New preferred name

  # Later: deprecate old name
  gamertag: String! @deprecated(reason: "Use username")
}

# Or use field aliases
query {
  user(id: \"123\") {
    username: gamertag  # Client aliases old field
  }
}
```

**Changing Argument (Breaking):**
```graphql
# Before
friends(limit: Int, offset: Int)

# After: Add cursor-based, deprecate offset
friends(
  first: Int
  after: String
  limit: Int @deprecated    # Old way
  offset: Int @deprecated   # Old way
)
```

**Best Practices:**
1. Design schema to be forward/backward compatible
2. Use `@deprecated` for 6-12 months before removal
3. Monitor via Apollo Sandbox which fields clients use
4. Never remove fields without warning period
5. Make new fields optional (nullable) by default
6. Add feature flags for large changes

**Internal vs Public Schemas:**
```
Internal (between your services):
- Can make breaking changes freely
- Use `@internal` directive
- Document well

Public (to clients):
- Strict versioning
- Long deprecation periods
- Monitor usage carefully
```"

---

### Question 10: Subscription Memory Management

**Q: If 100,000 users subscribe to friend presence updates, how do you prevent memory leaks?**

**A:** "**The Problem:**

```
Per subscription:
- AsyncIterator object: ~1KB
- Subscription context: ~2KB
- Event listener: ~0.5KB
Total: ~3.5KB per subscription

100,000 subscriptions × 3.5KB = 350MB
1,000,000 subscriptions = 3.5GB

Memory grows unbounded if subscriptions aren't cleaned up.
```

**Solutions:**

**1. Automatic Cleanup on Disconnect**
```typescript
const server = new ApolloServer({
  plugins: {
    async serverWillStart() {
      return {
        async drainServer() {
          // Called on graceful shutdown
          await subscriptionsServer.close();
        }
      };
    },

    async didResolveOperation(context) {
      // Track subscription lifecycle
      context.subscriptionId = uuid();
    }
  }
});

// When client disconnects
connection.on('close', () => {
  subscriptions.delete(subscriptionId);
  pubsub.unsubscribe(subscriptionId);
});
```

**2. Subscription Limits Per User**
```typescript
const MAX_SUBSCRIPTIONS_PER_USER = 5;

Subscription: {
  friendPresenceUpdated: {
    subscribe: async (_, __, context) => {
      const userId = context.user.userId;

      // Count active subscriptions
      const activeCount = await redis.incr(
        `subscriptions:${userId}`
      );

      if (activeCount > MAX_SUBSCRIPTIONS_PER_USER) {
        throw new Error('Too many active subscriptions');
      }

      // Return iterator
      const iterator = pubsub.asyncIterator(...);

      // Cleanup on completion
      iterator.finally(() => {
        redis.decr(`subscriptions:${userId}`);
      });

      return iterator;
    }
  }
}
```

**3. Subscription Timeout**
```typescript
const SUBSCRIPTION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

subscriptionManager.setTimeout(subscriptionId, SUBSCRIPTION_TIMEOUT);

// If no messages in 24 hours, clean up
subscriptions.on('timeout', (id) => {
  pubsub.unsubscribe(id);
  redis.del(`subscription:${id}`);
});
```

**4. Memory Monitoring**
```typescript
setInterval(() => {
  const memUsage = process.memoryUsage();
  const heapUsedPercent = memUsage.heapUsed / memUsage.heapTotal;

  if (heapUsedPercent > 0.85) {
    // Aggressive cleanup
    logger.warn('Memory usage high, force cleanup');
    subscriptions.forceCleanup();
  }
}, 30000);
```

**5. With Redis for Scalability**
```typescript
// Instead of in-memory PubSub
import RedisPubSub from 'graphql-redis-subscriptions';

const pubsub = new RedisPubSub({
  connection: redisClient
});

// Subscriptions stored in Redis, not application memory
// Scales to millions of subscriptions
// Automatic cleanup via Redis TTL
```

**6. Using graphql-ws (Modern Approach)**
```typescript
// graphql-ws has better cleanup than old apollo-subscriptions

import { makeServer } from 'graphql-ws';

const wsServer = makeServer({
  schema,
  onConnect: (ctx) => {
    // Authenticate connection
    return true;
  },
  onDisconnect: (ctx) => {
    // Automatic cleanup
    ctx.connectionParams = null;
  }
});

// Connections cleaned up automatically on disconnect
```

**Testing for Leaks:**
```typescript
// Load test
const clients = [];
for (let i = 0; i < 10000; i++) {
  const ws = new WebSocket('ws://localhost:4000/graphql');
  ws.send(JSON.stringify({
    id: '1',
    type: 'start',
    payload: { query: 'subscription { friendPresenceUpdated }' }
  }));
  clients.push(ws);
}

// Monitor memory
setInterval(() => {
  console.log('Memory:', process.memoryUsage().heapUsed / 1024 / 1024, 'MB');
}, 1000);

// Disconnect all
setTimeout(() => {
  clients.forEach(c => c.close());
  // Memory should drop back down
}, 60000);
```

**Bottom Line:** With proper cleanup + Redis Pub/Sub, you can handle 1M+ concurrent subscriptions across a cluster."

---

## Summary

| Topic | Key Takeaway |
|-------|--------------|
| **Schema Design** | Match domain model, not database. Separate concerns (User vs Presence) |
| **N+1 Problem** | Batch fetch all related data in one resolver, use DataLoader for nested types |
| **Pagination** | Use cursor-based for scale, offset-based for small datasets |
| **Authentication** | JWT in context, check per field, use directives for authorization |
| **Mutations** | Clear action verbs, input types, meaningful return values, atomic operations |
| **Subscriptions** | AsyncIterator pushed via WebSocket, publish from mutations, filter by relationship |
| **Real-time** | Redis Pub/Sub for multi-server, heartbeat for timeout, sequence numbers for order |
| **Performance** | Batch loading, caching, complexity limits, rate limiting |
| **Versioning** | Add fields freely, deprecate old ones, monitor usage |

---

## References

- [GraphQL Best Practices](https://graphql.org/learn/best-practices/)
- [Apollo Server Documentation](https://www.apollographql.com/docs/apollo-server/)
- [GraphQL DataLoader](https://github.com/graphql/dataloader)
- [GraphQL Cursor Pagination](https://relay.dev/docs/guides/graphql-server-specification/)

---

**Last Updated:** 2025-02-04
