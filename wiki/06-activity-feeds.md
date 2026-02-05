# Activity Feeds - PlayStation Network Backend Interview Guide

**Target Audience:** Backend engineers preparing for senior-level interviews at gaming and social platforms
**Document Version:** 1.0
**Last Updated:** February 2026

## Table of Contents

1. [Feed Architecture Overview](#feed-architecture-overview)
2. [Activity Types & Event Modeling](#activity-types--event-modeling)
3. [Fan-out Patterns](#fan-out-patterns)
4. [Implementation Details](#implementation-details)
5. [Activity Aggregation](#activity-aggregation)
6. [Scaling Considerations](#scaling-considerations)
7. [Real-World Platform Comparisons](#real-world-platform-comparisons)
8. [Interview Questions & Answers](#interview-questions--answers)
9. [Common Pitfalls & Solutions](#common-pitfalls--solutions)

---

## Feed Architecture Overview

An activity feed shows what your friends are doing in real-time: games they're playing, trophies they've earned, friend requests they've accepted, etc. The challenge is showing this information to potentially millions of users with sub-second latency.

### Core Problem

```
User A plays a game
       ↓
Other 500 friends should see this instantly
       ↓
But users might be on any of 1000 servers
       ↓
At scale, this is millions of activities/second
```

### Design Goals

| Goal | Why | Impact |
|------|-----|--------|
| **Low Read Latency** | Users check feeds constantly (10x per session) | Must read in <100ms |
| **Eventual Consistency** | Strong consistency doesn't exist at scale | OK if activity shows up 1-2 seconds late |
| **Write Throughput** | 100M users = millions of activities/second | Must batch/pipeline writes |
| **Memory Efficiency** | Redis is expensive | Must limit feed size, expire old activities |
| **Real-time Push** | Users expect instant notifications | WebSocket + Pub/Sub required |

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      USER ACTION OCCURS                         │
│            (Trophy unlock, game started, friend added)          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ACTIVITY SERVICE                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 1. Create activity record                                │   │
│  │ 2. Store in Redis (activity:data:{id})                   │   │
│  │ 3. Add to user's own activities (activity:user:{id})     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   FAN-OUT TO FRIENDS                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Pipeline operations to all friends' feeds:               │   │
│  │ - Friend 1: activity:feed:friend1                        │   │
│  │ - Friend 2: activity:feed:friend2                        │   │
│  │ - Friend N: activity:feed:friendN                        │   │
│  │                                                          │   │
│  │ Executed atomically via Redis pipeline                   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PUBLISH EVENT                                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Emit activity event for real-time subscriptions          │   │
│  │ Redis Pub/Sub broadcasts to all connected servers       │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  ┌──────────┐         ┌──────────┐         ┌──────────┐
  │ Server 1 │         │ Server 2 │         │ Server N │
  │ WebSocket│         │ WebSocket│         │ WebSocket│
  │ Clients  │         │ Clients  │         │ Clients  │
  └──────────┘         └──────────┘         └──────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              │
                              ▼
              User sees activity on their feed
```

---

## Activity Types & Event Modeling

### Supported Activity Types

```typescript
// From src/services/activity/activity.service.ts
type ActivityType =
  | 'game_started'           // User started playing a game
  | 'achievement_unlocked'   // User earned a trophy
  | 'friend_added'          // User added a new friend
  | 'trophy_milestone'      // User reached a trophy milestone (100, 200, etc)
```

### Activity Data Model

```typescript
interface Activity {
  // Core identity
  id: string;                    // Unique activity ID (act_uuid)
  type: ActivityType;            // What kind of activity
  createdAt: string;            // ISO 8601 timestamp

  // User attribution
  userId: string;               // Who performed the action
  gamertag: string;            // User's display name (cached for performance)
  avatar: string;              // User's avatar URL

  // Activity details
  title: string;               // "Started playing Spider-Man 2"
  description?: string;        // Optional additional context

  // Game-specific data
  gameId?: string;             // Game identifier
  gameTitle?: string;          // "Spider-Man 2"
  gameCoverUrl?: string;       // Game thumbnail

  // Achievement-specific data
  achievementId?: string;      // Trophy identifier
  achievementName?: string;    // "Defeated all bosses"
  trophyType?: 'bronze' | 'silver' | 'gold' | 'platinum';

  // Social signals
  likeCount: number;           // How many people liked this
  commentCount: number;        // Number of comments
  isLiked: boolean;           // Does current viewer like it?
}
```

### Why Cache User Data in Activities?

Notice how activities include `gamertag` and `avatar` even though we have a User table. Why?

```
REASON 1: Query Performance
- Activity: {userId: "123", gamertag: "JohnDoe", avatar: "url"}
- Get all fields from one Redis entry
- No additional lookup needed

REASON 2: Immutable History
- User later changes gamertag to "JohnDoe2"
- Activity should still show original gamertag
- Caching at write time ensures historical accuracy

REASON 3: Denormalization for Scale
- Reading 100 activities = 100 Redis hash gets
- NOT 100 + 100 user lookups = 200 operations
- Saves 50% of operations at scale
```

---

## Fan-out Patterns

The core architectural choice in feed systems is: **When do we distribute activities to followers?**

### Pattern 1: Fan-Out on Write (PSN Implementation)

**Strategy:** When an activity occurs, immediately push it to all followers' feeds.

```typescript
// From src/services/activity/activity.service.ts, lines 182-272
async createActivity(
  input: CreateActivityInput,
  friendIds: string[]  // All followers to fan-out to
): Promise<Activity> {
  // Step 1: Create activity record
  const activity = { id, type, userId, gamertag, title, ... };

  // Step 2: Store activity data
  await redis.hset(`activity:data:${activityId}`, activity);

  // Step 3: Add to user's own activities
  await redis.zadd(`activity:user:${userId}`, timestamp, activityId);

  // Step 4: Fan-out to all friends in PARALLEL
  const pipeline = redis.pipeline();
  for (const friendId of friendIds) {
    pipeline.zadd(`activity:feed:${friendId}`, timestamp, activityId);
    pipeline.zremrangebyrank(`activity:feed:${friendId}`, 0, -501); // Keep 500 max
  }
  await pipeline.exec(); // Atomic execution

  // Step 5: Publish for real-time subscriptions
  emit('activityEvent', { activity, toUserIds: friendIds });
}
```

#### Pros
- **Fast reads:** Feed is pre-computed. Just grab top 50 activities
- **Real-time:** Can push immediately via WebSocket
- **No dependency lookup:** Don't need to know who's friends when reading
- **Consistent ordering:** Sorted by timestamp in Redis

#### Cons
- **Write amplification:** 1 activity → write to 500+ feeds = 500+ operations
- **Celebrity problem:** Influencer with 5M followers causes 5M writes
- **Eventual consistency:** Distributed pipeline execution isn't atomic across servers

#### Best For
- **Normal users** with 100-500 followers
- **Balanced read/write** platforms like gaming
- **Sub-second latency** requirements

#### Code Complexity
```
Write path: O(friends) = complex
Read path: O(1) = simple
```

### Pattern 2: Fan-Out on Read (Alternative)

**Strategy:** Don't pre-compute feeds. At read time, pull activities from all followed users.

```typescript
// ALTERNATIVE approach (not used in PSN, but interview discussion)
async getFeed(userId: string): Promise<Activity[]> {
  // Get list of friends
  const friends = await redis.smembers(`user:${userId}:friends`);

  // Get activities from each friend
  const promises = friends.map(friendId =>
    redis.zrevrange(`activity:user:${friendId}`, 0, 20)
  );

  const activityLists = await Promise.all(promises);
  const activityIds = activityLists.flat();

  // Merge and sort all activities
  const activities = await getActivitiesByIds(activityIds);
  return activities
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);
}
```

#### Pros
- **No write amplification:** 1 activity = 1 write (just to user's activities)
- **Handles celebrities:** Even 5M followers doesn't cause fan-out explosion
- **Real-time by default:** Always pulling fresh data

#### Cons
- **Slow reads:** Must query 500+ friend feeds and merge = 500+ requests
- **Network overhead:** One feed read = network calls to all friends
- **Dependency on friend list:** Must know followers' list to compute feed
- **Merge complexity:** Sorting 500 lists is expensive

#### Best For
- **Celebrity/influencer models** (Twitter, TikTok)
- **Sparse follower relationships** (thousands of followers)
- **Can tolerate slightly stale feeds**

#### Code Complexity
```
Write path: O(1) = simple
Read path: O(friends * log(friends)) = complex
```

### Pattern 3: Hybrid (Production Reality)

**Strategy:** Use Pattern 1 for normal users, Pattern 2 for celebrities.

```typescript
async createActivity(
  input: CreateActivityInput,
  friendIds: string[]
): Promise<Activity> {
  const activity = createActivity(input);

  // Get user's follower count (cached)
  const followerCount = await redis.scard(`user:${userId}:followers`);

  if (followerCount > CELEBRITY_THRESHOLD /* 100K */) {
    // Pattern 2: Don't fan-out, just store in user's activities
    await redis.zadd(`activity:user:${userId}`, timestamp, activityId);
  } else {
    // Pattern 1: Fan-out to all followers
    const pipeline = redis.pipeline();
    for (const followerId of friendIds.slice(0, MAX_FANOUT)) {
      pipeline.zadd(`activity:feed:${followerId}`, timestamp, activityId);
    }
    await pipeline.exec();
  }

  emit('activityEvent', { activity });
}

async getFeed(userId: string): Promise<Activity[]> {
  // First, try pre-computed feed (from Pattern 1)
  const precomputed = await redis.zrevrange(`activity:feed:${userId}`, 0, 49);

  // Then, pull from followed celebrities (Pattern 2)
  const friends = await redis.smembers(`user:${userId}:friends`);
  const celebrities = friends.filter(f => {
    const count = redis.scard(`user:${f}:followers`);
    return count > CELEBRITY_THRESHOLD;
  });

  const celebrityActivities = await Promise.all(
    celebrities.map(c => redis.zrevrange(`activity:user:${c}`, 0, 10))
  );

  // Merge both sources and return top 50
  return mergeAndSort([precomputed, ...celebrityActivities]).slice(0, 50);
}
```

#### When to Use Which
| User Type | Followers | Strategy | Read Latency |
|-----------|-----------|----------|-------------|
| Regular user | <1K | Fan-out on write | <50ms |
| Popular player | 1K-100K | Fan-out on write | <50ms |
| Celebrity | 100K+ | Fan-out on read | <500ms |
| Streamer | 1M+ | Pure read + cache | <1s |

---

## Implementation Details

### Redis Data Structures

#### 1. Activity Data Hash

```
Key: activity:data:{activityId}
Type: Hash
TTL: 7 days (604800 seconds)

Fields:
  id                 → "act_abc123"
  type               → "achievement_unlocked"
  userId             → "user_123"
  gamertag           → "JohnDoe"
  avatar             → "https://cdn.psn.com/avatars/..."
  title              → "Earned 'Defeated all bosses'"
  description        → "In Spider-Man 2"
  gameId             → "game_456"
  gameTitle          → "Spider-Man 2"
  achievementId      → "ach_789"
  achievementName    → "Master of Combat"
  trophyType         → "gold"
  createdAt          → "2026-02-04T15:30:00Z"
  likeCount          → "42"
  commentCount       → "8"
```

**Why Hash?**
- Multiple fields about one activity
- Efficient batch retrieval with `HGETALL`
- Can increment counters with `HINCRBY`
- Automatic TTL cleanup

#### 2. User's Feed (Sorted Set)

```
Key: activity:feed:{userId}
Type: Sorted Set (score = timestamp)
TTL: None (persists until trimmed)

Members (stored in reverse time order):
  score            member
  1707049400000 → "act_abc123"  (newest first)
  1707049390000 → "act_def456"
  1707049380000 → "act_ghi789"
  1707049370000 → "act_jkl012"
  ...
  1707048400000 → "act_mno345"  (oldest, about to trim)
```

**Why Sorted Set?**
- Natural timestamp ordering (no sort needed)
- Efficient range queries: `ZREVRANGE(feed, 0, 49)` = top 50
- Trim old entries: `ZREMRANGEBYRANK(feed, 0, -501)`
- Score = timestamp = microsecond precision possible

#### 3. User's Own Activities (Sorted Set)

```
Key: activity:user:{userId}
Type: Sorted Set (score = timestamp)

Purpose: Show activities created by this user on their profile
- User visits another player's profile
- See their trophy unlocks, games played, etc.
- Different from their feed (shows friends' activities)
```

#### 4. Activity Likes (Set)

```
Key: activity:likes:{activityId}
Type: Set

Members: {userId1, userId2, userId3, ...}

Operations:
  SADD activity:likes:act_123 user_456    # Like activity
  SREM activity:likes:act_123 user_456    # Unlike
  SISMEMBER activity:likes:act_123 user_456  # Check if liked
  SCARD activity:likes:act_123            # Like count
```

### Feed Size Management

Activity feeds can grow infinitely without trimming. Here's how PSN limits them:

```typescript
// From activity.service.ts, lines 225-230
const maxFeedSize = 500; // Maximum activities per feed

// When adding activity to friend's feed
const pipeline = redis.pipeline();
pipeline.zadd(`activity:feed:${friendId}`, timestamp, activityId);

// Trim to max size: remove all activities beyond rank 500
pipeline.zremrangebyrank(
  `activity:feed:${friendId}`,
  0,  // Start: oldest
  -(maxFeedSize + 1)  // Stop: remove older than 500
);

await pipeline.exec();
```

**Why 500?**
- Typical user reads ~50 activities (one screen)
- 500 gives 10 screens of history
- At 50 activities/user/day = 10 days of history
- Balances Redis memory vs user utility

### Batch Fetching (Pipeline Pattern)

When displaying a feed, we need activity data for 50 activities. Naive approach:

```typescript
// BAD: 50 separate Redis calls
const activityIds = await redis.zrevrange('activity:feed:userId', 0, 49);
const activities = [];
for (const id of activityIds) {
  const data = await redis.hgetall(`activity:data:${id}`);  // N calls
  const likes = await redis.scard(`activity:likes:${id}`);  // N calls
  activities.push(data);
}
// Total: 100 network round-trips!
```

Smart approach using pipelines:

```typescript
// GOOD: 2 batch calls
async getActivitiesByIds(activityIds: string[], viewerId: string): Promise<Activity[]> {
  const pipeline = redis.pipeline();

  // Batch fetch all activity data
  for (const id of activityIds) {
    pipeline.hgetall(`activity:data:${id}`);
  }

  // Check if viewer liked each
  for (const id of activityIds) {
    pipeline.sismember(`activity:likes:${id}`, viewerId);
  }

  const results = await pipeline.exec();  // One network call!

  // Parse results
  const activities: Activity[] = [];
  const halfLength = activityIds.length;

  for (let i = 0; i < halfLength; i++) {
    const data = results[i][1] as Record<string, string>;
    const isLiked = results[i + halfLength][1] === 1;

    activities.push({
      ...data,
      isLiked,
      likeCount: parseInt(data.likeCount || '0'),
    });
  }

  return activities;
}
```

**Performance Improvement:**
- 50 activities: 100 calls → 2 calls = 50x faster
- At scale: Reduces Redis latency from 100ms to 2ms per feed read

### TTL Strategy

```typescript
// Activity data expires after 7 days
const activityTTLSeconds = 604800; // 7 * 24 * 60 * 60

await redis.hset(`activity:data:${activityId}`, activity);
await redis.expire(`activity:data:${activityId}`, activityTTLSeconds);

// Why 7 days?
// - Most users check feeds daily
// - Old activities are rarely accessed
// - Redis memory is expensive (save ~99% of data)
// - Frozen activities (no new likes) unlikely to change
```

---

## Activity Aggregation

### The Problem: Feed Clutter

Without aggregation:

```
John started playing Spider-Man 2
Mary started playing Spider-Man 2
Sarah started playing Spider-Man 2
Mike started playing Spider-Man 2
Lisa started playing Spider-Man 2
...
12 more friends started playing Spider-Man 2
```

18 separate feed items for the same game. Users find this annoying.

### Aggregation Solution

With aggregation:

```
John and 17 others are playing Spider-Man 2
   ↑ clickable, shows all 18 players
```

### Implementation

```typescript
// From activity.service.ts, lines 722-770
async getAggregatedFeed(userId: string, limit: number = 50): Promise<Activity[]> {
  // Step 1: Get raw feed (get extra to account for aggregation)
  const activities = await this.getFeed(userId, limit * 2);

  // Step 2: Group by game_started activities
  const gameGroups = new Map<string, Activity[]>();
  const otherActivities: Activity[] = [];

  for (const activity of activities) {
    if (activity.type === 'game_started' && activity.gameId) {
      const existing = gameGroups.get(activity.gameId) || [];
      existing.push(activity);
      gameGroups.set(activity.gameId, existing);
    } else {
      otherActivities.push(activity);
    }
  }

  // Step 3: Create aggregated activities for games with 2+ players
  const aggregatedActivities: Activity[] = [];

  for (const [gameId, gameActivities] of gameGroups.entries()) {
    if (gameActivities.length > 2) {
      // Aggregate: "John and 17 others playing..."
      const first = gameActivities[0];
      const otherCount = gameActivities.length - 1;

      aggregatedActivities.push({
        ...first,
        title: `${first.gamertag} and ${otherCount} others are playing ${first.gameTitle}`,
        description: gameActivities.map(a => a.gamertag).join(', '),
      });
    } else {
      // Keep individual activities for games with <2 players
      aggregatedActivities.push(...gameActivities);
    }
  }

  // Step 4: Merge and sort by timestamp
  const allActivities = [...aggregatedActivities, ...otherActivities];
  allActivities.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return allActivities.slice(0, limit);
}
```

### When to Aggregate?

| Scenario | Action | Reason |
|----------|--------|--------|
| 1 friend playing | Show alone | Unique, interesting |
| 2-3 friends playing | Show alone | Still relatively rare |
| 4+ friends playing | Aggregate | Reduce clutter |
| 20+ friends playing | Definitely aggregate | Otherwise feed is unreadable |

### Aggregation Strategies

```typescript
// Strategy 1: By game (what we do)
"John and 5 others are playing Spider-Man 2"

// Strategy 2: By activity type
"6 friends unlocked new trophies"

// Strategy 3: By time window
"5 achievements unlocked in the last 10 minutes"
(Reduces noise from trophy hunter binge sessions)

// Strategy 4: By user importance
"Your 3 best friends are playing..."
(Prioritize close friends over acquaintances)
```

### Why Aggregate at Read Time?

```
Option A: Aggregate at write time
- Complex: When to aggregate? After 4th player joins?
- Stale: What if one player stops? Need to un-aggregate
- Consistent: All clients see same aggregation
- Fast: Aggregation already done

Option B: Aggregate at read time (PSN approach)
- Simple: Always aggregate on the spot
- Fresh: Aggregation reflects current state
- Flexible: Each client can customize aggregation
- Slightly slower: Aggregation cost = O(n) per read

At scale, reading with n=50 activities is cheaper than
maintaining consistent aggregation across millions of feeds.
```

---

## Scaling Considerations

### Horizontal Scaling

#### Single Instance Problem

```
Redis Instance 1: Single bottleneck
- Max throughput: ~100K operations/second
- 100M users with 500K active at any moment
- 500K * 10 (feeds per user/min) = 5M ops/min needed
- 5M / 60 = 83K ops/sec (OK, but no headroom)
```

#### Redis Cluster Solution

```
┌─────────────────────────────────────────────────┐
│            REDIS CLUSTER (6 nodes)              │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ Master 1 │  │ Master 2 │  │ Master 3 │     │
│  │ hash:0-5 │  │ hash:6-b │  │ hash:c-f │     │
│  ├──────────┤  ├──────────┤  ├──────────┤     │
│  │ Slave 1a │  │ Slave 2a │  │ Slave 3a │     │
│  └──────────┘  └──────────┘  └──────────┘     │
│                                                 │
└─────────────────────────────────────────────────┘

Each shard handles 1/3 of keys:
- activity:feed:user_000-333  → Master 1
- activity:feed:user_334-666  → Master 2
- activity:feed:user_667-999  → Master 3

Key hash function: CRC16(key) % 16384 slots
```

**Benefits:**
- 3x throughput: 300K ops/sec instead of 100K
- Automatic failover: Slave 1a promotes if Master 1 fails
- Horizontal scaling: Add more masters = linear scaling

#### Sharding Key Selection

```typescript
// DON'T DO THIS (Bad distribution)
const key = `activity:feed:${userId}`;
// If user IDs are sequential (1, 2, 3, ...), all go to same shard

// DO THIS (Good distribution)
const key = `activity:feed:${userId}`;
// Redis cluster automatically hashes uniformly
// CRC16(key) gives good distribution

// For manual sharding, use hash ring
const shardId = hashFunction(userId) % numShards;
const redisClient = shardClients[shardId];
```

### Asynchronous Processing with Message Queues

At 100M users with 10% active (10M), generating 10 activities/user/day:

```
10M users * 10 activities/day = 100M activities/day
= 1.16K activities/second

Each activity fans out to 500 friends average:
1.16K * 500 = 580K writes/second

Redis Cluster can handle ~300K ops/sec
580K > 300K = We're overloaded!

Solution: Use message queue to decouple write
```

#### Without Queue (Synchronous - Bottleneck)

```
Client Request
    ↓
ActivityService.createActivity()
    ├─ Write to Redis         ← Blocks client
    ├─ Fan-out to 500 friends ← Blocks client (slow!)
    └─ Publish event          ← Blocks client
    ↓
Response to client (500-1000ms)

If fan-out is slow, client waits!
```

#### With Queue (Asynchronous - Scalable)

```
Client Request
    ↓
ActivityService.createActivity()
    ├─ Write to Redis              (fast, <10ms)
    ├─ Queue fan-out task          (fast, <5ms)
    └─ Publish event               (fast, <5ms)
    ↓
Response to client (20ms) ← Much faster!
    ↓
Async Worker (Kafka Consumer)
    ├─ Fan-out to 500 friends (slow, 500ms)
    └─ Update activity count

Client gets response quickly,
heavy work happens asynchronously
```

#### Implementation with Kafka

```typescript
// In ActivityService.createActivity()
async createActivity(
  input: CreateActivityInput,
  friendIds: string[]
): Promise<Activity> {
  const activity = { id, type, userId, ... };

  // Step 1: Store activity immediately
  await redis.hset(`activity:data:${activityId}`, activity);

  // Step 2: Queue the fan-out work
  await kafkaProducer.send({
    topic: 'activity.fanout',
    messages: [{
      key: activityId,
      value: JSON.stringify({
        activityId,
        friendIds,
      })
    }]
  });

  // Step 3: Return immediately
  return activity;
}

// Separate consumer processes fan-out
kafkaConsumer.subscribe({ topic: 'activity.fanout' });
kafkaConsumer.run({
  eachMessage: async ({ message }) => {
    const { activityId, friendIds } = JSON.parse(message.value);

    // Fan-out to Redis (slow operation)
    const pipeline = redis.pipeline();
    for (const friendId of friendIds) {
      pipeline.zadd(`activity:feed:${friendId}`, timestamp, activityId);
    }
    await pipeline.exec();
  }
});
```

**Benefits:**
- Client response time: Independent of fan-out speed
- Scalability: Add more workers = process faster
- Durability: Kafka retries failed fan-outs
- Ordering: Kafka ensures per-key ordering

### Celebrity Problem Deep Dive

A user with 5M followers creates an activity:

#### Naive Approach (Catastrophic)

```typescript
const friendIds = await redis.smembers(`user:celebrity:friends`); // 5M IDs
const pipeline = redis.pipeline();
for (const friendId of friendIds) {
  pipeline.zadd(`activity:feed:${friendId}`, timestamp, activityId);
}
await pipeline.exec(); // 5M operations!

// Cost: 5 seconds of Redis cluster time, all clients affected
```

#### Smart Approach: Don't Fan-out

```typescript
async createActivity(
  input: CreateActivityInput,
  friendIds: string[]
): Promise<Activity> {
  const activity = { ... };

  // Check if this user is a celebrity
  const followingCount = await redis.scard(`user:${userId}:followers`);

  if (followingCount > CELEBRITY_THRESHOLD /* 100K */) {
    // Don't fan-out! Just store activity
    await redis.hset(`activity:data:${activityId}`, activity);
    await redis.zadd(`activity:user:${userId}`, timestamp, activityId);

    // Followers pull at read time (Pattern 2)
    emit('activityEvent', { activity, isCelebrity: true });
  } else {
    // Normal fan-out for regular users
    // ... normal fan-out code ...
  }
}

// When follower reads feed
async getFeed(userId: string): Promise<Activity[]> {
  // Part 1: Get pre-computed feed (from non-celebrities)
  const precomputedIds = await redis.zrevrange(`activity:feed:${userId}`, 0, 49);
  const precomputed = await getActivitiesByIds(precomputedIds, userId);

  // Part 2: Pull from followed celebrities at read time
  const friends = await redis.smembers(`user:${userId}:friends`);
  const celebActivities: Activity[] = [];

  for (const friendId of friends) {
    const followingCount = await redis.scard(`user:${friendId}:followers`);
    if (followingCount > CELEBRITY_THRESHOLD) {
      // Pull celebrity's activities
      const ids = await redis.zrevrange(`activity:user:${friendId}`, 0, 20);
      const acts = await getActivitiesByIds(ids, userId);
      celebActivities.push(...acts);
    }
  }

  // Part 3: Merge and return
  const all = [...precomputed, ...celebActivities];
  return all
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);
}
```

**Impact:**
- Celebrity creates 1 activity = 1 write (not 5M)
- Follower reads feed = check ~500 celebrity feeds
- Followers pull 500 IDs in parallel, get 1-5 activities/celebrity
- Much better: Trading read latency for write stability

---

## Real-World Platform Comparisons

### Twitter's Approach (Fan-out on Read)

**Why:** Celebrities have millions of followers

```
Twitter user publishes a tweet
    ↓
Followers don't get pre-computed feeds
    ↓
When follower opens timeline
    ├─ Pull from followed users' tweet lists (1K+ queries)
    ├─ Merge and sort
    └─ Return top 50

Timeline latency: 500-2000ms (acceptable for Twitter's model)
```

**Drawbacks:** Slow feed loads, but handles any follower count

### Facebook's Approach (Fan-out on Write, Heavily Optimized)

**Why:** Most users have <500 friends, news feed is core product

```
Facebook user posts something
    ↓
Fan-out to all 500 friends immediately
    ├─ Batch operations for efficiency
    ├─ Use news feed ranking algorithm
    └─ Cache aggressively

But Facebook does it with:
- Advanced ranking (not just time)
- Multi-tier cache (hot/warm/cold)
- Real-time personalization
- Billions of feeds

Cost: Massive infrastructure, worth it for engagement
```

### LinkedIn's Approach (Hybrid with Ranking)

**Why:** Mix of celebrities (1M followers) and regular users (500 followers)

```
User publishes an article
    ↓
Regular user: Fan-out immediately
Influencer: Don't fan-out, followers pull

When viewing feed:
    ├─ Get pre-computed feed (90% of activities)
    ├─ Pull from followed influencers (10%)
    └─ Rank by importance (engagement, recency, relevance)

Feed = engagement-optimized, not just chronological
```

### Twitch's Approach (Fan-out on Write with Aggregation)

**Why:** Streamers have millions of concurrent viewers

```
Streamer goes live
    ↓
Fan-out message: "Channel X just went live"
    ├─ Push to followers' feed as aggregate
    ├─ "5 of your followed streamers are live"
    └─ Don't create 5 separate activities

Read:
    └─ Single aggregated activity (not 5)

Balances: Write simplicity with feed readability
```

### PSN's Approach (This Implementation)

```
Regular players: Fan-out on write
    ├─ Most players have <500 friends
    └─ Immediate visibility (core feature)

Celebrity players: Don't fan-out
    └─ Followers pull at read time

Activity aggregation: At read time
    └─ "5 friends playing game X" → single feed item

Result: Scales to millions of users without compromise
```

---

## Interview Questions & Answers

### Question 1: "Walk me through how you'd design an activity feed."

**Structure your answer:**

1. **Clarify requirements (Candidate should ask):**
   - How many users? (100M)
   - How many friends per user? (100-500)
   - Read frequency? (10x per session)
   - Latency requirement? (<100ms)
   - Strong or eventual consistency? (Eventual)

2. **Propose high-level architecture:**
   ```
   Activity occurs → Create activity → Fan-out to friends → Publish event
   ```

3. **Data structures:**
   ```
   activity:data:{id} = Hash (activity details)
   activity:feed:{userId} = Sorted Set (scored by timestamp)
   activity:likes:{id} = Set (users who liked)
   ```

4. **Write path (fan-out on write):**
   - Store activity data
   - Add to user's own activities
   - Fan-out to all friends in Redis pipeline
   - Publish for real-time

5. **Read path:**
   - Get feed IDs: ZREVRANGE activity:feed:{userId} 0 49
   - Batch fetch data: HGETALL for each activity
   - Batch fetch like status: SISMEMBER for each
   - Return paginated results

6. **Scaling:**
   - Redis Cluster for horizontal scaling
   - Message queue (Kafka) for async fan-out
   - Special handling for celebrities (pull instead of push)

7. **Tradeoffs:**
   - Write amplification: 1 activity → 500 writes
   - Memory: Keep 500 per feed × 100M = huge
   - Latency: Pays off in fast reads

**Follow-up likely:** "What about a user with 5M followers?"

Answer: "Use hybrid approach. For celebrities, don't fan-out. Followers pull at read time. Costs more reads but prevents write explosion."

### Question 2: "Why fan-out on write instead of on read?"

**Good answer structure:**

1. **Tradeoff matrix:**
   ```
   Fan-out on Write:
   ✓ Fast reads (pre-computed)
   ✓ Real-time updates easy
   ✗ Write amplification
   ✗ Celebrity problem

   Fan-out on Read:
   ✓ Simple writes
   ✓ Handles any follower count
   ✗ Slow reads
   ✗ Complex merging
   ```

2. **Why PSN chose write:**
   - Gaming is read-heavy (users check feeds constantly)
   - Normal follower counts (500 average, not millions)
   - Real-time is core (friends should see you playing instantly)

3. **Implementation insight:**
   ```
   Write cost: 500 operations (tolerable with Redis cluster)
   Read benefit: Serves 10K users/second from pre-computed feeds

   Equation: 1 write × 500 cost < 10K reads × individual merge cost
   ```

4. **When you'd change:**
   - "If 90% of users had 1M+ followers → fan-out on read"
   - "If reads were rare → fan-out on write becomes wasteful"
   - "If real-time wasn't critical → fan-out on read"

### Question 3: "How would you handle 100M concurrent users?"

**Layered response:**

1. **Server scaling:**
   ```
   Stateless servers behind load balancer
   Each server: Apollo + services
   Can add unlimited servers
   ```

2. **Redis scaling:**
   ```
   Single Redis: 100K ops/sec → bottleneck
   Redis Cluster: 3-5 nodes = 300-500K ops/sec

   At 100M users with 10% active (10M):
   10M * 5 reads/min = 833K ops/sec
   Need Redis Cluster with 5+ nodes
   ```

3. **Write amplification:**
   ```
   1.16K activities/sec * 500 friends = 580K writes/sec
   Exceeds Redis capacity → Use message queue

   Queue activities → workers fan-out asynchronously
   Redis handles reads in realtime, writes are async
   ```

4. **Data modeling:**
   ```
   Max 500 activities per feed = limited memory
   TTL 7 days = auto-cleanup
   Aggregation at read = no duplication
   ```

5. **Bottleneck analysis:**
   ```
   Network I/O: Saturates before Redis
   Solution: Compress, delta sync, batch requests

   Memory: 100M users * 500 activities * 1KB = 50TB
   Solution: Distributed across cluster (50TB / 5 nodes = 10TB each)
   ```

### Question 4: "How do you ensure activities reach all friends in order?"

**Answer:**

1. **Ordering guarantee:**
   ```
   Redis Sorted Sets store by timestamp
   ZREVRANGE = newest first (always)
   Timestamp = server time (not client submitted)

   Result: All users see same feed order
   ```

2. **Fan-out ordering:**
   ```
   Pipeline atomic execution:
   pipeline.zadd(...friend1...)
   pipeline.zadd(...friend2...)
   ...
   await pipeline.exec() // All succeed or all fail
   ```

3. **But acknowledge eventual consistency:**
   ```
   Friend A's feed might show activity 1 second before Friend B
   Reasons:
   - Redis Cluster: Different shards (network latency)
   - Kafka: Different partitions
   - WebSocket: Different server hops

   This is acceptable for gaming (1 second is instant)
   ```

4. **If strong ordering needed:**
   ```
   Option 1: Make writes synchronous (slower, 500ms per activity)
   Option 2: Accept eventual consistency (our choice)
   Option 3: Use message queue with guarantees (Kafka exactly-once)
   ```

### Question 5: "How would you aggregate activities?"

**Answer with code:**

```typescript
// Group by activity type + property
const groups = new Map<string, Activity[]>();
const other: Activity[] = [];

for (const activity of activities) {
  if (activity.type === 'game_started') {
    const key = activity.gameId; // Group by game
    const list = groups.get(key) || [];
    list.push(activity);
    groups.set(key, list);
  } else {
    other.push(activity);
  }
}

// Create aggregated entries for groups > 3
const aggregated: Activity[] = [];
for (const [_, list] of groups) {
  if (list.length > 3) {
    aggregated.push({
      ...list[0],
      title: `${list[0].gamertag} and ${list.length - 1} others playing`,
      description: list.map(a => a.gamertag).join(', '),
    });
  } else {
    aggregated.push(...list);
  }
}

return [...aggregated, ...other]
  .sort((a, b) => b.createdAt - a.createdAt)
  .slice(0, 50);
```

**Follow-ups:**
- "When do you aggregate?" → Read time (flexible, not expensive)
- "What about un-aggregating?" → Never needed, always fresh
- "How do you click through aggregated activities?" → Show list of all involved users

---

## Common Pitfalls & Solutions

### Pitfall 1: Not Trimming Feeds

**Problem:**
```typescript
// Bad: No trimming
async createActivity(..., friendIds) {
  for (const friendId of friendIds) {
    pipeline.zadd(`activity:feed:${friendId}`, timestamp, activityId);
  }
  // Missing: zremrangebyrank!

  // After 1 year: Each feed has 10K+ activities = slow reads
}
```

**Solution:**
```typescript
// Good: Always trim
async createActivity(..., friendIds) {
  const MAX_FEED_SIZE = 500;
  const pipeline = redis.pipeline();

  for (const friendId of friendIds) {
    pipeline.zadd(`activity:feed:${friendId}`, timestamp, activityId);
    // Remove all but newest MAX_FEED_SIZE
    pipeline.zremrangebyrank(
      `activity:feed:${friendId}`,
      0,
      -(MAX_FEED_SIZE + 1)
    );
  }
  await pipeline.exec();
}
```

**Impact:**
- Without trimming: Feeds grow infinitely, queries slow from O(50) to O(1000)
- With trimming: Always O(50), predictable latency

### Pitfall 2: Synchronous Fan-out

**Problem:**
```typescript
// Bad: Synchronous
async createActivity(..., friendIds) {
  for (const friendId of friendIds) {
    await redis.zadd(`activity:feed:${friendId}`, timestamp, activityId);
    // 500 * 10ms = 5 second delay!
  }
  return activity; // Client waits 5 seconds
}
```

**Solution:**
```typescript
// Good: Pipeline all writes
async createActivity(..., friendIds) {
  const pipeline = redis.pipeline();
  for (const friendId of friendIds) {
    pipeline.zadd(`activity:feed:${friendId}`, timestamp, activityId);
  }
  await pipeline.exec(); // All at once: 10ms total

  return activity; // Client gets response in 50ms
}

// Better: Use message queue for heavy fan-outs
async createActivity(..., friendIds) {
  await redis.hset(`activity:data:${activityId}`, activity);

  await kafka.send({
    topic: 'activity.fanout',
    messages: [{ value: JSON.stringify({ activityId, friendIds }) }]
  });

  return activity; // Client gets response in 20ms
  // Fan-out happens asynchronously
}
```

**Impact:**
- Without optimization: 5 second response times (bad UX)
- With optimization: 20ms (feels instant)

### Pitfall 3: Denormalized Data Staleness

**Problem:**
```typescript
// Creating activity
await redis.hset(`activity:data:${id}`, {
  userId: 'user123',
  gamertag: 'JohnDoe',  // Cached at activity creation time
  avatar: 'https://...'
});

// One year later, JohnDoe changes gamertag to 'JohnDoe2'
// Old activities still show 'JohnDoe' (stale)
```

**When is this OK?**
- Activities are immutable history
- Showing original gamertag when action occurred makes sense
- Example: "You were called 'JohnDoe' when you beat this achievement"

**When is this wrong?**
- Updating user's avatar → Want all activities to reflect new avatar
- Solution: Pull avatar at read time, not at write time

```typescript
// Better: Cache only immutable fields
await redis.hset(`activity:data:${id}`, {
  userId: 'user123',
  gamertag: 'JohnDoe',        // Immutable: won't change
  // avatar: DO NOT CACHE
});

// At read time: fetch avatar
const activity = await getActivityData(id);
const user = await getUserData(activity.userId);
activity.avatar = user.avatar; // Fresh avatar
```

### Pitfall 4: Missing Like Count Optimization

**Problem:**
```typescript
// Slow way: Count every time
const likes = await redis.smembers(`activity:likes:${activityId}`);
return likes.length; // O(n) = potentially 100K+ members

// Shown to user: "345,234 likes"
```

**Solution:**
```typescript
// Better: Use cached count
async likeActivity(activityId: string, userId: string) {
  const likesKey = `activity:likes:${activityId}`;
  const countKey = `activity:likecount:${activityId}`;

  // Add user to likes set
  await redis.sadd(likesKey, userId);

  // Increment cached count
  await redis.hincrby(`activity:data:${activityId}`, 'likeCount', 1);

  // Read: Just get the count, don't fetch all likes
  const count = await redis.hget(`activity:data:${activityId}`, 'likeCount');
}
```

**Impact:**
- Without: Fetch 345K IDs to count (slow)
- With: Fetch single number (instant)

### Pitfall 5: Not Handling Rate Limits

**Problem:**
```typescript
// No rate limiting
async createActivity(...) {
  // User can create 10K activities/second
  // Spam the entire friend list
}
```

**Solution:**
```typescript
// Rate limiting per user
const rateLimit = async (userId: string) => {
  const key = `activity:ratelimit:${userId}`;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, 3600); // 1 hour window
  }

  if (count > 100) { // Max 100 activities/hour
    throw new Error('Rate limit exceeded');
  }
};

async createActivity(...) {
  await rateLimit(userId);
  // ... create activity ...
}
```

**Impact:**
- Without: Users spam feeds, feeds become unusable
- With: Fair usage for all players

### Pitfall 6: Blocking Users Not Removing Activities

**Problem:**
```typescript
// User A blocks User B
// But User B's old activities still in User A's feed

// Later: User B makes activity
// Not in User A's feed (correct)
// But old activity still visible (inconsistent)
```

**Solution:**
```typescript
async blockUser(userId: string, blockedUserId: string) {
  // Add to blocked list
  await redis.sadd(`user:${userId}:blocked`, blockedUserId);

  // Remove all their activities from feed
  const activityIds = await redis.zrange(`activity:feed:${userId}`, 0, -1);

  for (const activityId of activityIds) {
    const author = await redis.hget(`activity:data:${activityId}`, 'userId');
    if (author === blockedUserId) {
      await redis.zrem(`activity:feed:${userId}`, activityId);
    }
  }
}
```

**Impact:**
- Without: Confusing UX (block doesn't fully work)
- With: Clean block experience

---

## Summary

**Activity feeds are a cornerstone of gaming platforms:**

1. **Design choice:** Fan-out on write for normal users (instant visibility)
2. **Data model:** Sorted Sets for feeds (efficient, time-ordered)
3. **Scalability:** Redis Cluster + async queues (handles 100M users)
4. **Optimization:** Batch operations, TTL cleanup, aggregation (performance)
5. **Complexity:** Celebrity handling, eventual consistency (production reality)

**Interview preparation focus:**

- Practice explaining the fan-out pattern on a whiteboard
- Be ready to defend fan-out-on-write vs on-read tradeoff
- Understand why Redis Sorted Sets are better than Strings/Hashes
- Know how to identify and solve the celebrity problem
- Think about batching and pipelining at scale

**Key insight:** "The activity feed is read-heavy but write-heavy at scale. The architectural choice of fan-out-on-write trades write complexity for read speed, which is the right tradeoff for a gaming platform where feeds are checked constantly but created relatively rarely (compared to message volume)."

---

## References

- **Code:** `/src/services/activity/activity.service.ts` (lines 1-800)
- **Redis Data Structures:** [redis.io/commands](https://redis.io/commands)
- **Fan-out Patterns:** Real-time Messaging with Firebase (Google Cloud)
- **Message Queues:** Apache Kafka Definitive Guide
- **Platform Studies:**
  - Twitter: Fan-out on read (millions of followers)
  - Facebook: Fan-out on write (millions of users)
  - LinkedIn: Hybrid approach
  - Instagram: Activity feeds + Cassandra at scale

**Last Updated:** February 2026
**Version:** 1.0
**Status:** Complete for interview preparation
