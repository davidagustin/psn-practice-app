# Real-Time Systems: Presence, WebSocket & Pub/Sub

This guide covers how PlayStation Network handles real-time updates for user presence, messaging, and friend notifications. Understanding these patterns is critical for senior backend engineering interviews.

## Table of Contents

1. [Overview](#overview)
2. [Presence System Architecture](#presence-system-architecture)
3. [WebSocket Connection Management](#websocket-connection-management)
4. [Redis Pub/Sub Distribution](#redispubsub-distribution)
5. [GraphQL Subscriptions](#graphql-subscriptions)
6. [Scaling Real-Time Systems](#scaling-real-time-systems)
7. [Code Walkthrough](#code-walkthrough)
8. [Interview Questions](#interview-questions)

---

## Overview

Real-time systems deliver updates instantly to connected clients. PlayStation's approach uses three layers:

```
Client (Browser/App)
    ↓ (Establishes connection)
WebSocket Server (Connection Management)
    ↓ (Subscribes to events)
Pub/Sub Broker (Redis)
    ↓ (Distributes events)
Services (Presence, Chat, Friends)
```

### Key Characteristics

| Characteristic | Requirement | Solution |
|---|---|---|
| **Low Latency** | < 100ms updates | WebSocket push (not polling) |
| **Scalability** | 100M+ users | Redis Pub/Sub across server fleet |
| **Reliability** | No missed events | Event store + heartbeat pattern |
| **Bandwidth** | Minimize traffic | Subscribe only to relevant events |

---

## Presence System Architecture

Presence is the "Who's Online" feature. It tracks user status, game, and availability in real-time.

### System Design

```
User Opens App
    ↓
1. AUTHENTICATE: Get JWT token
    ↓
2. CONNECT WebSocket: ws://api/graphql?token=...
    ↓
3. SUBSCRIBE: friendPresenceUpdated
    ↓
4. HEARTBEAT LOOP: Every 60 seconds send heartbeat mutation
    ↓
5. STORE: Redis SET presence:{userId} = {status, game, lastSeen}
    with TTL of 5 minutes
    ↓
6. PUBLISH: PUBLISH presence:updates {event}
    ↓
7. ALL SERVERS: Receive via Pub/Sub
    ↓
8. FILTER: "Which of my clients are friends with this user?"
    ↓
9. PUSH: Send via WebSocket to relevant clients
```

### Presence Data Structure

```typescript
interface PresenceData {
  userId: string;              // e.g., "user_123"
  gamertag: string;            // e.g., "ProGamer92"
  status: UserStatus;          // "online" | "away" | "busy" | "offline"
  currentGame: string | null;  // e.g., "Spider-Man 2"
  statusMessage: string | null; // e.g., "Playing competitive"
  lastActiveAt: number;        // Unix timestamp (milliseconds)
  updatedAt: number;           // Unix timestamp (milliseconds)
}
```

### Redis Keys Used

```
Presence data:
  presence:{userId}           → JSON string of PresenceData

Indexes for fast lookup:
  presence:online             → Set of online user IDs
  presence:game:{gameName}    → Set of users playing this game

Pub/Sub channels:
  presence:updates            → Broadcast channel for all presence changes
```

### Heartbeat Pattern

The heartbeat keeps presence alive without requiring explicit logout:

```
Timeline:
├─ T=0s:  User goes online
│         redis.setex('presence:user_123', 300, {...})  // 5 min TTL
│
├─ T=60s: Client sends heartbeat
│         redis.setex('presence:user_123', 300, {...})  // Refresh TTL
│
├─ T=120s: Heartbeat
│          redis.setex('presence:user_123', 300, {...})
│
└─ T=300s: If no heartbeat received, key auto-expires
           Cleanup job detects and publishes offline event
```

**Why TTL instead of explicit disconnect?**

- Handles browser crashes gracefully
- Works when network drops unexpectedly
- Prevents "stuck online" status from force-quit apps
- Simple implementation

### Status Types

```typescript
enum UserStatus {
  ONLINE = "online",      // Active and available
  AWAY = "away",          // Idle for 5+ minutes
  BUSY = "busy",          // In game, DND
  OFFLINE = "offline",    // Not connected
  INVISIBLE = "invisible" // Appears offline but can see others
}
```

### Update Flow with Sequence Diagram

```
User A                  Server 1                Redis                Server 2
 │                         │                       │                     │
 ├─ updatePresence()──────>│                       │                     │
 │   (start Spider-Man)     │                       │                     │
 │                          ├─ setex()─────────────>│                     │
 │                          │ presence:user_a       │                     │
 │                          │ TTL=300               │                     │
 │                          │                       │                     │
 │                          ├─ publish()───────────>│                     │
 │                          │ presence:updates      │                     │
 │                          │ {type: game_started}  │ ──────────────────>│
 │                          │                       │ (receives via       │
 │                          │                       │  Pub/Sub)           │
 │                          │                       │                     │
 │<─ Subscription push──────┤                       │<─ Filter logic─────│
 │  (User A is friend)      │                       │ (Is User B a friend │
 │                          │                       │  of User A?)        │
 │                          │                       │                     │
 │   User B                 │                       │   User C            │
 │   (Friend of A)          │                       │   (Not friend)      │
 │   Receives: presenceUpdate                       │   Receives: nothing
 │   Shows "Playing..."                             │
```

### Presence Events

Events are published to keep all servers in sync:

```typescript
interface PresenceUpdateEvent {
  type: "went_online" | "went_offline" | "status_changed" | "game_started" | "game_ended";
  userId: string;
  presence: PresenceData;
  timestamp: number;
}
```

**Example flow:**

```javascript
// User A logs in
await presenceService.setOnline('user_a', 'ProGamer92', null);
// Publishes: { type: "went_online", userId: "user_a", ... }

// User A starts playing Spider-Man
await presenceService.updatePresence('user_a', { currentGame: 'Spider-Man 2' });
// Publishes: { type: "game_started", userId: "user_a", ... }

// All subscribed clients receive updates
// (if they are friends with user_a)
```

---

## WebSocket Connection Management

WebSocket maintains a long-lived connection for pushing real-time updates.

### Connection Lifecycle

```
1. CLIENT INITIATES
   └─ ws://localhost:4000/graphql
      (Includes auth token in connection params)

2. SERVER ACCEPTS
   ├─ Validates token
   ├─ Creates context with user info
   └─ Initializes subscription handlers

3. CONNECTION OPEN
   ├─ Receives Pub/Sub events
   ├─ Pushes to client via WebSocket
   └─ Monitors for disconnection

4. CLIENT UNSUBSCRIBES
   └─ Stops receiving events

5. CLIENT DISCONNECTS
   ├─ Closes TCP connection
   ├─ Server detects disconnection
   └─ Cleanup resources
```

### Context Creation for WebSocket

Unlike HTTP requests (new context per request), WebSocket connections have persistent context:

```typescript
// server.ts - WebSocket context creation
context: async (ctx) => {
  const token = ctx.connectionParams?.authorization || '';

  let user: JWTPayload | null = null;
  if (token) {
    try {
      user = await authService.validateToken(token.replace('Bearer ', ''));
      console.log(`WebSocket authenticated: ${user.gamertag}`);
    } catch (error) {
      console.log('WebSocket anonymous connection');
    }
  }

  const context: GraphQLContext = {
    user,                    // Persists for lifetime of connection
    session: null,
    clientIp: 'websocket',
    requestId: uuidv4(),
  };

  return context;
}
```

### Connection Hooks

```typescript
onConnect: async (_ctx) => {
  console.log('Client connected');
  // Return true to accept, false to reject
  return true;
}

onDisconnect: async (_ctx, code, reason) => {
  console.log(`Disconnected: ${code} ${reason}`);
  // Cleanup resources, set user offline, etc.
}

onSubscribe: async (_ctx, msg) => {
  console.log(`New subscription: ${msg.payload.operationName}`);
  // Log subscription, validate permissions, etc.
}

onError: async (_ctx, _msg, errors) => {
  console.error('WebSocket error:', errors);
  // Log errors for monitoring
}
```

### Reconnection Strategies

**Client-side best practices:**

```typescript
// Exponential backoff reconnection
const reconnect = async (attempt = 0) => {
  const delay = Math.min(1000 * Math.pow(2, attempt), 32000);

  setTimeout(() => {
    webSocket = new WebSocket('ws://...');

    webSocket.onopen = () => {
      console.log('Reconnected');
      resubscribe(); // Re-establish subscriptions
      resetHeartbeat();
    };

    webSocket.onerror = () => {
      reconnect(attempt + 1);
    };
  }, delay);
};
```

**Why exponential backoff?**

- Attempt 1: 1s (recovers fast from brief outage)
- Attempt 2: 2s
- Attempt 3: 4s
- Attempt 4: 8s
- ...caps at 32s (doesn't hammer server)

### Connection State Tracking

```typescript
enum WebSocketState {
  CONNECTING = 0,    // Initial state
  OPEN = 1,          // Connected and ready
  CLOSING = 2,       // Closing handshake in progress
  CLOSED = 3,        // Fully disconnected
}

// Track per client
const connectionStates = new Map<string, WebSocketState>();
const subscriptions = new Map<string, Set<string>>();  // userId -> [subscriptionIds]
```

---

## Redis Pub/Sub Distribution

Redis Pub/Sub enables multi-server real-time delivery at scale.

### Why Pub/Sub Over Direct Messaging?

**Option 1: Direct Messages (No)**
```
Server 1 → Must know Server 2's IP
         → Must know Server 3's IP
         → Must know Server 4's IP
Problem: Tight coupling, hard to scale
```

**Option 2: Pub/Sub (Yes)**
```
Server 1 → PUBLISH presence:updates {event}
Server 2, 3, 4 → SUBSCRIBE presence:updates
Problem solved: Servers discover each other via Redis
```

### Channel Strategies

**Global Channels** (broadcast to all servers):
```
presence:updates          → Any user's presence changed
                           (All servers receive, filter locally)

FRIEND_PRESENCE_UPDATED   → A friend came online/offline
FRIEND_EVENT              → Friend request, accept, remove
MESSAGE_RECEIVED          → New message in conversation
```

**User-Specific Channels** (only relevant servers):
```
USER_PRESENCE_UPDATED.{userId}     → Specific user's presence
FRIEND_EVENT.{userId}              → Events for this user
FRIEND_REQUEST_RECEIVED.{userId}   → Incoming requests for this user
```

**Room-Specific Channels** (for group features):
```
MESSAGE_RECEIVED.{conversationId}   → Messages in this chat
VOICE_ROOM_UPDATED.{roomId}         → Voice room changes
```

### Publishing Pattern

```typescript
// In PresenceService
private async publishPresenceUpdate(event: PresenceUpdateEvent): Promise<void> {
  await this.redis.publish(
    this.config.presenceChannel,  // "presence:updates"
    JSON.stringify(event)
  );
}

// Usage
await presenceService.updatePresence(userId, {
  status: 'busy',
  currentGame: 'Elden Ring'
});
// Automatically publishes to all servers
```

### Subscription Pattern

```typescript
// In PresenceService
private async initializeSubscription(): Promise<void> {
  // Use dedicated subscriber connection (can't run other commands)
  await this.subscriber.subscribe(this.config.presenceChannel);

  this.subscriber.on('message', (channel, message) => {
    if (channel === this.config.presenceChannel) {
      const event = JSON.parse(message) as PresenceUpdateEvent;
      this.handlePresenceUpdate(event);
    }
  });
}

// Handle events
private handlePresenceUpdate(event: PresenceUpdateEvent): void {
  // Emit for local WebSocket clients
  this.emit('presenceUpdate', event);
}
```

### Pub/Sub Architecture Diagram

```
┌─────────────────────────────────────┐
│         REDIS PUBSUB                │
│  presence:updates channel           │
│  (Durable message broker)           │
└─────────────────────────────────────┘
          ▲        ▲        ▲
          │        │        │
       PUBLISH  PUBLISH  PUBLISH
          │        │        │
    ┌─────────┬──────────┬──────────┐
    │         │          │          │
    ▼         ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│Server 1│ │Server 2│ │Server 3│ │Server 4│
│(Node.js)│ │(Node.js)│ │(Node.js)│ │(Node.js)│
│        │ │        │ │        │ │        │
│SUBSCRIBE│ │SUBSCRIBE│ │SUBSCRIBE│ │SUBSCRIBE│
│        │ │        │ │        │ │        │
└────────┘ └────────┘ └────────┘ └────────┘
    │          │          │          │
    ▼          ▼          ▼          ▼
  10K users  10K users  10K users  10K users
  (WebSocket clients on each server)
```

### Redis Pub/Sub Limitations & Solutions

**Limitation: No persistence**
```
┌─ Server publishes message
├─ No subscribers connected → message lost
└─ Solution: Use Redis Streams or Kafka for durable events
```

**Limitation: At-most-once delivery**
```
Problem: Network hiccup → client misses update
Solution 1: Heartbeat (for presence)
Solution 2: Event replay (load from database)
Solution 3: Delta sync (fetch state from server)
```

**Limitation: Tight coupling between servers**
```
Problem: Broadcast channel → all servers process
Solution: Namespace channels by data type/user
```

---

## GraphQL Subscriptions

GraphQL Subscriptions are the interface layer above Pub/Sub.

### Subscription Flow

```
Client Code:
  subscription OnFriendOnline {
    friendPresenceUpdated {
      userId
      status
      currentGame
    }
  }
    │
    ▼
  Establish WebSocket
    │
    ▼
  Send subscription message
    │
    ▼
GraphQL Resolver (Subscription):
  friendPresenceUpdated: {
    subscribe: () => pubsub.asyncIterator([EVENTS.FRIEND_PRESENCE_UPDATED])
  }
    │
    ▼
  pubsub.asyncIterator() returns AsyncIterator
    │
    ▼
  Wait for events...
    │
    ▼
Mutation triggers:
  updatePresence() → pubsub.publish(EVENTS.FRIEND_PRESENCE_UPDATED, { ... })
    │
    ▼
  AsyncIterator yields value
    │
    ▼
  Server sends via WebSocket
    │
    ▼
  Client receives update
```

### AsyncIterator Pattern

The AsyncIterator is the core of subscriptions:

```typescript
// Subscription resolver returns an AsyncIterator
friendPresenceUpdated: {
  subscribe: () => {
    // Returns an async generator
    return pubsub.asyncIterator([EVENTS.FRIEND_PRESENCE_UPDATED]);
  }
}

// When server publishes
pubsub.publish(EVENTS.FRIEND_PRESENCE_UPDATED, {
  friendPresenceUpdated: { userId: 'user_a', status: 'online' }
});

// The asyncIterator yields the value
// Apollo sends it to subscribed clients
```

**Under the hood:**

```typescript
class PubSub {
  private subscriptions = new Map<string, Set<AsyncIterator>>();

  async *asyncIterator(channels: string[]): AsyncIterator {
    const queue: any[] = [];

    const listener = (message: any) => {
      queue.push(message);
    };

    // Register listener for each channel
    for (const channel of channels) {
      this.on(channel, listener);
    }

    // Yield queued messages as they arrive
    while (true) {
      if (queue.length > 0) {
        yield queue.shift();
      } else {
        // Wait for next message
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }
}
```

### Filtering with withFilter

By default, ALL clients receive ALL events. Use `withFilter()` to be selective:

```typescript
import { withFilter } from 'graphql-subscriptions';

// Without filter: sends to everyone
friendPresenceUpdated: {
  subscribe: () => pubsub.asyncIterator([EVENTS.FRIEND_PRESENCE_UPDATED])
}

// With filter: sends only to friends
friendPresenceUpdated: {
  subscribe: withFilter(
    () => pubsub.asyncIterator([EVENTS.FRIEND_PRESENCE_UPDATED]),
    (payload, _variables, context) => {
      // Only send if subscriber is friends with the user
      const friendIds = presenceService.getFriends(context.user.userId);
      return friendIds.includes(payload.friendPresenceUpdated.userId);
    }
  )
}

// Signature:
// withFilter(
//   sourceAsyncIterator,
//   filterFn(payload, variables, context) -> boolean
// )
```

**Filtering by argument:**

```typescript
// User subscribes to specific user's presence
userPresenceUpdated: {
  subscribe: (_, args: { userId: string }) => {
    return pubsub.asyncIterator([
      `${EVENTS.USER_PRESENCE_UPDATED}.${args.userId}`
    ]);
  }
}

// Publish to specific user's channel
pubsub.publish(`USER_PRESENCE_UPDATED.user_a`, {
  userPresenceUpdated: { userId: 'user_a', status: 'online' }
});
```

### Event Naming Convention

```typescript
const EVENTS = {
  // Global events (broadcast to all)
  FRIEND_PRESENCE_UPDATED: 'FRIEND_PRESENCE_UPDATED',

  // User-specific events (filtered by channel)
  USER_PRESENCE_UPDATED: 'USER_PRESENCE_UPDATED',           // Suffixed with .{userId}
  FRIEND_REQUEST_RECEIVED: 'FRIEND_REQUEST_RECEIVED',       // Suffixed with .{userId}
  FRIEND_EVENT: 'FRIEND_EVENT',                             // Suffixed with .{userId}

  // Conversation-specific events
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',                     // Suffixed with .{conversationId}
  USER_TYPING: 'USER_TYPING',                               // Suffixed with .{conversationId}

  // Room-specific events
  VOICE_ROOM_UPDATED: 'VOICE_ROOM_UPDATED',                 // Suffixed with .{roomId}
};

// Publishing
pubsub.publish(`FRIEND_EVENT.${toUserId}`, { ... });  // User-specific
pubsub.publish(`MESSAGE_RECEIVED.${conversationId}`, { ... });  // Room-specific
```

### Error Handling in Subscriptions

```typescript
friendEventReceived: {
  subscribe: (_: unknown, __: unknown, context: GraphQLContext) => {
    // Require authentication
    const userId = context.user?.userId;
    if (!userId) {
      throw new Error('Authentication required for friend events');
    }

    return pubsub.asyncIterator([`FRIEND_EVENT.${userId}`]);
  }
}
```

---

## Scaling Real-Time Systems

### Single Server Limits

```
Single Node.js Server:
├─ Max connections:      10,000 (by design, very fast)
├─ RAM per connection:   ~50KB
├─ Total RAM for users:  500MB
├─ Problem at scale:     Can only serve 10K users
└─ Needed for 100M:      10,000 servers!
```

**Solution: Horizontal scaling with shared infrastructure**

### Architecture at Scale

```
100M Players
      │
      ├─ Load Balancer
      │  (sticky sessions by user ID)
      │
      ├─────────────┬──────────────┬──────────────┐
      │             │              │              │
      ▼             ▼              ▼              ▼
   Server 1     Server 2       Server 3      Server N
   (10K users)  (10K users)    (10K users)   (10K users)
      │             │              │              │
      └─────────────┴──────────────┴──────────────┘
                    │
                    ▼
            Redis Pub/Sub Cluster
            (Shared message bus)
                    │
                    ▼
            Database (DynamoDB)
            (Authoritative state)
```

### Sticky Sessions vs Broadcast

**Option 1: Sticky Sessions (Simple but Limited)**
```
Load Balancer Routes:
  User A → Server 1 (always)
  User B → Server 2 (always)
  User C → Server 1 (always)

Problem: When Server 1 goes down, User A/C lose connection
         No horizontal scaling benefit
```

**Option 2: Broadcast with Pub/Sub (Scalable)**
```
Load Balancer Routes:
  User A → Server 1
  User B → Server 2 (can change on reconnect)

All Servers Subscribe to:
  Pub/Sub channels (presence:updates, friend_events, etc.)

When Server 1 receives presence update:
  ├─ Server 1 publishes to Redis
  ├─ All servers receive (including Server 2)
  ├─ Each server filters to its clients
  └─ Server 2 pushes to User B if they're friends
```

**Why broadcast?**

```
Update occurs → Server 1 → Redis → All Servers → Filter & Push
                                        ↓
                            (Server 2 gets it even though
                             update didn't originate there)
```

### Connection Limits Per Server

```
Real hardware (AWS t3.2xlarge):
├─ 8 vCPU
├─ 32 GB RAM
├─ Network: ~3 Gbps

Connection limits:
├─ Node.js: ~65K per process (ulimit)
├─ Per server: ~10-20K (practical, keeping RAM/CPU in check)
├─ Recommended: 10K (safe margin)
└─ Result: 10K servers for 100M users

Cost at scale:
├─ 10K servers × $0.30/hr = $3,000/hour
├─ = ~$2.2M/month (before networking/storage)
└─ Real PSN probably uses custom hardware
```

### Load Balancing Strategy

**Sticky sessions for WebSocket:**

```nginx
upstream backend {
  # Sticky: Route based on client IP/cookie
  # Ensures same client always hits same server
  hash $remote_addr consistent;

  server backend1:4000;
  server backend2:4000;
  server backend3:4000;
}

server {
  location /graphql {
    proxy_pass http://backend;

    # WebSocket upgrade headers
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

**Why sticky sessions?**

- Reduces reconnects (client always hits same server)
- Simplifies local state management
- Improves cache hit rates

**Fallback to broadcast:**
- If sticky sessions fail (server down), client reconnects
- New server picks up via Pub/Sub broadcast
- No data loss (Redis is source of truth)

### Pub/Sub at Scale

**Redis Cluster for Pub/Sub:**

```
Single Redis:
└─ Bottleneck at high throughput
   (e.g., 1M presence updates/second)

Redis Cluster:
├─ Shards by key (presence:user_* distributed)
├─ Each shard handles subset of load
└─ ~3-5K messages/second per shard

Problem: Pub/Sub doesn't shard
         All servers subscribe to same channels
         One node handles all broadcasts

Solution: Use Redis Streams
         ├─ Durable (persisted)
         ├─ Shardable (one stream per partition)
         └─ Consumer groups (parallel processing)
```

**Redis Streams for durable presence:**

```lua
-- Publish presence update to stream
redis.call('XADD', 'presence:updates', '*',
  'userId', 'user_a',
  'status', 'online',
  'timestamp', time()
)

-- Consumer groups
redis.call('XGROUP', 'CREATE', 'presence:updates', 'servers', '$')

-- Servers consume in parallel
local msg = redis.call('XREADGROUP', 'GROUP', 'servers', 'server_1',
  'COUNT', 10,
  'STREAMS', 'presence:updates', '>'
)

-- Server processes and acknowledges
redis.call('XACK', 'presence:updates', 'servers', msg_id)
```

### Handling Server Failures

**When Server 1 goes down:**

```
User A (connected to Server 1)
    ↓
Connection drops
    ↓
Client detects via WebSocket onclose
    ↓
Client reconnects (exponential backoff)
    ↓
Load Balancer routes to Server 2 (might fail sticky)
    ↓
Server 2 receives subscription
    ↓
Server 2 subscribes to Pub/Sub (from scratch)
    ↓
User A resumes receiving updates

Delta sync:
├─ Server 2 queries database for current state
└─ Sends to User A so they're not missing updates
   (presence list, unread messages, etc.)
```

---

## Code Walkthrough

### PresenceService Implementation

**Key methods from `src/services/presence/presence.service.ts`:**

#### 1. Going Online

```typescript
async setOnline(
  userId: string,
  gamertag: string,
  currentGame: string | null = null
): Promise<PresenceData> {
  // Create presence data
  const presenceData: PresenceData = {
    userId,
    gamertag,
    status: 'online',
    currentGame,
    statusMessage: null,
    lastActiveAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Atomic Redis operations using pipeline
  const pipeline = this.redis.pipeline();

  // 1. Store presence with TTL
  pipeline.setex(
    `presence:${userId}`,
    this.config.presenceTTL,  // 5 minutes
    JSON.stringify(presenceData)
  );

  // 2. Add to online users set
  pipeline.sadd('presence:online', userId);

  // 3. If playing a game, add to game set
  if (currentGame) {
    pipeline.sadd(`presence:game:${currentGame}`, userId);
  }

  await pipeline.exec();

  // 4. Publish to all servers
  await this.publishPresenceUpdate({
    type: 'went_online',
    userId,
    presence: presenceData,
    timestamp: Date.now(),
  });

  return presenceData;
}
```

**Why pipeline?**
- Atomic: All commands execute together
- Efficient: One round trip to Redis
- Consistent: No race conditions

#### 2. Heartbeat

```typescript
async heartbeat(userId: string): Promise<PresenceData | null> {
  const presenceKey = `presence:${userId}`;

  // Get current presence
  const presenceData = await this.redis.get(presenceKey);
  if (!presenceData) {
    return null;  // User not online
  }

  // Parse and update
  const presence = JSON.parse(presenceData) as PresenceData;
  presence.lastActiveAt = Date.now();

  // Refresh TTL (critical!)
  await this.redis.setex(
    presenceKey,
    this.config.presenceTTL,  // Reset 5 minute timer
    JSON.stringify(presence)
  );

  return presence;
}
```

**Why refresh TTL?**
- Without refresh: User goes offline after 5min of inactivity
- With refresh: Stays online as long as sending heartbeats
- Handles slow/idle connections gracefully

#### 3. Batch Fetch Presence

```typescript
async getPresenceMultiple(userIds: string[]): Promise<Map<string, PresenceData>> {
  if (userIds.length === 0) {
    return new Map();
  }

  // Build keys
  const keys = userIds.map(id => `presence:${id}`);

  // MGET: Fetch all in one call (not N calls!)
  const values = await this.redis.mget(...keys);

  // Parse results
  const result = new Map<string, PresenceData>();
  for (let i = 0; i < userIds.length; i++) {
    if (values[i]) {
      result.set(userIds[i], JSON.parse(values[i]));
    }
  }

  return result;
}
```

**Performance:**

```
N=1000 friends

Naive approach:
  1000 × redis.get() = 1000 round trips = 1000ms

MGET approach:
  1 × redis.mget(1000 keys) = 1 round trip = 2ms

Speedup: 500x faster!
```

#### 4. Publish Update

```typescript
private async publishPresenceUpdate(event: PresenceUpdateEvent): Promise<void> {
  // All servers subscribed to this channel receive the event
  await this.redis.publish(
    this.config.presenceChannel,  // "presence:updates"
    JSON.stringify(event)
  );
}
```

#### 5. Receive and Handle

```typescript
private async initializeSubscription(): Promise<void> {
  // Use separate connection (subscribe-mode can't do other ops)
  await this.subscriber.subscribe(this.config.presenceChannel);

  this.subscriber.on('message', (channel, message) => {
    if (channel === this.config.presenceChannel) {
      try {
        const event = JSON.parse(message) as PresenceUpdateEvent;
        this.handlePresenceUpdate(event);
      } catch (error) {
        console.error('Failed to parse presence update:', error);
      }
    }
  });
}

private handlePresenceUpdate(event: PresenceUpdateEvent): void {
  // Emit to GraphQL subscribers
  this.emit('presenceUpdate', event);
  console.log(`Received: ${event.type} for ${event.userId}`);
}
```

### GraphQL Resolver Integration

From `src/graphql/resolvers.ts`:

#### Update Presence Mutation

```typescript
updatePresence: async (
  _: unknown,
  args: {
    input: {
      status?: string;
      currentGame?: string;
      statusMessage?: string;
    };
  },
  context: GraphQLContext
) => {
  const userId = getUserId(context);

  // 1. Update in service
  const presence = await presenceService.updatePresence(userId, {
    status: args.input.status as any,
    currentGame: args.input.currentGame || null,
    statusMessage: args.input.statusMessage || null,
  });

  if (!presence) {
    throw new Error('Failed to update presence');
  }

  // 2. Publish to subscriptions
  // Global event (all subscribers receive, filtered server-side)
  pubsub.publish(EVENTS.FRIEND_PRESENCE_UPDATED, {
    friendPresenceUpdated: presence,
  });

  // User-specific event (only relevant subscribers)
  pubsub.publish(`${EVENTS.USER_PRESENCE_UPDATED}.${userId}`, {
    userPresenceUpdated: presence,
  });

  return presence;
};
```

#### Subscription Resolver

```typescript
friendPresenceUpdated: {
  // Subscribe returns AsyncIterator
  subscribe: () => pubsub.asyncIterator([EVENTS.FRIEND_PRESENCE_UPDATED]),
},

userPresenceUpdated: {
  subscribe: (_: unknown, args: { userId: string }) => {
    return pubsub.asyncIterator([
      `${EVENTS.USER_PRESENCE_UPDATED}.${args.userId}`,
    ]);
  },
},
```

### Server Setup

From `src/server.ts` - WebSocket configuration:

```typescript
const wsServer = new WebSocketServer({
  server: httpServer,
  path: '/graphql',
});

const serverCleanup = useServer(
  {
    schema,

    // Context for WebSocket connections
    context: async (ctx) => {
      const token = ctx.connectionParams?.authorization || '';

      let user: JWTPayload | null = null;
      if (token) {
        try {
          user = await authService.validateToken(token.replace('Bearer ', ''));
        } catch (error) {
          console.log('Invalid token, anonymous connection');
        }
      }

      return {
        user,
        session: null,
        clientIp: 'websocket',
        requestId: uuidv4(),
      };
    },

    // Connection lifecycle
    onConnect: async (_ctx) => {
      console.log('Client connected');
      return true;
    },

    onDisconnect: async (_ctx, code, reason) => {
      console.log(`Client disconnected: ${code} ${reason}`);
    },

    onSubscribe: async (_ctx, msg) => {
      console.log(`New subscription: ${msg.payload.operationName}`);
    },

    onError: async (_ctx, _msg, errors) => {
      console.error('WebSocket error:', errors);
    },
  },
  wsServer
);
```

---

## Interview Questions

### Q1: How would you handle a presence update for a user with 10,000 friends?

**Pattern: N+1 problem at scale**

**Bad approach:**
```typescript
const friends = await getFriends(userId);  // 10,000 IDs
for (const friendId of friends) {
  // Send individual notification to each friend
  // 10,000 separate WebSocket pushes!
}
```

**Good approach:**
```typescript
// 1. Publish to Redis once
await presenceService.updatePresence(userId, {
  status: 'online'
});

// 2. All servers receive via Pub/Sub
pubsub.publish('presence:updates', event);

// 3. Each server filters locally
// "Which of my connected clients are friends with user_a?"
// Only push to friends on my server
const myConnectedClients = [...webSocketConnections];
for (const client of myConnectedClients) {
  const friendIds = await presenceService.getFriends(client.userId);
  if (friendIds.includes(userId)) {
    client.send(event);  // Only one push per server
  }
}
```

**Why this works:**
- O(1) publish to Redis
- O(n) filtering per server (but n = 10K/100 = 100 friends on average per server)
- Total pushes: ~100 per server × 100 servers = 10K
- Naive approach: 10K separate operations per server

### Q2: What happens when a user force-quits the app without disconnecting?

**The problem:**
```
User A has app open
    ↓
User force-quits (no graceful shutdown)
    ↓
WebSocket connection stays open (TCP timeout = 2 hours)
    ↓
Other users see User A as online
    ↓
Users try messaging User A (messages pile up)
    ↓
User A reopens app 10 minutes later
    ↓
Realizes they've missed messages
```

**The solution: TTL-based expiration**

```
User A opens app → Server stores presence with TTL=5 minutes

Time T=0:    redis.setex('presence:user_a', 300, {...})
Time T=60:   Client sends heartbeat → TTL refreshed
Time T=120:  Client sends heartbeat → TTL refreshed
Time T=180:  (Force quit - no more heartbeats)
Time T=300:  Key auto-expires!

Result: Automatic offline after 5 minutes of no heartbeats
```

**Alternative without TTL:**
```
Explicit disconnect:
  await presenceService.setOffline(userId)
  webSocket.close()

Problem: If both fail, user stuck online forever
```

**Best practice: Combine both**
```
1. Client sends explicit disconnect on app close (best effort)
2. Server sets TTL as fallback (guaranteed cleanup)
3. Heartbeat refreshes TTL if user stays active
```

### Q3: Design presence for a private gaming session (only 4 players know about it)

**Challenge:** Broadcasting to all servers wastes bandwidth

**Solution: Sharded subscriptions**

```typescript
// Instead of global channel
pubsub.publish('presence:updates', event);  // ALL servers

// Use room/session-specific channel
pubsub.publish(`gaming-session:${sessionId}`, {
  type: 'player_went_online',
  userId: 'user_a'
});

// Only servers with connected session members subscribe
sessionMembers.forEach(memberId => {
  webSocket.subscribe(`gaming-session:${sessionId}`);
});
```

**At scale:**
```
10,000 gaming sessions × ~100 updates/second each = 1M updates/second

With global broadcast:
  └─ All 10K servers process all updates
     (Even if session not on their server)

With sharded channels:
  └─ Only servers with session members process
     ~10K servers × 100 members/session = 1M updates total
     (Distributed efficiently)
```

### Q4: How do you prevent the "cascade of disconnections" when a server goes down?

**The problem:**
```
Server 1 goes down
    ↓
10,000 users reconnect at once
    ↓
Load balancer routes to Server 2
    ↓
Server 2 gets 10K simultaneous connections
    ↓
Server 2 can only handle 10K → Server 2 crashes!
    ↓
Cascade: All servers go down
```

**Solution: Circuit breaker + exponential backoff**

```typescript
// Client-side exponential backoff
const reconnect = async (attempt = 0) => {
  const delay = Math.min(1000 * Math.pow(2, attempt), 32000);

  setTimeout(() => {
    try {
      webSocket = new WebSocket('ws://...');
    } catch (error) {
      // Exponential backoff
      // Attempt 1: 1s
      // Attempt 2: 2s
      // Attempt 3: 4s
      // ...max 32s
      // Total time to reconnect 10K users: ~4 minutes
      reconnect(attempt + 1);
    }
  }, delay);
};

// Server-side circuit breaker
if (connectionCount > MAX_CONNECTIONS) {
  // Reject new connections
  return false;
}
```

**Why it works:**
- Clients don't all reconnect at same time
- Servers don't get overwhelmed
- System gracefully degrades and recovers

### Q5: How do you ensure a friend doesn't receive presence updates after unfriending?

**Tricky part:** Filtering at subscription time vs publish time

**Bad approach (race condition):**
```typescript
// Mutation: removeFriend
await friendService.removeFriend(userId, friendId);
pubsub.publish('presence:updated', event);

// Client still subscribed during mutation
// Receives event after unfriending!
```

**Good approach: Filter at publish time**

```typescript
// Mutation: removeFriend (atomic)
const pipeline = redis.pipeline();
pipeline.srem(`friends:${userId}`, friendId);
pipeline.srem(`friends:${friendId}`, userId);
await pipeline.exec();

// Publish event
const event = { type: 'friend_removed', userId, friendId };
pubsub.publish('presence:updated', event);

// Subscription resolver filters
friendPresenceUpdated: {
  subscribe: withFilter(
    () => pubsub.asyncIterator([EVENTS.FRIEND_PRESENCE_UPDATED]),
    async (payload, _variables, context) => {
      // Check friendship AT SUBSCRIPTION TIME
      const friendIds = await friendService.getFriends(context.user.userId);
      const isStillFriend = friendIds.includes(
        payload.friendPresenceUpdated.userId
      );

      return isStillFriend;
    }
  )
}
```

**Why it works:**
- Filter executes BEFORE event is sent
- Even if race condition, filter catches it
- User never receives filtered-out events

### Q6: How would you implement a "typing indicator" efficiently?

**Challenge:** Bob is typing → Show indicator to Alice

**Naive approach (polling):**
```
Alice query every 100ms: "Is Bob typing?"
  └─ 10K users × 1000 messages/sec = 10M queries/sec
  └─ Not scalable
```

**Good approach (events):**

```typescript
// Bob types → Send event immediately
setTyping(conversationId, userId):
  pubsub.publish(`typing:${conversationId}`, {
    userId,
    isTyping: true
  })

// Alice subscribed
userTyping: {
  subscribe: (_, args: { conversationId: string }) => {
    return pubsub.asyncIterator([`typing:${args.conversationId}`]);
  }
}

// Bob stops typing (after 3 seconds of no new events)
setTyping(conversationId, userId):
  // Clear after timeout
  setTimeout(() => {
    pubsub.publish(`typing:${conversationId}`, {
      userId,
      isTyping: false
    })
  }, 3000)
```

**Optimization: Delta updates**

```typescript
// Only send if state changed
if (wasTyping && !isTyping) {
  pubsub.publish(`typing:${conversationId}`, {
    userId,
    isTyping: false
  });
}
```

**At scale:**
```
10M typing events/second
  (But delta-filtered to ~1M)
```

### Q7: What's the difference between graphql-subscriptions and graphql-redis-subscriptions?

| Aspect | graphql-subscriptions | graphql-redis-subscriptions |
|---|---|---|
| **Storage** | In-memory | Redis |
| **Scope** | Single server | Multiple servers |
| **Persistence** | None (lose on restart) | Persistent across restarts |
| **Latency** | < 1ms | ~5ms (Redis network latency) |
| **Scalability** | 1 server only | Unlimited servers |
| **Reliability** | No guarantees | Moderate (Redis Pub/Sub has limitations) |

**When to use graphql-subscriptions:**
- Development
- Single server deployment
- Low traffic

**When to use graphql-redis-subscriptions:**
- Production
- Multiple servers
- Enterprise scale

### Q8: How do you debug a client not receiving subscription updates?

**Debugging checklist:**

```
1. Check WebSocket connection
   └─ Open browser DevTools → Network → WS
   └─ Should show ws://localhost:4000/graphql
   └─ Status should be "101 Switching Protocols"

2. Check authentication
   └─ Verify token is sent in connection params
   └─ Check server logs: "[WebSocket] Authenticated connection"

3. Check subscription query
   └─ Manually test subscription in GraphQL Playground
   └─ graphql> subscription { friendPresenceUpdated { userId status } }

4. Check filtering
   └─ Are you friends with the user whose status changed?
   └─ Check withFilter() logic

5. Check server logs
   └─ Server logs when publishing
   └─ "[PubSub] Publish presence:updates"
   └─ Server logs when client disconnects
   └─ "[WebSocket] Client disconnected"

6. Check Redis
   └─ redis-cli SUBSCRIBE presence:updates
   └─ Manually publish and see if server receives
   └─ PUBLISH presence:updates '{"type":"test"}'

7. Check connection timeout
   └─ WebSocket connections default timeout = 30s
   └─ Configure longer timeout if needed
```

### Q9: Can you explain the heartbeat pattern in your own words?

**What I'm looking for:**

```
Good answer:
"The heartbeat keeps presence alive. The client sends a mutation
every 60 seconds, which refreshes the TTL in Redis. If the client
crashes or loses connection, after 5 minutes with no heartbeat,
Redis auto-deletes the presence key. The server then detects
the expired key and publishes an offline event. This handles
edge cases where the client can't gracefully disconnect."

Great answer:
"We use Redis TTL as our source of truth for auto-expiration.
The heartbeat is lightweight - just a mutation that calls setex
to refresh the TTL. This is much simpler than the alternative of
tracking connections in application logic, which would leak memory
if connections aren't explicitly closed. The TTL approach is fault-tolerant
and doesn't require synchronization between the client and server."

Excellent answer:
"The pattern is: storage (Redis SET) + expiration (TTL) + refresh (heartbeat).
By separating these concerns, we get good properties:

- Automatic cleanup (TTL doesn't depend on client behavior)
- Fault tolerance (crash = automatic offline after TTL)
- Scalability (TTL operations are O(1))
- Simplicity (no need for explicit disconnect messages)

At scale, this means we don't need a disconnect handler or cleanup
job - Redis handles it. The server detects expiration passively
when it queries presence, or actively via background scan if needed."
```

---

## Summary

### Key Takeaways

1. **Presence = Storage + Events**
   - Redis stores current state (WHO is online)
   - Pub/Sub distributes changes (WHEN they change)
   - WebSocket delivers to clients (HOW they know)

2. **Heartbeat Pattern**
   - TTL-based auto-expiration
   - Client refreshes every 60s
   - Redis cleans up after 5 minutes
   - Handles crashes gracefully

3. **Scale Strategy**
   - Single Redis Pub/Sub broadcasts
   - Multiple servers filter locally
   - Sticky sessions reduce reconnects
   - Pub/Sub is throughput bottleneck at extreme scale (→ use Streams)

4. **GraphQL Subscriptions**
   - AsyncIterator from PubSub
   - withFilter for fine-grained control
   - Context persists for lifetime of WebSocket
   - Always validate auth

5. **Common Pitfalls**
   - N+1 queries (use MGET for batch fetch)
   - Broadcasting to all servers (use targeted channels)
   - No filtering (only send relevant events)
   - No heartbeat (users stuck online after crash)

### Architecture Checklist

- [ ] Presence stored in Redis with TTL
- [ ] Heartbeat mutation refreshes TTL
- [ ] Updates published to Pub/Sub channel
- [ ] All servers subscribed to channels
- [ ] Servers filter to local clients
- [ ] WebSocket connection manages authentication
- [ ] Subscription resolvers use asyncIterator
- [ ] Filtering with withFilter() for sensitive events
- [ ] Load balancer uses sticky sessions
- [ ] Monitoring/alerting for missing updates

---

## References

- [Redis Pub/Sub Documentation](https://redis.io/topics/pubsub)
- [GraphQL Subscriptions](https://github.com/apollographql/graphql-subscriptions)
- [graphql-ws Protocol](https://github.com/enisdenjo/graphql-ws)
- [WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [Real-time Web with Node.js](https://www.ably.io/topic/real-time)

