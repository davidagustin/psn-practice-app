# Redis Patterns - PlayStation Network Backend Interview Guide

**Target Audience:** Backend engineers preparing for senior-level interviews
**Document Version:** 1.0
**Last Updated:** February 2026

## Table of Contents

1. [Overview](#overview)
2. [Data Structures Used](#data-structures-used)
3. [Key Naming Conventions](#key-naming-conventions)
4. [Caching Patterns](#caching-patterns)
5. [Redis Pub/Sub for Real-time](#redis-pubsub-for-real-time)
6. [Advanced Patterns](#advanced-patterns)
7. [Code Examples](#code-examples)
8. [Interview Questions & Answers](#interview-questions--answers)
9. [Common Pitfalls & Solutions](#common-pitfalls--solutions)

---

## Overview

Redis is the backbone of PlayStation Network's real-time features. At scale, the platform handles:

- **100M+ concurrent users** with sub-100ms presence updates
- **Billions of friendship relationships** with O(1) membership checks
- **Real-time messaging** with multiple tiers of storage
- **Distributed state management** across dozens of servers

This guide covers production patterns tested at scale.

---

## Data Structures Used

Redis provides five primary data structures. PSN uses all of them, each optimized for specific patterns.

### 1. Strings (with TTL) - Presence Status

**Use Case:** Real-time user presence that auto-expires

```
Key: presence:{userId}
Value: JSON object with presence data
TTL: 300 seconds (5 minutes)
```

**Why This Pattern:**
- TTL automatically cleans up stale presence data (no manual cleanup needed)
- String values are fast to read/write in high-throughput scenarios
- Auto-expiration handles cases where clients crash without explicit disconnect

**Example from Code:**
```typescript
// PresenceService - storing user presence
const presenceData: PresenceData = {
  userId,
  gamertag,
  status: 'online',
  currentGame,
  statusMessage: null,
  lastActiveAt: now,
  updatedAt: now,
};

// Store with 5-minute TTL
pipeline.setex(
  `presence:${userId}`,
  300,  // 5 minutes
  JSON.stringify(presenceData)
);
```

**Interview Answer:**
> "We store presence as a string with TTL because user status changes frequently and auto-expires. If a client crashes, we don't wait for an explicit disconnect message—Redis automatically removes the presence after 5 minutes. This is more reliable than trying to track disconnect events."

---

### 2. Sets - Friendship Lists & Blocked Users

**Use Case:** O(1) membership checks and set operations

```
Key: user:{userId}:friends
Members: {friendId1, friendId2, friendId3...}
```

**Operations & Complexity:**
| Operation | Complexity | Use Case |
|-----------|-----------|----------|
| SADD | O(1) | Add friend |
| SREM | O(1) | Remove friend |
| SISMEMBER | O(1) | Check if friends |
| SMEMBERS | O(n) | Get all friends |
| SINTER | O(n+m) | Find mutual friends |
| SCARD | O(1) | Count friends |

**Why Sets for Friends:**
- **O(1) membership test:** Check "is X a friend of Y?" instantly without loading all friends
- **Bidirectional storage:** Store A→B and B→A separately allows O(1) lookup from either direction
- **Set operations:** SINTER finds mutual friends server-side (much faster than application code)

**Example from Code:**
```typescript
// FriendService - checking if two users are friends
async areFriends(userId: string, otherUserId: string): Promise<boolean> {
  const isFriend = await this.redis.sismember(
    `user:${userId}:friends`,
    otherUserId
  );
  return isFriend === 1;
}

// Finding mutual friends (O(n+m) server-side is faster than app-side O(n*m))
async getMutualFriends(userId: string, otherUserId: string): Promise<string[]> {
  return this.redis.sinter(
    `user:${userId}:friends`,
    `user:${otherUserId}:friends`
  );
}
```

**Blocked Users Pattern (Same as Friends):**
```
Key: user:{userId}:blocked
Members: {blockedUserId1, blockedUserId2...}
```

---

### 3. Sorted Sets - Friend Requests (Ordered by Timestamp)

**Use Case:** Ordered data with ranking/scoring

```
Key: user:{userId}:friend_requests:incoming
Score: timestamp (milliseconds)
Members: {senderId1, senderId2...}
```

**Operations & Complexity:**
| Operation | Complexity | Use Case |
|-----------|-----------|----------|
| ZADD | O(log n) | Add request with timestamp |
| ZREM | O(log n) | Remove request |
| ZRANGE | O(log n + m) | Get requests (newest first) |
| ZREVRANGE | O(log n + m) | Get in reverse order |
| ZSCORE | O(1) | Check if request exists |
| ZCARD | O(1) | Count pending requests |

**Why Sorted Sets for Requests:**
- **Ordered by time:** ZREVRANGE returns newest requests first (better UX)
- **Efficient pagination:** Range queries handle "load more" patterns well
- **Expiration tracking:** Score represents creation time, easy to clean old requests

**Example from Code:**
```typescript
// FriendService - sending a friend request with timestamp score
async sendFriendRequest(
  fromUserId: string,
  toUserId: string,
  fromGamertag: string
): Promise<FriendRequest> {
  const now = Date.now();

  const pipeline = this.redis.pipeline();

  // Score = timestamp, member = userId
  // This allows sorting by recency
  pipeline.zadd(
    `user:${fromUserId}:friend_requests:outgoing`,
    now,  // score
    toUserId  // member
  );

  pipeline.zadd(
    `user:${toUserId}:friend_requests:incoming`,
    now,  // score
    fromUserId  // member
  );

  await pipeline.exec();
}

// Fetching requests (newest first with pagination)
async getFriendRequests(
  userId: string,
  type: 'incoming' | 'outgoing',
  limit: number = 50,
  offset: number = 0
): Promise<FriendRequest[]> {
  const key = type === 'incoming'
    ? `user:${userId}:friend_requests:incoming`
    : `user:${userId}:friend_requests:outgoing`;

  // ZREVRANGE: newest first, with scores (timestamps)
  const results = await this.redis.zrevrange(
    key,
    offset,
    offset + limit - 1,
    'WITHSCORES'
  );

  // Parse results...
}
```

---

### 4. Lists - Message History (Recent Messages Cache)

**Use Case:** Ordered append-only data with bounded size

```
Key: chat:messages:{conversationId}
Items: [msg_newest, msg_2nd_newest, ..., msg_oldest]
Max Items: 100 (keep only recent)
```

**Operations & Complexity:**
| Operation | Complexity | Use Case |
|-----------|-----------|----------|
| LPUSH | O(1) | Add new message to front |
| LPOP | O(1) | Remove from front |
| LRANGE | O(n) | Fetch range of messages |
| LTRIM | O(n) | Keep only recent messages |
| LLEN | O(1) | Count messages |

**Why Lists for Messages:**
- **Chronological order:** Messages naturally fit ordered data structure
- **Bounded cache:** LTRIM keeps only recent N messages (old ones in DynamoDB)
- **Efficient pagination:** LRANGE gets "load older messages" with single call
- **Prepend optimization:** LPUSH is O(1), faster than APPEND at end

**Example from Code:**
```typescript
// ChatService - storing new messages
async sendMessage(
  senderId: string,
  input: SendMessageInput
): Promise<ChatMessage> {
  const message: ChatMessage = {
    id: messageId,
    conversationId,
    senderId,
    content: input.content,
    type: 'text',
    createdAt: now,
    readAt: null,
  };

  const pipeline = this.redis.pipeline();

  // LPUSH adds to front (newest first)
  const messagesKey = `chat:messages:${conversationId}`;
  pipeline.lpush(messagesKey, JSON.stringify(message));

  // LTRIM keeps only most recent 100 messages
  // Older messages are in DynamoDB
  pipeline.ltrim(messagesKey, 0, 99);  // keep indices 0-99

  await pipeline.exec();
}

// Retrieving messages (newest first)
async getMessages(
  conversationId: string,
  limit: number = 50
): Promise<ChatMessage[]> {
  // LRANGE 0 49 = get 50 most recent messages
  const messagesKey = `chat:messages:${conversationId}`;
  const cachedMessages = await this.redis.lrange(
    messagesKey,
    0,
    limit - 1
  );

  return cachedMessages.map(m => JSON.parse(m) as ChatMessage);
}
```

---

### 5. Hashes - Structured Data (Conversation Metadata, Request Details)

**Use Case:** Objects with multiple fields

```
Key: chat:conversation:{conversationId}
Fields: {
  "data": "{...json...}",
  "participants": "user1,user2",
  "lastUpdated": "1707000000000"
}
```

**Operations & Complexity:**
| Operation | Complexity | Use Case |
|-----------|-----------|----------|
| HSET | O(1) | Set field |
| HGET | O(1) | Get field |
| HGETALL | O(n) | Get all fields |
| HDEL | O(k) | Delete k fields |
| HEXISTS | O(1) | Check field exists |
| HINCRBY | O(1) | Increment field |

**Why Hashes:**
- **Atomic multi-field updates:** Update all conversation fields in one command
- **Selective retrieval:** Get specific fields without loading entire object
- **Memory efficient:** More compact than separate keys for each field

**Example from Code:**
```typescript
// ChatService - storing conversation metadata
async createConversation(
  participantIds: string[],
  type: 'direct' | 'group'
): Promise<Conversation> {
  const conversation: Conversation = {
    id: conversationId,
    type,
    participantIds,
    // ... more fields
  };

  const pipeline = this.redis.pipeline();

  // Store entire conversation as one field
  pipeline.hset(
    `chat:conversation:${conversationId}`,
    'data',
    JSON.stringify(conversation)
  );

  await pipeline.exec();
}

// FriendService - storing request details
pipeline.hset(
  `friend_request:${fromUserId}:${toUserId}`,
  'id', requestId,
  'fromGamertag', fromGamertag,
  'createdAt', now.toString(),
  'status', 'pending'
);

// Set expiration on the entire hash
pipeline.expire(
  `friend_request:${fromUserId}:${toUserId}`,
  30 * 24 * 60 * 60  // 30 days
);
```

---

## Key Naming Conventions

Consistent key naming makes Redis introspection and debugging easier. PSN follows this pattern:

```
{entity}:{id}:{relationship}
```

### Patterns Used

**User-scoped keys:**
```
user:{userId}:friends              # Set of friend IDs
user:{userId}:blocked              # Set of blocked user IDs
user:{userId}:friend_requests:incoming  # Sorted set (ordered by timestamp)
user:{userId}:friend_requests:outgoing
```

**Presence keys:**
```
presence:{userId}                  # String - user's presence data
presence:online                    # Set - all online users
presence:game:{gameTitle}          # Set - users playing this game
```

**Chat keys:**
```
chat:conversation:{conversationId} # Hash - conversation metadata
chat:messages:{conversationId}     # List - recent messages
chat:user:{userId}:conversations   # Sorted set - user's conversations by timestamp
chat:participants:{conversationId} # Set - conversation participants
chat:typing:{conversationId}:{userId}  # String with TTL - typing indicator
```

**Activity keys:**
```
activity:{userId}:history          # Sorted set - user's activity timeline
activity:{userId}:feed             # Sorted set - user's friends' activities
```

### Hash Tags for Redis Cluster

When using Redis Cluster, related keys can be co-located on the same node using hash tags:

```
user:{123}:friends              # slot based on "123"
user:{123}:sessions             # slot based on "123"
user:{123}:blocked              # slot based on "123"
```

**All above keys hash to the same slot!** This enables atomic multi-key operations like:

```typescript
// CLUSTER MODE: Both keys on same node = atomic operation
pipeline.sadd(`user:{123}:friends`, friendId);
pipeline.zrem(`user:{123}:friend_requests:outgoing`, friendId);
await pipeline.exec();
```

**Interview Answer:**
> "In Redis Cluster, keys are hashed to 16,384 slots. By using hash tags—the part in curly braces—we ensure related keys go to the same slot. This allows atomic operations. Without this, we couldn't reliably execute multi-key operations across a cluster."

---

## Caching Patterns

### Cache-Aside (Lazy Loading)

**Pattern:** Check cache → miss? → fetch from DB → store in cache

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ 1. Get profile
       ▼
   ┌─────────────┐
   │ Redis Cache │────── Miss
   └─────────────┘
       │
       │ 2. Fetch from DB
       ▼
   ┌─────────────┐
   │  DynamoDB   │
   └──────┬──────┘
       │
       │ 3. Store in cache
       ▼
   ┌─────────────┐
   │ Redis Cache │────── Hit
   └─────────────┘
```

**Pros:**
- Only caches what's actually used
- Simple to implement
- Works with any data source

**Cons:**
- First request is slow (cache miss penalty)
- Stale data if database is updated elsewhere
- Cache stampede if many requests miss simultaneously

**Implementation:**
```typescript
// From redis-cluster/index.ts
export class CacheAside<T> {
  async get(key: string): Promise<T | null> {
    const cacheKey = `${this.prefix}:${key}`;

    // Step 1: Try cache first
    const cached = await this.cluster.get(cacheKey);
    if (cached) {
      console.log(`[Cache] HIT: ${cacheKey}`);
      return JSON.parse(cached);
    }

    console.log(`[Cache] MISS: ${cacheKey}`);

    // Step 2: Fetch from source (database)
    const value = await this.fetchFn(key);
    if (value === null) {
      return null;
    }

    // Step 3: Store in cache
    await this.cluster.set(
      cacheKey,
      JSON.stringify(value),
      'EX',
      this.ttlSeconds
    );

    return value;
  }
}
```

**When to use:**
- Profile data (read-heavy, rarely updated)
- Game metadata (static, updated infrequently)
- User preferences

### Write-Through Pattern

**Pattern:** Always write to cache, then write to DB

Guarantees cache is always fresh but adds latency to writes.

**Interview Context:**
> "For friend requests, we could use write-through: when someone sends a request, we write to Redis immediately, then asynchronously to DynamoDB. This keeps the cache fresh and makes reads fast."

### TTL-Based Expiration

**Pattern:** Set automatic expiration on cached data

```typescript
// Store presence with 5-minute TTL
await redis.setex(
  `presence:${userId}`,
  300,  // TTL in seconds
  JSON.stringify(presenceData)
);

// Refresh on heartbeat
await redis.setex(
  `presence:${userId}`,
  300,
  JSON.stringify(updatedPresence)
);
```

**TTL Strategies in PSN:**

| Data | TTL | Reason |
|------|-----|--------|
| User presence | 5 minutes | Auto-cleanup of stale state, heartbeat refresh |
| Friend list | 1 hour | Relatively stable, periodic refresh |
| Game metadata | 24 hours | Very static data |
| Typing indicator | 5 seconds | Auto-cleanup when user stops |
| Message history | Never expires | Bounded by LTRIM to 100 messages |
| Friend request | 30 days | Long-lived, explicit cleanup on accept/decline |

---

## Redis Pub/Sub for Real-time

### Architecture Pattern: Fan-Out Across Servers

**Challenge:** When user A's presence changes, notify all their friends:
- 100M+ users online
- Each has ~50 friends on average
- = 5 BILLION potential notifications

**Solution:** Redis Pub/Sub with local filtering

```
┌────────────────────────────────────────────────┐
│ USER A GOES ONLINE                             │
└────────────────────────────────────────────────┘
         │
         │ 1. Store in Redis
         ▼
┌────────────────────────────────────────────────┐
│ presence:{userA} = {...}                       │
└────────────────────────────────────────────────┘
         │
         │ 2. Publish to channel
         ▼
┌────────────────────────────────────────────────┐
│ PUBLISH presence:updates {userId: "userA"...} │
└────────────────────────────────────────────────┘
         │
         │ 3. All servers receive (fan-out)
         ├──────────────┬──────────────┬─────────────┐
         ▼              ▼              ▼             ▼
    ┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐
    │ Server │    │ Server │    │ Server │    │ Server │
    │   #1   │    │   #2   │    │   #3   │    │   #4   │
    └────┬───┘    └────┬───┘    └────┬───┘    └────┬───┘
         │             │             │             │
         │ 4. Filter to friends    │             │
         │ connected to this       │             │
         │ server                  │             │
         ▼                         ▼             ▼
    ┌─────────────┐         ┌──────────────┐
    │ 10 of User  │         │ 5 of User    │
    │ A's friends │         │ A's friends  │
    │ connected   │         │ connected    │
    │ here        │         │ here         │
    └────┬────────┘         └───┬──────────┘
         │                      │
         │ 5. Push to WebSocket │
         ▼                      ▼
    Connected clients    Connected clients
```

**Key insight:** Instead of 5B notifications, we have:
- **1 Redis publish** (reaches all servers)
- **100 servers** receive and filter
- **Each server** pushes to its connected clients only

**Code Implementation:**

```typescript
// PresenceService - Publishing presence updates
async setOnline(userId: string, gamertag: string): Promise<PresenceData> {
  const presenceData: PresenceData = {
    userId,
    gamertag,
    status: 'online',
    // ...
  };

  // Step 1: Store in Redis
  const pipeline = this.redis.pipeline();
  pipeline.setex(
    `presence:${userId}`,
    300,
    JSON.stringify(presenceData)
  );
  pipeline.sadd('presence:online', userId);
  await pipeline.exec();

  // Step 2: Publish to channel
  await this.redis.publish(
    'presence:updates',
    JSON.stringify({
      type: 'went_online',
      userId,
      presence: presenceData,
      timestamp: Date.now(),
    })
  );

  return presenceData;
}

// All servers subscribe to this channel
private async initializeSubscription(): Promise<void> {
  await this.subscriber.subscribe('presence:updates');

  this.subscriber.on('message', (channel, message) => {
    if (channel === 'presence:updates') {
      const event = JSON.parse(message) as PresenceUpdateEvent;
      // Step 3: Each server handles the event
      this.handlePresenceUpdate(event);
    }
  });
}

// Step 4: Filter to relevant clients on THIS server
private handlePresenceUpdate(event: PresenceUpdateEvent): void {
  // Emit for WebSocket handlers (they filter by friend relationships)
  // "Is this user one of my friends?"
  this.emit('presenceUpdate', event);
}
```

### Channel Naming Conventions

**Presence channel (broadcast to all servers):**
```
presence:updates

Clients on any server interested in ANY presence change
subscribe to this and filter locally
```

**User-specific channels (targeted subscriptions):**
```
presence:{userId}          # Updates about this specific user
friend:events:{userId}     # Friend requests for this user
chat:channel:{conversationId}  # Messages in this conversation
```

**Game-specific channels:**
```
game:activity:{gameId}     # Activity in this game
game:sessions:{gameId}     # Players joining/leaving
```

### Message Format Standards

**Presence Update:**
```json
{
  "type": "went_online|went_offline|status_changed|game_started|game_ended",
  "userId": "user_123",
  "presence": {
    "userId": "user_123",
    "gamertag": "xXProGamer420Xx",
    "status": "online",
    "currentGame": "Spider-Man 2",
    "statusMessage": "Let's play!",
    "lastActiveAt": 1707000000000,
    "updatedAt": 1707000000000
  },
  "timestamp": 1707000000000
}
```

**Friend Event:**
```json
{
  "type": "friend_request_received|friend_request_accepted|friend_removed|user_blocked",
  "eventId": "evt_uuid",
  "timestamp": "2026-02-04T12:00:00Z",
  "fromUserId": "user_123",
  "toUserId": "user_456",
  "fromGamertag": "xXProGamer420Xx"
}
```

---

## Advanced Patterns

### Distributed Locking

**Use Case:** Prevent double-processing of events

```typescript
// From redis-cluster/index.ts
export class DistributedLock {
  async acquire(resource: string): Promise<{ acquired: boolean; lockId: string }> {
    const lockKey = `lock:${resource}`;
    const lockId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // SET NX EX = "Set if not exists, with expiration"
    // Atomic: either succeeds or fails, never partial
    const result = await this.cluster.set(
      lockKey,
      lockId,
      'PX',          // milliseconds
      30000,         // 30 second TTL
      'NX'           // only if not exists
    );

    return {
      acquired: result === 'OK',
      lockId
    };
  }

  async release(resource: string, lockId: string): Promise<boolean> {
    const lockKey = `lock:${resource}`;

    // Lua script ensures atomic check-and-delete
    // We only delete if we own the lock
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await this.cluster.eval(script, 1, lockKey, lockId);
    return result === 1;
  }

  async withLock<T>(
    resource: string,
    fn: () => Promise<T>
  ): Promise<T | null> {
    const { acquired, lockId } = await this.acquire(resource);

    if (!acquired) {
      return null;  // Someone else has the lock
    }

    try {
      return await fn();
    } finally {
      await this.release(resource, lockId);
    }
  }
}

// Usage: Prevent duplicate friend requests
const lock = new DistributedLock(redis);

await lock.withLock(`friend-request:${fromUserId}:${toUserId}`, async () => {
  // Only one server at a time can execute this
  const existing = await checkIfRequestExists(fromUserId, toUserId);
  if (existing) {
    throw new Error('Request already exists');
  }

  // Safe to create
  await createFriendRequest(fromUserId, toUserId);
});
```

**Why this matters:**
- Race condition: Two servers both read "no request exists", both create one
- Solution: Lock ensures only one server processes at a time
- Timeout: If server crashes, lock expires automatically (30s)

**Interview Answer:**
> "Distributed locks prevent race conditions when multiple servers try to update the same resource. We use Redis SET NX EX for atomic lock acquisition and Lua scripts for atomic check-and-delete on release. The TTL ensures cleanup if a server crashes."

### Pipelining for Batch Operations

**Pattern:** Send multiple commands, read all responses at once

**Without pipeline:**
```
Client → Server: GET key1
Server → Client: value1          (1ms round trip)
Client → Server: GET key2
Server → Client: value2          (1ms round trip)
Client → Server: GET key3
Server → Client: value3          (1ms round trip)
Total: 3ms (3 round trips)
```

**With pipeline:**
```
Client → Server: [GET key1, GET key2, GET key3]
Server → Client: [value1, value2, value3]       (1ms round trip)
Total: 1ms (1 round trip)
```

**Implementation:**
```typescript
// From redis-cluster/index.ts
export class RedisBatch {
  private pipeline: ReturnType<Cluster['pipeline']>;

  constructor(cluster: Cluster) {
    this.pipeline = cluster.pipeline();
  }

  get(key: string): this {
    this.pipeline.get(key);
    return this;
  }

  set(key: string, value: string, ttl?: number): this {
    if (ttl) {
      this.pipeline.set(key, value, 'EX', ttl);
    } else {
      this.pipeline.set(key, value);
    }
    return this;
  }

  async exec(): Promise<any[]> {
    const results = await this.pipeline.exec();
    if (!results) return [];

    return results.map(([err, result]) => {
      if (err) throw err;
      return result;
    });
  }
}

// Usage: Fetch multiple friends' presence
async getPresenceMultiple(userIds: string[]): Promise<Map<string, PresenceData>> {
  const keys = userIds.map((id) => `presence:${id}`);

  // Single MGET call instead of N individual GETs
  const values = await this.redis.mget(...keys);

  const result = new Map<string, PresenceData>();
  for (let i = 0; i < userIds.length; i++) {
    if (values[i]) {
      result.set(userIds[i], JSON.parse(values[i]));
    }
  }

  return result;
}
```

**Benchmark:**
- Fetching 100 friends' presence without pipeline: 100ms
- With pipeline: 2ms (50x faster!)

---

## Code Examples

### Example 1: Real-time Presence (Most Important)

```typescript
// PresenceService - The core of PSN's real-time features

async setOnline(
  userId: string,
  gamertag: string,
  currentGame: string | null = null
): Promise<PresenceData> {
  const now = Date.now();

  const presenceData: PresenceData = {
    userId,
    gamertag,
    status: 'online',
    currentGame,
    statusMessage: null,
    lastActiveAt: now,
    updatedAt: now,
  };

  // Step 1: Store in Redis with TTL (auto-cleanup on no heartbeat)
  const pipeline = this.redis.pipeline();

  // Main presence record
  pipeline.setex(
    `presence:${userId}`,
    300,  // 5 minute TTL
    JSON.stringify(presenceData)
  );

  // Add to online users set (fast lookup)
  pipeline.sadd('presence:online', userId);

  // Add to game's player set (for "friends playing X game" queries)
  if (currentGame) {
    pipeline.sadd(`presence:game:${currentGame}`, userId);
  }

  await pipeline.exec();

  // Step 2: Publish to all servers (fan-out)
  await this.redis.publish(
    'presence:updates',
    JSON.stringify({
      type: 'went_online',
      userId,
      presence: presenceData,
      timestamp: now,
    })
  );

  console.log(`[PresenceService] User online: ${gamertag}`);
  return presenceData;
}

// Heartbeat: Client sends every 60 seconds to prove they're alive
async heartbeat(userId: string): Promise<PresenceData | null> {
  const presenceKey = `presence:${userId}`;

  // Get current presence
  const presenceData = await this.redis.get(presenceKey);
  if (!presenceData) {
    return null;  // User offline
  }

  const presence = JSON.parse(presenceData) as PresenceData;
  presence.lastActiveAt = Date.now();

  // Refresh TTL (extend by 5 more minutes)
  await this.redis.setex(
    presenceKey,
    300,
    JSON.stringify(presence)
  );

  return presence;
}

// Get friend list with presence
async getFriendsWithPresence(userId: string): Promise<Array<{
  friendId: string;
  presence: PresenceData | null;
  isOnline: boolean;
}>> {
  const friendIds = this.friendsCache.get(userId) || new Set();

  if (friendIds.size === 0) {
    return [];
  }

  // Batch fetch all friends' presence with MGET (1 round trip)
  const presenceMap = await this.getPresenceMultiple([...friendIds]);

  return [...friendIds].map((friendId) => {
    const presence = presenceMap.get(friendId) || null;
    return {
      friendId,
      presence,
      isOnline: presence !== null && presence.status !== 'offline',
    };
  });
}
```

### Example 2: Friend Requests (Sorted Sets)

```typescript
// FriendService - Managing friend requests with ordering

async sendFriendRequest(
  fromUserId: string,
  toUserId: string,
  fromGamertag: string
): Promise<FriendRequest> {
  // Validation...

  const now = Date.now();
  const requestId = uuidv4();

  const request: FriendRequest = {
    id: requestId,
    fromUserId,
    toUserId,
    fromGamertag,
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  // Store in sorted set with timestamp as score
  const pipeline = this.redis.pipeline();

  // Sender's outgoing requests
  pipeline.zadd(
    `user:${fromUserId}:friend_requests:outgoing`,
    now,           // score = timestamp
    toUserId       // member = recipient
  );

  // Recipient's incoming requests
  pipeline.zadd(
    `user:${toUserId}:friend_requests:incoming`,
    now,           // score = timestamp
    fromUserId     // member = sender
  );

  // Store request details in hash
  pipeline.hset(
    `friend_request:${fromUserId}:${toUserId}`,
    'id', requestId,
    'fromGamertag', fromGamertag,
    'createdAt', now.toString(),
    'status', 'pending'
  );

  // Expire request after 30 days
  pipeline.expire(
    `friend_request:${fromUserId}:${toUserId}`,
    30 * 24 * 60 * 60
  );

  await pipeline.exec();

  // Publish event
  await this.publishEvent({
    type: 'friend_request_received',
    eventId: uuidv4(),
    timestamp: new Date().toISOString(),
    fromUserId,
    toUserId,
    fromGamertag,
    request,
  });

  return request;
}

// Get friend requests (newest first)
async getFriendRequests(
  userId: string,
  type: 'incoming' | 'outgoing',
  limit: number = 50,
  offset: number = 0
): Promise<FriendRequest[]> {
  const key = type === 'incoming'
    ? `user:${userId}:friend_requests:incoming`
    : `user:${userId}:friend_requests:outgoing`;

  // ZREVRANGE: reverse order (newest first) with scores (timestamps)
  const results = await this.redis.zrevrange(
    key,
    offset,
    offset + limit - 1,
    'WITHSCORES'
  );

  // Parse results into FriendRequest objects
  const requests: FriendRequest[] = [];
  for (let i = 0; i < results.length; i += 2) {
    const otherUserId = results[i];
    const timestamp = parseInt(results[i + 1], 10);

    // Get request details from hash
    const fromId = type === 'incoming' ? otherUserId : userId;
    const toId = type === 'incoming' ? userId : otherUserId;
    const details = await this.redis.hgetall(
      `friend_request:${fromId}:${toId}`
    );

    requests.push({
      id: details.id || uuidv4(),
      fromUserId: fromId,
      toUserId: toId,
      fromGamertag: details.fromGamertag || 'Unknown',
      status: 'pending',
      createdAt: new Date(timestamp).toISOString(),
      updatedAt: new Date(timestamp).toISOString(),
    });
  }

  return requests;
}

// Accept request
async acceptFriendRequest(
  userId: string,
  fromUserId: string,
  userGamertag: string
): Promise<FriendRelationship> {
  const now = new Date().toISOString();

  // Atomic transaction
  const pipeline = this.redis.pipeline();

  // Add bidirectional friend relationship (sets)
  pipeline.sadd(`user:${userId}:friends`, fromUserId);
  pipeline.sadd(`user:${fromUserId}:friends`, userId);

  // Remove from pending requests (sorted sets)
  pipeline.zrem(`user:${userId}:friend_requests:incoming`, fromUserId);
  pipeline.zrem(`user:${fromUserId}:friend_requests:outgoing`, userId);

  // Clean up request details
  pipeline.del(`friend_request:${fromUserId}:${userId}`);

  await pipeline.exec();

  // Publish event
  await this.publishEvent({
    type: 'friend_request_accepted',
    eventId: uuidv4(),
    timestamp: now,
    fromUserId: userId,       // accepter
    toUserId: fromUserId,     // original sender
    fromGamertag: userGamertag,
  });

  return {
    userId,
    friendId: fromUserId,
    status: 'accepted',
    initiatedBy: fromUserId,
    createdAt: now,
    updatedAt: now,
  };
}
```

### Example 3: Chat Messages (Lists with Bounded Size)

```typescript
// ChatService - Two-tier message storage

async sendMessage(
  senderId: string,
  input: SendMessageInput
): Promise<ChatMessage> {
  const { conversationId, content } = input;

  // Check rate limit
  const rateLimitResult = await this.checkRateLimit(senderId);
  if (!rateLimitResult.allowed) {
    throw new Error(`Rate limit exceeded`);
  }

  // Validate access
  const conversation = await this.getConversation(conversationId, senderId);
  if (!conversation) {
    throw new Error('Conversation not found');
  }

  const now = new Date().toISOString();
  const messageId = `msg_${uuidv4()}`;

  const message: ChatMessage = {
    id: messageId,
    conversationId,
    senderId,
    senderGamertag: `User_${senderId.slice(-4)}`,
    content,
    type: 'text',
    createdAt: now,
    readAt: null,
  };

  // Two-tier storage: Redis (hot) + DynamoDB (cold)
  const pipeline = this.redis.pipeline();

  // TIER 1: Redis List (bounded to 100 recent messages)
  const messagesKey = `chat:messages:${conversationId}`;

  // LPUSH adds to front (newest first)
  pipeline.lpush(messagesKey, JSON.stringify(message));

  // LTRIM keeps only indices 0-99 (100 most recent messages)
  pipeline.ltrim(messagesKey, 0, 99);

  // Update conversation metadata
  conversation.lastMessage = message;
  conversation.updatedAt = now;

  pipeline.hset(
    `chat:conversation:${conversationId}`,
    'data',
    JSON.stringify(conversation)
  );

  // Update conversation position in each participant's list
  for (const participantId of conversation.participantIds) {
    pipeline.zadd(
      `chat:user:${participantId}:conversations`,
      Date.now(),
      conversationId
    );
  }

  // TIER 2: DynamoDB would go here (asynchronous write)
  // await dynamoDB.put({
  //   TableName: 'Messages',
  //   Item: { ...message }
  // });

  await pipeline.exec();

  // Publish for real-time delivery
  await this.redis.publish(
    `chat:channel:${conversationId}`,
    JSON.stringify({
      type: 'new_message',
      conversationId,
      message,
      timestamp: Date.now(),
    })
  );

  return message;
}

// Retrieve messages (from cache, or DynamoDB if older)
async getMessages(
  conversationId: string,
  userId: string,
  limit: number = 50
): Promise<ChatMessage[]> {
  // Check access
  const conversation = await this.getConversation(conversationId, userId);
  if (!conversation) {
    throw new Error('Conversation not found');
  }

  // Get from Redis cache (most recent 100)
  const messagesKey = `chat:messages:${conversationId}`;
  const cachedMessages = await this.redis.lrange(
    messagesKey,
    0,
    limit - 1
  );

  const messages = cachedMessages.map(
    (m) => JSON.parse(m) as ChatMessage
  );

  // If we got fewer than requested, would query DynamoDB here
  // const oldMessagesFromDB = await dynamoDB.query({...});

  return messages;
}
```

---

## Interview Questions & Answers

### Q1: Explain how PlayStation's presence system scales to 100M+ users

**Good Answer:**
"We separate storage from notification:

1. **Storage:** Each user's presence is a Redis String with 5-minute TTL
2. **Notification:** When presence changes, we publish to a Redis channel
3. **Fan-out:** All servers subscribe to the presence channel, receive every update, then filter locally
4. **Filtering:** Each server only notifies clients for their friends
5. **Heartbeat:** Clients send heartbeat every 60 seconds to refresh the TTL

Instead of sending 5 billion notifications directly, we have:
- 1 Redis publish (reaches ~100 servers in 1ms)
- 100 servers filter to their ~10,000 connected clients
- Each client only sees their ~50 friends

Total: O(servers × clients_per_server), not O(users × friends)"

**Why it's good:**
- Shows understanding of scale
- Explains separation of concerns (storage vs. notification)
- Demonstrates filtering strategy
- Mentions TTL for handling disconnects

---

### Q2: Why use Sets for friendship lists instead of just storing an array?

**Good Answer:**
"Sets give us O(1) operations:

1. **Membership test:** SISMEMBER is O(1). Checking 'are we friends?' is instant, even if someone has 2000 friends.
2. **Add/remove:** SADD and SREM are O(1). Adding a friend is consistent regardless of friend count.
3. **Set operations:** SINTER finds mutual friends server-side. Computing mutual friends of two users with 2000 friends each is O(n) in Redis vs. O(n*m) in application code.
4. **Bidirectional:** We store both user:123:friends and user:456:friends separately. This allows O(1) lookup from either direction.

With an array, checking if someone is a friend would be O(n), meaning a large friend list would slow down every permission check."

**Why it's good:**
- Focuses on algorithmic complexity
- Real-world scale reasoning
- Shows understanding of trade-offs

---

### Q3: What's the difference between cache-aside and write-through?

**Good Answer:**
"

**Cache-Aside (Lazy Loading):**
- Check cache → if miss, load from DB → store in cache
- Pro: Only caches what's actually used
- Con: First request is slow (cache miss penalty)
- Use for: Read-heavy data (profiles, game metadata)

**Write-Through:**
- Always write to cache first, then write to DB
- Pro: Cache is always fresh
- Con: Adds latency to every write
- Use for: Critical data (friend lists, presence)

**Example:** Friend requests use write-through. When someone sends a request, we write to Redis immediately, then asynchronously to DynamoDB. This keeps Redis fresh for real-time queries.

**Cache Stampede:** If a cache key expires and 1000 requests ask for it simultaneously, all hit the DB at once. Solution: Use locks or probabilistic early expiration."

---

### Q4: Explain Redis Pub/Sub and its limitations

**Good Answer:**
"

**What it does:**
- PUBLISH sends a message to a channel
- SUBSCRIBE listens to a channel
- Any subscriber receives the message in real-time

**Scaling benefit:**
- One publish reaches all subscribers (servers)
- Subscribers filter locally to relevant clients
- Linear scale: 100 servers, 1 publish reaches all

**Limitations:**
1. **No persistence:** If a subscriber is offline, it misses the message. (Solution: Write to a List, have offline subscribers catch up)
2. **No acknowledgment:** Publisher doesn't know if anyone received the message
3. **All-or-nothing:** You subscribe to entire channel, can't filter server-side
4. **Memory overhead:** Millions of channels = memory usage

**Better for critical messages:** Redis Streams provides acknowledgment and replay. But for real-time presence/typing, Pub/Sub is perfect because stale updates are fine."

---

### Q5: How would you handle a friend request being accepted simultaneously by two servers?

**Good Answer:**
"

**The Problem:**
Two servers both try to accept the same request at the same time. Both read 'request exists', both try to accept.

**Solution: Distributed Lock**

```typescript
const lock = new DistributedLock(redis);

await lock.withLock(`accept-request:${userId}:${fromUserId}`, async () => {
  // Only one server executes this block at a time
  const requestExists = await redis.zscore(
    `user:${userId}:friend_requests:incoming`,
    fromUserId
  );

  if (requestExists === null) {
    throw new Error('Request already accepted');
  }

  // Safe to proceed
  await acceptFriendRequest(userId, fromUserId);
});
```

**How it works:**
1. SET NX EX is atomic: either succeeds or fails
2. Only one server can acquire the lock
3. If server crashes, lock expires (TTL)
4. If another server is waiting, it retries after lock expires

**Alternative: Conditional write**
Some systems use versioning: 'Only write if version hasn't changed' (optimistic locking). But Redis doesn't support this natively, so distributed locks are cleaner."

---

### Q6: Why separate presence into Redis Strings but use Sets for online users?

**Good Answer:**
"

**Redis Strings (presence:{userId}):**
- Stores the full presence object (status, game, lastActive, etc.)
- Used for detailed queries ('what's user X doing?')
- TTL auto-cleanup (no heartbeat = auto-offline)

**Redis Sets (presence:online):**
- Just stores user IDs
- Used for fast counts ('how many users online?')
- Quick lookup ('is user X online?') with SISMEMBER

**Why not just one?**
- If we store only Sets, we lose the detail (no game info)
- If we store only Strings, counting online users requires fetching all Strings (O(n))
- Combined: O(1) checks and O(1) counts, both details and fast lookups

**Interview angle:** Showing you optimize for different query patterns."

---

### Q7: What happens if a client disconnects without sending an offline message?

**Good Answer:**
"

**Without TTL (the problem):**
- User closes browser without logging out
- Server never receives disconnect message
- User stays online forever (from friend's perspective)

**With TTL (our solution):**
- Every message/heartbeat refreshes the 5-minute TTL
- If client crashes, no more heartbeats
- After 5 minutes of silence, Redis auto-deletes presence
- Cleanup job (or SCAN) discovers the expired presence
- We publish 'went_offline' event

**Heartbeat mechanism:**
Client sends heartbeat every 60 seconds (app level):
```
// Client code (browser/mobile)
setInterval(async () => {
  await graphQL.mutation(heartbeat({ userId }));
}, 60 * 1000);  // Every 60 seconds
```

Server receives and refreshes TTL:
```typescript
async heartbeat(userId: string): Promise<PresenceData> {
  const presence = await redis.get(`presence:${userId}`);
  // Refresh TTL by re-setting
  await redis.setex(`presence:${userId}`, 300, presence);
  return JSON.parse(presence);
}
```

**This is why TTL is critical:** It handles the edge case of ungraceful disconnects."

---

## Common Pitfalls & Solutions

### Pitfall 1: Infinite Pub/Sub Connections

**Problem:**
```typescript
// WRONG: Creates new subscriber for every request
app.get('/subscribe', async (req, res) => {
  const subscriber = redis.duplicate();  // ❌ Leaks connection
  await subscriber.subscribe('presence:updates');
  // Never unsubscribed
});
```

**Solution:**
```typescript
// RIGHT: Single subscriber shared across application
class PresenceService extends EventEmitter {
  private subscriber: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
    this.subscriber = redis.duplicate();  // ✓ Created once
    this.initializeSubscription();
  }

  async cleanup() {
    await this.subscriber.unsubscribe();
    await this.subscriber.quit();  // ✓ Cleanup on shutdown
  }
}
```

---

### Pitfall 2: Blocking Commands in High Throughput

**Problem:**
```typescript
// WRONG: BLPOP blocks for 10 seconds
// With 1000 concurrent requests, you block 1000 connections
await redis.blpop('queue:messages', 10);
```

**Solution:**
Use non-blocking alternatives with polling:
```typescript
// RIGHT: Fast, non-blocking check
setInterval(async () => {
  const message = await redis.lpop('queue:messages');
  if (message) {
    processMessage(message);
  }
}, 100);  // Check every 100ms
```

---

### Pitfall 3: No Key Expiration for Temporary Data

**Problem:**
```typescript
// WRONG: Typing indicators never clean up
await redis.set(`typing:${conversationId}:${userId}`, '1');
// No TTL → Redis memory fills up
```

**Solution:**
```typescript
// RIGHT: Always set TTL for temporary data
await redis.setex(
  `typing:${conversationId}:${userId}`,
  5,  // 5 second TTL
  '1'
);
```

---

### Pitfall 4: Race Conditions in Multi-Step Operations

**Problem:**
```typescript
// WRONG: Two steps, no atomicity
const friends = await redis.smembers(`user:${userId}:friends`);
await redis.del(`user:${userId}:friends`);  // What if new friend added between?
```

**Solution:**
```typescript
// RIGHT: Use pipeline for atomicity
const pipeline = redis.pipeline();
pipeline.smembers(`user:${userId}:friends`);
pipeline.del(`user:${userId}:friends`);
const [friendsBefore, delResult] = await pipeline.exec();
```

---

### Pitfall 5: Forgetting to Handle Pub/Sub in Cluster Mode

**Problem:**
```typescript
// WRONG in Cluster mode
// Hash tags don't work with Pub/Sub channels
await redis.publish(
  `presence:${userId}`,  // Different slot per user = unreliable
  JSON.stringify(event)
);
```

**Solution:**
```typescript
// RIGHT: Use consistent channel names that aren't user-specific
await redis.publish(
  'presence:updates',  // Same slot always
  JSON.stringify({ userId, ...event })
);
```

---

### Pitfall 6: Assuming Redis Atomicity Without Lua

**Problem:**
```typescript
// WRONG: Not atomic even with pipeline
pipeline.get(`friend_request:${fromUserId}:${toUserId}`);
pipeline.zadd(`user:${fromUserId}:friend_requests:outgoing`, now, toUserId);
// Another request could succeed between get and zadd
```

**Solution:**
```typescript
// RIGHT: Use Lua script for true atomicity
const script = `
  if redis.call("exists", KEYS[1]) == 0 then
    redis.call("zadd", KEYS[2], ARGV[1], ARGV[2])
    return 1
  else
    return 0
  end
`;

const result = await redis.eval(
  script,
  2,
  `friend_request:${fromUserId}:${toUserId}`,
  `user:${fromUserId}:friend_requests:outgoing`,
  now,
  toUserId
);

if (result === 0) {
  throw new Error('Request already exists');
}
```

---

## Redis Cluster Considerations

### Hash Slots and Slot Distribution

When using Redis Cluster (3+ nodes for HA):

```
// All these keys go to the SAME slot (co-located)
user:{123}:friends
user:{123}:blocked
user:{123}:sessions

// These go to DIFFERENT slots (can't do atomic multi-key ops)
user:123:friends           // slot based on "123:friends"
user:456:friends           // slot based on "456:friends"
```

**In code:**
```typescript
// From redis-cluster/index.ts - Hash tag utilities
export const HashTags = {
  user(userId: string, suffix: string): string {
    return `user:{${userId}}:${suffix}`;
  },
  room(roomId: string, suffix: string): string {
    return `room:{${roomId}}:${suffix}`;
  },
};

// Usage: All user's keys go to same slot
const friendsKey = HashTags.user(userId, 'friends');
const blockedKey = HashTags.user(userId, 'blocked');

// Atomic: both on same slot
const pipeline = redis.pipeline();
pipeline.sadd(friendsKey, friendId);
pipeline.srem(blockedKey, friendId);
await pipeline.exec();
```

---

## Summary: Key Takeaways

| Pattern | Use Case | Complexity | Example |
|---------|----------|-----------|---------|
| **Strings with TTL** | Auto-expiring state | O(1) get/set | Presence, typing indicators |
| **Sets** | Membership & set ops | O(1) check, O(n) operations | Friends, blocked users |
| **Sorted Sets** | Ordered data | O(log n) add/remove | Friend requests, activity feed |
| **Lists** | Ordered append-only | O(1) push/pop, O(n) range | Message history (bounded) |
| **Hashes** | Structured objects | O(1) field access | Conversation metadata |
| **Pub/Sub** | Real-time fan-out | O(1) publish | Presence updates, chat events |
| **Distributed Locks** | Prevent race conditions | O(1) acquire/release | Friend request acceptance |

---

## References

- Official source: `/Users/davidagustin/Desktop/codingfolder/psn-practice-app/src/infrastructure/redis-cluster/index.ts`
- PresenceService: `/Users/davidagustin/Desktop/codingfolder/psn-practice-app/src/services/presence/presence.service.ts`
- FriendService: `/Users/davidagustin/Desktop/codingfolder/psn-practice-app/src/services/friends/friend.service.ts`
- ChatService: `/Users/davidagustin/Desktop/codingfolder/psn-practice-app/src/services/chat/chat.service.ts`

---

**Last Updated:** February 4, 2026
**For:** Senior Backend Engineer Interviews
**Difficulty:** Medium-Advanced
