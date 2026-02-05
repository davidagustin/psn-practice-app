# Rate Limiting - PlayStation Network Backend Interview Guide

**Target Audience:** Backend engineers preparing for senior-level interviews
**Document Version:** 1.0
**Last Updated:** February 2026

## Table of Contents

1. [Overview](#overview)
2. [Why Rate Limiting?](#why-rate-limiting)
3. [Rate Limiting Algorithms](#rate-limiting-algorithms)
4. [Implementation with Redis](#implementation-with-redis)
5. [Multi-Tier Rate Limiting](#multi-tier-rate-limiting)
6. [Response Handling](#response-handling)
7. [Code Examples](#code-examples)
8. [Interview Questions & Answers](#interview-questions--answers)
9. [Common Pitfalls & Solutions](#common-pitfalls--solutions)

---

## Overview

Rate limiting is the art of controlling how much work a user or client can do in a given timeframe. At PlayStation Network's scale, it protects against:

- Spam and abuse
- Distributed Denial of Service (DDoS) attacks
- Accidental resource exhaustion
- Unfair resource consumption

This guide covers production-grade rate limiting patterns with Redis, optimized for:

- **Accuracy:** Track usage precisely with sliding windows
- **Fairness:** All users treated equally regardless of timing
- **Performance:** O(log n) operations even with millions of users
- **Scalability:** Works across distributed systems with Redis Cluster

---

## Why Rate Limiting?

### 1. Protection Against Abuse

**Scenario:** User A sends 1000 chat messages per second

```
Without rate limiting:
- Messages flood Redis
- Other users' messages delayed
- Database becomes bottleneck
- System degrades for everyone

With rate limiting:
- User A capped at 30 messages/minute
- Remaining messages rejected with 429 Too Many Requests
- Other users unaffected
- Fair resource distribution
```

### 2. Protection Against DDoS

**Scenario:** Attacker floods `/send-message` endpoint

```
Without rate limiting:
- Server processes 100,000 requests/second
- CPU/memory spike
- Legitimate traffic dropped
- Service offline

With rate limiting:
- Per-IP limit: 100 requests/second
- Per-user limit: 30 messages/minute
- Excess requests instantly rejected (no processing)
- Legitimate users continue normally
```

### 3. Fair Resource Distribution

**Scenario:** 100M users share limited database capacity

```
Without rate limiting:
- 1000 power users each send 1000/minute
- = 1M requests from 1% of users
- 99% of users starved

With rate limiting:
- Each user limited to 30/minute
- Total requests = 100M × 30/60 = 50M/minute
- Predictable load, all users get fair share
```

### 4. Cost Control

**Scenario:** Unexpected traffic spike

```
Without rate limiting:
- Auto-scaling kicks in
- Thousands of new database connections
- Cloud costs spike (thousands → millions)
- Takes hours to scale back down

With rate limiting:
- Excess traffic rejected early
- No new connections opened
- Costs predictable
- System protects itself
```

---

## Rate Limiting Algorithms

### Comparison Table

| Algorithm | Accuracy | Memory | O(1)? | Burst Handling | Use Case |
|-----------|----------|--------|-------|---|----------|
| **Fixed Window** | Poor (edge case) | O(1) | Yes | None | Simple APIs (least preferred) |
| **Sliding Window Log** | Excellent | O(n) | No | Smooth | High-accuracy audit logs |
| **Sliding Window Counter** | Very Good | O(1) | Yes | Smooth | **Most common - what we use** |
| **Token Bucket** | Excellent | O(1) | Yes | Controlled | Burst with rate limit |
| **Leaky Bucket** | Excellent | O(1) | Yes | Queue | Rate-limited queue |

### 1. Fixed Window (Simple but Flawed)

**Algorithm:**
- Divide time into fixed buckets (e.g., minutes)
- Count requests in current bucket
- Reset counter at bucket boundary

**Visualization:**

```
Bucket 1       Bucket 2       Bucket 3
(0:00-1:00)    (1:00-2:00)    (2:00-3:00)
  [3 reqs]        [0 reqs]        [X]
  Allowed!
```

**The Edge Case Problem:**

```
Limit: 5 requests/minute

0:59:50  ▓▓▓▓▓ (5 requests in bucket 1)
         All allowed

1:00:00  ▓▓▓▓▓ (5 requests in bucket 2)  ⚠️  BURST!
         All allowed

Total in 10 seconds: 10 requests (2x limit)
```

**Why it fails:**
- User can burst at bucket boundary
- Violates "rate" (should be per unit time, not per fixed window)

**When to use:**
- Simple APIs with lenient requirements
- Least preferred in production

### 2. Sliding Window Log (Accurate but Memory-Intensive)

**Algorithm:**
- Store exact timestamp of every request
- Remove timestamps outside window
- Count remaining

**Visualization:**

```
Window: 60 seconds
Current time: 1:45:30

Timeline:
├─ 1:44:32 ▓ (in window, 58s old)
├─ 1:44:45 ▓ (in window, 45s old)
├─ 1:44:58 ▓ (in window, 32s old)
├─ 1:45:10 ▓ (in window, 20s old)
├─ 1:45:25 ▓ (in window, 5s old)
└─ 1:45:30 ▓ (in window, current)

Count: 6 requests → allowed if limit ≥ 6
```

**Pros:**
- Perfect accuracy (exact request times)
- No edge cases
- Great for audit logs

**Cons:**
- O(n) memory per user
- With 30 requests/minute limit × 100M users = 3B timestamps in Redis!
- Expensive to clean up

**Implementation:**

```typescript
// NOT recommended for large scale
async checkRateLimitLog(userId: string): Promise<boolean> {
  const key = `ratelimit:log:${userId}`;
  const now = Date.now();
  const windowStart = now - 60 * 1000;

  // Remove old entries (memory cleanup)
  await redis.zremrangebyscore(key, 0, windowStart);

  // Count in window
  const count = await redis.zcard(key);

  if (count >= 30) {
    return false;  // Rate limited
  }

  // Add timestamp (memory grows with every request!)
  await redis.zadd(key, now, `${now}-${uuid()}`);
  return true;
}
```

**When to use:**
- High-value audit systems
- Small number of users
- Compliance requirements (exact timestamp proof)

---

### 3. Sliding Window Counter (Balanced - What We Use)

**Algorithm:**
- Count requests in current window
- Cleanup old entries outside window
- Allow/deny based on count

**Key insight:** Don't store individual timestamps, just count!

**Visualization:**

```
Window size: 60 seconds
Limit: 5 requests

Timeline (moving window):
┌─────────────────────────────────────────────┐
│ Current 60 seconds                          │
│ 1:44:30 ─────────────────────────── 1:45:30 │
│         ▓ ▓ ▓   ▓   ▓                       │
└─────────────────────────────────────────────┘
Count: 5 → Allowed

Later:
┌─────────────────────────────────────────────┐
│ Current 60 seconds                          │
│ 1:45:00 ─────────────────────────── 1:46:00 │
│             ▓   ▓   ▓    ▓   ▓              │
└─────────────────────────────────────────────┘
Count: 5 → Allowed

Edge case (slight burst, still within SLA):
┌─────────────────────────────────────────────┐
│ Current 60 seconds                          │
│ 1:45:50 ─────────────────────────── 1:46:50 │
│                    ▓▓▓▓▓▓                   │
└─────────────────────────────────────────────┘
Count: 6 → Denied

Why this matters: We allow temporary bursts as long
as the average rate stays under limit. Much more fair
than hard window cutoffs.
```

**Why it's better than fixed window:**

```
Fixed Window problem:
Minute 1:00-1:59   Minute 2:00-2:59
[5 requests] ✓     [5 requests at 2:00] ✓
Burst at 1:59:50-2:00:10 = 10 reqs in 20 seconds!

Sliding Window solution:
At 1:59:50, can only add if past requests + new < limit
At 2:00:10, old requests from 1:00:10 are outside window
Prevents burst
```

**Pros:**
- Very accurate (nearly as good as log)
- O(1) memory per user (just count + timestamp)
- Works at scale (100M users)
- Handles bursts fairly

**Cons:**
- Slight inaccuracy possible (discussed below)
- Requires cleanup job or expiration

**Slight Inaccuracy Example:**

```
Assume we only store ONE counter + last request time:
- Requests are not evenly distributed
- We count all requests as if they arrived at same time

Real: 1:00:00, 1:00:10, 1:00:20, 1:00:30
Counted as: All at 1:00:30

This is usually acceptable because:
1. The inaccuracy decreases with window size
2. We clean up frequently
3. Most requests are evenly distributed
4. Small bursts are often acceptable anyway
```

**Redis Implementation (What ChatService Uses):**

```typescript
async checkRateLimit(userId: string): Promise<RateLimitResult> {
  const key = `ratelimit:${userId}`;
  const now = Date.now();
  const windowStart = now - 60000;  // 60 second window

  // Step 1: Remove entries outside window (O(log n))
  await redis.zremrangebyscore(key, 0, windowStart);

  // Step 2: Count remaining (O(1))
  const currentCount = await redis.zcard(key);

  // Step 3: Check limit
  if (currentCount >= 30) {
    return { allowed: false, resetInSeconds: 60 };
  }

  // Step 4: Add current request (O(log n))
  await redis.zadd(key, now, `${now}-${uuid()}`);

  // Step 5: Set expiration for cleanup (O(1))
  await redis.expire(key, 61);

  return { allowed: true, remaining: 30 - currentCount - 1 };
}
```

**Complexity Analysis:**
- ZREMRANGEBYSCORE: O(log n + m) where m = entries to remove
- ZCARD: O(1)
- ZADD: O(log n)
- EXPIRE: O(1)
- **Total:** O(log n) ✓

**When to use:**
- Most production systems
- Chat, messaging, API endpoints
- Fairness matters

---

### 4. Token Bucket (For Controlled Bursts)

**Algorithm:**
- Bucket starts with N tokens
- Each request costs 1 token
- Tokens refill at R requests/second
- Allow if tokens available, deny otherwise

**Visualization:**

```
Bucket capacity: 10 tokens
Refill rate: 2 tokens/second

Initial:
┌──────────────────┐
│ ●●●●●●●●●● (10) │  Ready for burst
└──────────────────┘

Request 1: Remove 1 token
┌──────────────────┐
│ ●●●●●●●●●  (9)  │
└──────────────────┘

Wait 1 second (refill 2 tokens):
┌──────────────────┐
│ ●●●●●●●●●●● (11) │  Capped at max
└──────────────────┘ (oversupply discarded)

Burst: 5 requests in 1 second
┌──────────────────┐
│ ●●●●●●      (6)  │
└──────────────────┘

Request 6 allowed? No (only 6 tokens, limit is 5)
```

**Use Cases:**

```
1. API endpoints: Allow burst, rate limit average
   - Bucket: 10 tokens
   - Refill: 1 token/second
   - User can send 10 requests instantly, then 1/second

2. Download: Allow quick start, throttle over time
   - Bucket: 1MB
   - Refill: 100KB/second
   - Quick burst for headers, then sustained rate

3. Message batching: Allow bursts if rate averages out
   - Bucket: 100 messages
   - Refill: 10 messages/second
   - User can send 100 at once, then wait 10 seconds
```

**Implementation:**

```typescript
interface TokenBucket {
  capacity: number;        // max tokens
  tokensPerSecond: number; // refill rate
  tokens: number;          // current tokens
  lastRefillAt: number;    // timestamp of last refill
}

async checkTokenBucket(userId: string): Promise<boolean> {
  const key = `bucket:${userId}`;

  // Get current bucket state
  const data = await redis.get(key);
  const bucket = data ? JSON.parse(data) : {
    capacity: 100,
    tokensPerSecond: 10,
    tokens: 100,
    lastRefillAt: Date.now(),
  };

  // Calculate tokens added since last refill
  const now = Date.now();
  const secondsElapsed = (now - bucket.lastRefillAt) / 1000;
  const tokensAdded = secondsElapsed * bucket.tokensPerSecond;

  // Refill (capped at capacity)
  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + tokensAdded
  );
  bucket.lastRefillAt = now;

  // Check if request allowed
  if (bucket.tokens < 1) {
    return false;  // No tokens, request denied
  }

  // Allow request
  bucket.tokens -= 1;
  await redis.set(key, JSON.stringify(bucket), 'EX', 3600);

  return true;
}
```

**When to use:**
- Allow bursts with rate limiting
- Smooth out traffic spikes
- Fair across users with different usage patterns

---

### 5. Leaky Bucket (For Queue-Based Rate Limiting)

**Algorithm:**
- Requests enter a bucket (queue)
- Requests leak out at constant rate
- If bucket overflows, reject new requests

**Visualization:**

```
Leak rate: 2 requests/second
Bucket capacity: 10 requests

Incoming requests: ▓▓▓▓▓▓▓▓
┌──────────────────────────────┐
│ Input:                       │
│ ▓▓▓ (3 requests/second)      │
│         │                    │
│         ▼                    │
│    ┌─────────────────────┐   │
│    │ ●●●●●●●●●● Queue   │   │
│    │ (capacity: 10)      │   │
│    └─────────────────────┘   │
│         │                    │
│         ▼                    │
│ Output: ▓▓ (2/sec leak)      │
└──────────────────────────────┘
```

**Key difference from Token Bucket:**
- Token Bucket: Immediate rejection when no tokens
- Leaky Bucket: Requests queue, processed in order

**When to use:**
- Message queues (RabbitMQ, Kafka)
- Scheduled task processing
- Smoothing traffic peaks (decouple input from output)

---

## Implementation with Redis

### Sliding Window Counter (Our Implementation)

The ChatService uses sliding window counters with sorted sets. Here's how it works:

**Data Structure:**

```
Key: chat:ratelimit:{userId}
Type: Sorted Set

Members: "{timestamp}-{uuid}"
Scores: timestamp values (milliseconds)

Example:
"1707000000000-abc123" → 1707000000000
"1707000000100-def456" → 1707000000100
"1707000005000-ghi789" → 1707000005000

Count: 3 requests in window
```

**Why Sorted Sets?**

```
1. Automatic ordering: Members sorted by score (timestamp)
2. Efficient range queries: ZRANGEBYSCORE removes old entries in O(log n)
3. Built-in TTL: EXPIRE cleans up entire key
4. O(1) counting: ZCARD returns count instantly
```

### Step-by-Step Algorithm

**Step 1: Remove Expired Entries**

```typescript
const windowStart = now - windowSeconds * 1000;
await redis.zremrangebyscore(key, 0, windowStart);
```

```
Before:
  "req1" (score: 1706999900000)  ← Outside window (old)
  "req2" (score: 1707000010000)  ← In window
  "req3" (score: 1707000015000)  ← In window

After ZREMRANGEBYSCORE:
  "req2" (score: 1707000010000)
  "req3" (score: 1707000015000)
```

**Step 2: Count Requests in Window**

```typescript
const currentCount = await redis.zcard(key);
```

```
Current window (last 60 seconds):
  "req2" (score: 1707000010000)
  "req3" (score: 1707000015000)

Count: 2 requests
Limit: 30 requests
Remaining: 28 requests ✓ ALLOWED
```

**Step 3: Allow or Deny**

```typescript
if (currentCount >= 30) {
  // Rate limited
  const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
  const retryAfterSeconds = Math.ceil(
    (oldest[1] + windowSeconds * 1000 - now) / 1000
  );
  return { allowed: false, retryAfterSeconds };
}
```

**Step 4: Add Request and Set Expiration**

```typescript
await redis.zadd(key, now, `${now}-${uuid()}`);
await redis.expire(key, windowSeconds + 1);
```

```
After ZADD:
  "req2" (score: 1707000010000)
  "req3" (score: 1707000015000)
  "req4" (score: 1707000020000)  ← New entry

TTL: 61 seconds (ensures cleanup of old keys)
```

### Complete Code Example

```typescript
interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
  retryAfterSeconds?: number;
}

async checkRateLimit(userId: string): Promise<RateLimitResult> {
  const key = `chat:ratelimit:${userId}`;
  const now = Date.now();
  const windowStart = now - 60000;  // 60 second window

  // Step 1: Remove old entries (O(log n + m))
  // m = number of entries to remove
  await this.redis.zremrangebyscore(key, 0, windowStart);

  // Step 2: Count entries in window (O(1))
  const currentCount = await this.redis.zcard(key);

  // Step 3: Check if rate limited (O(1))
  if (currentCount >= 30) {
    // Get oldest entry to calculate retry-after
    const oldest = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
    const oldestTimestamp = oldest.length > 1 ? parseInt(oldest[1]) : now;
    const retryAfterSeconds = Math.ceil(
      (oldestTimestamp + 60000 - now) / 1000
    );

    return {
      allowed: false,
      remaining: 0,
      resetInSeconds: 60,
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    };
  }

  // Step 4: Add request to window (O(log n))
  // Use {now}-{uuid} to ensure uniqueness
  await this.redis.zadd(key, now, `${now}-${uuidv4()}`);

  // Step 5: Set expiration for cleanup (O(1))
  // TTL = window + 1 second to avoid race conditions
  await this.redis.expire(key, 61);

  return {
    allowed: true,
    remaining: 30 - currentCount - 1,
    resetInSeconds: 60,
  };
}
```

### Complexity Analysis

| Operation | Complexity | Why |
|-----------|-----------|-----|
| ZREMRANGEBYSCORE | O(log n + m) | Remove m entries from sorted set of size n |
| ZCARD | O(1) | Sorted set stores count, no iteration |
| ZADD | O(log n) | Insert into sorted set |
| EXPIRE | O(1) | Set TTL on key |
| **Total** | **O(log n)** | Logarithmic, scalable to millions of users |

### Memory Usage

```
30 requests/minute × 100M users

Option 1: Store individual entries
= 30 entries × 100M users
= 3 billion entries in Redis
= 3B × 100 bytes per entry ≈ 300GB ❌ Too much

Option 2: Sliding window counter (ZCARD)
= 1 counter per user × 100M users
= 100M × 32 bytes (integer + metadata)
= ~3.2GB ✓ Acceptable

Our approach saves 100x memory!
```

### Lua Script for Atomic Operations (Advanced)

For complex rate limiting with side effects, use Lua scripts for atomicity:

```typescript
// If not exists, create and allow
const script = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])

  -- Remove old entries
  redis.call('zremrangebyscore', key, 0, now - window * 1000)

  -- Count in window
  local count = redis.call('zcard', key)

  -- Check limit
  if count >= limit then
    return {0, count}  -- Denied
  end

  -- Add request
  redis.call('zadd', key, now, now .. '-' .. math.random())
  redis.call('expire', key, window + 1)

  return {1, count + 1}  -- Allowed, new count
`;

const [allowed, count] = await redis.eval(
  script,
  1,
  `ratelimit:${userId}`,
  Date.now(),
  60,  // window in seconds
  30   // limit
);
```

---

## Multi-Tier Rate Limiting

Production systems need multiple limits at different levels:

### Tier 1: Global Rate Limit

**Purpose:** Protect entire system from overwhelming load

**Example:**
```
Key: ratelimit:global:chat
Limit: 1 million messages/minute across ALL users
When exceeded: Reject traffic, alert ops
```

**Implementation:**

```typescript
async checkGlobalRateLimit(): Promise<boolean> {
  const key = 'ratelimit:global:chat';
  const now = Date.now();

  // Remove old entries
  await redis.zremrangebyscore(key, 0, now - 60000);

  const count = await redis.zcard(key);

  if (count >= 1000000) {
    logger.alert('Global rate limit exceeded!');
    return false;
  }

  // Add server identifier
  const serverId = process.env.SERVER_ID;
  await redis.zadd(key, now, serverId);

  return true;
}
```

### Tier 2: Per-User Rate Limit

**Purpose:** Ensure fair distribution among users

**Example:**
```
Key: ratelimit:user:{userId}
Limit: 30 messages/minute per user
```

**Implementation:**

```typescript
// From chat.service.ts (lines 813-851)
async checkRateLimit(userId: string): Promise<RateLimitResult> {
  const key = `chat:ratelimit:${userId}`;
  const now = Date.now();
  const windowStart = now - this.config.rateLimitWindowSeconds * 1000;

  await this.redis.zremrangebyscore(key, 0, windowStart);
  const currentCount = await this.redis.zcard(key);

  if (currentCount >= this.config.rateLimitMaxMessages) {
    const oldest = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
    const oldestTimestamp = oldest.length > 1 ? parseInt(oldest[1]) : now;
    const retryAfterSeconds = Math.ceil(
      (oldestTimestamp + this.config.rateLimitWindowSeconds * 1000 - now) / 1000
    );

    return {
      allowed: false,
      remaining: 0,
      resetInSeconds: this.config.rateLimitWindowSeconds,
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    };
  }

  await this.redis.zadd(key, now, `${now}-${uuidv4()}`);
  await this.redis.expire(key, this.config.rateLimitWindowSeconds + 1);

  return {
    allowed: true,
    remaining: this.config.rateLimitMaxMessages - currentCount - 1,
    resetInSeconds: this.config.rateLimitWindowSeconds,
  };
}
```

### Tier 3: Per-IP Rate Limit

**Purpose:** Prevent abusive clients from overwhelming services

**Example:**
```
Key: ratelimit:ip:{clientIp}
Limit: 100 requests/minute per IP
```

**Implementation:**

```typescript
async checkIPRateLimit(clientIp: string): Promise<boolean> {
  const key = `ratelimit:ip:${clientIp}`;
  const now = Date.now();
  const windowStart = now - 60000;

  await redis.zremrangebyscore(key, 0, windowStart);
  const count = await redis.zcard(key);

  if (count >= 100) {
    return false;  // Rate limited
  }

  await redis.zadd(key, now, uuid());
  await redis.expire(key, 61);

  return true;
}
```

### Tier 4: Per-Endpoint Rate Limit

**Purpose:** Different limits for different endpoints

**Example:**

```
/send-message: 30/minute
/create-conversation: 10/minute
/upload-photo: 2/minute
```

**Implementation:**

```typescript
const ENDPOINT_LIMITS = {
  'sendMessage': { limit: 30, windowSeconds: 60 },
  'createConversation': { limit: 10, windowSeconds: 60 },
  'uploadPhoto': { limit: 2, windowSeconds: 3600 },
};

async checkEndpointRateLimit(
  userId: string,
  endpoint: string
): Promise<boolean> {
  const config = ENDPOINT_LIMITS[endpoint];
  const key = `ratelimit:${endpoint}:${userId}`;
  const now = Date.now();
  const windowStart = now - config.windowSeconds * 1000;

  await redis.zremrangebyscore(key, 0, windowStart);
  const count = await redis.zcard(key);

  if (count >= config.limit) {
    return false;
  }

  await redis.zadd(key, now, uuid());
  await redis.expire(key, config.windowSeconds + 1);

  return true;
}
```

### Tier 5: Adaptive Rate Limiting (Advanced)

**Purpose:** Adjust limits based on system load

**Example:**

```
If system load > 80%:
  - Global limit reduced by 50%
  - User limit reduced by 30%
  - Protect from cascade failure
```

**Implementation:**

```typescript
async getAdaptiveLimit(baseLimit: number): Promise<number> {
  const metrics = await prometheus.getMetrics();
  const cpuUsage = metrics.cpu;
  const memoryUsage = metrics.memory;
  const load = (cpuUsage + memoryUsage) / 2;

  if (load > 90) {
    return Math.floor(baseLimit * 0.3);  // 70% reduction
  } else if (load > 80) {
    return Math.floor(baseLimit * 0.5);  // 50% reduction
  } else if (load > 70) {
    return Math.floor(baseLimit * 0.8);  // 20% reduction
  }

  return baseLimit;  // Normal limit
}

async checkAdaptiveRateLimit(
  userId: string,
  baseLimit: number
): Promise<boolean> {
  const adaptiveLimit = await this.getAdaptiveLimit(baseLimit);
  const key = `ratelimit:${userId}`;
  const now = Date.now();

  await redis.zremrangebyscore(key, 0, now - 60000);
  const count = await redis.zcard(key);

  if (count >= adaptiveLimit) {
    return false;
  }

  await redis.zadd(key, now, uuid());
  return true;
}
```

---

## Response Handling

### HTTP Status Code

**429 Too Many Requests**

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 45
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1707000045

{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Maximum 30 requests per 60 seconds.",
  "retryAfterSeconds": 45,
  "resetAt": "2026-02-04T12:00:45Z"
}
```

### Standard Headers

**Request Phase (before checking limit):**

```
X-RateLimit-Limit: 30       # Maximum requests allowed
X-RateLimit-Remaining: 28   # Requests left in window
X-RateLimit-Reset: 1707000045  # Unix timestamp when limit resets
```

**Rejection Response:**

```
Retry-After: 45             # Seconds to wait before retry
```

### Explanation per Algorithm

**Sliding Window Counter:**

```
Requests: 27 out of 30
Window: 60 seconds
Current time: 1707000000

Calculate reset time:
  Oldest request: 1707000000000 (time in milliseconds)
  Window size: 60000 (60 seconds in milliseconds)
  Reset time: 1707000000000 + 60000 = 1707000060000

Convert to Unix seconds:
  Reset: 1707000060000 / 1000 = 1707000060

Retry-After:
  Current: 1707000000
  Reset: 1707000060
  Wait: 60 seconds

Headers:
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 3
X-RateLimit-Reset: 1707000060
Retry-After: 60
```

### GraphQL Response Format

**Error handling in GraphQL:**

```typescript
// In resolvers
async sendMessage(
  parent: any,
  args: SendMessageInput,
  context: GraphQLContext
): Promise<ChatMessage> {
  try {
    const result = await chatService.sendMessage(
      context.userId,
      args
    );
    return result;
  } catch (error) {
    if (error.message.includes('Rate limit')) {
      // Extract retry-after from error
      const match = error.message.match(/wait (\d+) seconds/);
      const retryAfter = match ? parseInt(match[1]) : 60;

      throw new GraphQLError(
        'Too Many Requests',
        {
          extensions: {
            code: 'TOO_MANY_REQUESTS',
            retryAfterSeconds: retryAfter,
            timestamp: new Date().toISOString(),
          },
        }
      );
    }
    throw error;
  }
}
```

**Client handling:**

```javascript
// Client code
async function sendMessage(message) {
  try {
    const response = await graphQL.mutation(SEND_MESSAGE, {
      message,
    });
    return response;
  } catch (error) {
    if (error.extensions?.code === 'TOO_MANY_REQUESTS') {
      const wait = error.extensions.retryAfterSeconds;
      console.log(`Rate limited. Retry after ${wait} seconds.`);

      // Exponential backoff with jitter
      const delay = wait * 1000 + Math.random() * 1000;
      setTimeout(() => sendMessage(message), delay);
    }
  }
}
```

---

## Code Examples

### Example 1: Basic Rate Limiting (from ChatService)

```typescript
// From chat.service.ts - lines 449-463
async sendMessage(
  senderId: string,
  input: SendMessageInput
): Promise<ChatMessage> {
  const { conversationId, content, type = 'text', metadata } = input;

  // Step 0: Check rate limit BEFORE any other operation
  const rateLimitResult = await this.checkRateLimit(senderId);
  if (!rateLimitResult.allowed) {
    throw new Error(
      `Rate limit exceeded. Please wait ${rateLimitResult.retryAfterSeconds} seconds before sending another message.`
    );
  }

  // Step 1: Validate sender is a participant
  const conversation = await this.getConversation(conversationId, senderId);
  if (!conversation) {
    throw new Error('Conversation not found or access denied');
  }

  // Step 2-7: Create and store message...
  // (rest of implementation)
}
```

### Example 2: Multi-Tier Rate Limiting

```typescript
class RateLimitingService {
  constructor(private redis: Redis) {}

  /**
   * Check all rate limits in order
   * Fail fast if any tier is exceeded
   */
  async checkAllLimits(
    userId: string,
    clientIp: string,
    endpoint: string
  ): Promise<RateLimitResult> {
    // Tier 1: Global limit (protects entire system)
    const globalAllowed = await this.checkGlobalRateLimit();
    if (!globalAllowed) {
      return {
        allowed: false,
        tier: 'global',
        retryAfterSeconds: 300,  // 5 minutes
      };
    }

    // Tier 2: IP limit (protects from abusive clients)
    const ipAllowed = await this.checkIPRateLimit(clientIp);
    if (!ipAllowed) {
      return {
        allowed: false,
        tier: 'ip',
        retryAfterSeconds: 60,
      };
    }

    // Tier 3: User limit (ensures fairness)
    const userResult = await this.checkUserRateLimit(userId);
    if (!userResult.allowed) {
      return {
        allowed: false,
        tier: 'user',
        retryAfterSeconds: userResult.retryAfterSeconds,
        remaining: userResult.remaining,
      };
    }

    // Tier 4: Endpoint limit (endpoint-specific constraints)
    const endpointAllowed = await this.checkEndpointRateLimit(
      userId,
      endpoint
    );
    if (!endpointAllowed) {
      return {
        allowed: false,
        tier: 'endpoint',
        retryAfterSeconds: 60,
      };
    }

    // All limits passed
    return {
      allowed: true,
      remaining: userResult.remaining,
      resetInSeconds: 60,
    };
  }

  private async checkGlobalRateLimit(): Promise<boolean> {
    const key = 'ratelimit:global:messages';
    const now = Date.now();

    await this.redis.zremrangebyscore(key, 0, now - 60000);
    const count = await this.redis.zcard(key);

    // 1 million messages/minute global limit
    if (count >= 1000000) {
      logger.alert('GLOBAL RATE LIMIT EXCEEDED');
      return false;
    }

    await this.redis.zadd(key, now, `${now}-${uuid()}`);
    return true;
  }

  private async checkIPRateLimit(clientIp: string): Promise<boolean> {
    const key = `ratelimit:ip:${clientIp}`;
    const now = Date.now();

    await this.redis.zremrangebyscore(key, 0, now - 60000);
    const count = await this.redis.zcard(key);

    // 100 requests/minute per IP
    if (count >= 100) {
      return false;
    }

    await this.redis.zadd(key, now, `${now}-${uuid()}`);
    await this.redis.expire(key, 61);
    return true;
  }

  private async checkUserRateLimit(
    userId: string
  ): Promise<RateLimitResult> {
    const key = `ratelimit:user:${userId}`;
    const now = Date.now();
    const windowStart = now - 60000;

    await this.redis.zremrangebyscore(key, 0, windowStart);
    const count = await this.redis.zcard(key);

    if (count >= 30) {
      const oldest = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
      const retryAfterSeconds = Math.ceil(
        (parseInt(oldest[1]) + 60000 - now) / 1000
      );

      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, retryAfterSeconds),
      };
    }

    await this.redis.zadd(key, now, `${now}-${uuid()}`);
    await this.redis.expire(key, 61);

    return {
      allowed: true,
      remaining: 30 - count - 1,
      retryAfterSeconds: 60,
    };
  }

  private async checkEndpointRateLimit(
    userId: string,
    endpoint: string
  ): Promise<boolean> {
    const limits: Record<string, { limit: number; window: number }> = {
      'sendMessage': { limit: 30, window: 60 },
      'createConversation': { limit: 10, window: 60 },
      'updateProfile': { limit: 5, window: 300 },
    };

    const config = limits[endpoint];
    if (!config) return true;  // No limit defined

    const key = `ratelimit:endpoint:${endpoint}:${userId}`;
    const now = Date.now();

    await this.redis.zremrangebyscore(
      key,
      0,
      now - config.window * 1000
    );
    const count = await this.redis.zcard(key);

    if (count >= config.limit) {
      return false;
    }

    await this.redis.zadd(key, now, `${now}-${uuid()}`);
    await this.redis.expire(key, config.window + 1);

    return true;
  }
}
```

### Example 3: Implementing Backoff Strategy (Client-Side)

```typescript
class ClientRateLimiter {
  /**
   * Exponential backoff with jitter
   * Used when server returns 429
   */
  async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3
  ): Promise<T> {
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        // Check if this is a rate limit error
        if (error.extensions?.code === 'TOO_MANY_REQUESTS') {
          const retryAfter =
            error.extensions.retryAfterSeconds || 60;

          // Exponential backoff: 2^attempt * base + jitter
          const baseDelay = retryAfter * 1000;
          const exponentialDelay = baseDelay * Math.pow(2, attempt);
          const jitter = Math.random() * 1000;
          const delay = exponentialDelay + jitter;

          console.log(
            `Rate limited. Retrying after ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
          );

          await this.sleep(delay);
        } else {
          throw error;  // Not rate limit, fail immediately
        }
      }
    }

    throw lastError;  // All retries exhausted
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Usage
const limiter = new ClientRateLimiter();

const message = await limiter.retryWithBackoff(async () => {
  return await graphQL.mutation(SEND_MESSAGE, {
    content: 'Hello!',
  });
});
```

---

## Interview Questions & Answers

### Q1: Explain sliding window counter algorithm and why it's better than fixed window

**Good Answer:**

"Sliding window counter is a practical balance between accuracy and efficiency.

**Fixed window problem:**
- Time is divided into fixed buckets (e.g., 1:00-2:00)
- User can burst at bucket boundary
- Example: 5 requests/minute limit
  - 0:59:50: 5 requests allowed
  - 1:00:00: 5 more requests allowed
  - Total in 10 seconds: 10 requests (2x limit)

**Sliding window counter solution:**
- Window moves continuously
- Always count last N seconds
- Example at 1:00:10:
  - Check: 'last 60 seconds of requests'
  - If 5 requests already sent in that window, deny 6th
  - Even if they arrive at same time, only 5 allowed

**Why it's better:**
1. **Fair:** Prevents bursting at boundaries
2. **Efficient:** O(log n) with Redis sorted sets
3. **Scalable:** Works for 100M+ users
4. **Simple:** Easy to understand and implement
5. **Flexible:** Can adjust window size without redesign

**Trade-off:** Slight inaccuracy if requests not evenly distributed, but acceptable for most use cases."

---

### Q2: How would you implement rate limiting across distributed servers?

**Good Answer:**

"Rate limiting at scale requires **centralized state in Redis**, not local in-process state.

**Wrong approach (local state):**
```
Server A: tracks user's requests
Server B: tracks same user's requests independently
Server C: tracks same user's requests independently

User sends 15 requests to each server = 45 total
Each server sees only 15, allows all ✓
User bypasses limit ❌
```

**Right approach (centralized Redis):**
```
┌─────────────┐
│ Server A    │
│ (user 123)  │─┐
└─────────────┘ │
                │
┌─────────────┐ │  All check same Redis key
│ Server B    │ ├──→ ratelimit:user:123
│ (user 123)  │ │  (sorted set: 45 timestamps)
└─────────────┘ │
                │
┌─────────────┐ │
│ Server C    │ │
│ (user 123)  │─┘
└─────────────┘

User sends 15 to each server:
  Server A: ZCARD = 0 → ZADD 15 → ZCARD = 15 ✓
  Server B: ZCARD = 15 → ZADD 15 → ZCARD = 30 ✓
  Server C: ZCARD = 30 → ZADD 15 → ZCARD = 45 ❌ Over limit
```

**Implementation:**

```typescript
async checkRateLimit(userId: string): Promise<boolean> {
  const key = `ratelimit:${userId}`;
  const now = Date.now();
  const windowStart = now - 60000;

  // Step 1: Remove old entries outside window
  await redis.zremrangebyscore(key, 0, windowStart);

  // Step 2: Count in window
  const count = await redis.zcard(key);

  // Step 3: Check against limit
  if (count >= 30) {
    return false;  // Rate limited
  }

  // Step 4: Add request
  await redis.zadd(key, now, `${now}-${uuid()}`);

  // Step 5: Set TTL for cleanup
  await redis.expire(key, 61);

  return true;
}
```

**Why this works:**
1. **Single source of truth:** Redis holds all request data
2. **Atomic operations:** Redis operations are atomic
3. **Scales:** No inter-server communication needed
4. **Fast:** Sub-millisecond operations
5. **Distributed:** Works across any number of servers

**Potential issue:** Redis becomes single point of failure
**Solution:** Use Redis Cluster or Sentinel for HA"

---

### Q3: What happens if Redis goes down? How would you handle it?

**Good Answer:**

"Redis outages need fallback strategies depending on SLA:

**Option 1: Fail Open (Lenient)**
```typescript
async checkRateLimit(userId: string): Promise<boolean> {
  try {
    return await this.checkRateLimitRedis(userId);
  } catch (error) {
    logger.error('Redis down, allowing request');
    return true;  // Allow request if Redis unavailable
  }
}
```

Pros: Service stays up
Cons: No rate limiting during outage (risk of abuse)

Use for: Non-critical endpoints (search, profiles)

**Option 2: Fail Closed (Strict)**
```typescript
async checkRateLimit(userId: string): Promise<boolean> {
  try {
    return await this.checkRateLimitRedis(userId);
  } catch (error) {
    logger.error('Redis down, rejecting request');
    throw new Error('Rate limit check unavailable');
  }
}
```

Pros: Protect against abuse
Cons: Service partially down during outage

Use for: Critical endpoints (payments, login)

**Option 3: Local Fallback (Hybrid)**
```typescript
async checkRateLimit(userId: string): Promise<boolean> {
  try {
    return await this.checkRateLimitRedis(userId);
  } catch (error) {
    logger.warn('Redis down, using local fallback');
    return this.checkRateLimitLocal(userId);  // Use in-process cache
  }
}

checkRateLimitLocal(userId: string): boolean {
  const now = Date.now();

  if (!this.localCache.has(userId)) {
    this.localCache.set(userId, {
      count: 0,
      windowStart: now,
    });
  }

  const bucket = this.localCache.get(userId);

  // Reset if window expired
  if (now - bucket.windowStart > 60000) {
    bucket.count = 0;
    bucket.windowStart = now;
  }

  if (bucket.count >= 30) {
    return false;
  }

  bucket.count++;
  return true;
}
```

Pros: Service stays up with basic protection
Cons: Not accurate across servers (but better than nothing)

Use for: Acceptable SLA allows minor violations

**Best practice (what PSN uses):**
1. Primary: Redis (accurate, distributed)
2. Fallback: Local cache (degraded but functional)
3. Monitoring: Alert when Redis down
4. Recovery: Automatic failover to Sentinel/Cluster"

---

### Q4: How would you rate limit by different dimensions (user, IP, endpoint)?

**Good Answer:**

"Different dimensions protect against different attack vectors. Layer them:

**Dimension 1: IP-based (prevent scanners)**
```
Limit: 100 requests/minute per IP
Protects: Network layer attacks
Example: Bot scanning all endpoints
```

**Dimension 2: User-based (ensure fairness)**
```
Limit: 30 requests/minute per user
Protects: Individual abuse
Example: One user hogging resources
```

**Dimension 3: Endpoint-based (prevent endpoint abuse)**
```
Limit: 2 uploads/minute per user
Limit: 10 follows/minute per user
Limit: 30 messages/minute per user
Protects: Endpoint-specific attacks
Example: User uploading millions of files
```

**Implementation strategy:**

```typescript
// Check all limits, fail on first one
async sendMessage(userId: string, clientIp: string): Promise<void> {
  // Check IP limit FIRST (fastest to reject)
  if (!await this.checkIPLimit(clientIp, 100)) {
    throw new Error('IP rate limit exceeded');
  }

  // Check user limit (more expensive, slower)
  if (!await this.checkUserLimit(userId, 30)) {
    throw new Error('User rate limit exceeded');
  }

  // Check endpoint limit (most expensive, slowest)
  if (!await this.checkEndpointLimit(userId, 'sendMessage', 30)) {
    throw new Error('Endpoint rate limit exceeded');
  }

  // All limits passed, process request
  await this.processSendMessage(userId);
}
```

**Why this order (IP → User → Endpoint)?**
1. IP checks are O(1) and fast
2. If most requests are from 10 IPs, reject there
3. Only proceed to User limits if IP is okay
4. Only check Endpoint if User limit okay
5. Saves CPU by failing fast

**Redis keys:**
```
ratelimit:ip:{ip}                    # Global per IP
ratelimit:user:{userId}              # Global per user
ratelimit:endpoint:sendMessage:{userId}  # Per endpoint + user
```

**Monitoring and alerting:**
```typescript
// Alert if specific IP is hitting limits
const ipLimit = await this.redis.zcard(`ratelimit:ip:${clientIp}`);
if (ipLimit > 90) {
  logger.warn(`IP ${clientIp} approaching limit: ${ipLimit}/100`);
}

// Alert if entire endpoint is being hit
const endpointCount = await this.redis.get('ratelimit:global:sendMessage');
if (endpointCount > 800000) {  // 80% of 1M limit
  logger.alert('sendMessage endpoint at 80% capacity');
}
```"

---

### Q5: How would you implement token bucket rate limiting?

**Good Answer:**

"Token bucket allows controlled bursts while maintaining average rate.

**Concept:**
- Bucket holds N tokens (capacity)
- Tokens refill at R per second (rate)
- Each request costs 1 token
- Request allowed if tokens available

**Why it's better than fixed rate:**
```
Fixed rate: 10 requests/second
  Second 1: Process 10 requests ✓
  Second 2: Process 10 requests ✓

With spike: If you have 20 requests in first second:
  Process 10 ✓
  Reject 10 ✗

Token bucket: 100 tokens, refill 10/second
  Initial: 100 tokens
  Spike of 20: Process 20 ✓ (use all tokens)
  Now: 0 tokens
  Wait 10 seconds to refill (1 token/second)

Allows burst if tokens available, then throttles
```

**Implementation:**

```typescript
interface TokenBucket {
  capacity: number;        // Max tokens
  tokensPerSecond: number; // Refill rate
  tokens: number;          // Current tokens
  lastRefillAt: number;    // Last refill timestamp
}

async checkTokenBucket(userId: string): Promise<boolean> {
  const key = `bucket:${userId}`;

  // Get or create bucket
  let bucket: TokenBucket;
  const data = await redis.get(key);

  if (data) {
    bucket = JSON.parse(data);
  } else {
    bucket = {
      capacity: 100,
      tokensPerSecond: 10,
      tokens: 100,
      lastRefillAt: Date.now(),
    };
  }

  // Calculate tokens added
  const now = Date.now();
  const secondsElapsed = (now - bucket.lastRefillAt) / 1000;
  const tokensAdded = secondsElapsed * bucket.tokensPerSecond;

  // Refill (capped at capacity)
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensAdded);
  bucket.lastRefillAt = now;

  // Check if allowed
  if (bucket.tokens < 1) {
    // Save state and reject
    await redis.set(key, JSON.stringify(bucket), 'EX', 3600);
    return false;
  }

  // Consume token
  bucket.tokens -= 1;
  await redis.set(key, JSON.stringify(bucket), 'EX', 3600);

  return true;
}
```

**Trade-offs:**
- Pro: Allows bursts (better UX)
- Pro: Smooth traffic (predictable load)
- Con: Slightly more complex
- Con: More Redis storage (whole bucket per user)

**When to use:**
- APIs with bursty traffic
- Downloads (quick start, then sustained)
- Message batching

**Alternative: Sliding window counter**
- If you don't want to allow bursts, use sliding window
- More common in production
- Simpler implementation"

---

### Q6: How would you design a rate limiter that adapts to system load?

**Good Answer:**

"Adaptive rate limiting reduces limits when system is under stress:

**Concept:**
```
System load: 30%  → Apply normal limits
System load: 60%  → Apply 80% of normal limits
System load: 80%  → Apply 50% of normal limits
System load: 95%  → Apply 10% of normal limits (circuit breaker)
```

**Benefits:**
- Protects database when under load
- Prevents cascade failure
- Automatically recovers when load drops

**Implementation:**

```typescript
async getAdaptiveLimit(baseLimit: number): Promise<number> {
  // Get system metrics
  const metrics = await prometheus.getMetrics();
  const cpuUsage = metrics.cpu / 100;  // 0.5 = 50%
  const memoryUsage = metrics.memory / 100;

  // Average load
  const load = (cpuUsage + memoryUsage) / 2;

  // Reduce limit proportionally
  if (load > 0.95) {
    // Circuit breaker: almost down
    return 0;  // Reject all
  } else if (load > 0.90) {
    // Critical: 10% capacity
    return Math.floor(baseLimit * 0.1);
  } else if (load > 0.80) {
    // High: 50% capacity
    return Math.floor(baseLimit * 0.5);
  } else if (load > 0.70) {
    // Elevated: 80% capacity
    return Math.floor(baseLimit * 0.8);
  } else if (load > 0.50) {
    // Normal: 100% capacity
    return baseLimit;
  }

  // Low load: allow burst
  return Math.floor(baseLimit * 1.2);
}

async checkAdaptiveRateLimit(
  userId: string,
  baseLimit: number
): Promise<boolean> {
  const adaptiveLimit = await this.getAdaptiveLimit(baseLimit);

  if (adaptiveLimit === 0) {
    throw new Error('Service overloaded, rejecting request');
  }

  // Use adaptive limit instead of base
  const key = `ratelimit:${userId}`;
  const now = Date.now();

  await redis.zremrangebyscore(key, 0, now - 60000);
  const count = await redis.zcard(key);

  if (count >= adaptiveLimit) {
    return false;
  }

  await redis.zadd(key, now, uuid());
  return true;
}
```

**Monitoring:**

```typescript
async monitorAndAlert(): Promise<void> {
  const metrics = await prometheus.getMetrics();
  const load = (metrics.cpu + metrics.memory) / 2;

  if (load > 0.80) {
    logger.alert(`System overloaded: ${load}%`, {
      cpu: metrics.cpu,
      memory: metrics.memory,
      activeLimits: await redis.get('adaptive:limits'),
    });

    // Trigger auto-scaling if needed
    await kubernetes.scaleUp();
  }

  if (load < 0.30) {
    logger.info('System under-utilized, scaling down');
    await kubernetes.scaleDown();
  }
}
```

**Why this matters:**
- Prevents cascade failures
- Degrades gracefully under load
- Automatically prioritizes critical operations
- Simple to implement with metrics system"

---

## Common Pitfalls & Solutions

### Pitfall 1: Checking Rate Limit Too Late

**Problem:**

```typescript
// WRONG: Rate limit check after expensive operations
async sendMessage(userId: string, message: string): Promise<void> {
  // Expensive: Database queries, object creation, etc.
  const conversation = await db.getConversation(message.conversationId);
  const sender = await db.getUser(userId);
  const enrichedMessage = enrichMessage(message, sender);

  // Rate limit check LAST (too late!)
  const allowed = await checkRateLimit(userId);
  if (!allowed) {
    throw new Error('Rate limited');  // Wasted CPU
  }

  await db.saveMessage(enrichedMessage);
}
```

**Why it's wrong:**
- If rate limited, wasted work already done
- Attacks that spam your API use all your CPU
- Expensive operations are called even for rejected requests

**Solution:**

```typescript
// RIGHT: Rate limit check FIRST
async sendMessage(userId: string, message: string): Promise<void> {
  // Step 1: Rate limit check FIRST (O(1) operation)
  const allowed = await checkRateLimit(userId);
  if (!allowed) {
    throw new Error('Rate limited');  // Fail fast, no wasted work
  }

  // Step 2: Only then do expensive operations
  const conversation = await db.getConversation(message.conversationId);
  const sender = await db.getUser(userId);
  const enrichedMessage = enrichMessage(message, sender);

  // Step 3: Save
  await db.saveMessage(enrichedMessage);
}
```

---

### Pitfall 2: Not Setting TTL on Rate Limit Keys

**Problem:**

```typescript
// WRONG: Rate limit key never expires
async checkRateLimit(userId: string): Promise<boolean> {
  const key = `ratelimit:${userId}`;

  const count = await redis.zcard(key);
  if (count >= 30) {
    return false;
  }

  await redis.zadd(key, Date.now(), uuid());
  // FORGOT: No expire() call!
  // Key stays in Redis forever

  return true;
}
```

**Why it's wrong:**
- Inactive users' rate limit keys never deleted
- Redis memory grows indefinitely
- Eventually fills up Redis instance

**Solution:**

```typescript
// RIGHT: Always set TTL
async checkRateLimit(userId: string): Promise<boolean> {
  const key = `ratelimit:${userId}`;
  const now = Date.now();

  await redis.zremrangebyscore(key, 0, now - 60000);
  const count = await redis.zcard(key);

  if (count >= 30) {
    return false;
  }

  await redis.zadd(key, now, uuid());
  await redis.expire(key, 61);  // ✓ Set TTL

  return true;
}
```

**TTL = window + 1 second** to avoid race conditions

---

### Pitfall 3: Race Condition in Increment Operations

**Problem:**

```typescript
// WRONG: Not atomic
const count = await redis.zcard(key);
if (count >= 30) {
  return false;
}
// ← Another request could arrive here
await redis.zadd(key, Date.now(), uuid());
// Both see count=29, both add, result = 31 ✗
```

**Why it's wrong:**
- Between ZCARD and ZADD, another request can arrive
- Both see same count, both pass
- Total requests exceed limit

**Solution:**

```typescript
// RIGHT: Use atomic operations
const script = `
  local key = KEYS[1]
  local limit = tonumber(ARGV[1])
  local now = tonumber(ARGV[2])
  local window = tonumber(ARGV[3])

  -- Remove old entries
  redis.call('zremrangebyscore', key, 0, now - window * 1000)

  -- Count
  local count = redis.call('zcard', key)

  -- Check + add in single atomic operation
  if count >= limit then
    return 0  -- Denied
  end

  -- Add request
  redis.call('zadd', key, now, now)
  redis.call('expire', key, window + 1)

  return 1  -- Allowed
`;

const result = await redis.eval(script, 1, key, 30, Date.now(), 60);
return result === 1;
```

---

### Pitfall 4: Rate Limiting the Wrong Identity

**Problem:**

```typescript
// WRONG: Rate limit by username (easy to spoof)
async checkRateLimit(username: string): Promise<boolean> {
  const key = `ratelimit:${username}`;
  // Attacker: Create 100 fake accounts, each can send 30/min
  // Total: 100 × 30 = 3000/min ✗
}
```

**Solution:**

```typescript
// RIGHT: Rate limit by user ID (from verified auth)
async checkRateLimit(userId: string): Promise<boolean> {
  const key = `ratelimit:${userId}`;
  // userId comes from JWT, can't be spoofed
}

// Also rate limit by IP (catches coordinated attacks)
async checkIPRateLimit(clientIp: string): Promise<boolean> {
  const key = `ratelimit:ip:${clientIp}`;
  // Blocks an entire IP if abusive
}
```

---

### Pitfall 5: Not Handling Retry-After Header

**Problem:**

```typescript
// Client retrying without backoff
for (let i = 0; i < maxRetries; i++) {
  try {
    return await sendMessage(message);
  } catch (error) {
    // Immediately retry ✗
    // Server returns Retry-After: 60, client ignores it
  }
}
```

**Why it's wrong:**
- Wastes server resources
- If 1M clients all retry immediately, 2M requests hit server
- Amplifies problem instead of solving it

**Solution:**

```typescript
// RIGHT: Respect Retry-After header
async retryWithBackoff(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error.response?.status === 429) {
        // Extract Retry-After header
        const retryAfter = parseInt(
          error.response.headers['retry-after'] || '60'
        );

        // Exponential backoff
        const delay = retryAfter * 1000 * Math.pow(2, attempt);

        console.log(`Waiting ${delay}ms before retry`);
        await sleep(delay);
      } else {
        throw error;  // Not rate limit, fail
      }
    }
  }
}
```

---

### Pitfall 6: Not Monitoring Rate Limit Effectiveness

**Problem:**

```typescript
// WRONG: Set limits and forget
async checkRateLimit(userId: string): Promise<boolean> {
  // Limit: 30/minute
  // Set it and forget about it
  // No idea if it's working, too strict, or too lenient
}
```

**Solution:**

```typescript
// RIGHT: Monitor and adjust
async checkRateLimit(userId: string): Promise<boolean> {
  const key = `ratelimit:${userId}`;
  const now = Date.now();

  await redis.zremrangebyscore(key, 0, now - 60000);
  const count = await redis.zcard(key);

  if (count >= 30) {
    // Log rate limit events for monitoring
    await metrics.recordRateLimitExceeded({
      userId,
      limit: 30,
      current: count,
      timestamp: now,
    });

    return false;
  }

  await redis.zadd(key, now, uuid());
  await redis.expire(key, 61);

  // Also log successful requests
  await metrics.recordRateLimitAllowed({
    userId,
    remaining: 30 - count - 1,
  });

  return true;
}

// Monitor effectiveness
async monitorRateLimits(): Promise<void> {
  const exceededCount = await metrics.getCount('rate_limit_exceeded');
  const allowedCount = await metrics.getCount('rate_limit_allowed');

  const hitRate = exceededCount / (exceededCount + allowedCount);

  if (hitRate > 0.05) {
    // 5% of requests rate limited
    logger.warn('High rate limit hit rate', { hitRate });
  }

  if (hitRate < 0.001) {
    // <0.1% of requests rate limited
    logger.info('Rate limit rarely triggered, might be too generous');
  }
}
```

---

## Summary: Key Takeaways

| Concept | Details | Complexity |
|---------|---------|-----------|
| **Fixed Window** | Simple but edge cases; burst at boundary | O(1) |
| **Sliding Window Log** | Accurate but memory-heavy; stores all timestamps | O(n) |
| **Sliding Window Counter** | **Best choice:** accurate, efficient, scalable | O(log n) |
| **Token Bucket** | Allows controlled bursts | O(1) |
| **Leaky Bucket** | Queue-based, smooth output | O(1) |
| **Multi-tier** | IP, User, Endpoint, Global; layer protections | O(log n) × tiers |
| **Adaptive** | Adjust limits based on system load | O(1) |
| **Monitoring** | Track hit rates, adjust limits, alert on abuse | O(1) |

### Redis Implementation Checklist

- [ ] Use sorted sets for sliding window (not individual keys)
- [ ] Clean up old entries with ZREMRANGEBYSCORE
- [ ] Set TTL on keys to auto-cleanup
- [ ] Check rate limit BEFORE expensive operations
- [ ] Use atomic Lua scripts for complex logic
- [ ] Return Retry-After header on 429
- [ ] Monitor rate limit hit rates
- [ ] Layer multiple limits (IP, User, Endpoint)
- [ ] Fail gracefully when Redis is down
- [ ] Alert on abnormal patterns

---

## References

- **ChatService Implementation:** `/Users/davidagustin/Desktop/codingfolder/psn-practice-app/src/services/chat/chat.service.ts` (lines 793-871)
- **Redis Cluster:** `/Users/davidagustin/Desktop/codingfolder/psn-practice-app/src/infrastructure/redis-cluster/index.ts`
- **Server Setup:** `/Users/davidagustin/Desktop/codingfolder/psn-practice-app/src/server.ts`

---

**Last Updated:** February 4, 2026
**For:** Senior Backend Engineer Interviews
**Difficulty:** Medium-Advanced
