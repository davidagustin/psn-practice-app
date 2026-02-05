# Production Scaling - PlayStation Network Backend Interview Guide

**Target Audience:** Backend engineers preparing for senior-level interviews
**Document Version:** 1.0
**Last Updated:** February 2026

## Table of Contents

1. [Scaling Philosophy](#scaling-philosophy)
2. [Redis Cluster Architecture](#redis-cluster-architecture)
3. [Kafka for Event Streaming](#kafka-for-event-streaming)
4. [Caching Strategies](#caching-strategies)
5. [Database Scaling](#database-scaling)
6. [Distributed Locking](#distributed-locking)
7. [Interview Questions & Answers](#interview-questions--answers)
8. [Common Pitfalls](#common-pitfalls)

---

## Scaling Philosophy

Before diving into specific technologies, understand the core principles that guide scaling decisions.

### Vertical vs Horizontal Scaling

#### Vertical Scaling (Scale Up)

```
Single Server
├─ 1 CPU    → 32 CPUs
├─ 16 GB    → 512 GB RAM
└─ 1 TB SSD → 10 TB SSD
```

**Pros:**
- Simple: Drop in the upgrade
- No code changes needed
- Easier to debug (single machine)

**Cons:**
- Limited by hardware (Moore's Law ends)
- Single point of failure (one machine down = all users down)
- Expensive at scale ($100K+ per upgrade)
- Can't handle sudden spikes

**When to use:** Early stage, single-market deployments

#### Horizontal Scaling (Scale Out)

```
Multiple Servers
├─ Server 1 (10K users)
├─ Server 2 (10K users)
├─ Server 3 (10K users)
└─ Server N (10K users)
= 10K × N users
```

**Pros:**
- Unlimited capacity (add servers)
- Automatic redundancy (one server down → others handle traffic)
- Cost-efficient at scale ($100 buys capacity for 100 users)
- Handles traffic spikes (add servers on demand)

**Cons:**
- Code must be stateless
- Coordination complexity (distributed systems)
- Harder debugging (events across servers)

**When to use:** Production, 100K+ users, global deployments

**PSN Architecture:** Horizontal scaling with 3-tier caching

### Stateless Service Design

The key to horizontal scaling: **servers must not store state locally**.

#### Bad: Stateful Servers

```typescript
// ANTI-PATTERN: Server stores session in memory
const activeSessions = new Map<string, Session>();

class SessionService {
  createSession(userId: string): string {
    const sessionId = uuid();
    activeSessions.set(sessionId, {
      userId,
      createdAt: Date.now(),
      data: {}
    });
    return sessionId;
  }
}

// Problem: If Server 1 crashes, all sessions in activeSessions are lost!
// Problem: If load balancer routes to Server 2, session doesn't exist there!
```

This works for 1-2 servers. At 100+ servers, any server crash loses millions of sessions.

#### Good: Stateless Servers

```typescript
// PATTERN: Server stores session in Redis (shared)
class SessionService {
  constructor(private redis: Redis) {}

  async createSession(userId: string): Promise<string> {
    const sessionId = uuid();
    await this.redis.setex(
      `session:${sessionId}`,
      7 * 24 * 60 * 60, // 7 days
      JSON.stringify({
        userId,
        createdAt: Date.now(),
        data: {}
      })
    );
    return sessionId;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const data = await this.redis.get(`session:${sessionId}`);
    return data ? JSON.parse(data) : null;
  }
}

// Benefit: Any server can handle any session!
// Load balancer routes randomly: Server 1 → Server 2 → Server 3 → Server 1
// Session follows across all servers seamlessly
```

**Interview Answer:**
> "Stateless design means any server can handle any request. User session data lives in Redis, not server memory. If Server 1 crashes, load balancer automatically routes that user to Server 2, which fetches the session from Redis. Zero downtime."

#### Trade-offs

| Aspect | Stateless | Stateful |
|--------|-----------|----------|
| Failover | Instant | Manual |
| Data Consistency | Guaranteed (Redis atomic) | Race conditions possible |
| Scaling | Add servers anytime | Need session replication |
| Debugging | Harder (distributed) | Easier (one machine) |
| Speed | Network latency to Redis | Memory latency (fast) |
| Complexity | More infrastructure | Simpler code |

**PSN Approach:** Accept network latency (2-5ms to Redis) in exchange for unlimited scale.

### Connection Pooling

With hundreds of servers, each opening direct connections becomes a bottleneck.

#### Without Connection Pooling (Bad)

```
Server 1 opens connection → Redis = 1 connection
Server 2 opens connection → Redis = 2 connections
Server 100 opens connection → Redis = 100 connections
...after Server 1000 → Redis = 1000 connections
```

Redis connection limit: ~10K. System falls over at 1000 servers.

#### With Connection Pooling (Good)

```typescript
const redis = new Redis({
  // Limits max concurrent connections
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  enableOfflineQueue: true,

  // Connection timeout
  connectTimeout: 10000,

  // Automatic reconnection
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },

  // Enable pipelining for batch operations
  enableAutoPipelining: true,
  autoPipeliningIgnoredCommands: ['ping'],
});

// Single connection from each server, all commands queued
// Redis processes: connection pooling on server side
// Total connections to Redis: 100 (not 100,000)
```

**How it works:**
1. Server 1 opens 1 persistent connection to Redis
2. Requests queue up: `SET key1 val1`, `GET key2`, `INCR counter`
3. Redis processes requests in order, replies in order
4. Connection stays open for reuse

**Benefits:**
- 100 servers → 100 connections to Redis (not millions)
- Requests naturally batch together (pipelining)
- Automatic reconnection on network failure
- Memory efficient

**Interview Tip:**
> "Connection pooling is critical at scale. Each server maintains one persistent connection to Redis. Requests queue automatically. This allows 1000s of servers to share a Redis cluster without overwhelming it."

---

## Redis Cluster Architecture

Single Redis instance bottleneck at ~1M ops/sec. PostgreSQL Network handles billions of operations. Solution: Redis Cluster.

### Hash Slots Explained

Redis Cluster divides data into **16,384 hash slots**. Each slot assigned to a node.

#### Slot Assignment

```
Total Slots: 16384

3-Node Cluster:
┌─────────────────────────────────────────────────┐
│ Master 1: Slots 0 - 5460 (5461 slots)           │
│   └─ Replica 1 (for failover)                   │
├─────────────────────────────────────────────────┤
│ Master 2: Slots 5461 - 10921 (5461 slots)       │
│   └─ Replica 2 (for failover)                   │
├─────────────────────────────────────────────────┤
│ Master 3: Slots 10922 - 16383 (5462 slots)      │
│   └─ Replica 3 (for failover)                   │
└─────────────────────────────────────────────────┘

Each node handles ~5461 slots = ~33% of data
```

#### Key → Slot Mapping

```typescript
// Redis uses CRC16 hash
slot = CRC16(key) mod 16384

Example:
- Key "user:123:profile" → CRC16 = 12345 → Slot: 12345 % 16384 = 12345
- Key "user:124:profile" → CRC16 = 12346 → Slot: 12346 % 16384 = 12346
- Key "user:125:profile" → CRC16 = 12347 → Slot: 12347 % 16384 = 12347

Each key routes to different master automatically!
```

#### Implementation

From `redis-cluster/index.ts`:

```typescript
const defaultConfig: RedisClusterConfig = {
  nodes: [
    { host: 'redis-node-1', port: 6379 },  // Master 1 + Replicas
    { host: 'redis-node-2', port: 6379 },  // Master 2 + Replicas
    { host: 'redis-node-3', port: 6379 },  // Master 3 + Replicas
  ],
  readFromReplicas: true,        // Read scaling
  maxRetries: 3,
  retryDelayMs: 100,
  connectTimeoutMs: 5000,
  slotsRefreshTimeoutMs: 1000,
};

// ioredis library handles slot mapping automatically
const cluster = new Cluster(nodes, {
  scaleReads: 'slave',  // Read from replicas
  slotsRefreshTimeout: 1000,
  clusterRetryStrategy: (times) => {
    return times > 3 ? null : Math.min(times * 100, 2000);
  }
});

// Just use cluster like single Redis - it routes automatically!
await cluster.set('user:123:profile', profileData);
await cluster.get('user:123:profile');
```

**Interview Tip:**
> "With 16,384 slots and 3 masters, each node handles ~5,461 slots. ioredis automatically routes `SET user:123` to the correct master based on slot. Adds ~1-2ms latency for lookup, but enables unlimited scale."

### Key Co-location with Hash Tags

Problem: Some operations need related keys on **same node**.

```typescript
// Without hash tags: keys scatter across cluster
user:123:profile   → Node 1
user:123:settings  → Node 2
user:123:friends   → Node 3

// Problem: Can't do MGET user:123:profile user:123:settings (different slots)
// Error: "CROSSSLOT Keys in request don't hash to the same slot"
```

#### Solution: Hash Tags

Keys with **{tag}** pattern hash to same slot:

```typescript
// WITH HASH TAGS: all keys on same node!
user:{123}:profile   → Slot 12345 → Node 1
user:{123}:settings  → Slot 12345 → Node 1  (same!)
user:{123}:friends   → Slot 12345 → Node 1  (same!)

// Now MGET works!
const [profile, settings, friends] = await cluster.mget(
  'user:{123}:profile',
  'user:{123}:settings',
  'user:{123}:friends'
);

// Atomic batch operations
const pipe = cluster.pipeline();
pipe.get('user:{123}:profile');
pipe.hgetall('user:{123}:settings');
pipe.smembers('user:{123}:friends');
await pipe.exec();
```

From the code (`redis-cluster/index.ts`):

```typescript
export const HashTags = {
  user(userId: string, suffix: string): string {
    return `user:{${userId}}:${suffix}`;
  },

  game(gameId: string, suffix: string): string {
    return `game:{${gameId}}:${suffix}`;
  },

  room(roomId: string, suffix: string): string {
    return `room:{${roomId}}:${suffix}`;
  },
};

// Usage:
await cluster.hset(
  HashTags.user(userId, 'sessions'),
  sessionId,
  sessionData
);

// All user's data on one node → Fast, atomic operations
```

**When to use hash tags:**
- ✓ Related data that's accessed together
- ✓ Operations requiring atomic batch updates
- ✗ Don't force unrelated keys together (causes hotspots)

**Interview Answer:**
> "Hash tags ensure related keys hash to the same slot. For example, `user:{123}:profile`, `user:{123}:friends`, and `user:{123}:sessions` all go to the same master. This enables atomic multi-key operations while preserving cluster distribution."

### Failover Handling

Replicas provide automatic failover:

```
┌──────────────────────────────────────────────┐
│          Normal Operation                    │
│                                              │
│  Server A → Query → Master 1 (Slot 0-5460)  │
│                                              │
│  Server B → Query → Replica 1               │
│             (reads only)                     │
└──────────────────────────────────────────────┘
                      ↓
        Master 1 crashes (network partition)
                      ↓
┌──────────────────────────────────────────────┐
│       Automatic Failover (< 1 second)        │
│                                              │
│  Master 1 Down → Cluster detects             │
│                                              │
│  Replica 1 Promoted → New Master 1           │
│                                              │
│  Server A → Query → New Master 1 (Replica) │
│             (writes resume)                  │
└──────────────────────────────────────────────┘
```

#### Failover Details

From code comments:

```typescript
async connect(): Promise<Cluster> {
  // Connection failure
  this.cluster.on('error', (err) => {
    console.error('[RedisCluster] Error:', err.message);
    this.emitEvent('error', undefined, err.message);
  });

  // Node detection
  this.cluster.on('+node', (node) => {
    console.log(`[RedisCluster] Node added: ${node.options?.host}`);
    // Replica promoted to master? New node joined?
    this.emitEvent('node_connected', nodeAddress);
  });

  // Node failure
  this.cluster.on('-node', (node) => {
    console.log(`[RedisCluster] Node removed: ${node.options?.host}`);
    // Master down? Replica failed?
    this.emitEvent('node_disconnected', nodeAddress);
  });

  // Wait for cluster ready
  await new Promise<void>((resolve) => {
    this.cluster!.once('ready', () => {
      console.log('[RedisCluster] Ready');
      resolve();
    });
  });
}
```

**Failover Timeline:**
1. **0-100ms:** Network detects master is down (TCP timeout)
2. **100-300ms:** Cluster elects new master from replicas
3. **300-500ms:** Replica promoted, starts accepting writes
4. **500-1000ms:** Servers reconnect, resume operations

**User Impact:**
- Millisecond interruption (invisible to client)
- Some in-flight requests may timeout (retry with exponential backoff)
- No data loss (replica has all data)

**Interview Tip:**
> "With 3 masters + 3 replicas, losing one master causes automatic failover within 500ms. The replica gets promoted. Clients retry and reconnect. Total downtime: typically under 1 second. Users barely notice."

---

## Kafka for Event Streaming

Redis Cluster handles synchronous operations (get/set). Kafka handles asynchronous events at massive scale.

### Topics and Partitions

Kafka Topic = Named event stream. Divided into partitions for parallelism.

```
                    Topic: user-events
        ┌───────────────────────────────────────────┐
        │                                           │
    ┌───▼────────┐  ┌──────────────┐  ┌──────────┐│
    │ Partition 0│  │ Partition 1  │  │ Partition 2
    │ (Users A-H)│  │ (Users I-P)  │  │ (Users Q-Z)
    │            │  │              │  │          │
    │ O1 O2 O3..│  │ O1 O2 O3...  │  │ O1 O2... │
    └────────────┘  └──────────────┘  └──────────┘
        │                │                │
        ▼                ▼                ▼
    Consumer 1       Consumer 2      Consumer 3
    (Partition 0)    (Partition 1)   (Partition 2)
```

From `kafka/index.ts`:

```typescript
const TOPICS = {
  USER_EVENTS: 'psn.user.events',
  GAME_EVENTS: 'psn.game.events',
  SOCIAL_EVENTS: 'psn.social.events',
  ACTIVITY_EVENTS: 'psn.activity.events',
  VOICE_EVENTS: 'psn.voice.events',
  NOTIFICATIONS: 'psn.notifications',
  DLQ: 'psn.dlq',  // Dead letter queue for failures
};
```

#### Offset: Position in Partition

```
Partition 0 of topic: game-events

Offsets:
0: { userId: "u1", event: "game_started", game: "SpiderMan" }
1: { userId: "u1", event: "achievement_unlocked", trophy: "Platinum" }
2: { userId: "u2", event: "game_started", game: "Elden Ring" }
3: { userId: "u1", event: "game_ended", duration: 120 }
4: { userId: "u2", event: "game_ended", duration: 45 }
5: ...

Consumer Group: gaming-stats
├─ Consumer 1: Processing offset 0, 1, 3 from user u1 (in order)
├─ Consumer 2: Processing offset 2, 4 from user u2 (in order)
└─ Consumer 3: Idle (waiting for partition assignment)

Each consumer processes its partition sequentially
Order guaranteed within partition
```

#### Partition Key Strategy for Ordering

Problem: Events for same user must process in order.

```typescript
// WRONG: Random key (loses ordering)
await producer.send({
  topic: 'game-events',
  messages: [
    {
      key: `${Date.now()}`,  // Random = different partitions
      value: JSON.stringify({
        userId: 'user123',
        event: 'game_started'
      })
    },
    {
      key: `${Date.now() + 1}`,  // Different partition!
      value: JSON.stringify({
        userId: 'user123',
        event: 'game_ended'  // Event 2 might process before Event 1!
      })
    }
  ]
});

// Problem: Events for user123 split across partitions
// Consumer 2 processes game_ended first, user123 still in game!
```

#### Correct: Consistent Partition Key

```typescript
// CORRECT: Use userId as key (same partition)
async publish(topic: TopicName, event: PSNEvent, key?: string): Promise<void> {
  const message = {
    key: key || event.eventId,  // Could be userId
    value: JSON.stringify(event),
    headers: {
      'event-type': event.type,
      'correlation-id': event.correlationId || '',
      'source': event.source,
    },
  };

  await producer.send({ topic, messages: [message] });
}

// Usage:
const event: GameStartedEvent = {
  eventId: uuid(),
  type: 'game.started',
  timestamp: new Date().toISOString(),
  source: 'game-service',
  version: '1.0',
  payload: {
    userId: 'user123',
    gameId: 'game456',
    sessionId: 'session789'
  }
};

// Use userId as partition key → same partition for all user's events
await eventBus.publish(TOPICS.GAME_EVENTS, event, 'user123');

// Now:
// game_started (offset 10) → Partition 0
// achievement_unlocked (offset 11) → Partition 0  (same partition!)
// game_ended (offset 12) → Partition 0  (same partition!)
// All in order, processed by Consumer 1
```

**Partition Key Strategies:**

| Key | Ordering | Use Case |
|-----|----------|----------|
| `userId` | Per-user ordering | User sessions, presence, activity |
| `gameId` | Per-game ordering | Game events, player turns |
| `conversationId` | Per-conversation ordering | Chat messages |
| Random/UUID | No ordering | Independent events |

**Interview Tip:**
> "Use consistent partition keys to guarantee ordering. For user events, key by userId. This ensures all user-related events process sequentially by the same consumer. If you use random keys, events scatter across partitions and ordering is lost."

### Consumer Groups

Multiple consumers in a group share partitions:

```
Topic: user-events (3 partitions)

Consumer Group: activity-service

Consumer 1: Processes Partition 0
Consumer 2: Processes Partition 1
Consumer 3: Processes Partition 2

Each partition assigned to exactly ONE consumer
No message duplication
Automatic rebalancing when consumer joins/leaves
```

From `kafka/index.ts`:

```typescript
export class EventConsumer extends EventEmitter {
  async subscribe(topics: TopicName[]): Promise<void> {
    await this.consumer.connect();

    for (const topic of topics) {
      // Subscribe to topic
      // Cluster automatically assigns partitions
      // Each partition → one consumer in group
      await this.consumer.subscribe({ topic, fromBeginning: true });
    }
  }

  async start(): Promise<void> {
    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;

        // This consumer only processes messages from ITS assigned partition
        // Other consumers process other partitions in parallel
        // No duplication, no coordination needed

        const event: PSNEvent = JSON.parse(message.value!.toString());
        const handler = this.handlers.get(event.type);
        await handler(event, {
          topic,
          partition,
          offset: message.offset,
        });
      },
    });
  }
}

// Usage:
const eventBus = new EventBus(kafkaConfig, 'activity-service');
eventBus.handle('game.started', async (event) => {
  // Process game start
  // This handler called for every game.started event
  // Processed in order (if keyed by userId/gameId)
  // Multiple instances process different partitions in parallel
});
```

**Scaling with Consumer Groups:**

```
Scenario: user-events topic has 3 partitions

Time 1: 1 Consumer
┌─────────────────────────────┐
│ Consumer 1                  │
├─────────────────────────────┤
│ Partition 0 (0 → lag)       │
│ Partition 1 (lag: 1000000)  │
│ Partition 2 (lag: 2000000)  │
└─────────────────────────────┘
Single consumer processes all partitions
Lag increases (queue builds up)

Time 2: Add Consumer 2
Rebalancing triggers automatically
┌──────────────────┬──────────────────┐
│ Consumer 1       │ Consumer 2       │
├──────────────────┼──────────────────┤
│ Partition 0 (lag)│ Partition 1 (lag)│
│ Partition 2 (lag)│                  │
└──────────────────┴──────────────────┘
2 consumers → partition assignment changes
Lag reduces by ~50%

Time 3: Add Consumer 3
┌──────────────┬──────────────┬──────────────┐
│ Consumer 1   │ Consumer 2   │ Consumer 3   │
├──────────────┼──────────────┼──────────────┤
│ Partition 0  │ Partition 1  │ Partition 2  │
└──────────────┴──────────────┴──────────────┘
3 consumers → each handles one partition
Lag reduced to near-zero
```

**Interview Tip:**
> "Consumer groups scale horizontally. Add more consumers, Kafka rebalances automatically. Each partition assigned to exactly one consumer, preventing duplication. Perfect for processing billions of events."

---

## Caching Strategies

### Cache-Aside Pattern (Lazy Loading)

Most common pattern in PSN: **check cache first, fetch from DB on miss**.

```
User Request:
    │
    ├─ Check Redis cache
    │  ├─ HIT → Return immediately
    │  └─ MISS → Fetch from DynamoDB, store in Redis, return
    │
    ▼
User gets data (from cache or DB)
```

Implementation (from `redis-cluster/index.ts`):

```typescript
export class CacheAside<T> {
  private cluster: Cluster;
  private prefix: string;
  private ttlSeconds: number;
  private fetchFn: (key: string) => Promise<T | null>;

  constructor(
    cluster: Cluster,
    prefix: string,
    ttlSeconds: number,
    fetchFn: (key: string) => Promise<T | null>
  ) {
    this.cluster = cluster;
    this.prefix = prefix;
    this.ttlSeconds = ttlSeconds;
    this.fetchFn = fetchFn;
  }

  async get(key: string): Promise<T | null> {
    const cacheKey = `${this.prefix}:${key}`;

    // Step 1: Try cache
    const cached = await this.cluster.get(cacheKey);
    if (cached) {
      console.log(`[Cache] HIT: ${cacheKey}`);
      return JSON.parse(cached);
    }

    console.log(`[Cache] MISS: ${cacheKey}`);

    // Step 2: Fetch from DB
    const value = await this.fetchFn(key);
    if (value === null) {
      return null;
    }

    // Step 3: Store in cache for next time
    await this.cluster.set(cacheKey, JSON.stringify(value), 'EX', this.ttlSeconds);

    return value;
  }

  async invalidate(key: string): Promise<void> {
    await this.cluster.del(`${this.prefix}:${key}`);
    console.log(`[Cache] INVALIDATED: ${this.prefix}:${key}`);
  }
}
```

#### Cache-Aside Characteristics

| Aspect | Details |
|--------|---------|
| **Hit Latency** | ~5ms (Redis) |
| **Miss Latency** | ~100ms (DB call) |
| **First User** | Slow (cache miss) |
| **Subsequent Users** | Fast (cache hit) |
| **Memory** | Only caches used data |
| **Staleness** | Up to TTL |
| **Complexity** | Simple to implement |

**Interview Answer:**
> "Cache-aside checks Redis first. On cache miss, fetch from database and populate cache for future requests. Simple, memory-efficient, but first request is slow. Good for read-heavy workloads."

### Write-Through vs Write-Behind

Two strategies for keeping cache fresh after writes.

#### Write-Through (Consistent)

```
Write Request:
    │
    ├─ Update Database
    │  (consistency point)
    │
    ├─ Update Cache (if write succeeded)
    │
    ▼
Response: "Write complete"
```

```typescript
async updateUserProfile(userId: string, changes: any) {
  // Step 1: Update database (source of truth)
  await dynamodb.update('users', userId, changes);

  // Step 2: Update cache
  const updated = await dynamodb.get('users', userId);
  await redis.set(`user:${userId}`, JSON.stringify(updated), 'EX', 3600);

  // Return only after both succeed
  return updated;
}
```

**Characteristics:**

| Aspect | Details |
|--------|---------|
| **Write Latency** | ~100ms (waits for DB + Redis) |
| **Consistency** | Strong (cache always matches DB) |
| **Risk** | DB write succeeds, cache fails → inconsistency |
| **Complexity** | Moderate |
| **Data Loss** | DB is source of truth |

#### Write-Behind (Fast but Risky)

```
Write Request:
    │
    ├─ Update Cache immediately
    │  (client sees instant response)
    │
    ├─ Queue DB update (async)
    │  (happens later)
    │
    ▼
Response: "Write complete" (cache updated)
```

```typescript
async updateUserProfile(userId: string, changes: any) {
  // Step 1: Update cache immediately (user sees instant response)
  const updated = { ...cached, ...changes };
  await redis.set(`user:${userId}`, JSON.stringify(updated), 'EX', 3600);

  // Step 2: Queue DB update (happens in background)
  eventBus.publish('user-updates', {
    userId,
    changes
  });

  // Return immediately (client thinks it's done)
  return updated;
}

// Async handler (might fail!)
eventBus.handle('user-updates', async (event) => {
  try {
    await dynamodb.update('users', event.userId, event.changes);
  } catch (error) {
    // DB update failed! Cache already updated!
    // Data inconsistency risk
    logger.error('Failed to persist update', error);
  }
});
```

**Characteristics:**

| Aspect | Details |
|--------|---------|
| **Write Latency** | ~5ms (cache only) |
| **Consistency** | Eventual (DB lags) |
| **Risk** | DB update fails, cache outdated |
| **Complexity** | High |
| **Data Loss** | If Redis crashes before DB update |

#### Comparison

| Scenario | Write-Through | Write-Behind |
|----------|---------------|--------------|
| Database failure | Client gets error (safe) | Client thinks update succeeded (risky) |
| Cache failure | Inconsistency (detectable) | Inconsistency (undetectable) |
| User perception | Slower (100ms) | Faster (5ms) |
| Consistency | Strong | Eventual |
| Production ready | Yes | No (unless Kafka) |

**PSN Approach:** Hybrid

```typescript
// Best of both: Write-Through for important data
async acceptFriendRequest(userId: string, requesterId: string) {
  // Step 1: Update database (atomic transaction)
  const friendship = await dynamodb.createFriendship(userId, requesterId);

  // Step 2: Update cache immediately
  await redis.sadd(`user:${userId}:friends`, requesterId);
  await redis.sadd(`user:${requesterId}:friends`, userId);

  // Step 3: Publish event (fire-and-forget)
  // Other services listen and update their caches
  eventBus.publish('friendship-created', { userId, requesterId });

  return friendship;
}
```

**Interview Tip:**
> "Write-through ensures consistency: update DB first, then cache. Slower but safe. Write-behind is fast but risky (cache updated, DB update fails). PSN uses write-through for critical data, with async event publishing for side effects."

### TTL Strategies

TTL (Time-To-Live) controls cache freshness.

#### Short TTL (5 minutes)

```
Fresh data guaranteed every 5 minutes
│
├─ T=0: User fetches profile (MISS) → DB
├─ T=1s: Second user fetches (HIT) → Cache
├─ T=4m: Data is 4 minutes stale (acceptable)
├─ T=5m: TTL expires, cache deleted
└─ T=5m+1s: New user fetches (MISS) → DB (fresh data)
```

**Use when:** Data changes frequently, or staleness unacceptable
**Example:** User presence, active game

#### Long TTL (24 hours)

```
User profile very stable
│
├─ T=0: Fetch profile (MISS) → DB
├─ T=1s: (HIT) → Cache
├─ T=23h: Still fresh
├─ T=24h: TTL expires
└─ T=24h+1s: Fetch (MISS) → DB

Meanwhile: If user updates profile
├─ New request → Update DB
├─ Invalidate cache (DELETE key)
└─ Next request → MISS → DB → Cache (fresh)
```

**Use when:** Data rarely changes, staleness acceptable
**Example:** Game library, user badges, profile info

#### Adaptive TTL

```typescript
// TTL based on data hotness
function calculateTTL(accessCount: number): number {
  // Frequently accessed? Keep longer
  // Rarely accessed? Expire sooner

  if (accessCount > 1000) {
    return 24 * 60 * 60; // 24 hours (hot data)
  } else if (accessCount > 100) {
    return 60 * 60; // 1 hour (warm data)
  } else {
    return 5 * 60; // 5 minutes (cold data)
  }
}

async getUser(userId: string) {
  const key = `user:${userId}`;
  const cached = await redis.get(key);

  if (cached) {
    // Increment access counter
    await redis.incr(`${key}:accesses`);
    return JSON.parse(cached);
  }

  const user = await database.getUser(userId);
  const ttl = calculateTTL(accessCount);
  await redis.setex(key, ttl, JSON.stringify(user));
  return user;
}
```

**Interview Tip:**
> "TTL balances freshness vs cache efficiency. Short TTL (5min) for presence data. Long TTL (24h) for profiles. Invalidate immediately on write. Always have fallback to DB for expired cache."

---

## Database Scaling

### Read Replicas

Single database bottleneck for reads. Solution: replicas.

```
Primary (Write)          Replicas (Read-Only)
     │                  ┌─────────┬──────────┐
     │          Replication
     │          (async)
     ├─────────────────────────┐
     │                         │
     ▼                         ▼
Write: CREATE user    Read: GET user
     │               (routed to replica)
     │
     └─── Replication Lag (typically < 100ms)
```

#### Write-Read Split

```typescript
class UserService {
  constructor(
    private primaryDb: DynamoDB,    // For writes
    private replicaDb: DynamoDB     // For reads (read-only)
  ) {}

  async createUser(userData: User) {
    // MUST write to primary (source of truth)
    return await this.primaryDb.put('users', userData);
  }

  async getUser(userId: string) {
    // Can read from replica (faster, slightly stale)
    return await this.replicaDb.get('users', userId);
  }

  async getUserImmediate(userId: string) {
    // Need fresh data after write? Read from primary
    return await this.primaryDb.get('users', userId);
  }
}
```

#### Replication Lag Handling

```
Time 0: User updates profile on Primary
Time 100ms: Replica still has old data (lag)
```

```typescript
// Problem: User updates profile, immediately refreshes page
async updateAndFetch(userId: string, changes: any) {
  // Write to primary
  await primaryDb.update('users', userId, changes);

  // Read from replica (might be stale!)
  const user = await replicaDb.get('users', userId);
  // Might show old data for 100ms

  // Solution: Read from primary after write
  const freshUser = await primaryDb.get('users', userId);
  return freshUser;
}
```

**Interview Tip:**
> "Read replicas scale read throughput. Write to primary, read from replicas. For data written then immediately read, query the primary to avoid stale reads."

### Sharding Strategies

Database partitioned into shards, each shard owns a range of data.

#### Shard Key Selection

```
Shard by UserId (Good):
┌──────────────────────────────────┐
│ Shard 1: Users 0000-2499         │
│   ├─ user:0001 profile          │
│   ├─ user:0001 games            │
│   ├─ user:0001 trophies         │
│   └─ ...all user:0001 data      │
├──────────────────────────────────┤
│ Shard 2: Users 2500-4999         │
│ ...                              │
└──────────────────────────────────┘

Benefits:
- All user's data on one shard (no joins across shards)
- Single shard handles all user's requests
- Easy to add shards (rehash range)
```

#### Problems with Sharding

```
Shard by GameId (Bad):
┌──────────────────────────────────┐
│ Shard 1: Games A-M               │
│   ├─ SpiderMan2 players         │
│   ├─ God of War players         │
│   └─ ...                         │
└──────────────────────────────────┘

Problem: User's games scattered across shards
Query "user's games" → Hit all shards → Slow
```

**Rules:**
1. ✓ Shard key correlates with access pattern
2. ✓ All related data on same shard
3. ✗ Don't shard by secondary key
4. ✗ Don't create uneven distribution

**PSN Approach:**

```typescript
// Shard by userId (primary access pattern)
function getShardId(userId: string): number {
  const hash = hashFunction(userId);
  return hash % NUMBER_OF_SHARDS;
}

async getUser(userId: string) {
  const shardId = getShardId(userId);
  const shard = shards[shardId];  // Correct shard
  return await shard.get('users', userId);
}

async getUserGames(userId: string) {
  const shardId = getShardId(userId);
  const shard = shards[shardId];  // Same shard
  return await shard.get('user_games', userId);
}

// All user's data accessed from one shard
// No cross-shard coordination needed
```

### Connection Pooling

Database connections are expensive. Pool and reuse.

```typescript
const pool = new Pool({
  host: 'dynamodb.aws.amazon.com',
  max: 10,              // Max 10 concurrent connections
  idleTimeoutMillis: 30000,  // Close after 30s idle
  connectionTimeoutMillis: 2000,
});

// Connection 1: Processing user A
pool.query('SELECT * FROM users WHERE id = A')
  .then(result => {
    // After query, connection returned to pool
    // Available for next user
  });

// Connection 2: Processing user B (if available)
pool.query('SELECT * FROM users WHERE id = B')

// Connection reused across many requests
// 1000 requests over time, 10 concurrent connections
// Not 1000 connections!
```

**Benefits:**
- **Memory savings:** 10 connections vs 1000
- **Faster requests:** Reuse = no connection overhead
- **Database stability:** DB not overwhelmed by connection attempts

**Interview Tip:**
> "Connection pooling is critical. Each server maintains 10-20 persistent connections to database. Requests queue and reuse connections. This scales to 1000s of servers without overwhelming the database."

---

## Distributed Locking

Prevent simultaneous access to shared resources.

### Use Cases

```
User A sends friend request to User B
User B accepts friend request

Without lock:
├─ Both happen simultaneously
├─ A: reads "not friends" → creates friendship
├─ B: reads "not friends" → creates friendship
└─ Result: Duplicate friendship created! Bug!

With lock:
├─ B acquires lock on "friendship:A:B"
├─ A: tries to acquire → waits
├─ B: completes operation, releases lock
├─ A: acquires lock, retries → sees existing friendship
└─ Result: Single friendship created ✓
```

### Redlock Algorithm

From `redis-cluster/index.ts`:

```typescript
export class DistributedLock {
  private cluster: Cluster;
  private lockPrefix: string;
  private defaultTTLMs: number;

  constructor(cluster: Cluster, prefix = 'lock', defaultTTLMs = 30000) {
    this.cluster = cluster;
    this.lockPrefix = prefix;
    this.defaultTTLMs = defaultTTLMs;
  }

  async acquire(
    resource: string,
    ttlMs: number = this.defaultTTLMs
  ): Promise<{ acquired: boolean; lockId: string }> {
    const lockKey = `${this.lockPrefix}:${resource}`;
    const lockId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Atomic: SET only if not exists (NX), with TTL (PX)
    const result = await this.cluster.set(
      lockKey,
      lockId,           // Value: unique ID (for release validation)
      'PX',             // Expire in milliseconds
      ttlMs,
      'NX'              // Only if key doesn't exist
    );

    if (result === 'OK') {
      console.log(`[Lock] Acquired: ${resource}`);
      return { acquired: true, lockId };
    }

    console.log(`[Lock] Failed to acquire: ${resource}`);
    return { acquired: false, lockId: '' };
  }

  async release(resource: string, lockId: string): Promise<boolean> {
    const lockKey = `${this.lockPrefix}:${resource}`;

    // Lua script for atomic check-and-delete
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await this.cluster.eval(script, 1, lockKey, lockId);

    if (result === 1) {
      console.log(`[Lock] Released: ${resource}`);
      return true;
    }

    console.log(`[Lock] Release failed (not owner): ${resource}`);
    return false;
  }

  async withLock<T>(
    resource: string,
    fn: () => Promise<T>,
    ttlMs?: number
  ): Promise<T | null> {
    const { acquired, lockId } = await this.acquire(resource, ttlMs);

    if (!acquired) {
      return null;  // Couldn't acquire lock
    }

    try {
      return await fn();  // Exclusive access
    } finally {
      await this.release(resource, lockId);
    }
  }
}
```

#### Lock Flow

```
┌─────────────────────────────────────────────┐
│ Acquire: SET lock:resource=${lockId} PX 30s NX
│                                             │
│ Success: SET returns "OK" → Lock acquired   │
│ Failure: SET returns null → Lock exists     │
└─────────────────────────────────────────────┘
         ▼
   Do critical work
         │
┌─────────────────────────────────────────────┐
│ Release: Lua script verifies lockId matches │
│ Only owner of lock can release it           │
│ Prevents releasing someone else's lock     │
└─────────────────────────────────────────────┘
         ▼
   Lock deleted, next process acquires
```

#### Lock Expiration & Renewal

```
Problem: What if process crashes while holding lock?

Without TTL:
├─ Process acquires lock
├─ Process crashes (segmentation fault)
├─ Lock held forever
└─ Other processes wait forever (deadlock)

With TTL:
├─ Process acquires lock: TTL = 30 seconds
├─ Process crashes at T=10
├─ T=30: TTL expires, lock released
├─ Other processes acquire lock at T=31
└─ System recovers (eventual)
```

Lock renewal for long-running operations:

```typescript
async longOperation(resourceId: string) {
  const lock = new DistributedLock(redis);
  const { acquired, lockId } = await lock.acquire(resourceId, 30000);

  if (!acquired) {
    throw new Error('Could not acquire lock');
  }

  // Start renewal timer (renew lock every 10s)
  const renewalInterval = setInterval(async () => {
    // Delete old lock, acquire new one
    await lock.release(resourceId, lockId);
    const { acquired: renewed } = await lock.acquire(resourceId, 30000);

    if (!renewed) {
      // Lost lock! Stop operation
      clearInterval(renewalInterval);
      throw new Error('Lost lock during operation');
    }
  }, 10000);

  try {
    // Long operation (takes 2 minutes)
    await processData();
  } finally {
    clearInterval(renewalInterval);
    await lock.release(resourceId, lockId);
  }
}
```

**Interview Tip:**
> "Use Redis locks for critical sections. SET NX ensures atomicity. Unique lockId prevents releasing someone else's lock. TTL handles crashes (eventual recovery). For long operations, renew the lock periodically."

---

## Interview Questions & Answers

### Question 1: "How do you scale Redis beyond 1M operations per second?"

**Answer Structure:**

Redis Cluster distributes data across multiple masters:

```
Single Redis:
├─ ~1M ops/sec max
└─ Bottleneck: single machine

Redis Cluster (3 masters):
├─ 3M ops/sec (1M per master)
├─ Data sharded by hash slots
├─ Each master handles ~5461 slots
└─ Add more masters → more capacity
```

**Implementation:**

```typescript
const cluster = new Cluster([
  { host: 'node1', port: 6379 },
  { host: 'node2', port: 6379 },
  { host: 'node3', port: 6379 },
], {
  scaleReads: 'slave',  // Read from replicas too
  // ioredis routes based on hash slot automatically
});

await cluster.set('user:{123}:profile', data);
// Automatically goes to master owning slot for "user:{123}:profile"
```

**Replicas for read scaling:**
- Replicas can't write, but handle reads
- Read from replicas → 2-3x throughput
- Write still goes to master

**Interview Follow-up:** "What about failures?"
> "Replicas provide automatic failover. If a master goes down, its replica gets promoted within 500ms. Minimal impact to users."

---

### Question 2: "How do you ensure ordering in a distributed system?"

**Answer:**

Ordering requires **consistent routing** and **sequential processing**.

```typescript
// WRONG: Random ordering
await kafka.send({
  topic: 'user-events',
  messages: [
    { key: uuid(), value: 'user_logged_in' },
    { key: uuid(), value: 'game_started' }   // Might process first!
  ]
});

// CORRECT: Consistent key for ordering
await kafka.send({
  topic: 'user-events',
  messages: [
    { key: userId, value: 'user_logged_in' },
    { key: userId, value: 'game_started' }   // Always processes second
  ]
});

// All messages with same key go to same partition
// Partition has single consumer → sequential processing
```

**Ordering Guarantees:**

| Scenario | Guarantee | How |
|----------|-----------|-----|
| Within partition | ✓ Yes | Single consumer processes sequentially |
| Across partitions | ✗ No | Multiple consumers, no ordering |
| Entire topic | ✗ No | Don't rely on this |

**Interview Follow-up:** "What if I need global ordering?"
> "Single partition (but no parallelism). Or use timestamps + deduplication at consumer side. Most apps don't need global ordering—per-user ordering is sufficient."

---

### Question 3: "Design a cache invalidation strategy for user profiles."

**Answer:**

Three-pronged approach:

**1. TTL-Based (Automatic)**
```typescript
// User profile: 24 hour TTL
async getProfile(userId: string) {
  const cached = await redis.get(`profile:${userId}`);
  if (cached) return JSON.parse(cached);

  const profile = await db.getProfile(userId);
  await redis.setex(`profile:${userId}`, 86400, JSON.stringify(profile));
  return profile;
}
```

**2. Event-Based (Immediate)**
```typescript
// When user updates profile
async updateProfile(userId: string, changes: any) {
  await db.updateProfile(userId, changes);

  // Invalidate cache immediately
  await redis.del(`profile:${userId}`);

  // Publish event for other services
  await eventBus.publish('profile-updated', {
    userId,
    changes
  });

  return changes;
}
```

**3. Lazy Invalidation (Backup)**
```typescript
// If event-based fails, next access triggers refresh
async getProfile(userId: string) {
  const version = await db.getProfileVersion(userId);
  const cached = await redis.get(`profile:${userId}`);
  const cachedVersion = cached?.version;

  if (cachedVersion === version) {
    return cached;  // Still fresh
  }

  // Version mismatch → cache stale
  const fresh = await db.getProfile(userId);
  await redis.set(`profile:${userId}`, JSON.stringify(fresh));
  return fresh;
}
```

**Combined Strategy:**
- **On write:** Immediately invalidate (event-based)
- **Normal reads:** 24h TTL
- **If event fails:** Version check catches it
- **Result:** Fresh data, with automatic cleanup

---

### Question 4: "What happens if Redis crashes? How do you recover?"

**Answer:**

```
Single Redis Crash
├─ All presence data lost
├─ All sessions lost
├─ All cache invalidated
└─ Users see outage (30 seconds to restart)

Redis Cluster Crash
├─ One node down
├─ Its replicas take over
├─ Users don't notice
└─ Automatic recovery (< 1 second)
```

**Recovery Strategy:**

```typescript
// 1. Redis Cluster with replicas
const cluster = new Cluster([
  // 3 masters + 3 replicas
  { host: 'master1', port: 6379 },
  { host: 'master2', port: 6379 },
  { host: 'master3', port: 6379 },
]);

// 2. Fallback to database if Redis unavailable
async function getUser(userId: string) {
  try {
    // Try Redis (fast path)
    const cached = await redis.get(`user:${userId}`);
    if (cached) return JSON.parse(cached);
  } catch (error) {
    logger.warn('Redis unavailable, falling back to DB');
  }

  // Fallback to database
  const user = await dynamodb.getUser(userId);

  // Try to cache (might succeed if Redis recovered)
  try {
    await redis.set(`user:${userId}`, JSON.stringify(user), 'EX', 3600);
  } catch {
    // Redis still down, just return DB data
  }

  return user;
}

// 3. Persistent storage as source of truth
// All writes go to DynamoDB first
// Redis is just cache (can be rebuilt)
```

**Interview Follow-up:** "Can you restore from backup?"

> "Redis is stateless cache—not critical data. All persistent data in DynamoDB. If entire Redis cluster crashes, restart from empty. Applications refill cache as users access data. Some performance impact initially, but data is never lost."

---

### Question 5: "How do you handle Kafka consumer lag?"

**Answer:**

Lag = difference between latest offset and processed offset.

```
Partition has offsets: 0, 1, 2, ... 1,000,000
Consumer processed: offset 500,000
Lag = 1,000,000 - 500,000 = 500,000 messages behind
```

**Causes of Lag:**

```
1. Slow Consumer
   └─ Processing takes 1 second per message
   └─ 1,000 messages queued = 1000 seconds lag

2. Consumer Crashes
   └─ No messages processed
   └─ Lag increases linearly

3. Not Enough Consumers
   └─ Topic has 10 partitions
   └─ Only 1 consumer processes
   └─ Other 9 partitions accumulate lag

4. Downstream Service Slow
   └─ Consumer reads from Kafka fast
   └─ But publishes to slow database
   └─ Waiting on database, not reading Kafka
```

**Solutions:**

```typescript
// 1. Optimize consumer processing
async processEvent(event) {
  // SLOW: Network call for each event
  for (let i = 0; i < 1000; i++) {
    await db.insert(event);  // 1 per event
  }

  // FAST: Batch all events
  const batch = [];
  events.forEach(e => batch.push(e));
  await db.batchInsert(batch);  // 1 call for 1000
}

// 2. Add more consumers (most effective)
// Topic has 10 partitions
// Add consumers from 1 → 10
// Each partition processed in parallel
// Lag reduced by ~10x

// 3. Increase batch size
// Default: process 1 message at a time
// Optimized: process 100 messages at a time
// Throughput increases with same latency

const consumer = kafka.consumer({
  sessionTimeout: 30000,
  heartbeatInterval: 3000,
});

await consumer.run({
  partitionsConsumedConcurrently: 8,  // More parallelism
  eachBatchAutoResolve: false,        // Manual offset commit
  eachBatch: async ({
    payload: { topic, partition, messages },
    resolveOffset,
    heartbeat,
  }) => {
    for (let i = 0; i < messages.length; i++) {
      // Process batch more efficiently
      const message = messages[i];
      await processMessage(message);

      // Commit offset regularly
      if (i % 100 === 0) {
        await heartbeat();
      }
    }
  },
});
```

**Monitoring:**

```typescript
// Alert on high lag
const lag = latestOffset - consumerOffset;
if (lag > 100000) {
  // Add more consumers
  // Or optimize processing
  alert('High Kafka lag detected!');
}
```

---

### Question 6: "How do you prevent cache stampede?"

**Scenario:**
```
Hot cache key expires at T=1000
Requests flood in at T=1001
All cache misses simultaneously
All hit database at same time (thundering herd)
Database overwhelmed!
```

**Solution 1: Lock Pattern**

```typescript
async getHotData(key: string) {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  // Lock prevents other threads from querying DB
  const lockKey = `lock:${key}`;
  const acquired = await redis.set(lockKey, '1', 'NX', 'EX', 5);

  if (!acquired) {
    // Someone else is fetching
    // Wait and retry (or return stale data)
    await sleep(100);
    return getHotData(key);
  }

  try {
    // Only one thread reaches here
    const fresh = await database.get(key);

    // Cache with longer TTL
    await redis.set(key, JSON.stringify(fresh), 'EX', 3600);

    return fresh;
  } finally {
    await redis.del(lockKey);
  }
}
```

**Solution 2: Probabilistic Expiration**

```typescript
// Expire slightly before TTL
async getHotData(key: string, ttl: number = 3600) {
  const cached = await redis.get(key);
  if (cached) {
    const xfuzz = cached.createdAt + (ttl * 0.8);  // Expire at 80% of TTL

    if (Date.now() < xfuzz) {
      return cached;  // Still fresh
    }
  }

  // Before actual expiration, refresh in background
  return refreshDataAsync(key, ttl);
}
```

**Solution 3: Stale-While-Revalidate**

```typescript
async getHotData(key: string) {
  const cached = await redis.get(key);

  if (cached && !isExpired(cached)) {
    return cached;  // Fresh data
  }

  if (cached && isExpired(cached)) {
    // Serve stale data while revalidating
    refreshInBackground(key);
    return cached;  // Return immediately (stale but available)
  }

  // No cache, must fetch
  return fetchFromDatabase(key);
}

async function refreshInBackground(key: string) {
  const fresh = await database.get(key);
  await redis.set(key, JSON.stringify(fresh), 'EX', 3600);
}
```

**Interview Tip:**
> "Cache stampede happens when hot keys expire. Prevent with distributed locks (only one thread fetches), or probabilistic expiration (refresh before expiry), or serve stale data while revalidating. Protect your database from thundering herd."

---

## Common Pitfalls

### Pitfall 1: Forgetting Hash Tags in Cluster

```typescript
// WRONG: Multi-key operation without hash tags
const key1 = `user:123:profile`;
const key2 = `user:123:friends`;

// These go to different slots!
const [profile, friends] = await cluster.mget(key1, key2);
// Error: CROSSSLOT Keys in request don't hash to the same slot

// CORRECT: Use hash tags
const key1 = `user:{123}:profile`;
const key2 = `user:{123}:friends`;

const [profile, friends] = await cluster.mget(key1, key2);
// Both go to same slot → Success
```

### Pitfall 2: Assuming Order in Non-Keyed Kafka Events

```typescript
// WRONG: No partition key
await kafka.send({
  topic: 'events',
  messages: [
    { value: 'user_logged_in' },
    { value: 'game_started' }
  ]
});

// Events can process out of order!
// game_started might process first!

// CORRECT: Consistent key
await kafka.send({
  topic: 'events',
  messages: [
    { key: userId, value: 'user_logged_in' },
    { key: userId, value: 'game_started' }
  ]
});

// Same key → same partition → ordered processing
```

### Pitfall 3: Cache Never Gets Refreshed

```typescript
// WRONG: Set cache, never update
async getUser(userId: string) {
  const cached = await redis.get(`user:${userId}`);
  if (cached) return JSON.parse(cached);

  const user = await db.getUser(userId);
  await redis.set(`user:${userId}`, JSON.stringify(user));
  // No TTL! Cache lasts forever!
  // User updates profile, but cache never refreshes!

  return user;
}

// CORRECT: Always set TTL
await redis.setex(
  `user:${userId}`,
  3600,  // 1 hour TTL
  JSON.stringify(user)
);

// AND invalidate on update
async updateUser(userId: string, changes: any) {
  await db.updateUser(userId, changes);
  await redis.del(`user:${userId}`);  // Clear cache
}
```

### Pitfall 4: Distributed Lock with No TTL

```typescript
// WRONG: Lock has no expiration
await redis.set(`lock:${resource}`, lockId);

// Process crashes while holding lock
// Lock held forever
// No one else can acquire it

// CORRECT: Always set TTL
await redis.set(
  `lock:${resource}`,
  lockId,
  'PX',
  30000,  // 30 second expiration
  'NX'
);

// If process crashes, lock expires automatically
// Other processes acquire after 30s
```

### Pitfall 5: Single Consumer Can't Keep Up

```
Topic has 10 partitions
You deploy 1 consumer
Result: 9 partitions have no consumer
Lag increases forever

FIX: Deploy at least as many consumers as partitions
Topic: 10 partitions → Deploy 10 consumers
Each gets one partition, parallel processing
```

---

## Summary

Production scaling requires:

1. **Stateless architecture** → Horizontal scaling
2. **Connection pooling** → Efficient resource use
3. **Redis Cluster** → Distributed cache, 16K slots
4. **Hash tags** → Multi-key operations on same node
5. **Kafka** → Event streaming at scale
6. **Partition keys** → Guaranteed ordering
7. **Caching strategy** → Cache-aside, TTL, invalidation
8. **Database sharding** → Distributed persistence
9. **Distributed locks** → Critical section protection
10. **Monitoring** → Lag, latency, errors

**Key Principle:** At 100M+ users, every architectural decision compounds. Stateless servers + cache-aside + event-driven + cluster-ready enables unlimited growth.

---

## Interview Checklist

Before your interview, know:

- [ ] Explain Redis Cluster slot distribution
- [ ] Describe hash tags and when to use
- [ ] Compare cache-aside vs write-through
- [ ] Design Kafka partitioning for ordering
- [ ] Explain consumer group rebalancing
- [ ] Implement distributed lock
- [ ] Handle cache stampede
- [ ] Shard database effectively
- [ ] Monitor Kafka lag
- [ ] Design fallback when Redis unavailable

**Good luck!**

---

**Last Updated:** February 2026
**Status:** Complete for interview preparation
