# PlayStation Network Backend Architecture Guide

A comprehensive guide to designing and implementing scalable real-time backends for gaming platforms. This document covers the architectural patterns, design decisions, and implementation details used in a production-grade PlayStation Network-style social gaming platform.

**Target Audience:** Backend engineers preparing for senior-level interviews at gaming companies (PlayStation, Xbox, Activision, Epic Games, Riot Games, etc.)

---

## Table of Contents

1. [System Overview](#system-overview)
2. [High-Level Architecture](#high-level-architecture)
3. [Layer Architecture](#layer-architecture)
4. [Data Flow Patterns](#data-flow-patterns)
5. [Technology Stack & Rationale](#technology-stack--rationale)
6. [Key Design Decisions](#key-design-decisions)
7. [Scaling Considerations](#scaling-considerations)
8. [Interview Discussion Points](#interview-discussion-points)

---

## System Overview

The PlayStation Network practice app is a full-stack backend system that mirrors the real PSN architecture. It demonstrates how to build a real-time social gaming platform that handles:

- **Hundreds of millions of concurrent users** with sub-100ms presence updates
- **Bidirectional real-time communication** for friends, chat, and gaming notifications
- **Complex social graphs** with relationships, blocks, and friend suggestions
- **Event-driven architecture** for activity feeds and notifications
- **Stateless horizontal scaling** for unlimited growth

### Core Capabilities

| Capability | Example | Technical Challenge |
|-----------|---------|-------------------|
| **Presence System** | See friends online in real-time | Sub-100ms updates across all servers |
| **Friend Management** | Send/accept friend requests | Bidirectional relationship consistency |
| **Real-Time Chat** | Instant messaging between friends | Millions of concurrent WebSocket connections |
| **Activity Feeds** | See what friends are playing | Fan-out writes to millions of followers |
| **Game Sessions** | Show which game you're playing | Consistent state across multiple devices |
| **Voice Parties** | In-game communication | Low-latency audio coordination |

---

## High-Level Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT LAYER                                │
│   (PlayStation Console, Mobile App, Web Browser)                    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       LOAD BALANCER                                 │
│              (Round-robin across servers)                           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Server 1 :4000  │ │  Server 2 :4000  │ │  Server N :4000  │
│                  │ │                  │ │                  │
│ ┌──────────────┐ │ │ ┌──────────────┐ │ │ ┌──────────────┐ │
│ │Apollo Server │ │ │ │Apollo Server │ │ │ │Apollo Server │ │
│ │(GraphQL API) │ │ │ │(GraphQL API) │ │ │ │(GraphQL API) │ │
│ └──────────────┘ │ │ └──────────────┘ │ │ └──────────────┘ │
│                  │ │                  │ │                  │
│ ┌──────────────┐ │ │ ┌──────────────┐ │ │ ┌──────────────┐ │
│ │  Services    │ │ │ │  Services    │ │ │ │  Services    │ │
│ │  (Auth, Chat)│ │ │ │  (Auth, Chat)│ │ │ │  (Auth, Chat)│ │
│ └──────────────┘ │ │ └──────────────┘ │ │ └──────────────┘ │
│                  │ │                  │ │                  │
│ ┌──────────────┐ │ │ ┌──────────────┐ │ │ ┌──────────────┐ │
│ │   WebSocket  │ │ │ │   WebSocket  │ │ │ │   WebSocket  │ │
│ │  (Real-time) │ │ │ │  (Real-time) │ │ │ │  (Real-time) │ │
│ └──────────────┘ │ │ └──────────────┘ │ │ └──────────────┘ │
└──────────────────┘ └──────────────────┘ └──────────────────┘
                              │
                ┌─────────────┼──────────────────┐
                ▼             ▼                  ▼
        ┌────────────────┐ ┌──────────────┐ ┌─────────────┐
        │ Redis Cluster  │ │    Kafka     │ │  DynamoDB   │
        │ (Cache, Pub/Sub)│ │  (Events)    │ │  (Database) │
        └────────────────┘ └──────────────┘ └─────────────┘
```

### Traffic Flow

```
1. REQUEST PATH (Queries/Mutations):
   Client → Load Balancer → Express → Apollo → GraphQL Resolver → Service → Redis/DB

2. SUBSCRIPTION PATH (Real-Time):
   Client (WebSocket) → GraphQL Subscription → Service Event → PubSub → All Clients

3. EVENT PATH (Cross-Server):
   Service Instance 1 → Redis Pub/Sub → All Server Instances → All Connected Clients
```

---

## Layer Architecture

The application follows a **three-tier layered architecture** with clear separation of concerns:

```
┌────────────────────────────────────────────────────┐
│         PRESENTATION LAYER                         │
│    (GraphQL Schema + Resolvers)                    │
│                                                    │
│  - Type-safe GraphQL API                          │
│  - Input validation                               │
│  - Authentication/authorization checks            │
│  - Response formatting                            │
└────────────────────────────────────────────────────┘
                        │
                        │ Delegates to
                        ▼
┌────────────────────────────────────────────────────┐
│      BUSINESS LOGIC LAYER                          │
│           (Services)                               │
│                                                    │
│  - Domain-specific logic                          │
│  - Business rule validation                       │
│  - Event emission                                 │
│  - Cross-service orchestration                    │
└────────────────────────────────────────────────────┘
                        │
                        │ Reads/Writes
                        ▼
┌────────────────────────────────────────────────────┐
│       DATA ACCESS LAYER                            │
│    (Redis + DynamoDB)                             │
│                                                    │
│  - Fast data retrieval (Redis)                    │
│  - Persistent storage (DynamoDB)                  │
│  - Pub/Sub messaging (Redis)                      │
│  - Event streaming (Kafka)                        │
└────────────────────────────────────────────────────┘
```

### Layer 1: Presentation Layer (GraphQL)

**Files:** `src/graphql/schema.ts`, `src/graphql/resolvers.ts`

The GraphQL layer is the public API boundary. It:

- **Defines the contract** between client and server
- **Validates inputs** before passing to services
- **Checks authentication/authorization** for protected operations
- **Transforms data** into the schema format
- **Remains thin** - business logic stays in services

#### Key Pattern: Thin Resolvers

```typescript
// Resolvers should be thin - just orchestration
sendFriendRequest: async (_, args, context) => {
  // 1. Authentication (already checked by middleware, but explicit)
  requireAuth(context);

  // 2. Input validation
  if (!isValidUserId(args.userId)) {
    throw new Error('Invalid user ID');
  }

  // 3. Delegate to service
  const request = await friendService.sendFriendRequest(
    context.user.userId,
    args.userId,
    context.user.gamertag
  );

  // 4. Publish event for real-time subscriptions
  pubsub.publish('FRIEND_REQUEST_RECEIVED', { request });

  // 5. Return result
  return request;
}
```

**Why thin resolvers?**
- Services are testable in isolation
- Business logic is reusable (can be called from multiple resolvers)
- Clear separation between API format and domain logic
- Easier to track what each layer does

### Layer 2: Business Logic Layer (Services)

**Files:** `src/services/*/`

Services contain the core business logic. Each service:

- **Owns a domain** (auth, chat, friends, presence)
- **Validates business rules** before operations
- **Manages state changes** through data operations
- **Emits events** for cross-service communication
- **Never knows about GraphQL** - works with plain objects

#### Example: FriendService Architecture

```typescript
class FriendService extends EventEmitter {
  constructor(redis: Redis) {
    super();
    this.redis = redis;
  }

  /**
   * Business logic: Send a friend request
   *
   * This method:
   * 1. Validates the business rules (not already friends, not blocked, etc.)
   * 2. Performs atomic operations
   * 3. Emits events for other services to consume
   */
  async sendFriendRequest(
    fromId: string,
    toId: string,
    fromGamertag: string
  ): Promise<FriendRequest> {
    // Step 1: Business rule validation
    const [isAlreadyFriend, isBlocked, alreadyRequested] = await Promise.all([
      this.isFriend(fromId, toId),
      this.isBlocked(toId, fromId),
      this.hasRequestPending(fromId, toId),
    ]);

    if (isAlreadyFriend) {
      throw new Error('Already friends');
    }
    if (isBlocked) {
      throw new Error('User blocked you');
    }
    if (alreadyRequested) {
      throw new Error('Request already sent');
    }

    // Step 2: Atomic operations
    const requestId = uuidv4();
    const now = new Date().toISOString();
    const pipe = this.redis.pipeline();

    // Store request in Redis Sorted Set
    pipe.zadd(
      `friend_requests:outgoing:${fromId}`,
      Date.now(),
      toId
    );
    pipe.zadd(
      `friend_requests:incoming:${toId}`,
      Date.now(),
      fromId
    );

    await pipe.exec();

    // Step 3: Create response object
    const request: FriendRequest = {
      id: requestId,
      fromId,
      toId,
      fromGamertag,
      status: 'PENDING',
      createdAt: now,
    };

    // Step 4: Emit event for other services
    this.emit('friendEvent', {
      type: 'friend_request_received',
      fromId,
      toId,
      fromGamertag,
      request,
      timestamp: now,
    });

    return request;
  }
}
```

### Layer 3: Data Access Layer

**Files:** Embedded in services, plus `docker-compose.yml`

The data layer handles all persistence and messaging:

#### Redis (Cache & Real-Time)

Redis stores **hot data** that needs fast access and real-time updates:

```
Session Data (TTL: 7 days)
  session:{userId} → { gamertag, status, loginTime, ... }

Presence Data (TTL: 5 minutes)
  presence:{userId} → { status, currentGame, lastActive, ... }

Friend Relationships (No expiry)
  user:{userId}:friends → SET of friend IDs
  user:{userId}:blocked → SET of blocked user IDs
  user:{userId}:requests:incoming → ZSET of request IDs (sorted by time)

Pub/Sub Channels (Real-time broadcast)
  presence:updates → Friend status changes
  chat:conversations:{convId} → New messages
  friend:events:${userId} → Friend requests/accepts
```

**Why Redis for real-time data?**
- Sub-millisecond latency for read/write
- Built-in Pub/Sub for broadcasting to all servers
- Automatic TTL expiration for sessions
- Atomic operations for consistency

#### DynamoDB (Persistent Storage)

DynamoDB stores **cold data** that needs persistence and complex queries:

```
User Profiles
  PK: USER#{userId}
  SK: PROFILE
  Attributes: gamertag, email, level, trophies, ...

User Games
  PK: USER#{userId}
  SK: GAME#{gameId}
  Attributes: playtimeMinutes, completionPercent, lastPlayedAt

Friend Relationships (Historical)
  PK: USER#{userId}
  SK: FRIEND#{friendId}
  Attributes: befriendedAt, isBestFriend, ...
```

#### Kafka (Event Streaming)

Kafka handles **high-volume asynchronous events**:

```
Topics:
  user.presence.updates → Friend comes online (millions/sec)
  user.achievement.unlocked → Trophy earned
  user.game.session.started → Playing a game
  user.activity.feed → Social feed updates
```

**Why Kafka?**
- Decouples services (no direct calls needed)
- Guaranteed event delivery (no data loss)
- Event replay for recovery
- Handles millions of events/second

---

## Data Flow Patterns

### Pattern 1: Request-Response (Queries & Mutations)

**Used for:** Fetching data, updating state

```
Client Request
    │
    ▼
Load Balancer
    │
    ▼
Express Middleware
  (CORS, JSON parsing, logging)
    │
    ▼
GraphQL Context Function
  (Extract auth token, validate JWT, get user)
    │
    ▼
GraphQL Resolver
  (Thin orchestration)
    │
    ▼
Service Method
  (Business logic)
    │
    ├─► Validate business rules
    ├─► Perform data operations (Redis/DynamoDB)
    └─► Emit event (optional)
    │
    ▼
Resolver (continued)
  (Publish to PubSub for subscriptions)
    │
    ▼
Response to Client
```

**Example: Update Friend List**

```
1. Client: Query {
     friends(limit: 100) {
       id
       gamertag
       status
     }
   }

2. Server: Get friends list IDs from Redis
   friends = await redis.smembers('user:${userId}:friends')

3. Server: Batch fetch friend data from DynamoDB
   friends = await dynamodb.batchGet(['USER#${id}' for each id])

4. Server: Get presence data for each friend (in-memory join)
   for each friend {
     presence = await redis.get('presence:${friendId}')
   }

5. Return to client with all data in one response
```

### Pattern 2: Real-Time Subscriptions (WebSocket)

**Used for:** Presence updates, new messages, notifications

```
Client WebSocket Connection
    │
    ▼
GraphQL Subscription Handler
    │
    ▼
Creates AsyncIterator for topic
    │
    ├─ Awaits messages from topic
    │
    └─ (Long-lived connection stays open)
    │
    ▼
Event Occurs (Friend comes online)
    │
    ▼
Service emits event via EventEmitter
    │
    ▼
Server wiring publishes to PubSub
    │
    ▼
All subscribed clients receive update
    │
    ▼
Push to client via WebSocket
```

**Example: Friend Presence Subscription**

```typescript
// Client subscribes
subscription {
  friendPresenceUpdated {
    userId
    status
    currentGame
  }
}

// Flow:
1. PresenceService.updatePresence() called
2. Service updates Redis: SET presence:${userId} { status, game }
3. Service emits: this.emit('presenceUpdate', { userId, ... })
4. Server listens: presenceService.on('presenceUpdate', event => {
     pubsub.publish('FRIEND_PRESENCE_UPDATED', { ... })
   })
5. PubSub pushes to all subscribed clients
6. Client receives real-time update via WebSocket
```

### Pattern 3: Pub/Sub Event Broadcasting (Redis Pub/Sub)

**Used for:** Cross-server event propagation

```
Server 1
  Service emits event
    │
    ▼
  Publish to Redis Pub/Sub
    │
    ▼
Redis Pub/Sub
  ├─► Server 1 receives copy
  ├─► Server 2 receives copy
  ├─► Server 3 receives copy
  └─► ... all servers
    │
    ▼
Each server processes event locally
  (Updates local subscriptions, caches, etc.)
    │
    ▼
Each server pushes to its connected WebSocket clients
```

**Why this pattern?**
- No direct server-to-server calls needed
- Works with any number of servers
- Events reach all instances automatically
- Can replay from Kafka for recovery

---

## Technology Stack & Rationale

### Backend Runtime: Node.js + TypeScript

| Choice | Rationale | Alternative |
|--------|-----------|-------------|
| **Node.js** | Single-threaded, event-driven. Perfect for I/O-heavy gaming platforms where thousands of concurrent users need real-time updates | Python: Slower. Java: Too heavy for real-time. Go: Good but less ecosystem |
| **TypeScript** | Type safety at compile time catches errors early. Critical for large teams building complex systems | JavaScript: Runtime errors slip through. Java: Verbose |

**Interview Tip:** "Node.js's event loop handles thousands of concurrent WebSocket connections efficiently. TypeScript catches bugs that would surface in production, which is worth the compilation step for a backend team."

### API Layer: Apollo Server + GraphQL

| Choice | Rationale | Alternative |
|--------|-----------|-------------|
| **GraphQL** | Clients specify exactly what data they need. One query gets friends + presence + games. Perfect for mobile apps with varying needs | REST: Multiple endpoints = multiple requests. Mobile clients want minimal data |
| **Apollo Server** | Mature, well-tested, supports HTTP + WebSocket on same port, excellent subscription handling | graphql-yoga: Lighter but less mature. Express-graphql: Older |

**Why GraphQL over REST for gaming?**

```
REST Approach (Bad):
GET /users/123 → User profile
GET /users/123/friends → Friends list
GET /users/123/presence → Presence data
GET /users/123/games → Game library
= 4 round trips to render friend list page

GraphQL Approach (Good):
{
  me {
    friends {
      id, gamertag
      presence { status, game }
    }
  }
}
= 1 request, gets exactly what's needed
```

### Real-Time Communication: WebSocket + graphql-ws

| Choice | Rationale | Alternative |
|--------|-----------|-------------|
| **graphql-ws** | Modern GraphQL subscription protocol. Works with Apollo. Handles auth properly | subscriptions-transport-ws: Deprecated. Raw WebSocket: No GraphQL protocol |
| **Single Port** | Both HTTP and WebSocket on port 4000 simplifies deployment. No port forwarding needed | Separate ports: Harder to configure in production |

### Data Storage: Redis + DynamoDB

| Choice | Rationale | Alternative |
|--------|-----------|-------------|
| **Redis** | Sub-millisecond latency for presence/sessions. Pub/Sub for broadcasting. Built-in TTL. Single system for cache + messaging | Memcached: No Pub/Sub. PostgreSQL: Too slow for real-time |
| **DynamoDB** | Scales horizontally to 100M+ users. Predictable millisecond latency. NoSQL handles gaming data variety | PostgreSQL: Great but doesn't scale horizontally easily. MongoDB: Works but AWS managed service is more reliable |

**Real-World Scale:**
- **Redis:** ~1 million presence updates per second
- **DynamoDB:** ~100,000 writes per second per partition
- **Kafka:** ~1 billion gaming events per day

### Infrastructure: Docker + Kubernetes (Implicit)

**Development:** Docker Compose (local)

```yaml
- Redis for caching/sessions
- Kafka for event streaming
- DynamoDB Local for persistence
```

**Production:** Kubernetes with:
- Multiple Node.js pods behind load balancer
- AWS ElastiCache for Redis Cluster
- AWS MSK for Kafka
- AWS DynamoDB (managed)

---

## Key Design Decisions

### Decision 1: Hybrid Authentication (JWT + Redis Sessions)

**Problem:** JWTs are stateless, making logout difficult. Redis sessions are stateful, limiting scale.

**Solution:** Use JWT for fast validation, Redis for logout capability.

```typescript
// On every request:
1. Verify JWT signature (fast, no network call)
2. Check session exists in Redis (enables logout)
3. Refresh session TTL (keeps active users logged in)

// On logout:
- Delete session from Redis
- JWT becomes invalid (no valid session)
- No need for token blacklist
```

**Benefits:**
- Fast authentication (JWT verification)
- True logout capability (session deletion)
- Scales with Redis Cluster
- Works with multiple devices

### Decision 2: Event-Driven Services

**Problem:** Direct service calls create tight coupling. Friend service needs to update presence service, which needs to update activity service, etc.

**Solution:** Services emit events. Other services listen.

```
Friend Service          Presence Service        Activity Service
      │                        │                       │
      ├─ Friend accepted ──────┤                       │
      │                        ├─ Presence updated ────┤
      │                        │                       │
      │                        └─ Activity created ────┤
```

**Benefits:**
- Services don't know about each other
- Easy to add new listeners without changing existing code
- Testable in isolation
- Scales to any number of services

### Decision 3: Redis Pub/Sub for Subscriptions

**Problem:** Each server has its own in-memory PubSub. Events on Server 1 don't reach clients connected to Server 2.

**Solution:** Use Redis Pub/Sub to broadcast across all servers.

```
Server 1                Redis Pub/Sub               Server 2
┌─────────────┐        ┌──────────┐           ┌─────────────┐
│ Friend A    │        │ Topic:   │           │ Friend B    │
│ connected   │───────▶│ presence │◀──────────│ connected   │
└─────────────┘        │ :updates │           └─────────────┘
                       └──────────┘
                            ▲
                            │
                      Friend A comes online
                      Server 1 publishes event
                            │
                      Both servers receive
                      Both push to clients
```

**Benefits:**
- Works with unlimited servers
- Automatic fan-out
- No explicit routing needed
- Redis handles at scale

### Decision 4: Sorted Sets for Time-Ordered Data

**Problem:** Need to track friend requests in order (newest first), with pagination, and auto-expiration.

**Solution:** Use Redis Sorted Sets with timestamp as score.

```typescript
// Store request with current timestamp as score
await redis.zadd(
  'friend_requests:incoming:${userId}',
  Date.now(),        // Score: timestamp
  requesterId        // Member: user ID
);

// Get 10 newest requests (highest timestamps first)
const requests = await redis.zrevrange(
  'friend_requests:incoming:${userId}',
  0,                 // Start
  9,                 // Stop
  'WITHSCORES'       // Include scores
);

// Remove expired requests (older than 30 days)
await redis.zremrangebyscore(
  'friend_requests:incoming:${userId}',
  '-inf',
  Date.now() - (30 * 24 * 60 * 60 * 1000)
);
```

**Benefits:**
- Natural ordering by time
- Efficient pagination (O(log N))
- Built-in range operations
- Can manually expire old requests

### Decision 5: Separate Read/Write Models

**Problem:** Presence data needs to be updated constantly (every heartbeat) but read by thousands of friends. Single model can't handle both.

**Solution:**
- **Write model:** Update presence in Redis (fast writes)
- **Read model:** Cache presence in Redis (fast reads)

```typescript
// Write: User updates presence
await redis.set(`presence:${userId}`, {
  status: 'ONLINE',
  currentGame: 'SpiderMan2',
  lastActive: Date.now()
});

// Read: Friends fetch presence
const presence = await redis.get(`presence:${userId}`);

// Broadcast: Publish to all friends
await redis.publish(`presence:updates`, {
  userId,
  presence
});
```

**Benefits:**
- No complex coordination
- Writes go directly to cache
- Reads hit cache 100% of the time
- Natural expiration via TTL

---

## Scaling Considerations

### Horizontal Scaling: Multiple Servers

#### Server Architecture

```
┌─ Server 1           ┌─ Server 2           ┌─ Server N
│  ┌────────────┐    │  ┌────────────┐    │  ┌────────────┐
│  │  Apollo    │    │  │  Apollo    │    │  │  Apollo    │
│  │  Server    │    │  │  Server    │    │  │  Server    │
│  └────────────┘    │  └────────────┘    │  └────────────┘
│       │            │       │            │       │
│  ┌────────────┐    │  ┌────────────┐    │  ┌────────────┐
│  │ Services   │    │  │ Services   │    │  │ Services   │
│  └────────────┘    │  └────────────┘    │  └────────────┘
│       │            │       │            │       │
│  ┌────────────┐    │  ┌────────────┐    │  ┌────────────┐
│  │ PubSub     │    │  │ PubSub     │    │  │ PubSub     │
│  │ (in-memory)│    │  │ (in-memory)│    │  │ (in-memory)│
│  └────────────┘    │  └────────────┘    │  └────────────┘
└─                   └─                   └─
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                    ┌────────────────────┐
                    │  Redis Pub/Sub     │
                    │  (cross-server     │
                    │   events)          │
                    └────────────────────┘
```

#### Why Horizontal Scaling Works

1. **Stateless Servers:** Services don't store state locally. Everything is in Redis or DynamoDB.
2. **Redis Pub/Sub:** Events broadcast to all servers automatically.
3. **No Session Affinity:** Any server can handle any request (load balancer routes randomly).

#### Scaling Limits

| Component | Bottleneck | Solution |
|-----------|-----------|----------|
| Single Redis | ~1M ops/sec | Redis Cluster (3+ nodes) |
| DynamoDB | Per-partition writes | Use partition key distribution |
| WebSocket Connections | Per-server: ~50K | Add more servers + load balancer |
| Kafka | Per-broker throughput | Add brokers + partition topics |

### Redis Cluster for High Availability

#### Why Redis Cluster?

```
Single Redis (Bad):
  If it fails → All users disconnected
  Capacity limit → Can't grow beyond single machine

Redis Cluster (Good):
  Automatic failover → No downtime
  Horizontal scaling → Add nodes to grow
  Data distribution → No single bottleneck
```

#### Cluster Setup

```
┌────────────────────────────────────────────────────┐
│           REDIS CLUSTER                            │
│                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ Master 1 │  │ Master 2 │  │ Master 3 │        │
│  │  (a-f)   │  │  (g-m)   │  │  (n-z)   │        │
│  ├──────────┤  ├──────────┤  ├──────────┤        │
│  │ Slave 1a │  │ Slave 2a │  │ Slave 3a │        │
│  └──────────┘  └──────────┘  └──────────┘        │
└────────────────────────────────────────────────────┘

All servers connect to cluster (not individual nodes)
Cluster handles routing automatically
```

### Connection Pooling

```typescript
const redis = new Redis({
  // Max number of waiting commands
  maxRetriesPerRequest: 3,

  // Automatic reconnection strategy
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },

  // Connection timeout
  connectTimeout: 10000,

  // Enable auto-pipelining for batch operations
  enableAutoPipelining: true,
  autoPipeliningIgnoredCommands: ['ping'],
});
```

### Rate Limiting Strategy

#### Three-Tier Approach

```
┌────────────────────────────────────────┐
│  1. API Gateway Level                  │
│  (Global rate limit: 1M req/min)       │
└────────────────────────────────────────┘
                  │
                  ▼
┌────────────────────────────────────────┐
│  2. GraphQL Level                      │
│  (Per operation: 100 req/min)          │
│  (Per user: 1000 req/min)              │
└────────────────────────────────────────┘
                  │
                  ▼
┌────────────────────────────────────────┐
│  3. Service Level                      │
│  (Per resource: 10 req/sec)            │
│  (Friend requests: 5 per day)          │
└────────────────────────────────────────┘
```

#### Implementation: Token Bucket in Redis

```typescript
async rateLimit(userId: string, limit: number, window: number) {
  const key = `ratelimit:${userId}`;
  const current = await redis.incr(key);

  if (current === 1) {
    // First request in window, set expiration
    await redis.expire(key, window);
  }

  if (current > limit) {
    throw new Error('Rate limit exceeded');
  }
}
```

### Caching Strategy

#### Cache Invalidation (The Hard Problem)

```
Strategy 1: TTL-Based
  cache.set('user:123', userData, { ttl: 5 minutes })
  ✓ Simple
  ✗ Stale data possible

Strategy 2: Event-Based
  user.update() → emit event → invalidate cache
  ✓ Always fresh
  ✗ Complex to implement

Strategy 3: Hybrid (Recommended)
  TTL + invalidation events
  ✓ Fresh when possible, automatic fallback after TTL
```

#### Cache Warming

```typescript
// Pre-load hot data at startup
async warmCache() {
  const hotUsers = await dynamodb.queryHotUsers();
  for (const user of hotUsers) {
    await redis.set(
      `user:${user.id}`,
      JSON.stringify(user),
      { ttl: 24 * 60 * 60 } // 24 hours
    );
  }
}
```

### Monitoring & Observability

#### Key Metrics

| Metric | Alert Threshold | Action |
|--------|-----------------|--------|
| Redis latency | >100ms p99 | Check connection pool, increase cluster size |
| Kafka lag | >10s | Increase partitions or consumers |
| Server memory | >80% | Scale horizontally |
| Failed requests | >0.1% | Check logs, circuit breaker |
| WebSocket connections | >100K per server | Add servers |

---

## Interview Discussion Points

### 1. "Walk me through how presence updates work."

**Expected answer structure:**

1. **Client sends heartbeat:** Every 60 seconds, client calls `heartbeat` mutation
2. **Service updates Redis:** `SET presence:{userId} { status, game, timestamp }`
3. **Service publishes event:** `emit('presenceUpdate', { userId, ... })`
4. **Server broadcasts:** PubSub publishes to Redis channel
5. **All servers receive:** Subscribe to Redis Pub/Sub
6. **Push to connected clients:** Each server pushes to its WebSocket clients
7. **Clients update UI:** Render friend as online

**Follow-ups they might ask:**
- "What if Redis goes down?" → Fall back to periodic polling
- "How do you scale presence?" → Redis Cluster, sharding by userId
- "What about offline detection?" → TTL-based expiration (5 min)

### 2. "Why GraphQL instead of REST?"

**Talking points:**
- **Overfetching:** REST returns all user fields; GraphQL lets mobile request just {id, gamertag}
- **Underfetching:** REST requires 4 calls; GraphQL does 1
- **Type safety:** Schema is self-documenting; client code generation possible
- **Versioning:** Add new fields without breaking clients
- **Mobile-first:** Different clients request different data shapes

**Concession:** "REST is simpler for CRUD APIs. GraphQL shines for complex graph traversal (friends → friends → games)."

### 3. "How would you handle millions of concurrent users?"

**Layered response:**

1. **Servers:** Stateless, behind load balancer. Scale horizontally.
2. **Redis:** Single instance bottleneck. Use Redis Cluster.
3. **Database:** DynamoDB scales automatically, but partition key distribution matters.
4. **Events:** Kafka for high-volume data.
5. **Monitoring:** Prometheus/CloudWatch for bottleneck detection.

**Specific number:** "With proper scaling, this architecture handles 100M concurrent users. Bottleneck would be data modeling, not infrastructure."

### 4. "What about data consistency in a distributed system?"

**Answer:**
- **Presence:** Eventual consistency is fine (eventual = within seconds)
- **Friends list:** Strong consistency required (use transactions)
- **Activity feed:** Eventual consistency acceptable

**Redis transactions for consistency:**
```typescript
const pipeline = redis.pipeline();
pipeline.sadd('user:123:friends', userId);
pipeline.sadd('user:456:friends', userId);
await pipeline.exec(); // Atomic: both or nothing
```

### 5. "How would you prevent race conditions?"

**Scenarios:**

1. **Two friend requests simultaneously:**
   Use Redis Sorted Sets with unique scores (timestamp + UUID)

2. **Double-spending friend requests:**
   Check both directions: if request pending both ways, auto-accept

3. **Duplicate message sends:**
   Client-side request ID, server-side deduplication

```typescript
// Idempotent message send
async sendMessage(conversationId, content, requestId) {
  const dedupeKey = `dedup:${requestId}`;
  const existing = await redis.get(dedupeKey);

  if (existing) {
    return JSON.parse(existing); // Return cached response
  }

  const message = await createMessage(...);
  await redis.setex(dedupeKey, 3600, JSON.stringify(message));
  return message;
}
```

### 6. "What are the failure modes?"

**Failures & Recovery:**

| Failure | Impact | Recovery |
|---------|--------|----------|
| Redis down | Presence unavailable, can't login | Failover to replica, restore from backup |
| DynamoDB throttled | Slow responses | Increase RCU/WCU, optimize queries |
| Kafka lag | Activity feed delayed | Increase partitions, add consumers |
| Single server down | Lost WebSocket connections | Load balancer routes to other servers |
| Network partition | Service to service calls fail | Circuit breaker, fallback behavior |

**Redundancy for critical features:**
- Dual database writes (sync + async)
- Event replay from Kafka for recovery
- Session backup across regions

### 7. "How would you optimize for mobile?"

**Optimization strategies:**

1. **Smaller payloads:** GraphQL lets mobile request only needed fields
2. **Delta sync:** Send only changed data, not full state
3. **Offline-first:** Local cache, sync when online
4. **Batch requests:** Combine multiple queries
5. **Caching headers:** ETag, Last-Modified for HTTP caching
6. **WebSocket:** More efficient than polling for real-time

### 8. "What about security?"

**Security layers:**

```
1. Transport: TLS for all connections
2. Auth: JWT with Redis session validation
3. API: GraphQL introspection disabled in production
4. Data: Sensitive fields not exposed in schema
5. Rate limiting: Prevent abuse
6. Input validation: Prevent injection attacks
7. Logging: Audit trail for compliance
```

**Example - Securing presence:**
```typescript
// Only return presence if user is friend or self
if (targetUserId !== context.user.id) {
  const isFriend = await friendService.isFriend(
    context.user.id,
    targetUserId
  );
  if (!isFriend) {
    throw new Error('Not authorized');
  }
}
```

### 9. "What would you change for production?"

**Production improvements:**

1. **Add database layer:** DynamoDB for persistence (currently only Redis)
2. **Add Kafka:** Event streaming for reliability, replay capability
3. **Add monitoring:** Prometheus for metrics, Grafana for dashboards
4. **Add tracing:** Jaeger or X-Ray for request tracing
5. **Add logging:** CloudWatch Logs or ELK stack
6. **Add CDN:** CloudFront for static assets
7. **Add backup:** Automated snapshots, cross-region replication
8. **Add testing:** Load testing, chaos engineering

### 10. "Architecture questions about specific choices?"

**Be prepared to justify:**

**"Why Redis Sorted Sets for friend requests?"**
```
Alternatives:
- List: No time ordering without sorting on read (O(n))
- Hash: No efficient range queries
- Sorted Set: Time ordering, range queries, expiration (best choice)
```

**"Why separate presence from user?"**
```
Reasons:
- Changes frequency: Presence updates every heartbeat, user profile rarely
- Storage: Redis (presence) vs DynamoDB (user)
- Consistency: Presence is eventually consistent, user is strongly consistent
```

**"Why event emission for cross-service communication?"**
```
Alternative (bad): friendService.on('accepted', () => {
  presenceService.updateFriendPresence(...) // direct call
})
Problem: Creates dependency. Can't test in isolation.

Our way: friendService emits, server wires listeners
Benefit: Decoupled, testable, scalable
```

---

## Summary

A production-grade gaming backend requires:

1. **Stateless design** for horizontal scaling
2. **Event-driven architecture** for loose coupling
3. **Redis for real-time**, DynamoDB for persistence
4. **GraphQL for flexible client queries**
5. **Proper monitoring and graceful degradation**

**Key insight:** The architecture scales not just servers, but also team velocity. When services are decoupled and clearly defined, new engineers can add features without understanding the whole system.

---

## References

- [Apollo Server Documentation](https://www.apollographql.com/docs/apollo-server/)
- [Redis Commands Reference](https://redis.io/commands/)
- [GraphQL Best Practices](https://graphql.org/learn/best-practices/)
- [DynamoDB Design Patterns](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html)
- [Kafka Architecture](https://kafka.apache.org/intro)

**Last Updated:** February 2025
**Version:** 1.0
**Status:** Complete for interview preparation
