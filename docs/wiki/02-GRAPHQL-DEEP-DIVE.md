# GraphQL Deep Dive

This document covers GraphQL concepts used in the PlayStation Network practice app.

---

## Table of Contents

1. [Why GraphQL?](#why-graphql)
2. [Schema Design](#schema-design)
3. [Resolver Architecture](#resolver-architecture)
4. [The N+1 Problem](#the-n1-problem)
5. [Subscriptions](#subscriptions)
6. [Authentication](#authentication)
7. [Error Handling](#error-handling)
8. [Caching Strategies](#caching-strategies)

---

## Why GraphQL?

### GraphQL vs REST Comparison

| Aspect | REST | GraphQL |
|--------|------|---------|
| **Endpoints** | Multiple (/users, /friends, /messages) | Single (/graphql) |
| **Data Fetching** | Fixed response shape | Client specifies exactly what it needs |
| **Over-fetching** | Common (get all user fields) | Never (request only needed fields) |
| **Under-fetching** | Common (multiple roundtrips) | Never (get related data in one query) |
| **Versioning** | URL versions (/v1, /v2) | Field deprecation |
| **Real-time** | Separate WebSocket API | Built-in Subscriptions |
| **Type Safety** | Optional (Swagger) | Enforced by schema |

### Why PlayStation Uses GraphQL

1. **Multiple Clients**: PlayStation App (mobile), Console UI, Web - each needs different data
2. **Bandwidth Optimization**: Mobile users shouldn't download unnecessary data
3. **Real-time Features**: Presence, messaging, game invites need subscriptions
4. **Rapid Development**: Frontend can request new fields without backend changes

```graphql
# Mobile app only needs basic info
query MobileFriendList {
  friends {
    user { gamertag avatar }
    isOnline
  }
}

# Console UI needs full details
query ConsoleFriendList {
  friends {
    user {
      gamertag
      avatar
      level
      trophyCount
      currentGame
      statusMessage
    }
    presence {
      status
      currentGame
      lastActiveAt
    }
    isOnline
  }
}
```

---

## Schema Design

### Schema Definition Language (SDL)

```graphql
# Types define the shape of data
type User {
  id: ID!           # ! means non-null
  gamertag: String!
  level: Int!
  friends: [User!]! # Array of non-null Users
}

# Enums for fixed values
enum UserStatus {
  ONLINE
  AWAY
  BUSY
  OFFLINE
}

# Input types for mutations
input RegisterInput {
  gamertag: String!
  email: String!
  password: String!
}
```

### Type Relationships

```graphql
type User {
  id: ID!
  gamertag: String!
  # Resolved by separate resolver
  friends: [FriendWithPresence!]!
  # Resolved by separate resolver
  presence: Presence
}

type FriendWithPresence {
  user: User!           # Reference to User type
  presence: Presence    # Nullable - might be offline
  isOnline: Boolean!
}
```

### Documentation in Schema

```graphql
"""
A user on the PlayStation Network.

This type represents the PUBLIC profile - sensitive fields
like email and password are never exposed.
"""
type User {
  """Unique identifier (UUID format)"""
  id: ID!

  """Display name visible to other players (3-16 characters)"""
  gamertag: String!
}
```

---

## Resolver Architecture

### Resolver Function Signature

```typescript
// All resolvers receive four arguments
fieldName: (parent, args, context, info) => result

// parent: Return value from parent resolver
// args: Arguments passed to this field
// context: Shared request context (user, services)
// info: Field-specific info (rarely used)
```

### Resolver Chain

```graphql
query {
  me {           # Query.me resolver
    gamertag     # Default resolver (parent.gamertag)
    friends {    # User.friends resolver
      user {     # FriendWithPresence.user resolver
        gamertag # Default resolver (parent.gamertag)
      }
    }
  }
}
```

### Resolver Implementation

```typescript
const resolvers = {
  Query: {
    // Root resolver - parent is undefined
    me: async (_, __, context) => {
      return authService.getUserById(context.user.userId);
    },
  },

  User: {
    // Type resolver - parent is User object
    friends: async (parent, args, context) => {
      // parent.id is the user's ID
      const friendIds = await friendService.getFriends(parent.id);
      return authService.getUsersByIds(friendIds);
    },
  },

  // Default resolvers: GraphQL returns parent[fieldName]
  // No need to write resolver for simple fields
};
```

### Context Setup

```typescript
// In server.ts - context is created per request
context: async ({ req }) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  let user = null;
  if (token) {
    user = await authService.validateToken(token);
  }

  return {
    user,                    // Authenticated user
    clientIp: req.ip,       // For rate limiting
    requestId: uuidv4(),    // For tracing
  };
}
```

---

## The N+1 Problem

### The Problem

```graphql
query {
  friends {     # 1 query: Get 100 friend IDs
    user {      # 100 queries: Get each user by ID!
      gamertag
    }
    presence {  # 100 queries: Get each presence!
      status
    }
  }
}
# Total: 201 queries for 100 friends!
```

### Solution 1: Batch Fetching

```typescript
friends: async (_, args, context) => {
  const userId = context.user.userId;

  // 1 query: Get all friend IDs
  const friendIds = await friendService.getFriends(userId);

  // 1 query: Batch fetch all users (MGET or BatchGetItem)
  const users = await authService.getUsersByIds(friendIds);

  // 1 query: Batch fetch all presence (Redis MGET)
  const presenceMap = await presenceService.getPresenceMultiple(friendIds);

  // Combine in memory
  return friendIds.map(id => ({
    user: users.find(u => u.id === id),
    presence: presenceMap.get(id),
    isOnline: presenceMap.has(id),
  }));
};
// Total: 3 queries regardless of friend count!
```

### Solution 2: DataLoader

```typescript
// Create DataLoader in context (per-request)
context: async ({ req }) => ({
  user: await validateToken(req),
  loaders: {
    users: new DataLoader(async (ids) => {
      const users = await authService.getUsersByIds(ids);
      // Return in same order as requested IDs
      return ids.map(id => users.find(u => u.id === id));
    }),
  },
});

// Use in resolver
User: {
  friends: async (parent, _, context) => {
    const friendIds = await friendService.getFriends(parent.id);
    // DataLoader batches all load() calls in same tick
    return Promise.all(friendIds.map(id =>
      context.loaders.users.load(id)
    ));
  },
}
```

**DataLoader Features:**
- **Batching**: Collects all load() calls in one tick, executes single batch
- **Caching**: Same ID in one request returns cached result
- **Per-Request**: New instance per request prevents stale data

---

## Subscriptions

### How Subscriptions Work

```
1. Client: Subscribe via WebSocket
   subscription { friendEventReceived { type fromUser { gamertag } } }

2. Server: Returns AsyncIterator
   subscribe: () => pubsub.asyncIterator(['FRIEND_EVENT'])

3. Event Occurs: User sends friend request

4. Service: Publishes event
   pubsub.publish('FRIEND_EVENT', { friendEventReceived: event })

5. Server: Iterator yields value

6. Server: Pushes to client via WebSocket
```

### Subscription Implementation

```typescript
Subscription: {
  // Simple subscription
  friendPresenceUpdated: {
    subscribe: () => pubsub.asyncIterator(['FRIEND_PRESENCE_UPDATED']),
  },

  // Subscription with filtering
  messageReceived: {
    subscribe: (_, args) => {
      // Only events for this conversation
      return pubsub.asyncIterator([
        `MESSAGE_RECEIVED.${args.conversationId}`
      ]);
    },
  },

  // Subscription with auth check
  friendEventReceived: {
    subscribe: (_, __, context) => {
      if (!context.user) {
        throw new Error('Authentication required');
      }
      // User-specific channel
      return pubsub.asyncIterator([
        `FRIEND_EVENT.${context.user.userId}`
      ]);
    },
  },
}
```

### Scaling Subscriptions

```
Problem: Multiple server instances
- User A on Server 1 sends friend request
- User B on Server 2 should receive notification

Solution: Redis Pub/Sub

┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Server 1   │     │  Redis      │     │  Server 2   │
│             │ ──► │  Pub/Sub    │ ──► │             │
│  User A     │     │             │     │  User B     │
└─────────────┘     └─────────────┘     └─────────────┘

1. Server 1: Publishes to Redis channel
2. Redis: Broadcasts to all subscribers
3. Server 2: Receives, pushes to User B's WebSocket
```

---

## Authentication

### Authentication Flow

```typescript
// 1. Context function validates token
context: async ({ req }) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  let user = null;
  if (token) {
    try {
      user = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      // Invalid token - user stays null
    }
  }

  return { user };
}

// 2. Helper function enforces auth
const requireAuth = (context) => {
  if (!context.user) {
    throw new GraphQLError('Authentication required', {
      extensions: { code: 'UNAUTHENTICATED' }
    });
  }
};

// 3. Resolvers use helper
friends: async (_, __, context) => {
  requireAuth(context);  // Throws if not authenticated
  return friendService.getFriends(context.user.userId);
}
```

### Authorization Patterns

```typescript
// Field-level authorization
userByGamertag: async (_, { gamertag }, context) => {
  requireAuth(context);

  const user = await authService.getUserByGamertag(gamertag);

  // Check if blocked
  if (await friendService.isBlocked(user.id, context.user.userId)) {
    throw new Error('Cannot view this user');
  }

  return user;
}

// Directive-based (advanced)
type Mutation {
  deleteUser(id: ID!): User @auth(requires: ADMIN)
}
```

---

## Error Handling

### GraphQL Error Format

```json
{
  "data": null,
  "errors": [
    {
      "message": "Not authorized",
      "locations": [{ "line": 2, "column": 3 }],
      "path": ["friends"],
      "extensions": {
        "code": "UNAUTHORIZED"
      }
    }
  ]
}
```

### Throwing Errors

```typescript
import { GraphQLError } from 'graphql';

// Standard error
throw new Error('Something went wrong');

// Error with code
throw new GraphQLError('Not authorized', {
  extensions: { code: 'UNAUTHORIZED' }
});

// Error with additional data
throw new GraphQLError('Validation failed', {
  extensions: {
    code: 'BAD_USER_INPUT',
    validationErrors: [
      { field: 'gamertag', message: 'Already taken' }
    ]
  }
});
```

### Partial Success

GraphQL can return partial data with errors:

```json
{
  "data": {
    "user": {
      "gamertag": "Player1",
      "friends": null  // This field failed
    }
  },
  "errors": [
    {
      "message": "Could not fetch friends",
      "path": ["user", "friends"]
    }
  ]
}
```

---

## Caching Strategies

### Caching Challenges

GraphQL uses POST requests, making HTTP caching difficult.

### Persisted Queries

```
# Client sends hash instead of query
POST /graphql
{
  "extensions": {
    "persistedQuery": {
      "sha256Hash": "abc123..."
    }
  },
  "variables": { "id": "123" }
}

# Server looks up query by hash
# Can cache at CDN level
```

### Apollo Cache Control

```graphql
type User @cacheControl(maxAge: 3600) {
  id: ID!
  gamertag: String!
  presence: Presence @cacheControl(maxAge: 0)  # Always fresh
}
```

### Response Caching

```typescript
// In resolver - cache result in Redis
friends: async (_, __, context) => {
  const cacheKey = `friends:${context.user.userId}`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Fetch and cache
  const friends = await friendService.getFriends(context.user.userId);
  await redis.setex(cacheKey, 60, JSON.stringify(friends));

  return friends;
}
```

---

## Interview Questions

1. **"Why GraphQL over REST?"**
   - Client-specified queries prevent over/under-fetching
   - Single endpoint simplifies client code
   - Built-in subscriptions for real-time
   - Schema as documentation and contract

2. **"How do you handle the N+1 problem?"**
   - DataLoader for batching and caching
   - Batch database operations (MGET, BatchGetItem)
   - Preload related data when appropriate

3. **"How do subscriptions scale?"**
   - Redis Pub/Sub distributes events to all servers
   - Each server filters to relevant WebSocket clients
   - Connection pooling for many concurrent subscriptions

4. **"How do you secure GraphQL?"**
   - JWT validation in context
   - Per-resolver authorization checks
   - Rate limiting per operation
   - Query depth limiting to prevent DoS
