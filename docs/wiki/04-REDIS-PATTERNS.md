# Redis Patterns Deep Dive

This document covers Redis patterns used in the PlayStation Network practice app.

---

## Table of Contents

1. [Why Redis?](#why-redis)
2. [Data Structures](#data-structures)
3. [Key Naming Conventions](#key-naming-conventions)
4. [Caching Patterns](#caching-patterns)
5. [Pub/Sub for Real-time](#pubsub-for-real-time)
6. [Transactions & Atomicity](#transactions--atomicity)
7. [TTL & Expiration](#ttl--expiration)
8. [Scaling Redis](#scaling-redis)
9. [Interview Questions](#interview-questions)

---

## Why Redis?

### Redis vs Other Databases

| Feature | Redis | PostgreSQL | MongoDB |
|---------|-------|------------|---------|
| **Latency** | Sub-millisecond | 1-10ms | 1-10ms |
| **Data Model** | Key-Value + Structures | Relational | Document |
| **Persistence** | Optional (RDB/AOF) | Full ACID | Full |
| **Scaling** | Cluster + Replicas | Read Replicas | Sharding |
| **Use Case** | Cache, Sessions, Pub/Sub | Primary data | Flexible schemas |

### What We Use Redis For

| Use Case | Why Redis? |
|----------|------------|
| **Sessions** | Fast reads, TTL for expiration |
| **Presence** | Sub-ms updates, TTL for heartbeat |
| **Friends** | O(1) Set operations |
| **Friend Requests** | Sorted Sets for ordering |
| **Pub/Sub** | Real-time event distribution |
| **Caching** | Fast reads, flexible TTL |

---

## Data Structures

### Strings

```redis
# Simple key-value
SET session:user123 "{\"userId\":\"123\",\"token\":\"abc\"}"
GET session:user123

# With expiration
SETEX session:user123 3600 "{...}"  # Expires in 1 hour

# Atomic increment
INCR page:views:homepage
```

**Use cases:** Sessions, presence, counters, simple cache

### Sets

```redis
# Add members
SADD user:123:friends 456 789 101

# Check membership (O(1))
SISMEMBER user:123:friends 456  # Returns 1 or 0

# Get all members
SMEMBERS user:123:friends

# Set operations
SINTER user:123:friends user:456:friends  # Mutual friends
SUNION user:123:friends user:456:friends  # Combined friends
SDIFF user:123:friends user:456:friends   # Friends of 123 not in 456

# Remove
SREM user:123:friends 789
```

**Use cases:** Friends, followers, tags, unique visitors

### Sorted Sets

```redis
# Add with score (timestamp for ordering)
ZADD user:123:requests 1699900000 "456"
ZADD user:123:requests 1699901000 "789"

# Get by rank (newest first)
ZREVRANGE user:123:requests 0 9  # Top 10

# Get by score range
ZRANGEBYSCORE user:123:requests 1699900000 1699901000

# Remove by score (cleanup old)
ZREMRANGEBYSCORE user:123:requests 0 (old_timestamp)

# Get rank
ZRANK user:123:requests "456"
```

**Use cases:** Leaderboards, time-ordered lists, priority queues

### Hashes

```redis
# Set fields
HSET user:123 gamertag "Player1" level 42 trophies 100

# Get field
HGET user:123 gamertag

# Get all fields
HGETALL user:123

# Increment field
HINCRBY user:123 level 1

# Check field exists
HEXISTS user:123 gamertag
```

**Use cases:** Object storage, user profiles, counters per key

### Lists

```redis
# Push to list
LPUSH chat:conv123 "{\"from\":\"A\",\"text\":\"Hi\"}"
RPUSH chat:conv123 "{\"from\":\"B\",\"text\":\"Hello\"}"

# Get range
LRANGE chat:conv123 0 49  # Last 50 messages

# Trim (keep recent)
LTRIM chat:conv123 0 99  # Keep last 100

# Pop
LPOP chat:conv123
RPOP chat:conv123
```

**Use cases:** Message history, activity feed, queues

---

## Key Naming Conventions

### Pattern: `entity:id:property`

```
# User-related
user:123:profile
user:123:friends
user:123:blocked

# Session-related
session:123

# Presence-related
presence:123
presence:online

# Chat-related
chat:conv456:messages
chat:conv456:typing
```

### Benefits

1. **Self-documenting**: Keys describe their content
2. **Scannable**: `SCAN 0 MATCH user:123:*` finds all user keys
3. **Shardable**: Consistent hashing on key prefix
4. **Organized**: Easy to understand data layout

### Anti-patterns

```
# Bad: Unclear purpose
x123
temp_data_1

# Bad: Inconsistent naming
User_123_friends
user-123-friends
user.123.friends

# Good: Consistent, clear
user:123:friends
```

---

## Caching Patterns

### Cache-Aside (Lazy Loading)

```typescript
async getUser(userId: string) {
  const cacheKey = `user:${userId}`;

  // 1. Check cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // 2. Cache miss - fetch from DB
  const user = await db.users.findById(userId);

  // 3. Populate cache
  await redis.setex(cacheKey, 3600, JSON.stringify(user));

  return user;
}
```

**Pros:** Only caches accessed data
**Cons:** Cache miss penalty on first access

### Write-Through

```typescript
async updateUser(userId: string, data: Partial<User>) {
  // 1. Update database
  const user = await db.users.update(userId, data);

  // 2. Update cache synchronously
  await redis.setex(
    `user:${userId}`,
    3600,
    JSON.stringify(user)
  );

  return user;
}
```

**Pros:** Cache always consistent
**Cons:** Write latency includes cache update

### Write-Behind (Async)

```typescript
async updateUser(userId: string, data: Partial<User>) {
  // 1. Update cache immediately
  const user = { ...currentUser, ...data };
  await redis.setex(`user:${userId}`, 3600, JSON.stringify(user));

  // 2. Queue database update
  await messageQueue.publish('user:update', { userId, data });

  return user;
}

// Worker processes queue
async processUserUpdate({ userId, data }) {
  await db.users.update(userId, data);
}
```

**Pros:** Fast writes
**Cons:** Eventual consistency, complexity

### Cache Invalidation

```typescript
// Event-driven invalidation
userService.on('userUpdated', async ({ userId }) => {
  await redis.del(`user:${userId}`);
});

// TTL-based (simple but may serve stale)
await redis.setex(key, 3600, value);

// Version-based
await redis.set(`user:${userId}:v2`, value);
```

---

## Pub/Sub for Real-time

### Basic Pattern

```typescript
// Publisher
await redis.publish('presence:updates', JSON.stringify({
  userId: '123',
  status: 'online',
}));

// Subscriber (separate connection!)
const subscriber = redis.duplicate();
await subscriber.subscribe('presence:updates');

subscriber.on('message', (channel, message) => {
  const event = JSON.parse(message);
  console.log(`User ${event.userId} is ${event.status}`);
});
```

### Why Separate Connection?

```typescript
// WRONG: Same connection
const redis = new Redis();
redis.subscribe('channel');  // Now in subscribe mode
redis.get('key');           // ERROR: Can't run commands

// RIGHT: Separate connections
const redis = new Redis();      // For commands
const subscriber = redis.duplicate();  // For Pub/Sub
```

### Pattern: User-Specific Channels

```typescript
// Publish to specific user
await redis.publish(`friend:events:${userId}`, event);

// Subscribe to your own events
await subscriber.subscribe(`friend:events:${myUserId}`);
```

### Scaling Pub/Sub

```
┌─────────────┐
│   Redis     │
│   Pub/Sub   │
└──────┬──────┘
       │ Broadcast to all subscribers
       ├─────────────────┬─────────────────┐
       ▼                 ▼                 ▼
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  Server 1   │   │  Server 2   │   │  Server 3   │
│  (10K conn) │   │  (10K conn) │   │  (10K conn) │
└─────────────┘   └─────────────┘   └─────────────┘
       │                 │                 │
       ▼                 ▼                 ▼
   Filter to         Filter to         Filter to
   relevant          relevant          relevant
   clients           clients           clients
```

---

## Transactions & Atomicity

### Pipeline (Batching)

```typescript
// Without pipeline: 3 round trips
await redis.sadd(key1, value);
await redis.sadd(key2, value);
await redis.sadd(key3, value);

// With pipeline: 1 round trip
const pipeline = redis.pipeline();
pipeline.sadd(key1, value);
pipeline.sadd(key2, value);
pipeline.sadd(key3, value);
await pipeline.exec();
```

### MULTI/EXEC (Atomic)

```typescript
// All commands execute atomically
const multi = redis.multi();
multi.sadd('user:123:friends', '456');
multi.sadd('user:456:friends', '123');
const results = await multi.exec();

// If any command fails, all fail
```

### Watch (Optimistic Locking)

```typescript
// Watch key for changes
await redis.watch('user:123:friends');

// Read current value
const friendCount = await redis.scard('user:123:friends');

// Check condition
if (friendCount >= 2000) {
  await redis.unwatch();
  throw new Error('Friend limit reached');
}

// Execute if key unchanged
const multi = redis.multi();
multi.sadd('user:123:friends', '456');
const results = await multi.exec();

if (results === null) {
  // Another client modified the key - retry
}
```

---

## TTL & Expiration

### Setting TTL

```redis
# On creation
SETEX key 3600 value        # Expires in 1 hour
SET key value EX 3600       # Same thing

# On existing key
EXPIRE key 3600             # Expires in 1 hour
EXPIREAT key 1699900000     # Expires at timestamp

# Check TTL
TTL key                     # Seconds remaining
PTTL key                    # Milliseconds remaining
```

### Heartbeat Pattern

```typescript
// Client sends heartbeat every 60 seconds
async heartbeat(userId: string) {
  const presenceKey = `presence:${userId}`;
  const presence = await redis.get(presenceKey);

  if (presence) {
    // Refresh TTL
    await redis.expire(presenceKey, 300);  // 5 minutes
  }
}

// If no heartbeat for 5 minutes:
// - Key expires automatically
// - User appears offline
```

### Lazy Expiration vs Active Expiration

Redis uses both:
1. **Lazy**: Key expires when accessed
2. **Active**: Periodic sampling and deletion

```
// Key with TTL of 0 is not guaranteed deleted immediately
// Access triggers deletion
GET expired_key  // Returns nil, key deleted

// Active expiration runs periodically
// Samples random keys, deletes expired ones
```

---

## Scaling Redis

### Read Replicas

```
┌─────────────┐
│   Primary   │ ◄─── All writes
└──────┬──────┘
       │ Replication
       ├─────────────────┐
       ▼                 ▼
┌─────────────┐   ┌─────────────┐
│  Replica 1  │   │  Replica 2  │ ◄─── Reads distributed
└─────────────┘   └─────────────┘
```

### Redis Cluster (Sharding)

```
┌─────────────────────────────────────────────────┐
│                REDIS CLUSTER                     │
│                                                 │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐   │
│  │  Shard 1  │  │  Shard 2  │  │  Shard 3  │   │
│  │ Slots 0-  │  │ Slots     │  │ Slots -   │   │
│  │   5460    │  │ 5461-10922│  │   16383   │   │
│  └───────────┘  └───────────┘  └───────────┘   │
│                                                 │
│  Keys are hashed to slots: HASH(key) mod 16384 │
└─────────────────────────────────────────────────┘
```

### Hash Tags for Co-location

```redis
# These keys hash to same slot (same shard)
user:{123}:profile
user:{123}:friends
user:{123}:requests

# Hash tag is {123}
# Enables multi-key operations on same shard
```

---

## Interview Questions

### 1. "Why use Redis for sessions?"

**Answer Points:**
- Sub-millisecond reads for every request
- TTL for automatic expiration
- Atomic operations for safe updates
- Easy horizontal scaling with Cluster
- Compared to DB: 100x faster reads

### 2. "How does Pub/Sub scale?"

**Answer Points:**
- One publish reaches all subscribers instantly
- No message persistence (fire-and-forget)
- For reliability, use Redis Streams instead
- Each server subscribes, filters locally
- Linear scaling with server count

### 3. "Explain Redis data structure choice for friends"

**Answer Points:**
- **Set** for friend list: O(1) add/remove/check
- **Sorted Set** for requests: ordered by time
- **Hash** for request details: multiple fields
- Bidirectional storage for fast queries
- SINTER for mutual friends

### 4. "How do you handle cache invalidation?"

**Answer Points:**
- Event-driven: Delete on update
- TTL-based: Eventual consistency
- Version-based: Include version in key
- Trade-offs: Consistency vs complexity
- Monitor hit rate and adjust

### 5. "What's the difference between MULTI and Pipeline?"

**Answer Points:**
- **Pipeline**: Batches commands, reduces round trips
- **MULTI**: Atomic execution, all-or-nothing
- Pipeline can fail partially
- MULTI with WATCH for optimistic locking
- Use pipeline for performance, MULTI for atomicity
