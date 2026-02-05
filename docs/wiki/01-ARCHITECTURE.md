# Architecture Deep Dive

This document explains the architectural decisions and patterns used in the PlayStation Network practice app.

---

## Table of Contents

1. [Overview](#overview)
2. [Layer Architecture](#layer-architecture)
3. [Service Pattern](#service-pattern)
4. [Event-Driven Design](#event-driven-design)
5. [Data Flow Patterns](#data-flow-patterns)
6. [Scaling Considerations](#scaling-considerations)

---

## Overview

The application follows a **layered architecture** with clear separation of concerns:

```
┌─────────────────────────────────────────────┐
│              PRESENTATION LAYER              │
│         (GraphQL Schema + Resolvers)         │
├─────────────────────────────────────────────┤
│              BUSINESS LOGIC LAYER            │
│                  (Services)                  │
├─────────────────────────────────────────────┤
│               DATA ACCESS LAYER              │
│              (Redis + DynamoDB)              │
└─────────────────────────────────────────────┘
```

### Design Principles

1. **Single Responsibility**: Each service handles one domain
2. **Dependency Injection**: Services receive dependencies via constructor
3. **Event-Driven**: Services communicate via events, not direct calls
4. **Stateless Servers**: All state in Redis/DynamoDB for horizontal scaling

---

## Layer Architecture

### Presentation Layer (GraphQL)

**Files:** `schema.ts`, `resolvers.ts`

The GraphQL layer is the public API. It:
- Defines the schema (what clients can request)
- Validates input
- Checks authentication/authorization
- Delegates to services
- Formats responses

```typescript
// Resolvers are thin - they validate and delegate
sendFriendRequest: async (_, args, context) => {
  // 1. Validate auth
  requireAuth(context);

  // 2. Delegate to service
  const request = await friendService.sendFriendRequest(
    context.user.userId,
    args.userId,
    context.user.gamertag
  );

  // 3. Publish event for subscriptions
  pubsub.publish(EVENTS.FRIEND_REQUEST, { request });

  // 4. Return result
  return request;
}
```

**Key Pattern:** Resolvers should be thin. Business logic lives in services.

### Business Logic Layer (Services)

**Files:** `*.service.ts`

Services contain the business logic. Each service:
- Owns a specific domain (auth, presence, friends, chat)
- Validates business rules
- Manages data persistence
- Emits events for cross-service communication

```typescript
class FriendService extends EventEmitter {
  constructor(redis: Redis) {
    this.redis = redis;
    // Subscribe to events from other services
  }

  async sendFriendRequest(fromId, toId, gamertag) {
    // Business validation
    if (await this.isBlocked(toId, fromId)) {
      throw new Error('Cannot send request');
    }

    // Data operations
    await this.redis.zadd(/*...*/);

    // Emit event
    this.emit('friendEvent', { type: 'request', from, to });

    return request;
  }
}
```

**Key Pattern:** Services don't know about GraphQL. They work with plain objects.

### Data Access Layer (Redis)

**Files:** Embedded in services

Redis is our primary data store for:
- Sessions (SETEX with TTL)
- Presence (Hash with TTL)
- Friends (Sets for O(1) lookup)
- Requests (Sorted Sets for ordering)
- Pub/Sub (cross-server events)

```typescript
// Data access patterns
const REDIS_KEYS = {
  friends: (userId) => `user:${userId}:friends`,
  presence: (userId) => `presence:${userId}`,
  session: (userId) => `session:${userId}`,
};

// Atomic operations with pipeline
const pipeline = redis.pipeline();
pipeline.sadd(REDIS_KEYS.friends(userId), friendId);
pipeline.sadd(REDIS_KEYS.friends(friendId), userId);
await pipeline.exec();
```

**Key Pattern:** Use pipelines for atomic multi-command operations.

---

## Service Pattern

### Dependency Injection

Services receive dependencies through constructor:

```typescript
// In server.ts
const redis = new Redis(REDIS_URL);
const authService = new AuthService(redis);
const presenceService = new PresenceService(redis);
const friendService = new FriendService(redis);

// Inject into resolvers
const resolvers = createResolvers(
  authService,
  presenceService,
  chatService,
  friendService,
  pubsub
);
```

**Benefits:**
- Easy to test with mocks
- Clear dependency graph
- Centralized configuration

### EventEmitter Pattern

Services extend EventEmitter for loose coupling:

```typescript
class FriendService extends EventEmitter {
  async acceptRequest(userId, fromId) {
    // ... business logic ...

    // Emit event instead of calling presenceService directly
    this.emit('friendEvent', {
      type: 'accepted',
      userId,
      fromId,
    });
  }
}

// In server.ts, wire events to other services
friendService.on('friendEvent', (event) => {
  if (event.type === 'accepted') {
    presenceService.addFriend(event.userId, event.fromId);
  }
  pubsub.publish(EVENTS.FRIEND_EVENT, event);
});
```

**Benefits:**
- Services don't know about each other
- Easy to add new listeners
- Testable in isolation

---

## Event-Driven Design

### Event Flow

```
User Action
    │
    ▼
GraphQL Resolver
    │
    ├─► Service Method
    │       │
    │       ├─► Data Operations (Redis)
    │       │
    │       └─► Emit Event (EventEmitter)
    │               │
    │               ▼
    │           Server Wiring
    │               │
    │               ├─► Update Other Services
    │               │
    │               └─► Publish to PubSub
    │                       │
    │                       ▼
    │                   Redis Pub/Sub
    │                       │
    │                       ├─► All Server Instances
    │                       │
    │                       └─► WebSocket Push to Clients
    │
    └─► Return Response
```

### Redis Pub/Sub for Cross-Server Events

```typescript
// Service publishes event
await redis.publish('friend:events', JSON.stringify(event));

// All servers subscribe
subscriber.subscribe('friend:events');
subscriber.on('message', (channel, message) => {
  const event = JSON.parse(message);
  // Handle event locally
});
```

**Why Redis Pub/Sub?**
- Events reach all server instances
- No direct server-to-server communication needed
- Scales linearly with server count

---

## Data Flow Patterns

### Request-Response (Queries/Mutations)

```
Client ─► Apollo Server ─► Resolver ─► Service ─► Redis ─► Response
```

### Real-Time (Subscriptions)

```
1. Client subscribes via WebSocket
2. Server returns AsyncIterator
3. Event occurs in Service
4. Service emits event
5. Event published to Redis Pub/Sub
6. All servers receive
7. Each server pushes to relevant clients
```

### Heartbeat (Presence)

```
Every 60 seconds:
  Client ─► heartbeat mutation ─► PresenceService ─► Redis EXPIRE refresh

After 5 minutes without heartbeat:
  Redis TTL expires ─► Presence auto-deleted ─► User appears offline
```

---

## Scaling Considerations

### Horizontal Scaling

The app is designed for horizontal scaling:

1. **Stateless Servers**: All state in Redis
2. **Session Affinity Not Required**: Any server can handle any request
3. **Pub/Sub for Events**: All servers receive updates

```
Load Balancer
     │
     ├─► Server 1 ─┐
     ├─► Server 2 ─┼─► Redis Cluster
     └─► Server 3 ─┘
```

### Redis Cluster (Production)

```
┌─────────────────────────────────────────────┐
│              REDIS CLUSTER                   │
│                                             │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐     │
│  │ Shard 1 │  │ Shard 2 │  │ Shard 3 │     │
│  │ a-f     │  │ g-m     │  │ n-z     │     │
│  ├─────────┤  ├─────────┤  ├─────────┤     │
│  │ Replica │  │ Replica │  │ Replica │     │
│  └─────────┘  └─────────┘  └─────────┘     │
└─────────────────────────────────────────────┘
```

### Rate Limiting Strategy

```
Rate Limit at:
1. API Gateway (global limits)
2. GraphQL Layer (per-operation limits)
3. Service Layer (per-resource limits)

Implementation:
- Token Bucket in Redis
- Sliding Window for bursts
```

### Connection Pooling

```typescript
const redis = new Redis({
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  connectTimeout: 10000,
});
```

---

## Interview Talking Points

1. **"Why this architecture?"**
   - Clear separation of concerns
   - Each layer is independently testable
   - Services can evolve independently
   - Easy to add new features

2. **"How does this scale?"**
   - Stateless servers behind load balancer
   - Redis Cluster for data sharding
   - Pub/Sub for event distribution
   - No single point of failure

3. **"How do you handle failures?"**
   - Redis retry strategy with exponential backoff
   - Graceful degradation (cache miss → fetch from DB)
   - Circuit breaker for external services
   - Dead letter queues for failed events

4. **"What would you change for production?"**
   - Add DynamoDB for persistence
   - Add Kafka for reliable event streaming
   - Add comprehensive monitoring (Prometheus)
   - Add distributed tracing (Jaeger)
