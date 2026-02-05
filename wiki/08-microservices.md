# Microservices Architecture Guide

PlayStation Network Backend Interview Practice App

## Table of Contents

1. [Microservices Overview](#microservices-overview)
2. [API Gateway Pattern](#api-gateway-pattern)
3. [Circuit Breaker Pattern](#circuit-breaker-pattern)
4. [Service Communication](#service-communication)
5. [GraphQL Federation](#graphql-federation)
6. [Service Discovery & Health Checks](#service-discovery--health-checks)
7. [Distributed Systems Patterns](#distributed-systems-patterns)
8. [Interview Questions](#interview-questions)

---

## Microservices Overview

### Monolith vs Microservices

#### Monolithic Architecture

A monolithic architecture centralizes all functionality into a single codebase and deployment unit.

**Structure:**
```
┌──────────────────────────────────────────────────────┐
│              MONOLITHIC APPLICATION                   │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │  Auth │ Friends │ Games │ Chat │ Voice │ Profile  │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  Single Database                                      │
│  Single Deployment                                    │
│  Single Technology Stack                             │
└──────────────────────────────────────────────────────┘
```

**Pros:**
- Simple deployment (one binary/container)
- Easy debugging (all code in one place)
- Straightforward transactions (shared database)
- Simple performance optimization

**Cons:**
- Scaling is all-or-nothing (must scale entire monolith)
- Technology lock-in (entire app uses same stack)
- One team's changes affect everyone
- Failure in one component affects whole system
- Difficult to deploy frequently

#### Microservices Architecture

Microservices break the monolith into independently deployable services, each owning its data.

**Structure:**
```
┌─────────────────────────────────────────────────────────┐
│                  API GATEWAY                             │
└────────────┬───────────────────┬───────────┬────────────┘
             │                   │           │
      ┌──────▼────────┐  ┌───────▼──────┐  ┌▼─────────────┐
      │  Auth Service │  │Friend Service│  │Game Service  │
      │               │  │              │  │              │
      │ Auth DB       │  │Friend DB     │  │Game DB       │
      └───────────────┘  └──────────────┘  └──────────────┘

      ┌─────────────────┐  ┌─────────────────┐
      │  Chat Service   │  │Activity Service │
      │                 │  │                 │
      │  Chat DB        │  │Activity DB      │
      └─────────────────┘  └─────────────────┘
```

**Pros:**
- Independent scaling (scale only what's needed)
- Technology diversity (each service chooses its stack)
- Independent deployment (fast, low-risk changes)
- Team autonomy (each team owns their service)
- Resilience (one service down doesn't kill everything)

**Cons:**
- Distributed system complexity (eventual consistency, network calls)
- Operational overhead (more services to monitor/manage)
- Data consistency challenges (no global transactions)
- Testing is harder (need to test across services)
- Debugging is complex (need distributed tracing)

### When to Break Apart Services

**Start with a monolith.** Microservices add complexity—only adopt when you get value.

**Break into microservices when:**

1. **Independent scaling needs**
   - Gaming service has 100x more traffic than auth
   - Scaling entire monolith is wasteful
   - Solution: Extract Game Service, scale independently

2. **Different technology requirements**
   - Auth needs strong consistency
   - Chat needs real-time messaging (WebSockets)
   - Video streaming needs different infrastructure
   - Solution: Each service uses appropriate tech stack

3. **Team independence**
   - 50+ engineers working on same codebase
   - Different teams have different release cycles
   - Solution: Each team owns a service

4. **Resilience requirements**
   - Database migration for one feature
   - Don't want to take down entire system
   - Solution: Service owns its database

5. **High-frequency deployments**
   - Friends team deploys 10x per day
   - Can't coordinate with every other team
   - Solution: Friends Service deploys independently

### Service Boundaries in Gaming Platforms

When designing microservices for gaming platforms, boundaries should follow business domains:

```
┌──────────────────────────────────────────────────────────────┐
│                      PSN SERVICES                             │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  AUTH SERVICE              PROFILE SERVICE                   │
│  - Register/login          - User profiles                   │
│  - JWT tokens              - Gamertag                        │
│  - Sessions                - Avatar                          │
│  - Password mgmt           - Level/trophies                  │
│                                                               │
│  FRIEND SERVICE            GAME SERVICE                      │
│  - Friend list             - Game catalog                    │
│  - Friend requests         - Game library                    │
│  - Blocking                - Achievements                    │
│  - Lists                   - Play sessions                   │
│                                                               │
│  ACTIVITY SERVICE          PRESENCE SERVICE                  │
│  - Activity feed           - Online status                   │
│  - Feed items              - Current game                    │
│  - Social interactions     - Status messages                 │
│  - Likes/comments          - Activity updates                │
│                                                               │
│  CHAT SERVICE              VOICE SERVICE                     │
│  - Direct messages         - Voice calls                     │
│  - Group chat              - Party management                │
│  - Message persistence     - Audio quality mgmt              │
│  - Notifications           - Connection handling             │
└──────────────────────────────────────────────────────────────┘
```

**Key Principle:** Each service owns a business capability with a clear API contract.

---

## API Gateway Pattern

The API Gateway is the single entry point for all client requests. It centralizes cross-cutting concerns.

### Architecture

```
┌──────────────────────────────────┐
│      CLIENT REQUESTS             │
└───────────────┬──────────────────┘
                │
┌───────────────▼────────────────────────────────────────────┐
│                    API GATEWAY                              │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ Authenticate │  │ Rate Limit   │  │ Circuit Break    │ │
│  └──────────────┘  └──────────────┘  └──────────────────┘ │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐ │
│  │              Request Router                         │ │
│  └──────────────────────────────────────────────────────┘ │
└───────────────┬──────────────────────────────────────────┘
                │
        ┌───────┴──────────┬──────────┬──────────┐
        │                  │          │          │
   ┌────▼──┐  ┌─────────────┐ ┌──────▼──┐ ┌────▼───┐
   │ Auth  │  │   Friend    │ │  Game   │ │ Chat   │
   │Svc    │  │   Service   │ │Service  │ │Service │
   └───────┘  └─────────────┘ └────────┘ └────────┘
```

### Gateway Responsibilities

#### 1. Request Routing

Route requests to appropriate microservices based on path patterns.

```typescript
// Route examples
GET /auth/login             → Auth Service
GET /friends/list           → Friend Service
GET /games/library          → Game Service
POST /chat/messages         → Chat Service
GET /profile/@me            → Profile Service
```

**Implementation:** Express middleware with service registry

```typescript
const SERVICE_REGISTRY: Record<string, ServiceConfig> = {
  auth: {
    name: 'auth-service',
    url: process.env.AUTH_SERVICE_URL || 'http://localhost:4001',
    healthEndpoint: '/health',
    timeout: 5000,
    retries: 3,
  },
  friend: {
    name: 'friend-service',
    url: process.env.FRIEND_SERVICE_URL || 'http://localhost:4002',
    healthEndpoint: '/health',
    timeout: 5000,
    retries: 3,
  },
  // ... more services
};

// Mount routes
app.use('/auth', createServiceProxy('auth'));
app.use('/friends', createServiceProxy('friend'));
app.use('/games', createServiceProxy('game'));
```

#### 2. Authentication at Gateway

Validate JWT tokens centrally, avoiding duplicate auth logic in every service.

**Flow:**

```
Client Request
    ↓
[Gateway Auth Middleware]
    ↓
Validate JWT token
    ↓
Extract user info
    ↓
Attach X-User-ID header
    ↓
Forward to service
```

**Implementation:**

```typescript
app.use((req: Request, res: Response, next: NextFunction) => {
  // Skip auth for public endpoints
  const publicPaths = ['/health', '/auth/login', '/auth/register'];
  if (publicPaths.some(path => req.path.startsWith(path))) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization' });
  }

  const token = authHeader.substring(7);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'key');
    (req as any).user = payload;
    (req as any).context.userId = (payload as any).userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
});
```

**Benefits:**
- Single source of truth for auth
- Services don't need to validate tokens
- Easy to update auth strategy (rotate keys, change algorithm)
- Consistent security across all endpoints

#### 3. Rate Limiting Aggregation

Prevent any single user/IP from overwhelming the system with distributed rate limiting.

**Algorithm: Token Bucket with Redis**

Each user has a bucket that refills tokens at a fixed rate. Requests consume tokens.

```
User Alice's Token Bucket:

Time 0:      [████████] 100 tokens, max capacity 100
Request 1:   [███████░] 99 tokens consumed
Request 2:   [██████░░] 98 tokens consumed
Time 60s:    [████████] 100 tokens (refilled)
```

**Implementation:**

```typescript
class RateLimiter {
  async isAllowed(key: string): Promise<{
    allowed: boolean;
    remaining: number;
    resetAt: number;
  }> {
    const now = Date.now();
    const windowStart = now - this.windowMs; // 60 second window
    const redisKey = `ratelimit:${key}`;

    // Remove old entries outside window
    await this.redis.zremrangebyscore(redisKey, 0, windowStart);

    // Count requests in current window
    const count = await this.redis.zcard(redisKey);

    if (count >= this.maxRequests) { // 100 requests per minute
      const oldest = await this.redis.zrange(redisKey, 0, 0, 'WITHSCORES');
      const resetAt = oldest.length >= 2
        ? parseInt(oldest[1]) + this.windowMs
        : now + this.windowMs;

      return { allowed: false, remaining: 0, resetAt };
    }

    // Record this request
    await this.redis.zadd(redisKey, now, `${now}:${Math.random()}`);
    await this.redis.expire(redisKey, Math.ceil(this.windowMs / 1000));

    return {
      allowed: true,
      remaining: this.maxRequests - count - 1,
      resetAt: now + this.windowMs,
    };
  }
}
```

**Gateway Middleware:**

```typescript
app.use(async (req: Request, res: Response, next: NextFunction) => {
  // Skip rate limiting for health checks
  if (req.path === '/health') return next();

  // Use authenticated user ID, fallback to IP
  const key = (req as any).user?.userId || req.ip || 'unknown';
  const result = await rateLimiter.isAllowed(key);

  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', result.resetAt);

  if (!result.allowed) {
    return res.status(429).json({
      error: 'Too Many Requests',
      retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
    });
  }

  next();
});
```

**Response Headers:**

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1706937600
Retry-After: 45
```

---

## Circuit Breaker Pattern

The Circuit Breaker prevents cascade failures when a downstream service is failing.

### States and Transitions

The circuit breaker has three states:

```
                    ┌──────────────────┐
                    │     CLOSED       │
                    │ Requests allowed │
                    └────────┬─────────┘
                             │
              Failures > 5   │    Success
                             ▼
                    ┌──────────────────┐
                    │     OPEN         │
                    │ Requests blocked │
                    └────────┬─────────┘
                             │
                   Timeout 30s reached
                             │
                             ▼
                    ┌──────────────────┐
                    │   HALF_OPEN      │
                    │  Testing service │
                    └────────┬─────────┘
                             │
               Request fails │ Success (3x)
                      ┌──────┴──────┐
                      ▼             ▼
                    OPEN          CLOSED
```

### State Details

**CLOSED:** Normal operation
- All requests pass through to the service
- Failures are counted
- When failures exceed threshold, transition to OPEN

**OPEN:** Service is failing
- All requests are immediately rejected with 503
- Prevents wasting resources on failing service
- After timeout expires, transition to HALF_OPEN

**HALF_OPEN:** Testing recovery
- A few requests are allowed through
- If they succeed, the service has recovered → CLOSED
- If they fail, service still broken → OPEN

### Implementation

```typescript
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreaker {
  state: CircuitState;
  failures: number;
  lastFailureTime: number;
  successCount: number;
}

class CircuitBreakerManager {
  private circuits: Map<string, CircuitBreaker> = new Map();
  private readonly failureThreshold = 5;
  private readonly resetTimeout = 30000; // 30 seconds
  private readonly halfOpenSuccessThreshold = 3;

  canRequest(serviceName: string): boolean {
    const circuit = this.getOrCreateCircuit(serviceName);

    switch (circuit.state) {
      case 'CLOSED':
        return true;

      case 'OPEN':
        // Check if timeout has expired
        if (Date.now() - circuit.lastFailureTime > this.resetTimeout) {
          circuit.state = 'HALF_OPEN';
          circuit.successCount = 0;
          console.log(`Circuit OPEN → HALF_OPEN for ${serviceName}`);
          return true;
        }
        return false;

      case 'HALF_OPEN':
        return true;
    }
  }

  recordSuccess(serviceName: string): void {
    const circuit = this.getOrCreateCircuit(serviceName);

    if (circuit.state === 'HALF_OPEN') {
      circuit.successCount++;
      if (circuit.successCount >= this.halfOpenSuccessThreshold) {
        circuit.state = 'CLOSED';
        circuit.failures = 0;
        console.log(`Circuit HALF_OPEN → CLOSED for ${serviceName}`);
      }
    } else if (circuit.state === 'CLOSED') {
      circuit.failures = 0;
    }
  }

  recordFailure(serviceName: string): void {
    const circuit = this.getOrCreateCircuit(serviceName);

    if (circuit.state === 'HALF_OPEN') {
      circuit.state = 'OPEN';
      circuit.lastFailureTime = Date.now();
      console.log(`Circuit HALF_OPEN → OPEN for ${serviceName}`);
    } else if (circuit.state === 'CLOSED') {
      circuit.failures++;
      if (circuit.failures >= this.failureThreshold) {
        circuit.state = 'OPEN';
        circuit.lastFailureTime = Date.now();
        console.log(`Circuit CLOSED → OPEN for ${serviceName}`);
      }
    }
  }
}
```

### Gateway Integration

```typescript
const createServiceProxy = (serviceName: string): express.RequestHandler => {
  const config = SERVICE_REGISTRY[serviceName];

  return (req: Request, res: Response, next: NextFunction) => {
    // Check circuit breaker BEFORE proxying
    if (!circuitBreaker.canRequest(serviceName)) {
      return res.status(503).json({
        error: 'Service Unavailable',
        message: `${serviceName} is temporarily unavailable.`,
      });
    }

    const proxy = createProxyMiddleware({
      target: config.url,
      changeOrigin: true,
      on: {
        proxyRes: () => {
          circuitBreaker.recordSuccess(serviceName);
        },
        error: () => {
          circuitBreaker.recordFailure(serviceName);
        },
      },
    });

    return proxy(req, res, next);
  };
};
```

### Example Scenario

**Time 0s:** Auth Service starts responding slowly

```
Request 1: timeout (CLOSED → failures=1)
Request 2: timeout (failures=2)
Request 3: timeout (failures=3)
Request 4: timeout (failures=4)
Request 5: timeout (failures=5, CLOSED → OPEN)
```

**Time 5s-35s:** Auth Service is broken

```
Request 6: 503 "Service Unavailable" (circuit OPEN)
Request 7: 503 "Service Unavailable"
Request 8: 503 "Service Unavailable"
```

**Time 35s:** Timeout expires, test if service recovered

```
Request 9: Allowed (HALF_OPEN)
  ✓ Success! (successCount=1)
Request 10: Allowed
  ✓ Success! (successCount=2)
Request 11: Allowed
  ✓ Success! (successCount=3, HALF_OPEN → CLOSED)
```

**Time 36s+:** Normal operation resumes

```
Request 12: Normal (CLOSED)
Request 13: Normal
```

---

## Service Communication

Microservices need to communicate. There are two main patterns.

### Synchronous Communication (REST, GraphQL)

Direct request-response communication. Caller waits for response.

#### REST

Simple HTTP requests between services.

```typescript
// Friend Service wants user info from Auth Service
const response = await fetch('http://auth-service:4001/users/user_123');
const user = await response.json();
```

**Pros:**
- Simple, HTTP standard
- Synchronous guarantees (immediate result)
- Easy to implement

**Cons:**
- Tight coupling (caller depends on callee availability)
- Cascading failures (if downstream service slow, caller slow)
- No retry/resilience built-in

#### GraphQL

Query language for APIs, with field-level composition.

```graphql
query {
  activity(id: "act_123") {
    title
    user {
      gamertag
      friends { gamertag }
    }
  }
}
```

Single query spans multiple services (via Federation).

**Pros:**
- Clients request exactly what they need
- Federation allows composing across services
- Strongly typed schema
- Excellent for UI clients

**Cons:**
- More complex than REST
- N+1 query problems if not careful
- Schema coordination between services

### Asynchronous Communication (Message Queues, Events)

Publish-subscribe communication. Publisher doesn't wait for responses.

#### Kafka Event Streaming

Services emit events to topics. Other services subscribe and react.

**Architecture:**

```
┌─────────────────────────────────────────┐
│          KAFKA CLUSTER                   │
├─────────────────────────────────────────┤
│                                          │
│ Topic: user-events                       │
│ ├─ Partition 0: users A-H               │
│ ├─ Partition 1: users I-P               │
│ └─ Partition 2: users Q-Z               │
│                                          │
│ Topic: game-events                       │
│ ├─ Partition 0: games A-M               │
│ ├─ Partition 1: games N-Z               │
│ └─ Partition 2: achievements            │
│                                          │
│ Topic: social-events                     │
│ └─ Partition 0: all social events       │
│                                          │
└─────────────────────────────────────────┘

Producers                Consumers
├─ Auth Service       ├─ Profile Service
│  ├─ user.registered │  └─ Creates profile
│  ├─ user.logged_in  │
│  └─ ...             ├─ Activity Service
│                     │  └─ Records activities
├─ Game Service       │
│  ├─ game.started    ├─ Presence Service
│  ├─ achievement.    │  └─ Updates status
│  │  unlocked        │
│  └─ ...             └─ Notification Service
│                        └─ Sends alerts
└─ ...
```

**Example Event:**

```json
{
  "eventId": "evt_123",
  "type": "user.registered",
  "timestamp": "2024-02-04T10:30:00Z",
  "source": "auth-service",
  "correlationId": "req_456",
  "version": "1.0",
  "payload": {
    "userId": "user_789",
    "gamertag": "ProGamer123",
    "email": "user@psn.com"
  }
}
```

**Producer (Auth Service):**

```typescript
// When user registers
await eventBus.publish(
  TOPICS.USER_EVENTS,
  'user.registered',
  {
    userId: 'user_789',
    gamertag: 'ProGamer123',
    email: 'user@psn.com',
  },
  'user_789', // partition key (ensures ordering per user)
  correlationId
);
```

**Consumer (Profile Service):**

```typescript
eventBus.handle('user.registered', async (event, metadata) => {
  const { userId, gamertag, email } = event.payload;

  // Create user profile
  await profileService.createProfile({
    userId,
    gamertag,
    avatar: '🎮',
    level: 1,
  });

  console.log(`Profile created for ${gamertag}`);
});

await eventBus.startConsuming();
```

**Key Concepts:**

- **Topics:** Named channels (user-events, game-events)
- **Partitions:** Parallel lanes within a topic
- **Consumers:** Services that read from topics
- **Consumer Groups:** Multiple consumers share partitions
- **Offsets:** Position in partition (for exactly-once processing)
- **Keys:** Messages with same key go to same partition (ordering guarantee)

**Ordering Guarantees:**

```
User Alice events MUST be processed in order:
├─ user.registered (offset 0)
├─ user.logged_in (offset 1)
├─ friend.request_sent (offset 2)
└─ friend.created (offset 3)

Solution: Use userId as partition key
All Alice events → same partition → same consumer → ordered
```

**Pros:**
- Loose coupling (services don't know about each other)
- Resilience (publisher doesn't care if subscriber is down)
- Scalability (add subscribers without publisher knowing)
- Naturally handles async operations

**Cons:**
- Eventual consistency (subscribers lag behind)
- Complex error handling (what if subscriber fails?)
- Harder to debug (events dispersed across services)
- Need monitoring/alerting for failed subscribers

### gRPC for Internal Communication

Protocol Buffers for efficient, strongly-typed internal service calls.

```protobuf
service UserService {
  rpc GetUser(GetUserRequest) returns (User) {}
  rpc SearchUsers(SearchUsersRequest) returns (stream User) {}
}

message GetUserRequest {
  string user_id = 1;
}

message User {
  string id = 1;
  string gamertag = 2;
  int32 level = 3;
}
```

**Benefits:**
- Efficient binary serialization
- Strongly typed
- Built-in streaming
- Fast (HTTP/2 multiplexing)

**Use Cases:**
- Internal service-to-service calls
- High-frequency communication
- Real-time updates (streaming)

---

## GraphQL Federation

Apollo Federation allows composing a graph from multiple microservices. Each service defines its own schema (subgraph). The Gateway stitches them together (supergraph).

### Architecture

```
                    SUPERGRAPH
                  (Apollo Gateway)
                        │
        ┌───────────────┼───────────────┐
        │               │               │
   ┌────▼────┐   ┌─────▼──────┐  ┌────▼──────┐
   │ User    │   │ Friend     │  │ Game      │
   │Subgraph │   │ Subgraph   │  │ Subgraph  │
   └─────────┘   └────────────┘  └───────────┘
```

### Subgraph Composition

Each service defines and owns its entities.

**User Subgraph (owns User):**

```typescript
const userTypeDefs = gql`
  type User @key(fields: "id") {
    id: ID!
    gamertag: String!
    avatar: String!
    level: Int!
    trophyCount: Int!
    status: UserStatus!
  }

  enum UserStatus {
    ONLINE
    AWAY
    BUSY
    OFFLINE
  }

  type Query {
    user(id: ID!): User
    me: User
  }
`;

const userResolvers = {
  Query: {
    user: async (_, { id }, { dataSources }) => {
      return dataSources.userAPI.getUser(id);
    },
  },
  User: {
    // Federation: resolve referenced user
    __resolveReference: async (reference, { dataSources }) => {
      return dataSources.userAPI.getUser(reference.id);
    },
  },
};
```

**Friend Subgraph (extends User):**

```typescript
const friendTypeDefs = gql`
  # Extend User without owning it
  type User @key(fields: "id") {
    id: ID! @external  # Field defined elsewhere
    friends: [User!]!  # New field we add
    friendCount: Int!
    isFriendWith(userId: ID!): Boolean!
  }

  type Query {
    friendRequests(userId: ID!): [FriendRequest!]!
  }
`;

const friendResolvers = {
  User: {
    __resolveReference: async (reference) => {
      return { id: reference.id };
    },
    friends: async (user, _, { dataSources }) => {
      const friendIds = await dataSources.friendAPI.getFriendIds(user.id);
      // Return entity references (pointers to User)
      return friendIds.map(id => ({ __typename: 'User', id }));
    },
  },
};
```

### Federation Directives

**@key:** Marks a type as a federated entity with a primary key.

```graphql
type User @key(fields: "id") {
  id: ID!
  gamertag: String!
}
```

Tells Gateway: "This type can be referenced by other subgraphs using `id` field."

**@external:** References a field defined in another subgraph.

```graphql
type User @key(fields: "id") {
  id: ID! @external  # Field owned by User subgraph
  friends: [User!]!  # Field we're adding
}
```

**@requires:** Field requires another field to be fetched first.

```graphql
type User @key(fields: "id") {
  id: ID!
  gamertag: String!
  displayName: String! @requires(fields: "gamertag")
}
```

**@shareable:** Multiple subgraphs can resolve this field.

```graphql
type User @key(fields: "id") {
  id: ID!
  gamertag: String! @shareable
}
```

### Entity Resolution

When a query spans multiple subgraphs, how does the Gateway resolve entities?

**Example Query:**

```graphql
query {
  activity(id: "act_123") {
    title
    user {
      gamertag
      friendCount
    }
  }
}
```

Spans: Activity Subgraph → User Subgraph → Friend Subgraph

**Resolution Flow:**

```
1. Gateway queries Activity Subgraph
   activity(id: "act_123")
   Returns: { id: "act_123", userId: "user_789", title: "... }

2. Friend Subgraph needs User info
   Returns reference: { __typename: "User", id: "user_789" }

3. Gateway queries User Subgraph
   _entities(representations: [{ __typename: "User", id: "user_789" }])
   Returns: { id: "user_789", gamertag: "ProGamer", ... }

4. Gateway queries Friend Subgraph (with User in context)
   user { friendCount }
   Returns: { friendCount: 42 }

5. Merge results
   {
     activity: {
       title: "...",
       user: {
         gamertag: "ProGamer",
         friendCount: 42
       }
     }
   }
```

### Production Setup

In development, subgraphs are stitched locally. Production uses Apollo Gateway:

```typescript
import { ApolloGateway, IntrospectAndCompose } from '@apollo/gateway';
import { ApolloServer } from '@apollo/server';

const gateway = new ApolloGateway({
  supergraphSdl: new IntrospectAndCompose({
    subgraphs: [
      { name: 'users', url: 'http://users-service:4001/graphql' },
      { name: 'friends', url: 'http://friends-service:4002/graphql' },
      { name: 'games', url: 'http://games-service:4003/graphql' },
      { name: 'activities', url: 'http://activities-service:4004/graphql' },
    ],
  }),
  // ... options
});

const server = new ApolloServer({ gateway });
await server.start();
```

**Schema Management with Rover CLI:**

```bash
# Publish subgraph schema
rover subgraph publish psn-supergraph \
  --name users \
  --schema schema.graphql \
  --routing-url http://users-service/graphql

# Compose supergraph
rover supergraph compose --config supergraph.yaml > supergraph.graphql
```

---

## Service Discovery & Health Checks

Services need to find each other. How do they know where other services are?

### Registration Patterns

#### 1. Static Configuration (Simple)

Services configured with hardcoded URLs.

```typescript
const SERVICE_REGISTRY = {
  auth: { url: 'http://auth-service:4001' },
  friend: { url: 'http://friend-service:4002' },
  game: { url: 'http://game-service:4003' },
};
```

**Pros:** Simple, no extra infrastructure
**Cons:** Requires deployment to change, doesn't handle dynamic IPs

#### 2. DNS-based (Kubernetes)

Kubernetes provides DNS names that resolve to services.

```
http://auth-service         → K8s resolves to all auth pods
http://auth-service.default → Fully qualified name
```

Kubernetes' built-in service discovery:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: auth-service
spec:
  selector:
    app: auth
  ports:
    - port: 4001
      targetPort: 4001
```

**Pros:** Automatic, handles pod creation/deletion
**Cons:** K8s-specific, requires cluster DNS

#### 3. Consul/Eureka (Client-side Discovery)

Centralized registry. Clients query registry to find services.

```
Service Start → Register at Consul
               ↓
Client needs service → Query Consul
                    ← Consul returns healthy instances
Client connects to instance
```

#### 4. AWS ALB/NLB (Server-side Discovery)

Load balancer handles service discovery.

```
Client → Load Balancer (knows all backends)
      → Backend instance 1
      → Backend instance 2
      → Backend instance 3 (down, ALB removes)
```

### Health Endpoints

Every service should have a `/health` endpoint for liveness/readiness checks.

**Liveness Check:** "Is the service running?"

```typescript
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});
```

**Readiness Check:** "Can the service handle requests?"

```typescript
app.get('/ready', async (req, res) => {
  const health = {
    ready: true,
    checks: {
      database: 'ok',
      redis: 'ok',
      dependencies: 'ok',
    },
  };

  // Check database connection
  try {
    await db.ping();
  } catch {
    health.ready = false;
    health.checks.database = 'failed';
  }

  // Check Redis connection
  try {
    await redis.ping();
  } catch {
    health.ready = false;
    health.checks.redis = 'failed';
  }

  const statusCode = health.ready ? 200 : 503;
  res.status(statusCode).json(health);
});
```

**Gateway Health Check:**

```typescript
app.get('/health', async (_req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {},
  };

  // Check each downstream service
  for (const [name, config] of Object.entries(SERVICE_REGISTRY)) {
    const circuit = circuitBreaker.getState(name);
    health.services[name] = {
      url: config.url,
      circuitState: circuit.state,
      failures: circuit.failures,
    };
  }

  res.json(health);
});
```

### Load Balancing Strategies

**Round Robin:** Distribute requests evenly

```
Request 1 → Instance A
Request 2 → Instance B
Request 3 → Instance C
Request 4 → Instance A
```

**Least Connections:** Route to instance with fewest active connections

```
Instance A: 5 active connections
Instance B: 2 active connections  ← Route here
Instance C: 3 active connections
```

**Weighted Round Robin:** Prefer stronger instances

```
Instance A (2 CPUs):   2x weight
Instance B (4 CPUs):   4x weight
Instance C (2 CPUs):   2x weight

Requests distributed as: A:2, B:4, C:2
```

**Random:** Simple, good for stateless services

```
Random selection from healthy instances
```

---

## Distributed Systems Patterns

### Request Tracing

Track requests across services for debugging and monitoring.

**Implementation:**

```typescript
// Middleware: Generate/propagate request IDs
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || uuidv4();
  const correlationId = req.headers['x-correlation-id'];

  (req as any).context = {
    requestId,
    correlationId,
    startTime: Date.now(),
  };

  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Correlation-ID', correlationId || requestId);

  next();
});

// When calling downstream service
const context = (req as any).context;
const response = await fetch('http://friend-service/friends', {
  headers: {
    'X-Request-ID': context.requestId,
    'X-Correlation-ID': context.correlationId,
  },
});
```

**Log Aggregation:**

```
[2024-02-04 10:30:00] [req-abc123] GET /profile/user_123
[2024-02-04 10:30:00] [req-abc123] X-User-ID: user_456
[2024-02-04 10:30:01] [req-abc123] → Friend Service: GET /friends/user_123
[2024-02-04 10:30:01] [req-abc123] ← Friend Service: 200, 42 friends
[2024-02-04 10:30:02] [req-abc123] → Game Service: GET /games/user_123
[2024-02-04 10:30:02] [req-abc123] ← Game Service: 200, 87 games
[2024-02-04 10:30:03] [req-abc123] Response: 200, 125ms
```

All logs with same request ID can be correlated.

### Saga Pattern for Distributed Transactions

Database transactions don't work across services. Use Sagas for compensation.

**Example: Referral Bonus**

User A refers User B. Requirements:
1. Create new user
2. Update User A's friend list
3. Award User A trophy
4. Send notification to User A

Transactions can fail at any step. Sagas handle compensation.

**Choreography (Events):**

```
Auth Service: user.registered
       ↓
Friend Service: Add User A as friend
       ↓
Game Service: Award trophy to User A
       ↓
Notification Service: Send email

If Notification fails:
Game Service compensates: Remove trophy
Friend Service compensates: Remove friend
```

**Orchestration (Workflow):**

```
Saga Orchestrator:
1. Call Auth Service: Create user → success
2. Call Friend Service: Add friend → success
3. Call Game Service: Award trophy → FAIL!
4. Compensate: Call Friend Service: Remove friend
5. Compensate: Cleanup
```

### Eventual Consistency

Services eventually agree on state, but not immediately.

**Example: Like Activity**

```
Time 0: User clicks "Like"
↓
Activity Service records like → Activity.likeCount = 42
↓
Publish event: activity.liked
↓
Notification Service subscribes
Notification Service sluggish, 5 seconds behind
↓
During those 5 seconds:
- Activity Service sees 42 likes
- Notification Service still sees 41 likes
↓
Eventually consistent: Both see 42 likes
```

---

## Interview Questions

### Design Questions

#### 1. Design a Messaging Service for PSN

> You need to build a messaging system that allows users to send direct messages to friends. What are the key components and patterns you'd use?

**Key Points to Cover:**

- **Service isolation:** Chat Service owns message data and delivery
- **Scalability:** Distributed message queuing (Kafka) for high throughput
- **Real-time updates:** WebSockets for instant message delivery
- **Data consistency:** Messages should be ordered per conversation
- **Offline handling:** Store messages until user comes online
- **Caching:** Cache recent conversations for fast access

**Architecture:**

```
┌─────────────────────────────────────────┐
│          Client (WebSocket)              │
└────────────────────┬────────────────────┘
                     │
          ┌──────────▼──────────┐
          │  Chat Gateway       │
          │  (WebSocket Handler)│
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  Chat Service       │
          │  (Message logic)    │
          └──────────┬──────────┘
                     │
         ┌───────────┼───────────┐
         │           │           │
    ┌────▼──┐  ┌────▼──┐  ┌────▼──┐
    │Postgres│  │  Redis│  │ Kafka │
    │(persist)│  │(cache)│  │(relay)│
    └────────┘  └───────┘  └───────┘
```

#### 2. How Would You Handle Service Failures?

> Auth Service is down. Describe how your system handles this and what happens to users.

**Answer:**

1. **Circuit Breaker:** Gateway detects Auth Service failures, opens circuit
2. **Cached tokens:** Gateway caches recently validated tokens
3. **Fallback:** Allow requests with cached tokens (eventual consistency)
4. **Retry:** Implement exponential backoff for recovery attempts
5. **Alert:** Ops team is notified immediately
6. **Graceful degradation:** Some features work, others return errors

**Timeline:**

```
10:00 - Auth Service crashes
10:01 - Gateway circuit opens after 5 failures
        New auth requests get 503
        Existing sessions continue (cached tokens)
10:02 - Ops team alerted
10:05 - Circuit enters half-open, tests recovery
10:06 - Auth Service restarts
        Circuit closes, auth restored
```

#### 3. Design Friend List Synchronization

> Friend lists need to be consistent across 3 data centers. Design the replication strategy.

**Approach: Event Sourcing**

1. **All changes are events:** "User A added User B"
2. **Events replicated to all DCs:** Kafka replication
3. **Each DC applies events in order:**

```
DC 1: Primary
  Event 1: A added B
  Event 2: B added C
  ↓ Replicate to DC 2, DC 3

DC 2: Replica
  Event 1: A added B
  Event 2: B added C

DC 3: Replica
  Event 1: A added B
  Event 2: B added C
```

**Consistency guarantees:**
- Strong consistency for single user's events (same partition key)
- Eventual consistency across users
- Conflict-free (events are ordered)

### Implementation Questions

#### 4. Implement Rate Limiting for an Endpoint

> Design and implement rate limiting for the `/friends/list` endpoint. It should limit users to 100 requests per minute.

**Solution:**

```typescript
class RateLimiter {
  constructor(private redis: Redis, private windowMs: number = 60000) {}

  async isAllowed(key: string, limit: number = 100): Promise<boolean> {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const redisKey = `ratelimit:${key}`;

    // Remove old entries
    await this.redis.zremrangebyscore(redisKey, 0, windowStart);

    // Count requests in window
    const count = await this.redis.zcard(redisKey);

    if (count >= limit) {
      return false;
    }

    // Record this request
    await this.redis.zadd(redisKey, now, `${now}:${Math.random()}`);
    await this.redis.expire(redisKey, Math.ceil(this.windowMs / 1000));

    return true;
  }
}

// Express middleware
app.use('/friends/list', async (req, res, next) => {
  const userId = (req as any).user?.userId || req.ip;
  const allowed = await rateLimiter.isAllowed(userId, 100);

  if (!allowed) {
    return res.status(429).json({ error: 'Rate limited' });
  }

  next();
});
```

#### 5. Debug a Cascading Failure

> Users report latency spikes. Logs show Game Service is slow. How do you diagnose and fix?

**Investigation Steps:**

1. **Check circuit breaker status:**
   ```
   GET /health → Game Service circuit is HALF_OPEN
   → Game Service is failing
   ```

2. **Review recent deployments:**
   ```
   Game Service deployed 10 minutes ago
   Latency started right after deployment
   ```

3. **Check logs for errors:**
   ```
   [Game Service] Query timeout: SELECT * FROM games (20s)
   → Database query is slow
   ```

4. **Check database:**
   ```
   EXPLAIN SHOW stats
   → Missing index on game_name
   OR → Disk full, slow I/O
   ```

5. **Implement circuit breaker:**
   - Block Game Service requests temporarily
   - Prevent cascade to other services
   - Return fallback response or error

6. **Fix root cause:**
   - Add database index
   - Optimize query
   - Scale database

7. **Monitor recovery:**
   - Circuit transitions to HALF_OPEN
   - Test requests pass
   - Circuit closes
   - Latency returns to normal

#### 6. Data Consistency Challenge

> Two users add each other as friends simultaneously. How do you prevent race conditions?

**Solution Options:**

**Option 1: Optimistic Locking**
```typescript
// Friend Service
const friend = await db.getFriend(userId1, userId2);
const version = friend.version;

// Update only if version matches
const updated = await db.updateFriend(
  userId1,
  userId2,
  newData,
  version // Check version
);

if (!updated) {
  // Version mismatch, retry
  return await addFriend(userId1, userId2);
}
```

**Option 2: Distributed Locks**
```typescript
const lock = await redis.acquire(`friend_lock:${userId1}:${userId2}`, 5000);

if (!lock.acquired) {
  return { error: 'Locked, try again' };
}

try {
  // Critical section
  await friendService.addFriend(userId1, userId2);
  await friendService.addFriend(userId2, userId1);
} finally {
  await lock.release();
}
```

**Option 3: Event Sourcing**
```
Event: "User A added User B as friend"
  - All changes stored as immutable events
  - Events applied in order (no race conditions)
  - Same request seen twice → same event → idempotent
```

**Best Practice:** Use distributed locks for critical operations, ensure operations are idempotent.

---

## Key Takeaways

1. **API Gateway:** Centralizes auth, rate limiting, routing, circuit breaking
2. **Circuit Breaker:** Prevents cascading failures with three states
3. **Service Communication:** Synchronous (REST/GraphQL) vs Asynchronous (Kafka)
4. **GraphQL Federation:** Compose subgraph schemas at the gateway
5. **Health Checks:** Every service needs `/health` and `/ready` endpoints
6. **Distributed Tracing:** Track requests with correlation IDs
7. **Eventual Consistency:** Services eventually agree on state
8. **Idempotency:** Operations should be safe to retry
9. **Monitoring:** Alert on circuit breaker state changes, service latency
10. **Fallbacks:** Graceful degradation when services fail

---

## References

- [API Gateway Pattern - Sam Newman](https://samnewman.io/patterns/architectural/api-gateway/)
- [Circuit Breaker Pattern - Martin Fowler](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Apollo Federation - Apollo Docs](https://www.apollographql.com/docs/federation/)
- [Apache Kafka Documentation](https://kafka.apache.org/documentation/)
- [Service Discovery Patterns - Chris Richardson](https://microservices.io/patterns/service-discovery.html)
