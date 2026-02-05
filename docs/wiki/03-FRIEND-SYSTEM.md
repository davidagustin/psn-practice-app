# Friend System Deep Dive

This document explains the friend system implementation in detail.

---

## Table of Contents

1. [Overview](#overview)
2. [Data Structures](#data-structures)
3. [Friend Request Flow](#friend-request-flow)
4. [Blocking System](#blocking-system)
5. [Real-time Notifications](#real-time-notifications)
6. [Friend Suggestions](#friend-suggestions)
7. [Edge Cases](#edge-cases)
8. [Interview Questions](#interview-questions)

---

## Overview

The friend system enables PlayStation-style social connections:

- **Send/Accept/Decline** friend requests
- **Remove** existing friends
- **Block/Unblock** users
- **Search** for users by gamertag
- **Real-time notifications** for friend events
- **Friend suggestions** based on mutual connections

### Key Design Decisions

| Decision | Reasoning |
|----------|-----------|
| Redis Sets for friends | O(1) membership check |
| Sorted Sets for requests | Ordered by time, paginated |
| Bidirectional storage | Fast lookup from either user |
| Event-driven notifications | Loose coupling, real-time |
| Per-user channels | Privacy and filtering |

---

## Data Structures

### Redis Key Patterns

```
user:{userId}:friends                    # Set of friend IDs
user:{userId}:friend_requests:incoming   # Sorted Set (score: timestamp)
user:{userId}:friend_requests:outgoing   # Sorted Set (score: timestamp)
user:{userId}:blocked                    # Set of blocked user IDs
friend_request:{fromId}:{toId}           # Hash with request details
```

### Why These Structures?

#### Friends (Set)

```redis
SADD user:A:friends B C D
SMEMBERS user:A:friends        # Get all friends
SISMEMBER user:A:friends B     # Check if B is friend (O(1))
SINTER user:A:friends user:B:friends  # Mutual friends
```

**Benefits:**
- O(1) add/remove/check operations
- Set intersection for mutual friends
- No duplicates by design

#### Friend Requests (Sorted Set)

```redis
ZADD user:A:friend_requests:incoming 1699900000 B
ZRANGE user:A:friend_requests:incoming 0 9 REV  # Latest 10
ZREMRANGEBYSCORE key 0 (old_timestamp)          # Expire old
```

**Benefits:**
- Ordered by timestamp (score)
- Efficient pagination with ZRANGE
- Easy expiration with ZREMRANGEBYSCORE

#### Request Details (Hash)

```redis
HSET friend_request:A:B id "uuid" fromGamertag "PlayerA" createdAt "123"
HGETALL friend_request:A:B
EXPIRE friend_request:A:B 2592000  # 30 days
```

**Benefits:**
- Multiple fields in one key
- Atomic updates with HSET
- TTL for automatic cleanup

### Bidirectional Storage

When A friends B, we store:

```
user:A:friends -> [B]
user:B:friends -> [A]
```

**Why?**
- Query "A's friends" without scanning all users
- O(1) lookup from either direction
- DynamoDB pattern: store relationship twice

---

## Friend Request Flow

### Sending a Request

```typescript
async sendFriendRequest(fromUserId, toUserId, fromGamertag) {
  // 1. VALIDATION
  if (fromUserId === toUserId)
    throw new Error('Cannot friend yourself');

  if (await this.areFriends(fromUserId, toUserId))
    throw new Error('Already friends');

  if (await this.isBlocked(toUserId, fromUserId))
    throw new Error('Cannot send request to this user');

  // 2. CHECK FOR REVERSE REQUEST (Auto-accept)
  const reverseExists = await this.redis.zscore(
    REDIS_KEYS.incomingRequests(fromUserId),
    toUserId
  );
  if (reverseExists) {
    return this.acceptFriendRequest(fromUserId, toUserId);
  }

  // 3. CREATE REQUEST (Atomic transaction)
  const pipeline = this.redis.pipeline();
  pipeline.zadd(outgoingKey, timestamp, toUserId);
  pipeline.zadd(incomingKey, timestamp, fromUserId);
  pipeline.hset(detailsKey, ...details);
  pipeline.expire(detailsKey, 30 * 24 * 60 * 60);
  await pipeline.exec();

  // 4. PUBLISH EVENT
  await this.publishEvent({
    type: 'friend_request_received',
    fromUserId,
    toUserId,
  });
}
```

### Accepting a Request

```typescript
async acceptFriendRequest(userId, fromUserId) {
  // 1. VERIFY REQUEST EXISTS
  const exists = await this.redis.zscore(incomingKey, fromUserId);
  if (!exists) throw new Error('Request not found');

  // 2. CHECK LIMITS
  const friendCount = await this.redis.scard(friendsKey);
  if (friendCount >= 2000) throw new Error('Friend limit reached');

  // 3. CREATE FRIENDSHIP (Atomic)
  const pipeline = this.redis.pipeline();
  pipeline.sadd(friendsKey(userId), fromUserId);      // Add to my friends
  pipeline.sadd(friendsKey(fromUserId), userId);      // Add me to their friends
  pipeline.zrem(incomingKey, fromUserId);             // Remove request
  pipeline.zrem(outgoingKey(fromUserId), userId);     // Remove their outgoing
  pipeline.del(detailsKey);                           // Clean up details
  await pipeline.exec();

  // 4. NOTIFY
  await this.publishEvent({
    type: 'friend_request_accepted',
    fromUserId: userId,
    toUserId: fromUserId,
  });
}
```

### Request State Machine

```
┌─────────┐  send   ┌─────────┐
│  NONE   │ ──────► │ PENDING │
└─────────┘         └────┬────┘
     ▲                   │
     │    ┌──────────────┼──────────────┐
     │    │ decline      │ accept       │ cancel
     │    ▼              ▼              ▼
     │ ┌─────────┐  ┌─────────┐  ┌─────────┐
     └─│ DECLINED│  │ FRIENDS │  │CANCELED │
       └─────────┘  └─────────┘  └─────────┘
```

---

## Blocking System

### Effects of Blocking

When User A blocks User B:

1. **Friendship removed** (if exists)
2. **Pending requests canceled** (both directions)
3. **Future requests prevented** (in both directions)
4. **Presence hidden** (B can't see A's status)
5. **Messaging blocked** (B can't message A)

### Implementation

```typescript
async blockUser(userId, blockedUserId) {
  const pipeline = this.redis.pipeline();

  // Add to blocked set
  pipeline.sadd(REDIS_KEYS.blocked(userId), blockedUserId);

  // Remove friendship (both directions)
  pipeline.srem(REDIS_KEYS.friends(userId), blockedUserId);
  pipeline.srem(REDIS_KEYS.friends(blockedUserId), userId);

  // Cancel pending requests (both directions)
  pipeline.zrem(REDIS_KEYS.incomingRequests(userId), blockedUserId);
  pipeline.zrem(REDIS_KEYS.outgoingRequests(userId), blockedUserId);
  pipeline.zrem(REDIS_KEYS.incomingRequests(blockedUserId), userId);
  pipeline.zrem(REDIS_KEYS.outgoingRequests(blockedUserId), userId);

  await pipeline.exec();
}
```

### Privacy Considerations

- Blocked user is **NOT** notified
- They may notice they can't interact
- Block list is private (only you can see it)

---

## Real-time Notifications

### Event Flow

```
1. Friend action occurs
       ↓
2. FriendService emits event
   this.emit('friendEvent', { type, from, to })
       ↓
3. Server wiring publishes to Redis
   redis.publish('friend:events', event)
       ↓
4. All servers receive via subscriber
       ↓
5. Each server publishes to GraphQL PubSub
   pubsub.publish(`FRIEND_EVENT.${toUserId}`, event)
       ↓
6. WebSocket pushes to subscribed client
```

### User-Specific Channels

```typescript
// Publishing - target specific user
pubsub.publish(`FRIEND_EVENT.${toUserId}`, { event });

// Subscribing - only my events
friendEventReceived: {
  subscribe: (_, __, context) => {
    return pubsub.asyncIterator([
      `FRIEND_EVENT.${context.user.userId}`
    ]);
  }
}
```

**Why user-specific channels?**
- Privacy: Users only see their own events
- Performance: No filtering in resolver
- Security: Can't subscribe to other users' events

---

## Friend Suggestions

### Algorithm

```
1. Get user's friends: [A, B, C]
2. For each friend, get their friends:
   A's friends: [X, Y, Z]
   B's friends: [Y, Z, W]
   C's friends: [X, W, V]
3. Count appearances of non-friends:
   X: 2, Y: 2, Z: 2, W: 2, V: 1
4. Filter blocked users
5. Sort by count, return top N
```

### Implementation

```typescript
async getFriendSuggestions(userId, limit = 10) {
  const friends = await this.getFriends(userId);
  const mutualCounts = new Map<string, number>();

  for (const friendId of friends) {
    const friendsOfFriend = await this.getFriends(friendId);

    for (const suggestion of friendsOfFriend) {
      // Skip self and existing friends
      if (suggestion === userId || friends.includes(suggestion)) continue;

      // Skip blocked users
      if (await this.isEitherBlocked(userId, suggestion)) continue;

      // Increment count
      mutualCounts.set(
        suggestion,
        (mutualCounts.get(suggestion) || 0) + 1
      );
    }
  }

  // Sort by count, return top suggestions
  return Array.from(mutualCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([userId, count]) => ({ userId, mutualFriendCount: count }));
}
```

### Production Optimization

For large friend graphs, this should be:
- **Precomputed** in a batch job
- **Cached** with periodic refresh
- **ML-enhanced** with additional signals

---

## Edge Cases

### Race Conditions

**Problem:** Two users send requests to each other simultaneously.

**Solution:** Check for reverse request before creating new one:

```typescript
const reverseExists = await this.redis.zscore(
  incomingRequests(fromUserId),
  toUserId
);
if (reverseExists) {
  // Auto-accept their request instead
  return this.acceptFriendRequest(fromUserId, toUserId);
}
```

### Request Expiration

**Problem:** Old requests accumulate.

**Solution:** TTL on request details + periodic cleanup:

```typescript
// Set TTL when creating
pipeline.expire(detailsKey, 30 * 24 * 60 * 60);

// Cleanup job (run periodically)
async cleanupExpiredRequests() {
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  await this.redis.zremrangebyscore(
    incomingKey,
    0,
    thirtyDaysAgo
  );
}
```

### Friend Limit

**Problem:** Need to enforce max 2000 friends.

**Solution:** Check count before accepting:

```typescript
const count = await this.redis.scard(friendsKey);
if (count >= 2000) {
  throw new Error('Maximum friends reached');
}
```

### Blocked User Tries to Unblock First

**Problem:** Blocked user might try to unblock blocker.

**Solution:** Only check your own blocked list:

```typescript
async unblockUser(userId, blockedUserId) {
  // Only remove from YOUR blocked set
  const removed = await this.redis.srem(
    REDIS_KEYS.blocked(userId),  // Your list
    blockedUserId
  );
  if (removed === 0) {
    throw new Error('User is not blocked');
  }
}
```

---

## Interview Questions

### 1. "How would you design a friend system at scale?"

**Answer Points:**
- **Storage**: Redis Sets for O(1) operations, bidirectional for fast queries
- **Requests**: Sorted Sets for time-ordered, paginated lists
- **Notifications**: Pub/Sub for real-time, user-specific channels
- **Limits**: Enforce max friends (2000), max pending requests (500)
- **Edge cases**: Race conditions, expiration, blocking

### 2. "How do you handle blocking?"

**Answer Points:**
- Block removes existing friendship
- Cancels pending requests in both directions
- Prevents future friend requests
- Hides presence from blocked user
- Blocked user is NOT explicitly notified (privacy)

### 3. "How would you implement 'People You May Know'?"

**Answer Points:**
- Count friends-of-friends appearances
- Filter existing friends and blocked users
- Rank by mutual connection count
- For production: precompute, cache, add ML signals

### 4. "What happens if two users send requests simultaneously?"

**Answer Points:**
- Check for reverse request before creating new one
- If reverse exists, auto-accept instead
- Use atomic Redis transactions
- Prevents duplicate requests

### 5. "How do you scale friend operations?"

**Answer Points:**
- Redis Cluster for data sharding
- Consistent hashing for user distribution
- Read replicas for heavy read operations
- Batch operations (MGET, pipeline) to reduce round trips
