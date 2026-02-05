# PlayStation Network Social Platform - Backend Interview Study Guide

A comprehensive full-stack real-time social gaming platform demonstrating PlayStation Network's backend architecture patterns. Built for **backend engineering interview preparation**.

**10 Complete Phases** | **Production-Ready Patterns** | **Interview-Focused Documentation**

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [All 10 Phases](#all-10-phases)
4. [Quick Start](#quick-start)
5. [Project Structure](#project-structure)
6. [Core Services](#core-services)
7. [Interview Topics by Phase](#interview-topics-by-phase)
8. [API Reference](#api-reference)
9. [Development Guide](#development-guide)
10. [Common Interview Questions](#common-interview-questions)
11. [Wiki Documentation](#wiki-documentation)
12. [Resources](#resources)

---

## Overview

This project implements a **complete PlayStation Network clone** covering 10 progressive phases—from basic auth to AWS production deployment. Each phase introduces real-world backend patterns used at companies like Sony, Discord, and Netflix.

### What You'll Master

| Phase | Topics | Key Patterns |
|-------|--------|--------------|
| **1. Friend System** | GraphQL, Redis Sets, Pub/Sub | Fan-out, real-time events |
| **2. Chat System** | Rate limiting, message types | Sliding window algorithm |
| **3. Game Integration** | Achievements, sessions | Two-tier caching |
| **4. Activity Feed** | Social feeds | Fan-out on write |
| **5. Voice Chat** | WebRTC signaling | SFU architecture |
| **6. User Profiles** | Privacy, stats | Privacy-based filtering |
| **7. Microservices** | Service mesh | Circuit breaker, API Gateway |
| **8. Production Scaling** | Redis Cluster, Kafka | Distributed locks, event streaming |
| **9. React Frontend** | Apollo Client | Subscriptions, optimistic updates |
| **10. AWS Deployment** | Terraform, ECS Fargate | ElastiCache, MSK |

---

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLIENTS                                     │
│                    (PlayStation App, Web, Mobile)                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                     ┌──────────────┴──────────────┐
                     ▼                              ▼
            ┌─────────────────┐           ┌─────────────────┐
            │   HTTP :4000    │           │  WebSocket :4000│
            │ (GraphQL API)   │           │ (Subscriptions) │
            └─────────────────┘           └─────────────────┘
                     │                              │
                     └──────────────┬──────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           APOLLO SERVER                                  │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                          CONTEXT                                    │ │
│  │  • Authenticated User (from JWT)                                    │ │
│  │  • Session Data (from Redis)                                        │ │
│  │  • Request ID (for tracing)                                         │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                         RESOLVERS                                   │ │
│  │  • Query (read operations)                                          │ │
│  │  • Mutation (write operations)                                      │ │
│  │  • Subscription (real-time streams)                                 │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            SERVICES LAYER                                │
│                                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ AuthService │  │PresenceServ│  │ ChatService │  │FriendService│    │
│  │             │  │             │  │             │  │             │    │
│  │ • Register  │  │ • Online    │  │ • Messages  │  │ • Requests  │    │
│  │ • Login     │  │ • Status    │  │ • Groups    │  │ • Accept    │    │
│  │ • JWT       │  │ • Heartbeat │  │ • Typing    │  │ • Block     │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           INFRASTRUCTURE                                 │
│                                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                      │
│  │    Redis    │  │    Kafka    │  │  DynamoDB   │                      │
│  │             │  │             │  │             │                      │
│  │ • Sessions  │  │ • Events    │  │ • Users     │                      │
│  │ • Presence  │  │ • Messages  │  │ • Friends   │                      │
│  │ • Pub/Sub   │  │ • Activity  │  │ • Games     │                      │
│  │ • Cache     │  │             │  │             │                      │
│  └─────────────┘  └─────────────┘  └─────────────┘                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data Flow Example: Friend Request

```
1. User A sends friend request to User B
   │
   ├─► GraphQL Mutation: sendFriendRequest(userId: "B")
   │
   ├─► FriendService validates:
   │   • Not already friends
   │   • Not blocked
   │   • Under request limit
   │
   ├─► Redis Transaction (atomic):
   │   • ZADD user:A:friend_requests:outgoing B timestamp
   │   • ZADD user:B:friend_requests:incoming A timestamp
   │   • HSET friend_request:A:B details
   │
   ├─► Publish Event:
   │   • PUBLISH friend:events {type: "request", from: A, to: B}
   │
   └─► All servers receive event via Pub/Sub
       │
       └─► Server with User B's WebSocket pushes notification
```

---

## Features

### ✅ All Phases Complete

| Phase | Feature | Key Files | Status |
|-------|---------|-----------|--------|
| 1 | **Friend System** | `friend.service.ts` | ✅ Complete |
| 2 | **Chat + Rate Limiting** | `chat.service.ts` | ✅ Complete |
| 3 | **Game Integration** | `game.service.ts` | ✅ Complete |
| 4 | **Activity Feed** | `activity.service.ts` | ✅ Complete |
| 5 | **Voice Chat** | `voice.service.ts` | ✅ Complete |
| 6 | **User Profiles** | `profile.service.ts` | ✅ Complete |
| 7 | **Microservices** | `microservices/` | ✅ Complete |
| 8 | **Production Scaling** | `infrastructure/` | ✅ Complete |
| 9 | **React Frontend** | `frontend/` | ✅ Complete |
| 10 | **AWS Deployment** | `terraform/` | ✅ Complete |

---

## All 10 Phases

### Phase 1: Friend System ✅
**Core social features with real-time updates**

```
Key Patterns:
├── Redis Sets for O(1) friend lookups
├── Sorted Sets for ordered friend requests
├── Pub/Sub for real-time notifications
└── GraphQL subscriptions for WebSocket delivery
```

**Interview Focus:** Redis data structures, real-time architecture

---

### Phase 2: Chat System with Rate Limiting ✅
**Direct messaging with abuse protection**

```
Rate Limiting Algorithm: Sliding Window
┌─────────────────────────────────────────────┐
│  Window: 60 seconds                         │
│  Max requests: 100                          │
│                                             │
│  User sends message:                        │
│  1. ZREMRANGEBYSCORE (remove old entries)   │
│  2. ZCARD (count current window)            │
│  3. If < limit: ZADD + allow               │
│  4. If >= limit: reject                    │
└─────────────────────────────────────────────┘
```

**Interview Focus:** Rate limiting algorithms, Redis Sorted Sets

---

### Phase 3: Game Integration ✅
**Game library, achievements, and play sessions**

```
Trophy System:
├── Bronze (15 points)   - Common achievements
├── Silver (30 points)   - Moderate difficulty
├── Gold (90 points)     - Challenging achievements
└── Platinum (180 points) - 100% game completion
```

**Key Features:**
- User game library with playtime tracking
- Achievement/trophy system with rarity calculation
- Play session management with heartbeat
- Game invites via Pub/Sub

**Interview Focus:** Two-tier caching, session management

---

### Phase 4: Activity Feed ✅
**"What's New" feed using fan-out on write**

```
Fan-Out on Write Pattern:
┌─────────────────────────────────────────────┐
│  User unlocks trophy                        │
│           │                                 │
│           ▼                                 │
│  Create activity record                     │
│           │                                 │
│           ▼                                 │
│  Get friend list (100 friends)              │
│           │                                 │
│           ▼                                 │
│  Pipeline: ZADD to each friend's feed       │
│  (Single round-trip for 100 writes!)        │
│           │                                 │
│           ▼                                 │
│  Publish real-time event                    │
└─────────────────────────────────────────────┘
```

**Interview Focus:** Feed architectures, write amplification tradeoffs

---

### Phase 5: Voice Chat System ✅
**WebRTC signaling with SFU architecture**

```
SFU Architecture (vs Mesh):
┌─────────────────────────────────────────────┐
│  MESH (N² connections)    SFU (N connections)│
│                                             │
│    A ─── B                  A               │
│    │ ╲ ╱ │                  │               │
│    │  ╳  │                  ▼               │
│    │ ╱ ╲ │              ┌───────┐           │
│    C ─── D              │  SFU  │           │
│                         │Server │           │
│  Each sends to all      └───────┘           │
│  4 users = 12 streams   ▲   ▲   ▲           │
│                         B   C   D           │
│                         Each sends 1 stream │
│                         4 users = 4 streams │
└─────────────────────────────────────────────┘
```

**Interview Focus:** WebRTC, media server architectures

---

### Phase 6: User Profiles & Stats ✅
**Extended profiles with privacy controls**

```
Profile Data Layers:
┌─────────────────────────────────────────────┐
│  Layer 1: Core User (AuthService)           │
│  - id, gamertag, email, passwordHash        │
│  - Rarely changes                           │
├─────────────────────────────────────────────┤
│  Layer 2: Extended Profile (ProfileService) │
│  - bio, theme, region, languages            │
│  - User-controlled                          │
├─────────────────────────────────────────────┤
│  Layer 3: Statistics (Computed)             │
│  - playtime, trophies, completion           │
│  - Cached with TTL                          │
└─────────────────────────────────────────────┘
```

**Privacy Visibility:** `public` | `friends` | `private`

**Interview Focus:** Data layering, caching strategies, privacy patterns

---

### Phase 7: Microservices Migration ✅
**Split monolith into independent services**

```
API Gateway Pattern:
┌─────────────────────────────────────────────┐
│                 API GATEWAY                 │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │  Auth   │ │  Rate   │ │ Circuit │       │
│  │Middleware│ │ Limiter │ │ Breaker │       │
│  └────┬────┘ └────┬────┘ └────┬────┘       │
└───────┼───────────┼───────────┼─────────────┘
        │           │           │
   ┌────▼───┐  ┌────▼───┐  ┌────▼───┐
   │  Auth  │  │  Game  │  │  Chat  │
   │Service │  │Service │  │Service │
   └────────┘  └────────┘  └────────┘
```

**Circuit Breaker States:**
- `CLOSED` → Normal operation
- `OPEN` → Failures exceed threshold, reject requests
- `HALF_OPEN` → Testing if service recovered

**Interview Focus:** Service decomposition, fault tolerance

---

### Phase 8: Production Scaling ✅
**Redis Cluster + Kafka event streaming**

```
Redis Cluster (Hash Slots):
┌─────────────────────────────────────────────┐
│  16384 hash slots distributed across nodes  │
│                                             │
│  Master 1        Master 2        Master 3   │
│  Slots 0-5461    Slots 5462-     Slots 10923│
│                  10922           -16383     │
│     │               │               │       │
│  Replica 1      Replica 2      Replica 3    │
│  (failover)     (failover)     (failover)   │
└─────────────────────────────────────────────┘

Hash Tags: user:{123}:profile and user:{123}:friends
           → Same slot (key co-location)
```

**Kafka Event Topics:**
- `psn.user.events` - Registration, login, status changes
- `psn.game.events` - Sessions, achievements
- `psn.social.events` - Friends, messages
- `psn.activity.events` - Feed updates

**Interview Focus:** Sharding, event-driven architecture

---

### Phase 9: React Frontend ✅
**PlayStation-inspired UI with Apollo Client**

```
Apollo Client Architecture:
┌─────────────────────────────────────────────┐
│                Apollo Client                │
│  ┌─────────────────────────────────────┐   │
│  │         Normalized Cache            │   │
│  │  User:123 → { gamertag, status }    │   │
│  │  User:456 → { gamertag, status }    │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  Split Link:                                │
│  ├── HTTP Link (queries, mutations)         │
│  └── WebSocket Link (subscriptions)         │
└─────────────────────────────────────────────┘
```

**Key Hooks:**
- `useAuth()` - Authentication state
- `usePresence()` - Real-time friend presence
- `useFriends()` - Friend list with subscriptions

**Interview Focus:** GraphQL client architecture, real-time React

---

### Phase 10: AWS Deployment ✅
**Terraform infrastructure as code**

```
AWS Architecture:
┌─────────────────────────────────────────────┐
│                    VPC                      │
│  ┌────────────────────────────────────────┐ │
│  │            PUBLIC SUBNETS              │ │
│  │   ALB         NAT Gateway              │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  ┌────────────────────────────────────────┐ │
│  │            PRIVATE SUBNETS             │ │
│  │  ECS Fargate   ElastiCache   MSK       │ │
│  │  (containers)   (Redis)     (Kafka)    │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**Auto-Scaling:** Target CPU 70% → Scale out in 60s, in 300s

**Interview Focus:** Infrastructure as code, cloud architecture

---

## Quick Start

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- Git

### 1. Clone and Install

```bash
git clone <repo-url>
cd psn-practice-app
npm install
```

### 2. Start Infrastructure

```bash
# Start Redis (required)
docker-compose up -d redis

# Optional: Start Redis Commander UI
docker-compose up -d redis-commander
# Access at http://localhost:8081
```

### 3. Start Backend Server

```bash
npm run dev
```

Server available at:
- **GraphQL API**: http://localhost:4000/graphql
- **GraphQL Sandbox**: http://localhost:4000/graphql
- **Health Check**: http://localhost:4000/health
- **WebSocket**: ws://localhost:4000/graphql

### 4. Start Frontend (Optional)

```bash
cd frontend
npm install
npm run dev
```

Frontend at http://localhost:3000

### 5. Test the API

Try this query in the GraphQL Sandbox:

```graphql
mutation Register {
  register(input: {
    gamertag: "TestPlayer"
    email: "test@example.com"
    password: "password123"
  }) {
    token
    user {
      id
      gamertag
    }
  }
}
```

---

## Project Structure

```
psn-practice-app/
├── src/
│   ├── server.ts                    # Main entry (Express + Apollo + WebSocket)
│   │
│   ├── types/
│   │   └── index.ts                 # 1100+ lines of TypeScript interfaces
│   │
│   ├── graphql/
│   │   ├── schema.ts                # Comprehensive GraphQL schema
│   │   └── resolvers.ts             # All query/mutation/subscription resolvers
│   │
│   ├── services/                    # Core application services
│   │   ├── auth/auth.service.ts     # JWT, sessions, user management
│   │   ├── presence/presence.service.ts  # Real-time online status
│   │   ├── friends/friend.service.ts     # Friend system with blocking
│   │   ├── chat/chat.service.ts     # Messaging + rate limiting
│   │   ├── game/game.service.ts     # Game library + achievements
│   │   ├── activity/activity.service.ts  # Feed with fan-out
│   │   ├── voice/voice.service.ts   # Voice rooms + WebRTC signaling
│   │   └── profile/profile.service.ts    # Profiles + privacy
│   │
│   ├── microservices/               # Phase 7: Service decomposition
│   │   ├── gateway/index.ts         # API Gateway + circuit breaker
│   │   ├── auth-service/index.ts    # Standalone auth service
│   │   └── graphql-federation/index.ts  # Apollo Federation setup
│   │
│   └── infrastructure/              # Phase 8: Scaling infrastructure
│       ├── redis-cluster/index.ts   # Cluster config + distributed locks
│       └── kafka/index.ts           # Event streaming + typed events
│
├── frontend/                        # Phase 9: React application
│   └── src/
│       ├── hooks/
│       │   ├── useAuth.tsx          # Auth context + JWT handling
│       │   └── usePresence.tsx      # Real-time presence hook
│       └── components/
│           └── FriendList.tsx       # PlayStation-styled friend list
│
├── infrastructure/                  # Phase 10: AWS deployment
│   └── terraform/
│       └── main.tf                  # Complete AWS infrastructure
│
├── wiki/                            # Comprehensive documentation
│   ├── 01-architecture.md
│   ├── 02-redis-patterns.md
│   ├── 03-graphql-design.md
│   └── ... (see wiki section)
│
├── docker-compose.yml               # Local development infrastructure
├── package.json
└── tsconfig.json
```

---

## Core Concepts

### 1. GraphQL Architecture

**Why GraphQL over REST for PlayStation?**

| Aspect | REST | GraphQL |
|--------|------|---------|
| **Data Fetching** | Multiple endpoints, over/under-fetching | Single endpoint, exact data needed |
| **Real-time** | Separate WebSocket implementation | Subscriptions built-in |
| **Type Safety** | Swagger/OpenAPI (optional) | Schema is the contract |
| **Versioning** | URL versions (/v1, /v2) | Add fields, deprecate old |

**Schema Organization:**
```
schema.ts
├── Enums (UserStatus, MessageType, etc.)
├── Object Types (User, Message, Presence)
├── Input Types (LoginInput, SendMessageInput)
├── Query Type (read operations)
├── Mutation Type (write operations)
└── Subscription Type (real-time events)
```

### 2. Real-time Presence System

**The Challenge:**
- 100M+ users online simultaneously
- Each status change must notify all friends
- Sub-100ms update delivery

**The Solution:**

```
1. User changes status
       ↓
2. Store in Redis with TTL
   SETEX presence:{userId} 300 {data}
       ↓
3. Publish to Pub/Sub channel
   PUBLISH presence:updates {event}
       ↓
4. All servers receive event
   (100 servers, each with ~10,000 clients)
       ↓
5. Each server filters to relevant clients
   (Only notify friends of the user)
       ↓
6. Push via WebSocket to those clients
```

**Heartbeat Pattern:**
```
Client → Server: Heartbeat every 60 seconds
Server → Redis: EXPIRE presence:{userId} 300

If no heartbeat for 5 minutes:
  Redis TTL expires → User marked offline
```

### 3. Friend System Design

**Redis Data Structures:**

```
# Friends (Set) - O(1) membership check
user:{userId}:friends
  └─ {friendId1, friendId2, ...}

# Incoming Requests (Sorted Set) - Ordered by time
user:{userId}:friend_requests:incoming
  └─ Score: timestamp, Member: senderId

# Outgoing Requests (Sorted Set)
user:{userId}:friend_requests:outgoing
  └─ Score: timestamp, Member: recipientId

# Blocked Users (Set)
user:{userId}:blocked
  └─ {blockedId1, blockedId2, ...}
```

**Why These Data Structures?**

| Operation | Data Structure | Time Complexity |
|-----------|----------------|-----------------|
| Check if friends | Set (SISMEMBER) | O(1) |
| Add/remove friend | Set (SADD/SREM) | O(1) |
| Get all friends | Set (SMEMBERS) | O(n) |
| Mutual friends | Set (SINTER) | O(n*m) |
| Paginate requests | Sorted Set (ZRANGE) | O(log n + k) |
| Expire old requests | Sorted Set (ZREMRANGEBYSCORE) | O(log n + k) |

### 4. Authentication Flow

```
1. Login Request
   POST /graphql { mutation: login(...) }
       ↓
2. Validate Credentials
   bcrypt.compare(password, user.passwordHash)
       ↓
3. Generate JWT
   jwt.sign({ userId, gamertag }, secret, { expiresIn: '24h' })
       ↓
4. Create Session in Redis
   SETEX session:{userId} 3600 {session_data}
       ↓
5. Return Token
   { token: "eyJ...", user: {...} }
       ↓
6. Client Stores Token
   localStorage.setItem('token', token)
       ↓
7. Subsequent Requests
   Authorization: Bearer {token}
       ↓
8. Context Validation
   jwt.verify(token, secret) → context.user
```

---

## Interview Topics

### JavaScript Fundamentals

| Topic | Key Points | Code Location |
|-------|------------|---------------|
| **Event Loop** | Phases, microtasks, process.nextTick | Comments in `server.ts` |
| **Async/Await** | Promise handling, parallel execution | All services |
| **Closures** | Factory functions, private state | `createResolvers()` |
| **Error Handling** | Try/catch, custom errors | All services |

### System Design

| Topic | Key Points | Code Location |
|-------|------------|---------------|
| **Scaling** | Horizontal vs vertical, stateless servers | `server.ts` |
| **Caching** | TTL, invalidation, Redis patterns | `presence.service.ts` |
| **Pub/Sub** | Event distribution, fan-out | All services |
| **Rate Limiting** | Token bucket, sliding window | (Coming soon) |
| **Circuit Breaker** | Failure handling, recovery | (Coming soon) |

### GraphQL

| Topic | Key Points | Code Location |
|-------|------------|---------------|
| **Schema Design** | Types, inputs, enums | `schema.ts` |
| **Resolvers** | Context, args, parent | `resolvers.ts` |
| **N+1 Problem** | DataLoader, batching | `resolvers.ts:friends` |
| **Subscriptions** | WebSocket, Pub/Sub | `resolvers.ts:Subscription` |
| **Authentication** | Context, directives | `resolvers.ts:requireAuth` |

---

## API Reference

### Queries

```graphql
# Get current user
me: User

# Get friend list with presence
friends(limit: Int, offset: Int, onlineOnly: Boolean): [FriendWithPresence!]!

# Get incoming friend requests
incomingFriendRequests(limit: Int, offset: Int): [FriendRequest!]!

# Get outgoing friend requests
outgoingFriendRequests(limit: Int, offset: Int): [FriendRequest!]!

# Get friend statistics
friendStats: FriendStats!

# Get mutual friends
mutualFriends(userId: ID!, limit: Int): [User!]!

# Get friend suggestions
friendSuggestions(limit: Int): [FriendSuggestion!]!

# Check relationship status
isFriend(userId: ID!): Boolean!
isBlocked(userId: ID!): Boolean!
```

### Mutations

```graphql
# Authentication
register(input: RegisterInput!): AuthResponse!
login(input: LoginInput!): AuthResponse!
logout: OperationResult!

# Presence
updatePresence(input: UpdatePresenceInput!): Presence!
heartbeat: Presence
goOffline: OperationResult!

# Friend Management
sendFriendRequest(userId: ID!, message: String): FriendRequest!
acceptFriendRequest(userId: ID!): FriendWithPresence!
declineFriendRequest(userId: ID!): OperationResult!
cancelFriendRequest(userId: ID!): OperationResult!
removeFriend(userId: ID!): OperationResult!
blockUser(userId: ID!): OperationResult!
unblockUser(userId: ID!): OperationResult!

# Chat
sendMessage(input: SendMessageInput!): Message!
createConversation(input: CreateConversationInput!): Conversation!
markConversationAsRead(conversationId: ID!): OperationResult!
```

### Subscriptions

```graphql
# Presence updates
friendPresenceUpdated: Presence!
userPresenceUpdated(userId: ID!): Presence!

# Friend events
friendEventReceived: FriendEvent!
friendRequestReceived: FriendRequest!

# Chat
messageReceived(conversationId: ID!): Message!
userTyping(conversationId: ID!): TypingIndicator!
```

---

## Development Guide

### Environment Variables

```bash
# .env (copy from .env.example)
PORT=4000
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key
CORS_ORIGIN=http://localhost:3000
NODE_ENV=development
```

### Scripts

```bash
# Development
npm run dev        # Start with hot reload (ts-node-dev)

# Build
npm run build      # Compile TypeScript
npm start          # Run compiled code

# Docker
docker-compose up -d           # Start all services
docker-compose down            # Stop all services
docker-compose logs -f redis   # View Redis logs
```

### Testing GraphQL

**Using GraphQL Sandbox (http://localhost:4000/graphql):**

1. **Register a user:**
```graphql
mutation {
  register(input: {
    gamertag: "Player1"
    email: "player1@test.com"
    password: "password123"
  }) {
    token
    user { id gamertag }
  }
}
```

2. **Set authorization header:**
```json
{
  "Authorization": "Bearer <token>"
}
```

3. **Update presence:**
```graphql
mutation {
  updatePresence(input: {
    status: ONLINE
    currentGame: "Spider-Man 2"
    statusMessage: "Grinding for platinum!"
  }) {
    userId
    status
    currentGame
  }
}
```

4. **Subscribe to friend updates:**
```graphql
subscription {
  friendEventReceived {
    type
    fromUser { gamertag }
    timestamp
  }
}
```

---

## Common Interview Questions

### 1. "How would you design a real-time presence system?"

**Answer Points:**
- Use Redis for fast reads/writes with TTL for automatic expiration
- Heartbeat pattern: clients ping every 60s, TTL of 5 minutes
- Pub/Sub for distributing updates to all server instances
- Filter at the server level to only notify relevant friends
- Handle edge cases: browser crash (TTL expires), network issues

**Code Reference:** `presence.service.ts`

### 2. "How do GraphQL subscriptions work?"

**Answer Points:**
- Built on WebSocket protocol (graphql-ws)
- Client subscribes → server returns AsyncIterator
- When event occurs → iterator yields value → pushed to client
- Use filtering to only send relevant events to each client
- Redis Pub/Sub enables horizontal scaling

**Code Reference:** `resolvers.ts:Subscription`

### 3. "How would you handle authentication in GraphQL?"

**Answer Points:**
- JWT token in Authorization header
- Validate in context function before resolvers run
- Attach user to context for resolver access
- `requireAuth()` helper throws if not authenticated
- Session data in Redis for revocation capability

**Code Reference:** `server.ts:context`, `resolvers.ts:requireAuth`

### 4. "What's the N+1 problem and how do you solve it?"

**Answer Points:**
- Fetching list of items, then N additional queries for related data
- Example: 10 friends → 10 presence queries
- Solution: Batch with Redis MGET or DataLoader
- Result: 1 query instead of N+1

**Code Reference:** `resolvers.ts:friends`, `presence.service.ts:getPresenceMultiple`

### 5. "How would you scale this to 100M users?"

**Answer Points:**
- **Stateless servers**: Scale horizontally, load balance
- **Redis Cluster**: Shard data across nodes
- **Pub/Sub for events**: Single publish reaches all subscribers
- **Connection pooling**: Reuse database connections
- **Caching**: Cache frequently accessed data (friend lists)
- **Rate limiting**: Protect against abuse

---

## Resources

### Official Documentation
- [GraphQL Subscriptions](https://www.apollographql.com/docs/apollo-server/data/subscriptions/)
- [Redis Pub/Sub](https://redis.io/docs/manual/pubsub/)
- [JWT Best Practices](https://auth0.com/blog/a-look-at-the-latest-draft-for-jwt-bcp/)
- [Apollo Client Cache](https://www.apollographql.com/docs/react/caching/overview/)

### System Design Resources
- [Designing Data-Intensive Applications](https://dataintensive.net/)
- [System Design Interview](https://www.amazon.com/System-Design-Interview-insiders-Second/dp/B08CMF2CQF)
- [Redis University](https://university.redis.com/)

### Interview Prep
- [Leetcode](https://leetcode.com/) - Algorithm practice
- [NeetCode](https://neetcode.io/) - Curated patterns
- [Pramp](https://www.pramp.com/) - Mock interviews

---

## Contributing

This is a study project. Feel free to:
- Add new features following the patterns
- Improve documentation
- Fix bugs
- Add tests

---

## License

MIT - Use this for learning and interview prep!

---

**Good luck with your interview!** 🎮
