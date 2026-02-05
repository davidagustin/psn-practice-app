# Interview Questions - PlayStation Network Backend Interview Guide

**Target Audience:** Senior Backend Engineers interviewing at gaming companies (PlayStation, Xbox, EA, Riot Games, Activision, etc.)

**Document Version:** 1.0

**Last Updated:** February 2026

---

## Table of Contents

1. [System Design Questions](#system-design-questions) (10 questions)
2. [Redis Questions](#redis-questions) (8 questions)
3. [GraphQL Questions](#graphql-questions) (8 questions)
4. [Real-time Systems Questions](#real-time-systems-questions) (8 questions)
5. [Microservices Questions](#microservices-questions) (8 questions)
6. [Scaling Questions](#scaling-questions) (8 questions)
7. [Behavioral & Experience Questions](#behavioral--experience-questions) (5 questions)
8. [Quick-Fire Technical Questions](#quick-fire-technical-questions) (10 questions)
9. [Interview Strategies & Tips](#interview-strategies--tips)

---

## System Design Questions

### Q1: Design a Friend System for 100M Users

**Question:** Design a friend system for PlayStation Network that supports 100M concurrent users. Users should be able to add friends, see who's online, and get friend suggestions. What data structures would you use? How would you handle the scale?

**Key Points to Cover:**

1. **Data Structure Selection**
   - Friends as Redis Sets (O(1) membership checks)
   - Pending requests as Sorted Sets (ordered by timestamp)
   - Blocked users as Redis Sets

2. **Storage Strategy**
   - Redis for hot data (active friends, current online status)
   - DynamoDB for historical data (friend history, metadata)
   - Bidirectional storage (`user:A:friends` and `user:B:friends`)

3. **Scaling Approach**
   - Horizontal scaling of servers
   - Redis Cluster for distributed cache
   - Database sharding by user ID

4. **Real-time Updates**
   - Pub/Sub for broadcasting friend events
   - WebSocket subscriptions for friend status changes
   - Event-driven architecture

5. **Query Optimization**
   - SINTER for mutual friends
   - SMEMBERS pagination for large friend lists
   - Denormalization of friend count

**Sample Answer Structure:**

```
1. Data Model (2-3 min):
   - Explain Redis Strings/Sets/Sorted Sets choice
   - Why bidirectional storage matters
   - Hybrid storage (Redis + DynamoDB)

2. Scaling Strategy (2 min):
   - Multiple stateless servers
   - Redis Cluster (not single Redis)
   - Database sharding approach

3. Real-time Features (2 min):
   - Pub/Sub for notifications
   - How friends learn about each other coming online
   - Heartbeat mechanism for presence

4. Edge Cases (1 min):
   - Circular friend requests (A→B, B→A simultaneously)
   - Friend removed then re-added
   - Block/unblock during pending request
```

**Follow-up Questions to Expect:**

- "What if Redis goes down?"
  - Answer: Degrade to polling, periodically sync with DynamoDB

- "How do you prevent race conditions?"
  - Answer: Distributed locks, Lua scripts, pipeline atomicity

- "How would you suggest friends?"
  - Answer: Batch job analyzing mutual friends, games played, activity patterns
  - Would use Kafka for async processing

- "What about privacy settings?"
  - Answer: Add visibility tier to friend relationships (public/friends-only/hidden)
  - Filter in resolvers based on permission checks

**Red Flags (Common Mistakes):**

- ❌ "I'd query the database for every friend check" → Doesn't scale, O(n) complexity
- ❌ "I'd store all friends in a single Redis key" → No sharding strategy
- ❌ "I'd use a list to store friends" → O(n) membership checks instead of O(1)
- ❌ "I'd notify every user when someone comes online" → 100M* 50 friends = 5B notifications
- ❌ "I'd use a relational database" → Doesn't scale to billions of relationships

**Follow-up Depth Interview Can Go:**

If they seem confident:
- Implement mutual friend algorithm and complexity
- Sharding strategy for billions of edges
- Cache invalidation strategy
- A/B testing friend suggestions

---

### Q2: Design a Real-time Presence System for a Gaming Platform

**Question:** Design a presence system that shows 100M users whether their friends are online, what game they're playing, and their status message. Updates should be in real-time with sub-100ms latency.

**Key Points to Cover:**

1. **Heartbeat Mechanism**
   - Client sends heartbeat every 60 seconds
   - Server refreshes presence TTL (5 minutes)
   - Auto-cleanup of stale presence data

2. **Data Storage**
   - Presence as Redis Strings with TTL
   - Online users set for fast lookup
   - Game-specific sets for "friends playing X game"

3. **Real-time Broadcasting**
   - Redis Pub/Sub for cross-server events
   - Apollo subscriptions for client updates
   - Local filtering on each server

4. **Edge Cases**
   - Ungraceful disconnects (TTL handles this)
   - Presence updates faster than propagation time
   - Device-specific presence (mobile vs console)

5. **Performance Optimization**
   - Batch presence fetches with MGET
   - Caching presence locally after fetch
   - Delta updates (only send what changed)

**Sample Answer Structure:**

```
1. Architecture (1-2 min):
   - Presence stored as Redis String: presence:{userId} = {...}
   - TTL: 5 minutes for auto-cleanup
   - Publish to Redis channel: presence:updates

2. Client Behavior (1 min):
   - Heartbeat every 60 seconds from client
   - Server receives → refresh TTL
   - Subscribe via GraphQL subscription

3. Server-to-Server (1-2 min):
   - Server A: User goes online
   - Publish to Redis: presence:updates
   - All servers receive
   - Each server filters to its clients
   - Push to WebSocket only for friends

4. Latency Analysis (1 min):
   - Network to server: ~50ms
   - Redis write: <1ms
   - Publish to Redis: <1ms
   - All servers receive: <10ms
   - Filter and push: <10ms
   - Total: ~100ms (acceptable)
```

**Follow-up Questions to Expect:**

- "How do you handle 1M concurrent heartbeats?"
  - Answer: Stagger heartbeats (randomize within 10 seconds), use pipelining

- "What if presence data needs to be accurate to 10ms?"
  - Answer: Increase heartbeat frequency, but adds server load

- "How do you know when someone goes offline?"
  - Answer: TTL expiration is passive; can implement cleanup job that:
    1. Scans for expired presence keys
    2. Publishes offline event
    3. Removes from online set

- "Can presence be edited while heartbeat is happening?"
  - Answer: Yes, refresh always overwrites; use pipelining to be atomic

**Red Flags:**

- ❌ "I'd store presence in the database" → Too slow, database isn't for real-time
- ❌ "I'd push to every user's friends" → Doesn't scale to 100M
- ❌ "I'd query heartbeats from database" → 100M heartbeats/min would overwhelm DB
- ❌ "I'd use polling instead of subscriptions" → Can't do sub-100ms with polling
- ❌ "I don't need TTL" → Ungraceful disconnects would cause stale data forever

---

### Q3: Design a Chat System with Message History

**Question:** Design a real-time chat system for millions of concurrent users. Messages should be instantly delivered, queryable for history, and support multiple participants (1:1 and group chats). How would you handle scale?

**Key Points to Cover:**

1. **Two-Tier Message Storage**
   - Redis for recent messages (hot data, bounded size)
   - DynamoDB for historical messages (persistent, queryable)

2. **Real-time Delivery**
   - Redis Pub/Sub per conversation
   - WebSocket subscriptions for live messages
   - Message acknowledgment for delivery confirmation

3. **Conversation Management**
   - Conversation metadata in Redis Hash
   - User's conversation list sorted by last activity
   - Participant management for access control

4. **Deduplication**
   - Client request ID for idempotency
   - Server-side dedup key in Redis
   - Prevents duplicate messages

5. **Typing Indicators**
   - Typing status as Redis String with TTL
   - Published to conversation channel
   - Auto-cleanup on timeout

**Sample Answer Structure:**

```
1. Storage (2 min):
   - Recent messages: Redis List (bounded to 100 most recent)
   - Conversation data: Redis Hash
   - Old messages: DynamoDB with GSI on userId for history queries
   - Conversation index: Sorted Set by lastUpdatedAt

2. Delivery (2 min):
   - Message sent → store in Redis
   - Publish to conversation channel
   - All servers with subscribers get notified
   - Push to online clients via WebSocket
   - Offline clients fetch on reconnect

3. Deduplication (1 min):
   - Client generates requestId
   - Server checks cache: dedup:{requestId}
   - If exists: return cached message
   - If new: create and cache response

4. Typing Indicators (1 min):
   - User typing → SET typing:{convId}:{userId} = '1' EX 5
   - Publish to channel
   - Receivers see "User is typing"
   - Expires after 5s of inactivity
```

**Follow-up Questions to Expect:**

- "How do you query message history?"
  - Answer: Query DynamoDB with userId partition key, sort by timestamp, use pagination tokens

- "What if two messages arrive out of order?"
  - Answer: Client-side sorting by timestamp, server ensures monotonic timestamps

- "How do you handle group chat scaling?"
  - Answer: Multiple Pub/Sub channels per conversation, not per user; reduces channels

- "What about message encryption?"
  - Answer: End-to-end encryption at application layer, server never sees plaintext

**Red Flags:**

- ❌ "Store all messages in Redis" → Memory cost, not durable
- ❌ "Store all messages in database" → Database reads too slow for chat
- ❌ "Push message to every participant individually" → Doesn't scale for groups
- ❌ "No deduplication" → Double-sends from network retries
- ❌ "Fetch all history on every load" → Huge query, kills latency

---

### Q4: Design an Activity Feed System

**Question:** Design an activity feed showing what friends are playing, achievements they unlocked, etc. Users should see a personalized feed of their friends' activities. How would you handle millions of users generating billions of events?

**Key Points to Cover:**

1. **Event Types & Flow**
   - User starts game → publish event
   - User unlocks achievement → publish event
   - Event reaches activity feed service
   - Stored in user's feed

2. **Fan-Out Strategy (Two Approaches)**
   - **Option A: Fan-out on Write** (eager)
     - User's activity published to all followers' feeds
     - 1 write becomes 1000 writes (if 1000 followers)
     - Complex for celebrities with millions of followers

   - **Option B: Fan-out on Read** (lazy)
     - Store in global feed
     - When user loads feed, query all friends' activities
     - Slower read, simpler write

3. **Hybrid Approach (Recommended)**
   - Fan-out on write for regular users (<10K followers)
   - Fan-out on read for power users (>10K followers)
   - Cache recent activities

4. **Data Structure**
   - Activity: Sorted Set ordered by timestamp
   - User feed: Sorted Set `activity:{userId}:feed`
   - Global activity: Sorted Set `activity:global`
   - Notification queue: List for async processing

5. **Consistency**
   - Eventual consistency acceptable (users can see activities seconds later)
   - No need for strong consistency

**Sample Answer Structure:**

```
1. Event Production (1 min):
   - Game service: user starts game
   - Emit event: game_session_started
   - Publish to activity service via Kafka

2. Fan-Out Decision (1 min):
   - Get follower count for user
   - If < 10K: fan-out on write
     - Add to each follower's feed (async)
   - If >= 10K: fan-out on read
     - Store in central index

3. Feed Retrieval (1 min):
   - User loads feed
   - Query: friends' recent activities (from Sorted Sets)
   - Query: power users' activities (from global index)
   - Merge and paginate

4. Scale Handling (1 min):
   - Use Kafka for async processing
   - Batch writes (don't individually add each follower)
   - Delete old activities (>30 days)
```

**Follow-up Questions to Expect:**

- "What if a celebrity has 10M followers?"
  - Answer: Fan-out on read; query just followers' activity feeds, not individual push

- "How do you handle activity deletion/update?"
  - Answer: Mark as deleted, filter in read path; hard delete after TTL

- "What about duplicate events?"
  - Answer: Use requestId deduplication, similar to chat messages

- "How fresh does the feed need to be?"
  - Answer: Establish SLA with product (example: 95% within 5 seconds)

**Red Flags:**

- ❌ "Fan-out on write for all users" → Celebrity with 10M followers = 10M writes
- ❌ "Store all activities in database" → Querying billions of rows is slow
- ❌ "No caching" → Every feed load queries friends' activities
- ❌ "Synchronous processing" → Activity service blocks on fan-out completion
- ❌ "No TTL on old activities" → Feed grows unbounded

---

### Q5: Design a Rate Limiting System

**Question:** Design a rate limiting system to prevent abuse. Different operations have different limits: 100 friend requests/day, 1000 messages/hour, 100 API calls/minute. How would you implement this at scale?

**Key Points to Cover:**

1. **Three-Tier Approach**
   - Global rate limit (API gateway level)
   - Per-user limits (application level)
   - Per-resource limits (operation-specific)

2. **Token Bucket Algorithm**
   - Refill bucket at fixed rate
   - Consume tokens on request
   - Reject if bucket empty
   - Implemented in Redis using Lua scripts

3. **Data Structure**
   - Rate limit key: `ratelimit:{userId}:{operation}`
   - Value: number of tokens remaining
   - TTL: window duration

4. **Distributed Implementation**
   - All servers share Redis bucket
   - Atomic increment/decrement
   - No duplicate counting

5. **Edge Cases**
   - User crossing time boundary (11:59 PM)
   - Burst handling (allow 2x bucket for short spike)
   - Graceful degradation if Redis down

**Sample Answer Structure:**

```
1. Algorithm Choice (1 min):
   - Token Bucket vs. Sliding Window vs. Leaky Bucket
   - Token Bucket: simple, allows bursts, easy to implement
   - Use Lua script for atomicity

2. Redis Implementation (1-2 min):
   - Key: ratelimit:{userId}:{operation}
   - Script:
     1. Get current count
     2. Check against limit
     3. Increment if allowed
     4. Set expiration for window
     5. Return allowed/denied

3. Multi-Tier Setup (1 min):
   - Gateway: 1M req/min global
   - GraphQL: 1000 req/min per user
   - Friend service: 5 requests/day per user per recipient

4. Handling Limits (1 min):
   - Hit limit: return 429 (Too Many Requests)
   - Response header: X-RateLimit-Remaining
   - Client-side backoff (exponential)
```

**Follow-up Questions to Expect:**

- "What if user gets exactly 100 friend requests?"
  - Answer: Increment limit key 100 times, on 101st request returns 429

- "How do you handle different time zones?"
  - Answer: Use UTC server time, not client time; prevents gaming the system

- "What about rate limits per IP?"
  - Answer: Additional tracking `ratelimit:ip:{ipAddress}:{operation}`

- "How do you handle distributed systems?"
  - Answer: Redis is the single source of truth; all servers increment the same key

**Red Flags:**

- ❌ "Store rate limits in application memory" → Different servers see different counts
- ❌ "Use database to track" → Too slow, can't handle high throughput
- ❌ "No distributed approach" → Easy to bypass with multiple servers
- ❌ "Reset at midnight" → Doesn't work with distributed systems (which midnight?)
- ❌ "No Lua script" → Race condition between read and write

---

### Q6: Design a Matchmaking System for Multiplayer Games

**Question:** Design a matchmaking system that pairs players for multiplayer games. Players queue up and get matched with similarly skilled opponents within 30 seconds. Millions of players queue concurrently.

**Key Points to Cover:**

1. **Queue Management**
   - Sorted Set queue ordered by skill rating
   - Per-game queues
   - Per-region queues (latency matters)

2. **Matching Algorithm**
   - Find nearest skill rating within tolerance
   - Time-based tolerance increase (wait longer = lower standards)
   - Region proximity for low latency

3. **Scaling Issues**
   - Millions queuing simultaneously
   - Finding "nearest neighbor" in queue
   - Allocating game servers

4. **Data Structure**
   - Queue: Sorted Set `queue:{game}:{region}` with rating as score
   - Match attempts: Sorted Set `matchmaking:attempts:{queueId}`
   - Allocated servers: Pool of available game servers

5. **Fault Tolerance**
   - Player accepts match within 10 seconds
   - If decline/timeout: return to queue
   - Server allocation with availability tracking

**Sample Answer Structure:**

```
1. Queue Structure (1 min):
   - Per-game, per-region sorted sets
   - Score = player's skill rating
   - Member = playerId

2. Matching Logic (2 min):
   - Every 5 seconds: match round
   - For each player in queue:
     1. Find players within ±500 rating (initial tolerance)
     2. Check if in same region (ping < 50ms)
     3. Create match, notify players
   - If no match: increase tolerance

3. Time-Based Tolerance (1 min):
   - 0-10s wait: tolerance ±500 rating
   - 10-20s wait: tolerance ±1000 rating
   - 20-30s wait: tolerance ±2000 rating (more lenient over time)

4. Server Allocation (1 min):
   - Keep pool of ready game servers
   - On match: allocate server
   - Notify both players with server address
   - Release server on game end
```

**Follow-up Questions to Expect:**

- "What happens if queues are unbalanced?"
  - Answer: Increase tolerance more aggressively; prioritize giving players a match

- "How do you handle rage quits during matchmaking?"
  - Answer: Set flag to not match them for 5 minutes; anti-grief measure

- "What about regional server capacity?"
  - Answer: Track available game servers per region; if full, queue cross-region

**Red Flags:**

- ❌ "Linear search through queue to find match" → O(n), too slow for millions
- ❌ "Match everyone with anyone" → Poor player experience (skill mismatch)
- ❌ "No tolerance increase over time" → Some players wait 10 minutes
- ❌ "Database queries for queue" → Too slow, Redis only

---

### Q7: Design a Leaderboard System

**Question:** Design a leaderboard showing top 1000 players by score. Millions of players update scores constantly. Leaderboard should update in near real-time and support global, regional, and friend-based leaderboards.

**Key Points to Cover:**

1. **Data Structure**
   - Sorted Set: `leaderboard:{game}:{type}` with score as member
   - Score: numeric value (points, rating, wins, etc.)
   - Multiple sorted sets for different views

2. **Update Strategy**
   - Player score changes: ZADD to update
   - Atomic increment for point gains

3. **Query Optimization**
   - ZREVRANGE for top N (O(log n + N))
   - ZRANK for player's rank (O(log n))
   - Cache top 100 in a separate key

4. **Multiple Leaderboards**
   - Global: `leaderboard:game_123:global`
   - Regional: `leaderboard:game_123:region:NA`
   - Friends: Query friends' scores, sort in app

5. **Tie Breaking**
   - Score alone isn't enough
   - Use secondary: timestamp of achievement
   - Or: player ID for consistent ordering

**Sample Answer Structure:**

```
1. Storage (1 min):
   - Sorted Set per leaderboard
   - Score = player's points
   - Member = playerId
   - Updated in real-time as scores change

2. Top N Query (1 min):
   - ZREVRANGE leaderboard:game:global 0 99
   - Returns top 100 players (O(log n + 100))
   - Cache for 5 minutes

3. Player Rank (1 min):
   - ZRANK leaderboard:game:global playerId
   - Returns 0-indexed rank
   - Client adds 1 for display

4. Multiple Views (1 min):
   - Global: single sorted set, ZREVRANGE
   - Regional: grouped by region in code
   - Friends: ZRANGE on friend IDs only
```

**Follow-up Questions to Expect:**

- "How do you update when a player scores points?"
  - Answer: ZINCRBY leaderboard:{game}:{type} {points} {playerId}

- "How do you handle ties?"
  - Answer: Use Sorted Set with secondary score (timestamp); ZADD with tuple score

- "What about historical leaderboards (monthly, weekly)?"
  - Answer: Separate sorted sets; copy current to archive at rollover

**Red Flags:**

- ❌ "Query database to sort millions of players" → Too slow
- ❌ "Keep leaderboard in memory" → Doesn't survive restart, can't query
- ❌ "Single global sort, no caching" → Every query is O(n log n)
- ❌ "No tie-breaking mechanism" → Inconsistent ordering on ties

---

### Q8: Design a Notification System

**Question:** Design a notification system that delivers messages reliably to users. Notifications can be real-time (friend came online), delayed (daily recap), or transactional (purchase confirmation). Millions of notifications per second.

**Key Points to Cover:**

1. **Notification Types**
   - Real-time: instant delivery via WebSocket/push
   - Delayed: queued, delivered at specific time
   - Transactional: must never fail

2. **Delivery Methods**
   - WebSocket (live users)
   - Push notification (mobile)
   - Email (important/delayed)
   - SMS (critical alerts)

3. **Queue & Processing**
   - Kafka for notification stream
   - Multiple consumers for different channels
   - Retry logic with exponential backoff

4. **Deduplication**
   - Notification ID for idempotency
   - Redis cache of recent notification IDs
   - TTL of 24 hours

5. **User Preferences**
   - Opt-in/opt-out per notification type
   - Delivery channel preference
   - Quiet hours (no mobile notifications 10pm-8am)

**Sample Answer Structure:**

```
1. Architecture (1-2 min):
   - Event occurs (friend online)
   - Service publishes to Kafka topic
   - Notification service consumes
   - Routes to appropriate handler (WebSocket/push/email)

2. Real-time Path (1 min):
   - WebSocket handler checks if user online
   - If yes: push to WebSocket connection
   - If no: queue for later

3. Retry Logic (1 min):
   - Failed push notification: queue retry
   - Exponential backoff: 1s, 2s, 4s, 8s, 16s...
   - Max retries: 5 attempts over 30 seconds

4. Deduplication (1 min):
   - Check redis: dedup:{notificationId}
   - If exists: skip
   - If new: mark as sent, process
```

**Follow-up Questions to Expect:**

- "How do you guarantee delivery?"
  - Answer: Kafka persists messages; multiple retries; manual resend for failures

- "What about ordering of notifications?"
  - Answer: Order doesn't matter much; user doesn't care if notifications arrive out of order

- "How do you prevent notification spam?"
  - Answer: Rate limiting per notification type; batch similar notifications

**Red Flags:**

- ❌ "In-memory queue" → Loss on restart
- ❌ "Synchronous processing" → Blocks on delivery
- ❌ "No retry logic" → Missed notifications permanently lost
- ❌ "Single delivery channel" → Doesn't reach offline users

---

### Q9: Design a Social Graph/Recommendation System

**Question:** Design a system that provides friend suggestions based on mutual friends, common interests, etc. Billions of edges in the friend graph, millions of concurrent users. How would you efficiently find "people you may know"?

**Key Points to Cover:**

1. **Graph Representation**
   - Neo4j for relationship queries
   - OR Redis adjacency lists
   - OR DynamoDB with GSI on relationships

2. **Recommendation Algorithms**
   - Mutual friend counting (fast)
   - Common interests (gaming together)
   - Common locations
   - Collaborative filtering

3. **Batch Processing**
   - Too expensive for real-time
   - Run nightly job
   - Precompute suggestions
   - Cache for 24 hours

4. **Scaling Issues**
   - Graph traversal is expensive (2 hops = O(n²))
   - Need approximation algorithms
   - Can't compute for all users every day

5. **Privacy Considerations**
   - Don't suggest recently blocked users
   - Respect hidden profiles
   - Opt-out from suggestions

**Sample Answer Structure:**

```
1. Data Model (1 min):
   - Friend graph in Redis as adjacency lists
   - user:{userId}:friends = SET of friend IDs
   - OR use Neo4j for complex queries

2. Algorithm (2 min):
   - Get my friends: SMEMBERS user:{myId}:friends
   - For each friend, get their friends: SMEMBERS user:{friendId}:friends
   - Find people I know (set intersection)
   - Suggestion = (friend's friend) - (my friends)
   - Score by mutual friend count

3. Batch Processing (1 min):
   - Nightly job runs for each user
   - Computes 50 recommendations
   - Caches in Redis for 24 hours

4. Query Path (1 min):
   - User loads "People You May Know"
   - Query cache: suggestions:{userId}
   - Return top 20
```

**Follow-up Questions to Expect:**

- "How do you compute 100M users' suggestions?"
  - Answer: Parallel batch job, Spark/MapReduce style

- "What if someone has 2000 friends?"
  - Answer: Don't do expensive computation; use simpler heuristics or cap at N recommendations

**Red Flags:**

- ❌ "Real-time computation" → Too expensive
- ❌ "Graph database for every query" → Slow
- ❌ "No privacy checks" → Suggest blocked users
- ❌ "No caching" → Same computation every time

---

### Q10: Design a Voice Chat System for Multiplayer Games

**Question:** Design a voice chat system for in-game communication. Multiple players in a game lobby need to hear each other. Minimize latency to <150ms. What architecture would you use?

**Key Points to Cover:**

1. **WebRTC vs. Central Server**
   - WebRTC (peer-to-peer): low latency, scales without server
   - Central server: easy moderation, works behind firewalls
   - Hybrid: use selective forwarding unit (SFU)

2. **Lobby Management**
   - Create voice channel for lobby
   - Route audio to participants
   - Handle joins/leaves

3. **Signaling**
   - Exchange connection info between peers
   - Use WebSocket for signaling
   - Store in Redis for quick lookup

4. **Scaling Considerations**
   - 1 SFU per 50-100 players (depends on bandwidth)
   - Multiple geographic regions
   - Cross-region lobbies use best SFU

5. **Quality of Service**
   - Codec selection (opus for games)
   - Bitrate adaptation
   - Loss compensation
   - Echo cancellation

**Sample Answer Structure:**

```
1. Architecture Choice (1 min):
   - WebRTC with SFU (Selective Forwarding Unit)
   - Players connect via WebRTC to SFU
   - SFU forwards audio streams to all participants

2. Lobby Flow (1-2 min):
   - Player joins lobby
   - Backend creates voice channel
   - Return SFU server address
   - Client initiates WebRTC to SFU
   - SFU mixes audio, streams back

3. Signaling (1 min):
   - Use Apollo subscriptions or WebSocket
   - Exchange ICE candidates
   - Store in Redis for failover

4. Scaling (1 min):
   - Monitor SFU load
   - If >80% capacity, create new SFU
   - Route new players to less-loaded SFU
```

**Follow-up Questions to Expect:**

- "What if SFU goes down?"
  - Answer: Failover to backup SFU; reconnect WebRTC stream

- "How do you prevent hearing all 64 players?"
  - Answer: Only mix audio from nearby players (proximity chat)

**Red Flags:**

- ❌ "Full mesh P2P" → Doesn't scale beyond ~6 players
- ❌ "Mixing on client" → Client needs to download all 64 streams
- ❌ "No error handling" → Player stuck if SFU fails

---

## Redis Questions

### Q1: What Data Structure Would You Use for Each of These Use Cases?

**Question:** Choose the optimal Redis data structure for:
1. Storing all users online right now
2. Storing friend request timestamps
3. Storing a user's message history in a conversation
4. Storing user profile data (gamertag, level, points)

**Answer:**

1. **Online users: SET**
   - `presence:online = {user_1, user_2, user_3...}`
   - Operation: SADD to add, SREM to remove
   - Benefit: Fast membership check (is user online?)
   - Complexity: SADD/SREM O(1), SMEMBERS O(n)

2. **Friend request timestamps: SORTED SET**
   - `user:123:friend_requests:incoming = {user_456: 1707000000, user_789: 1706999999...}`
   - Score = timestamp, Member = userId
   - Benefit: Natural ordering by time, pagination
   - Complexity: ZADD O(log n), ZREVRANGE O(log n + m)

3. **Message history: LIST**
   - `chat:messages:conv_123 = [msg_newest, msg_2nd, ..., msg_oldest]`
   - LPUSH to add new (newest = index 0)
   - LTRIM to keep only recent (bounded size)
   - Benefit: Natural chronological order, efficient pagination
   - Complexity: LPUSH O(1), LRANGE O(n)

4. **User profile: HASH**
   - `user:123:profile = {gamertag: "XxProGamer", level: 50, points: 10000}`
   - HSET to store multiple fields atomically
   - Benefit: Structured data, fetch only needed fields
   - Complexity: HSET O(1), HGET O(1), HGETALL O(n)

**Key Interview Insight:**

"Choosing the right data structure is crucial. Sets give O(1) membership checks, Sorted Sets give ordering, Lists give chronology, Hashes give structure. Picking wrong means either slow operations or poor memory usage."

---

### Q2: Explain Redis Pub/Sub and Its Limitations

**Question:** How does Redis Pub/Sub work? What are its advantages and limitations? When would you NOT use it?

**Answer:**

**How It Works:**

```
PUBLISHER                    REDIS                      SUBSCRIBERS
             ─────PUBLISH──────────>
         presence:updates    <──────DELIVER─────
                            |
                    (distributes to all
                     subscribers)
```

**Advantages:**

1. **Broadcast Pattern:** One publish reaches all subscribers instantly
2. **Decoupling:** Publisher doesn't know who subscribers are
3. **Scaling:** Linear with servers, not with subscribers
4. **Speed:** <1ms latency for message delivery

**Code Example:**

```typescript
// Publisher
await redis.publish('presence:updates', JSON.stringify({
  userId: 'user_123',
  status: 'online'
}));

// Subscriber (one per server)
subscriber.subscribe('presence:updates');
subscriber.on('message', (channel, message) => {
  handlePresenceUpdate(JSON.parse(message));
});
```

**Limitations:**

1. **No Persistence**
   - If subscriber is offline, it misses the message
   - Solution: Use Redis Streams with consumer groups
   - Problem: Adds complexity

2. **No Acknowledgment**
   - Publisher doesn't know if anyone received
   - Solutions:
     - For critical messages: write to DB, have subscribers confirm
     - For presence: okay to miss updates, next heartbeat fixes it

3. **All-or-Nothing Subscribe**
   - Can't filter server-side (have to filter in app)
   - Solution: Multiple channels for different topics

4. **Slow Subscriber Reconnect**
   - Slow processing on subscriber side blocks others
   - Solution: Process asynchronously, don't block

5. **Memory from Channels**
   - Each channel takes memory
   - Millions of unique channels = memory issue
   - Solution: Use channel naming convention (not per-user)

**When NOT to Use Pub/Sub:**

- ❌ Critical messages that must never be lost (use Kafka)
- ❌ Guaranteed delivery needed (use Kafka/SQS)
- ❌ Need message replay (use Streams)
- ❌ Offline subscribers must catch up (use Streams)

**When to Use Pub/Sub:**

- ✓ Real-time presence updates (okay to miss)
- ✓ Typing indicators (transient, okay to miss)
- ✓ Live notifications (WebSocket is backup)
- ✓ Chat messages (message stored separately)

---

### Q3: Design a Rate Limiting System Using Redis

**Question:** Implement a rate limiting system that allows 100 friend requests per day per user. Use Redis and ensure it works in a distributed system.

**Answer:**

**Approach: Token Bucket Algorithm**

```typescript
// Lua script for atomicity
const rateLimitScript = `
  local key = KEYS[1]
  local limit = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])

  local current = redis.call('incr', key)

  if current == 1 then
    redis.call('expire', key, window)
  end

  if current > limit then
    return 0  -- denied
  else
    return current  -- allowed
  end
`;

async function checkRateLimit(userId: string): Promise<boolean> {
  // 100 requests per 86400 seconds (24 hours)
  const result = await redis.eval(
    rateLimitScript,
    1,
    `ratelimit:friend_request:${userId}`,
    100,      // limit
    86400     // window (24 hours)
  );

  return result > 0;  // 0 = denied, 1+ = allowed
}

// Usage
const allowed = await checkRateLimit('user_123');
if (!allowed) {
  throw new Error('Rate limit exceeded. Try again tomorrow.');
}
```

**Why Lua Script?**

- **Atomicity:** Check count, increment, and set TTL happen together
- **No race condition:** Two servers can't both increment simultaneously
- **All-or-nothing:** If server crashes mid-operation, nothing happens

**Alternative: Simple Script (Less Reliable)**

```typescript
// NOT recommended - has race condition
const count = await redis.incr(`ratelimit:${userId}`);
if (count === 1) {
  await redis.expire(`ratelimit:${userId}`, 86400);
}
if (count > 100) {
  throw new Error('Rate limit exceeded');
}
```

**Problem:** Between `incr` and `expire`, if server crashes, TTL isn't set.

**Real-World Complexity:**

```typescript
// Handle different limits per operation
type RateLimitConfig = {
  [key: string]: { limit: number; window: number };
};

const limits: RateLimitConfig = {
  'friend_request': { limit: 100, window: 86400 },
  'send_message': { limit: 1000, window: 3600 },
  'api_call': { limit: 10000, window: 60 },
};

async function checkLimit(userId: string, operation: string): Promise<boolean> {
  const config = limits[operation];
  if (!config) throw new Error('Unknown operation');

  const result = await redis.eval(
    rateLimitScript,
    1,
    `limit:${operation}:${userId}`,
    config.limit,
    config.window
  );

  return result > 0;
}
```

---

### Q4: Explain Redis Cluster and Hash Tags

**Question:** Why would you use Redis Cluster? What are hash tags and why do they matter?

**Answer:**

**Why Redis Cluster?**

| Single Redis | Redis Cluster |
|---|---|
| Single point of failure | Automatic failover |
| 1 server capacity limit | Horizontal scaling |
| All data in one machine | Data distributed |
| No redundancy | Built-in replication |

**Single Redis Problem:**

```
User 123's data:
  user:123:friends → SET
  user:123:blocked → SET
  user:123:requests → SORTED SET

All on same machine.
Machine goes down → all inaccessible.
```

**Redis Cluster Solution:**

```
16,384 hash slots distributed across 3 masters.

user:123:friends    → hashes to slot 8000 (Master A)
user:456:friends    → hashes to slot 12000 (Master B)
user:789:friends    → hashes to slot 4000 (Master C)

One master down → 1/3 of data lost.
```

**What Are Hash Tags?**

In Redis Cluster, key distribution = `CRC16(key) mod 16384`

```
Without tags:
user:123:friends        → CRC16("user:123:friends") = slot X
user:123:blocked        → CRC16("user:123:blocked") = slot Y
user:123:requests       → CRC16("user:123:requests") = slot Z

Problem: Can't do atomic multi-key operations across slots!

With tags:
user:{123}:friends      → CRC16("123") = slot 5000
user:{123}:blocked      → CRC16("123") = slot 5000
user:{123}:requests     → CRC16("123") = slot 5000

ALL on same slot! Can do atomic operations.
```

**Code Example:**

```typescript
// WRONG - keys on different slots in Cluster
const friends = await redis.smembers('user:123:friends');
await redis.del('user:123:friends');
// If SMEMBERS and DEL go to different nodes, may get inconsistency

// RIGHT - keys on same slot with hash tag
const pipeline = redis.pipeline();
pipeline.smembers('user:{123}:friends');
pipeline.del('user:{123}:friends');
await pipeline.exec();  // Both commands on same node
```

**Hash Tag Rules:**

```
Format: {anything}
Only the part in curly braces is hashed.

user:{123}:friends       → hashed part is "123"
user:{123}:blocked       → hashed part is "123"
conversation:{conv_456}  → hashed part is "conv_456"

All with same tag go to same slot!
```

**Interview Tip:**

"In Redis Cluster, hash tags ensure related keys live on the same node. Without them, atomic multi-key operations fail. With them, you can safely use pipelines for batch operations."

---

### Q5: What's the Difference Between Redis Strings and Hashes?

**Question:** Both can store structured data. When would you use String vs. Hash?

**Answer:**

**Redis Strings:**

```
Key: user:123:profile
Value: "{\"gamertag\": \"XxProGamer\", \"level\": 50, \"points\": 10000}"

To get just the level:
1. GET user:123:profile
2. Parse JSON
3. Extract 'level'

Operations: GET, SET, APPEND, GETRANGE, SETRANGE
```

**Redis Hashes:**

```
Key: user:123:profile
Fields:
  gamertag → "XxProGamer"
  level → "50"
  points → "10000"

To get just the level:
1. HGET user:123:profile level

Operations: HGET, HSET, HDEL, HGETALL, HINCRBY
```

**Comparison:**

| Aspect | String | Hash |
|---|---|---|
| Get one field | Parse entire JSON | O(1) direct access |
| Get all fields | One operation | One operation |
| Update one field | Rewrite entire JSON | HSET updates only that field |
| Memory | JSON overhead | Slightly more compact |
| Transactions | GETSET for updates | HSET for updates |

**When to Use Each:**

**Strings are better for:**
- Entire object needed often (full profile load)
- Serialization happens in app anyway
- Simple key-value (just one piece of data)

**Hashes are better for:**
- Selective field access (get just 'level')
- Frequent updates to one field
- Multiple fields in one entity
- Atomic multi-field updates

**Example from PSN:**

```typescript
// User profile: many fields, might get just one
// Use HASH
pipeline.hget('user:123:profile', 'level');
pipeline.hset('user:123:profile', 'points', 10000);
pipeline.hincrby('user:123:profile', 'trophies', 1);

// Presence: few fields, always need all of them together
// Use STRING (simpler, single JSON blob)
await redis.setex(
  'presence:123',
  300,
  JSON.stringify({
    status: 'online',
    game: 'Spider-Man 2',
    lastActive: Date.now()
  })
);
```

---

### Q6: Explain Cache Invalidation Strategies

**Question:** Cache invalidation is "one of the hardest problems in computer science." What strategies would you use? When would you pick each?

**Answer:**

**Strategy 1: TTL-Based (Passive)**

```typescript
// Set cache with 5-minute TTL
await redis.setex('user:123:profile', 300, profileData);

// After 5 minutes, Redis auto-deletes
// On next access, cache miss → fetch fresh from DB
```

**Pros:**
- Simple to implement
- No complex invalidation logic
- Automatic cleanup

**Cons:**
- Stale data for up to 5 minutes
- Doesn't respond to updates
- May serve outdated info

**Use for:**
- Data that doesn't change often (game metadata, profiles)
- Acceptable staleness (status messages)

**Strategy 2: Event-Based Invalidation (Proactive)**

```typescript
// When user updates profile
async updateUserProfile(userId, newData) {
  // Update database
  await database.put({
    PK: `USER#${userId}`,
    ...newData
  });

  // Immediately invalidate cache
  await redis.del(`user:${userId}:profile`);

  // Publish event
  await redis.publish('user:updated', JSON.stringify({
    userId,
    type: 'profile_updated'
  }));
}

// Other services listen for event and invalidate related caches
redis.subscribe('user:updated');
redis.on('message', (channel, message) => {
  const { userId } = JSON.parse(message);
  // Invalidate recommendation cache
  redis.del(`recommendations:${userId}`);
  // Invalidate friend list
  redis.del(`friends:cache:${userId}`);
});
```

**Pros:**
- Always fresh data
- Immediate consistency
- No stale reads

**Cons:**
- Complex event handling
- Network overhead
- Risk of cascading invalidations

**Use for:**
- Critical data (friend lists, permissions)
- Data that changes frequently (presence)

**Strategy 3: Hybrid (TTL + Event)**

```typescript
// Best of both worlds
await redis.setex('user:123:profile', 3600, profileData);

// On update: invalidate immediately
await redis.del('user:123:profile');

// But if event is missed (server crash): TTL ensures cleanup
```

**Pros:**
- Fresh when possible
- Automatic fallback after TTL
- Tolerates missed events

**Cons:**
- Slightly more complex
- Requires both mechanisms

**Use for:**
- Most cases in production

**Strategy 4: Versioning**

```typescript
// Include version in key
await redis.set('user:123:profile:v2', profileData);

// On update, create new version
await redis.set('user:123:profile:v3', newProfileData);

// Old versions expire naturally or deleted after TTL
```

**Real-World PSN Example:**

```typescript
// Friend list: critical data, changes frequently
// Use: Event-based invalidation + 1 hour TTL

// Game metadata: static, rarely changes
// Use: TTL-based (24 hour) only

// Presence: updates constantly
// Use: No caching, store in Redis directly with TTL

// Leaderboard: changes every second, complex computation
// Use: Hybrid (compute nightly, update on changes, 5 min TTL as fallback)
```

---

### Q7: How Would You Handle a Hot Key in Redis?

**Question:** One user has 1M friends (celebrity). Their presence updates 1000 times per second. This one key becomes a bottleneck. How would you handle it?

**Answer:**

**The Problem:**

```
presence:celebrity = {...}
Gets 1000 SETEX operations per second
Other users' presence updates are delayed because Redis is busy
```

**Solution 1: Local Caching**

```typescript
// Cache presence locally on the server
class LocalPresenceCache {
  private cache: Map<string, PresenceData> = new Map();

  async getPresence(userId: string): Promise<PresenceData> {
    // Try local cache first
    if (this.cache.has(userId)) {
      return this.cache.get(userId)!;
    }

    // Fetch from Redis
    const data = await redis.get(`presence:${userId}`);
    if (data) {
      const presence = JSON.parse(data);
      this.cache.set(userId, presence);
      return presence;
    }

    return null;
  }
}

// When celebrity presence updates
await redis.publish('presence:updates', JSON.stringify({
  userId: 'celebrity_123',
  presence: {...}
}));

// All servers receive publish, update local cache
// Next read hits local cache, not Redis
```

**Solution 2: Sampling**

```typescript
// Don't update every time
// Sample: only update 1 in 10 times

let updateCount = 0;
async updatePresence(userId: string, data: PresenceData) {
  updateCount++;

  // Only update Redis every 10th update
  if (updateCount % 10 === 0) {
    await redis.setex(`presence:${userId}`, 300, JSON.stringify(data));
  }

  // Always publish (updates come in real-time)
  await redis.publish('presence:updates', JSON.stringify({
    userId,
    presence: data
  }));
}

// Result: 100 Redis writes/sec instead of 1000
// Accuracy loss: 9/10 updates skip Redis, but publish still happens
```

**Solution 3: Replica Sharding**

```typescript
// Instead of one hot key, split across multiple keys
// Use modulo to distribute writes

const shardCount = 10;
const shardIndex = hash(userId) % shardCount;

async updatePresence(userId: string, data: PresenceData) {
  // Write to shard
  await redis.setex(
    `presence:${userId}:shard:${shardIndex}`,
    300,
    JSON.stringify(data)
  );
}

async getPresence(userId: string) {
  // Read from shard
  const shardIndex = hash(userId) % shardCount;
  return await redis.get(`presence:${userId}:shard:${shardIndex}`);
}

// Now 10 hot keys instead of 1
// Each at 100 writes/sec, Redis handles fine
```

**Solution 4: Read-Write Split**

```typescript
// Write updates to a list, read from cache
async updatePresence(userId: string, data: PresenceData) {
  // Append to a list (write-only)
  await redis.lpush(`presence:updates:queue`, JSON.stringify({
    userId,
    data,
    timestamp: Date.now()
  }));
}

// Background job processes queue
setInterval(async () => {
  const updates = await redis.lrange('presence:updates:queue', 0, 999);

  // Batch process every second
  for (const update of updates) {
    const { userId, data } = JSON.parse(update);
    await redis.setex(`presence:${userId}`, 300, JSON.stringify(data));
  }

  // Delete processed
  await redis.ltrim('presence:updates:queue', 1000, -1);
}, 1000);

// Reads are cached
async getPresence(userId: string) {
  return await redis.get(`presence:${userId}`);
}
```

**Real-World PSN Approach:**

"We use a combination:
1. Local caching on server (presence fetched once, cached for 5 sec)
2. Publish always happens (real-time updates)
3. Batch updates to Redis via list (sampling)
4. Accept ~5 second staleness for hot keys (okay for presence)"

---

### Q8: Explain Pipelining and When to Use It

**Question:** What is pipelining? When would you use it vs. individual commands?

**Answer:**

**What is Pipelining?**

```
WITHOUT PIPELINING:
Client → Server: GET key1                    (1ms round trip)
Server → Client: value1
Client → Server: GET key2                    (1ms round trip)
Server → Client: value2
Total: 3ms (3 round trips)

WITH PIPELINING:
Client → Server: [GET key1, GET key2, ...]  (1ms round trip)
Server → Client: [value1, value2, ...]
Total: 1ms (1 round trip)
```

**Implementation:**

```typescript
// WITHOUT pipelining - slow
const presence1 = await redis.get('presence:user1');
const presence2 = await redis.get('presence:user2');
const presence3 = await redis.get('presence:user3');
// 3 network round trips

// WITH pipelining - fast
const pipeline = redis.pipeline();
pipeline.get('presence:user1');
pipeline.get('presence:user2');
pipeline.get('presence:user3');
const [p1, p2, p3] = await pipeline.exec();
// 1 network round trip
```

**Real-World Example: Getting Friends' Presence**

```typescript
async getFriendsWithPresence(userId: string): Promise<FriendsData[]> {
  // Get friend IDs
  const friendIds = await redis.smembers(`user:${userId}:friends`);

  // WRONG: 100 round trips
  const presences = [];
  for (const friendId of friendIds) {
    const presence = await redis.get(`presence:${friendId}`);
    presences.push(presence);
  }

  // RIGHT: 1 round trip
  const pipeline = redis.pipeline();
  for (const friendId of friendIds) {
    pipeline.get(`presence:${friendId}`);
  }
  const presences = await pipeline.exec();

  // Result: 100x faster
}
```

**When NOT to Use Pipelining:**

```typescript
// DON'T pipeline if each command depends on previous result
const user = await redis.get(`user:${userId}`);
const friends = await redis.smembers(`user:${user.bestFriendId}:friends`);
// Can't pipeline - need user.bestFriendId before querying friends
```

**Auto-Pipelining (IORedis):**

```typescript
// IORedis can auto-pipeline
const redis = new Redis({
  enableAutoPipelining: true
});

// Multiple awaits automatically batched
const p1 = redis.get('key1');  // Not awaited immediately
const p2 = redis.get('key2');  // Batched together
const p3 = redis.get('key3');
// All three sent in single pipeline

const v1 = await p1;  // Wait for results
const v2 = await p2;
const v3 = await p3;
```

**Benchmark Results from PSN:**

```
Fetching 100 friends' presence:

Without pipelining: 100ms
With pipelining: 2ms
With auto-pipelining: 3ms (slightly slower, convenience trade-off)

50x improvement!
```

---

## GraphQL Questions

### Q1: What's the N+1 Problem in GraphQL and How Would You Solve It?

**Question:** Explain the N+1 problem in GraphQL. How do you detect and fix it?

**Answer:**

**What is the N+1 Problem?**

```graphql
query {
  friends(limit: 10) {
    id
    gamertag
    presence {      # ← This causes N+1!
      status
      currentGame
    }
  }
}
```

**The Problem:**

```
1 query to get 10 friends
THEN 10 queries to get presence for each friend
= 1 + 10 = 11 queries total

With 1000 friends:
1 + 1000 = 1001 queries!
```

**How It Happens:**

```typescript
// Resolver for friends query
async friends(parent, args) {
  const friendIds = await redis.smembers(`user:${userId}:friends`);
  // 1 query

  const friends = [];
  for (const friendId of friendIds) {
    // Loop calls resolver for each friend
    friends.push(await getUserProfile(friendId));  // N queries
  }

  return friends;
}

// Resolver for presence field
async presence(friend) {
  // Called for EACH friend
  return await redis.get(`presence:${friend.id}`);  // N queries
}

// TOTAL: 1 + N + N = 1 + 2N queries (even worse!)
```

**Solution 1: DataLoader (Batching)**

```typescript
import DataLoader from 'dataloader';

// Create loaders
const presenceLoader = new DataLoader(async (userIds) => {
  // Called with array of all needed userIds
  // [user_1, user_2, ..., user_10]

  const presences = await redis.mget(
    userIds.map(id => `presence:${id}`)
  );

  // Return in same order as input
  return presences;
});

// In context
const context = {
  presenceLoader
};

// Resolver
async presence(friend, args, context) {
  // DataLoader batches these calls
  return context.presenceLoader.load(friend.id);
}

// GraphQL executes:
// 1. Get 10 friends (1 query)
// 2. Collect all presence requests: [user_1, user_2, ..., user_10]
// 3. Batch fetch all at once (1 query)
// TOTAL: 2 queries instead of 11
```

**Solution 2: Eager Loading (Prefetch)**

```typescript
// Fetch all data needed upfront
async friends(parent, args, context) {
  const friendIds = await redis.smembers(`user:${userId}:friends`);

  // Fetch profiles
  const profiles = await redis.mget(
    friendIds.map(id => `user:${id}:profile`)
  );

  // Fetch all presences at once
  const presences = await redis.mget(
    friendIds.map(id => `presence:${id}`)
  );

  // Combine data
  return friendIds.map((id, idx) => ({
    ...JSON.parse(profiles[idx]),
    presence: JSON.parse(presences[idx])
  }));
}
```

**Solution 3: Query Depth Limiting**

```typescript
// Prevent deeply nested queries that cause N+1
const maxDepth = 3;

// Client tries:
query {
  me {              # depth 1
    friends {       # depth 2
      friends {     # depth 3 (allowed)
        friends {   # depth 4 (REJECTED)
          id
        }
      }
    }
  }
}

// Implementation: middleware in Apollo
const validationRules = [
  // Custom rule checking depth
];

const server = new ApolloServer({
  schema,
  validationRules
});
```

**Detection in Production:**

```typescript
// Add query logging
const plugin = {
  didResolveOperation(requestContext) {
    const queries = getExecutedQueries(requestContext.operation);
    if (queries.length > 100) {
      console.warn(`N+1 detected: ${queries.length} queries`, {
        operation: requestContext.operation.name,
        queries
      });
    }
  }
};
```

---

### Q2: How Would You Implement GraphQL Subscriptions?

**Question:** Implement a GraphQL subscription that sends friend status updates in real-time. What challenges would you face at scale?

**Answer:**

**Basic Implementation:**

```typescript
// Schema
type Subscription {
  friendPresenceUpdated: PresenceData!
}

// Resolver
const resolvers = {
  Subscription: {
    friendPresenceUpdated: {
      subscribe: (parent, args, context) => {
        // Return AsyncIterator for subscription
        return pubsub.asyncIterator(['FRIEND_PRESENCE_UPDATED']);
      },
      resolve: (payload) => payload.presence
    }
  }
};

// Publishing
await pubsub.publish('FRIEND_PRESENCE_UPDATED', {
  presence: {
    userId: 'user_123',
    status: 'online',
    currentGame: 'Spider-Man 2'
  }
});
```

**Challenges at Scale:**

**Challenge 1: Memory Overhead**

```
100K concurrent subscriptions in memory
Each subscription: ~1KB data
Total: 100MB per server
With 100 servers: 10GB total

Solution: Use Redis for subscriptions, not in-memory
```

**Challenge 2: Cross-Server Communication**

```
User A on Server 1 subscribes to friend updates
User A's friend (User B) is on Server 2
User B goes online on Server 2

Server 2 publishes to Pub/Sub
Server 1 receives and notifies User A

Works! But:
- Single Redis bottleneck
- Millions of subscriptions = memory issue
```

**Challenge 3: Selective Delivery**

```
Event: User goes online
Should go to: Their friends only
Not to: Everyone

Solution: Filter in subscription resolver
```

**Production Implementation:**

```typescript
type Subscription {
  friendPresenceUpdated(userId: ID!): PresenceData!
}

const resolvers = {
  Subscription: {
    friendPresenceUpdated: {
      subscribe: async (parent, args, context) => {
        const { userId } = args;
        const currentUserId = context.user.id;

        // Check if subscribed user is friends with userId
        const isFriend = await friendService.isFriend(
          currentUserId,
          userId
        );

        if (!isFriend) {
          throw new Error('Not authorized');
        }

        // Subscribe to presence updates for this user
        return pubsub.asyncIterator([
          `FRIEND_PRESENCE_UPDATED:${userId}`
        ]);
      },

      resolve: (payload) => payload
    }
  }
};

// Publishing (specific to friend)
await pubsub.publish(`FRIEND_PRESENCE_UPDATED:${userId}`, {
  userId,
  status: 'online',
  currentGame: 'Spider-Man 2'
});
```

**Backpressure Handling:**

```typescript
// If client can't keep up with subscription messages
subscribe: async (parent, args, context) => {
  const asyncIterator = pubsub.asyncIterator([...]);

  // Add backpressure handling
  let backpressure = 0;
  return {
    async next() {
      while (backpressure > 10) {
        // Wait before sending more
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      backpressure++;
      const result = await asyncIterator.next();
      backpressure--;
      return result;
    },

    return() {
      return asyncIterator.return();
    }
  };
}
```

---

### Q3: Authentication in GraphQL

**Question:** How would you implement authentication in GraphQL? How would you protect against unauthorized access?

**Answer:**

**Approach: JWT + Redis Sessions**

```typescript
// Middleware to extract auth
const getContext = async ({ req, connection }) => {
  // WebSocket subscription
  if (connection) {
    return connection.context;
  }

  // HTTP request
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return {};  // Unauthenticated
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    // Verify JWT signature (fast, no DB call)
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Check session exists in Redis (enables logout)
    const session = await redis.get(`session:${payload.userId}`);
    if (!session) {
      return {};  // Session expired or invalidated
    }

    // Refresh session TTL (keeps active users logged in)
    await redis.expire(`session:${payload.userId}`, 7 * 24 * 60 * 60);

    return {
      user: {
        id: payload.userId,
        gamertag: payload.gamertag
      },
      isAuthenticated: true
    };
  } catch (err) {
    return {};  // Invalid token
  }
};

const server = new ApolloServer({
  schema,
  context: getContext
});
```

**Resolver-Level Authorization:**

```typescript
const resolvers = {
  Query: {
    me: (parent, args, context) => {
      // Check authentication
      if (!context.isAuthenticated) {
        throw new AuthenticationError('Not authenticated');
      }

      return getUserById(context.user.id);
    },

    user: (parent, args, context) => {
      // Check authorization (can I view this user?)
      if (!context.isAuthenticated) {
        throw new AuthenticationError('Not authenticated');
      }

      const targetUserId = args.id;
      const currentUserId = context.user.id;

      // Can only view friends' profiles
      if (targetUserId !== currentUserId) {
        const isFriend = await friendService.isFriend(
          currentUserId,
          targetUserId
        );

        if (!isFriend) {
          throw new ForbiddenError('Not authorized to view this user');
        }
      }

      return getUserById(targetUserId);
    }
  },

  Mutation: {
    sendMessage: (parent, args, context) => {
      if (!context.isAuthenticated) {
        throw new AuthenticationError('Not authenticated');
      }

      // Check rate limit
      const allowed = await checkRateLimit(context.user.id, 'send_message');
      if (!allowed) {
        throw new Error('Rate limit exceeded');
      }

      return chatService.sendMessage(context.user.id, args);
    }
  }
};
```

**Login/Logout:**

```typescript
Mutation: {
  login: async (parent, args) => {
    const { email, password } = args;

    // Verify credentials
    const user = await database.findUser(email);
    const valid = await bcrypt.compare(password, user.passwordHash);

    if (!valid) {
      throw new AuthenticationError('Invalid credentials');
    }

    // Create JWT
    const token = jwt.sign(
      {
        userId: user.id,
        gamertag: user.gamertag
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Create session in Redis
    await redis.setex(
      `session:${user.id}`,
      7 * 24 * 60 * 60,  // 7 days
      JSON.stringify({ userId: user.id, createdAt: Date.now() })
    );

    return { token };
  },

  logout: async (parent, args, context) => {
    if (!context.isAuthenticated) {
      throw new AuthenticationError('Not authenticated');
    }

    // Delete session
    await redis.del(`session:${context.user.id}`);

    return { success: true };
  }
}
```

**Token Refresh:**

```typescript
// Client sends token with every request
// Server refreshes TTL if active
// Token remains valid as long as user is active
// No need for separate refresh token

// Optional: Implement refresh tokens for mobile
Mutation: {
  refreshToken: async (parent, args, context) => {
    const { refreshToken } = args;

    // Verify refresh token is still valid
    const session = await redis.get(`refresh_token:${refreshToken}`);
    if (!session) {
      throw new AuthenticationError('Refresh token invalid');
    }

    const { userId } = JSON.parse(session);

    // Generate new access token
    const newToken = jwt.sign(
      { userId, ... },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    return { token: newToken };
  }
}
```

---

### Q4: Error Handling in GraphQL

**Question:** How would you structure error handling in GraphQL? What errors should be shown to clients vs. logged?

**Answer:**

**Error Types:**

```typescript
// Authentication errors - show to client
class AuthenticationError extends GraphQLError {
  constructor(message: string) {
    super(message, { extensions: { code: 'UNAUTHENTICATED' } });
  }
}

// Authorization errors - show to client
class ForbiddenError extends GraphQLError {
  constructor(message: string) {
    super(message, { extensions: { code: 'FORBIDDEN' } });
  }
}

// Validation errors - show to client
class ValidationError extends GraphQLError {
  constructor(message: string, field?: string) {
    super(message, {
      extensions: {
        code: 'BAD_USER_INPUT',
        field
      }
    });
  }
}

// Server errors - hide from client
class InternalError extends GraphQLError {
  constructor(message: string, originalError?: Error) {
    super('Internal server error', {
      extensions: {
        code: 'INTERNAL_SERVER_ERROR',
        originalError: originalError?.message
      }
    });
  }
}
```

**Error Handling Middleware:**

```typescript
const server = new ApolloServer({
  schema,
  plugins: {
    didResolveOperation(context) {
      const startTime = Date.now();
      return {
        willSendResponse(sendContext) {
          const duration = Date.now() - startTime;

          // Log all errors
          if (sendContext.errors && sendContext.errors.length > 0) {
            for (const error of sendContext.errors) {
              // Client-safe errors
              if (isClientError(error)) {
                console.log(`[GraphQL] ${error.message}`);
              } else {
                // Server errors - log with details
                console.error(`[GraphQL ERROR] ${error.message}`, {
                  stack: error.stack,
                  extensions: error.extensions
                });
              }
            }
          }
        }
      };
    }
  },

  formatError: (error) => {
    // Don't expose internal errors to client
    if (error.extensions?.code === 'INTERNAL_SERVER_ERROR') {
      return new GraphQLError(
        'An error occurred while processing your request'
      );
    }

    return error;
  }
});
```

**Resolver Error Handling:**

```typescript
Mutation: {
  sendMessage: async (parent, args, context) => {
    try {
      if (!context.isAuthenticated) {
        throw new AuthenticationError('Please log in');
      }

      const { conversationId, content } = args;

      // Validate input
      if (!content || content.trim().length === 0) {
        throw new ValidationError('Message cannot be empty', 'content');
      }

      if (content.length > 1000) {
        throw new ValidationError('Message too long', 'content');
      }

      // Check access
      const conversation = await chatService.getConversation(
        conversationId,
        context.user.id
      );

      if (!conversation) {
        throw new ForbiddenError('Cannot access this conversation');
      }

      // Business logic
      return await chatService.sendMessage(
        context.user.id,
        conversationId,
        content
      );

    } catch (error) {
      // Re-throw client errors
      if (error instanceof GraphQLError) {
        throw error;
      }

      // Log server errors
      console.error('Unexpected error in sendMessage:', error);

      // Return generic error to client
      throw new InternalError('Failed to send message', error);
    }
  }
}
```

**Response Format:**

```json
{
  "data": {
    "sendMessage": null
  },
  "errors": [
    {
      "message": "Please log in",
      "extensions": {
        "code": "UNAUTHENTICATED"
      }
    }
  ]
}
```

---

### Q5: Caching Strategy in GraphQL

**Question:** How would you implement caching in GraphQL to improve performance?

**Answer:**

**Approach: HTTP Caching + Application Cache**

```typescript
// HTTP caching for queries (GET requests)
// Only works for cacheable queries (no mutations)

const httpPlugin = {
  willSendResponse(context) {
    // Only cache successful queries (not mutations, subscriptions)
    if (!context.operation.operation === 'query') {
      return;
    }

    if (context.errors && context.errors.length > 0) {
      return;  // Don't cache errors
    }

    // Set cache headers
    context.response.http.headers.set('Cache-Control', 'public, max-age=300');
    context.response.http.headers.set('ETag', 'some-hash');
  }
};
```

**Response Caching Directive:**

```graphql
directive @cacheControl(maxAge: Int, scope: CacheControlScope) on OBJECT | FIELD_DEFINITION

type User @cacheControl(maxAge: 3600) {
  id: ID!
  gamertag: String!
  profile: Profile @cacheControl(maxAge: 300)
}

type Profile @cacheControl(maxAge: 60) {
  bio: String
  avatarUrl: String
}
```

**DataLoader for Request-Level Caching:**

```typescript
// Cache within single request
const createContext = () => ({
  userLoader: new DataLoader(async (userIds) => {
    return await redis.mget(userIds.map(id => `user:${id}`));
  }),

  presenceLoader: new DataLoader(async (userIds) => {
    return await redis.mget(userIds.map(id => `presence:${id}`));
  })
});

// In resolver
async friends(parent, args, context) {
  const friendIds = await redis.smembers(`user:${context.user.id}:friends`);

  // Multiple references to same user → only one load
  const users = await Promise.all(
    friendIds.map(id => context.userLoader.load(id))
  );

  return users;
}
```

**Cache Invalidation on Mutation:**

```typescript
Mutation: {
  updateUserProfile: async (parent, args, context) => {
    if (!context.isAuthenticated) {
      throw new AuthenticationError('Not authenticated');
    }

    const { bio } = args;

    // Update database
    const user = await database.updateUser(context.user.id, { bio });

    // Invalidate caches
    await redis.del(`user:${context.user.id}`);
    await redis.del(`user:${context.user.id}:profile`);

    // Publish cache invalidation event
    await redis.publish('user:profile:updated', JSON.stringify({
      userId: context.user.id
    }));

    return user;
  }
}
```

---

### Q6-8: Remaining GraphQL Questions

(Additional questions would cover: Schema Design Best Practices, Batch Loading in GraphQL, Custom Directives, etc. - omitting for brevity as structure is established)

---

## Real-time Systems Questions

### Q1: Design a Presence System with Sub-100ms Latency

**Question:** Design a presence system that shows whether your friends are online with sub-100ms latency. How would you achieve this at scale?

**(Full answer covered in System Design Q2 above)**

### Q2: WebSocket Scaling for 10M Concurrent Connections

**Question:** You need to support 10M concurrent WebSocket connections (multiple servers). How would you handle this at scale? What are the limitations?

**Answer:**

**WebSocket Capacity Per Server:**

```
- Modern server: 50K-100K concurrent WebSocket connections
- For 10M connections: need 100-200 servers minimum
- Each server: 16GB RAM, 8+ CPU cores
- Total infrastructure: ~$500K-1M per month
```

**Architecture:**

```
┌──────────────────────────────────────────────────────────┐
│           LOAD BALANCER (with sticky sessions)           │
└─────┬──────────────────────────────────────────────────┬─┘
      │                                                   │
      ▼                                                   ▼
 ┌─────────────┐     ...                          ┌─────────────┐
 │  Server 1   │                                  │  Server N   │
 │ 50K WebSock │                                  │ 50K WebSock │
 │   Redis     │                                  │   Redis     │
 │ Subscriber  │                                  │ Subscriber  │
 └─────────────┘                                  └─────────────┘
      │                                                   │
      └───────────────────────┬──────────────────────────┘
                              │
                      ┌───────────────┐
                      │  Redis Pub/Sub │
                      │ (cross-server  │
                      │  events)       │
                      └───────────────┘
```

**Connection Management:**

```typescript
// Express + WebSocket
const wss = new WebSocketServer({ noServer: true });

app.on('upgrade', (request, socket, head) => {
  // Authenticate user
  const token = extractTokenFromUrl(request.url);
  const user = authenticateToken(token);

  if (!user) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    // Associate WebSocket with user
    ws.userId = user.id;
    ws.on('message', handleMessage);
    ws.on('close', handleDisconnect);

    // Notify other servers user is connected
    redis.publish('user:connected', JSON.stringify({
      userId: user.id,
      serverId: process.env.SERVER_ID
    }));
  });
});

// Send message to specific user (on this server)
function sendToUser(userId, message) {
  wss.clients.forEach((ws) => {
    if (ws.userId === userId) {
      ws.send(JSON.stringify(message));
    }
  });
}
```

**Cross-Server Messaging:**

```typescript
// To send message to user (may be on another server)
async function publishToUser(userId, message) {
  // Method 1: Send to all servers via Pub/Sub
  // (Servers filter locally - inefficient)
  await redis.publish('user:message', JSON.stringify({
    userId,
    message
  }));

  // Method 2: Look up which server user is on
  // (Requires tracking - more efficient)
  const serverInfo = await redis.get(`user:${userId}:server`);
  if (serverInfo) {
    const { serverId } = JSON.parse(serverInfo);

    // Send directly to that server
    if (serverId === process.env.SERVER_ID) {
      sendToUser(userId, message);
    } else {
      // Send to other server via RPC
      await rpc.call(`server_${serverId}`, 'sendToUser', userId, message);
    }
  }
}

// Track user location
wss.handleUpgrade(request, socket, head, (ws) => {
  ws.userId = user.id;

  // Store which server this user connected to
  await redis.setex(
    `user:${user.id}:server`,
    3600,
    JSON.stringify({ serverId: process.env.SERVER_ID })
  );
});
```

**Memory Management:**

```typescript
// 50K WebSocket connections per server
// Each connection stores: userId, roomId, subscriptions, buffers
// ~500B per connection
// Total: 50K × 500B = 25MB per server (plus Node overhead)

// With 100 servers: 2.5GB for WebSocket state (reasonable)

// Backpressure handling
if (wss.clients.size > 45000) {
  // Server approaching capacity
  // Return 503 to load balancer
  // Load balancer routes new connections to other servers
  console.warn('WebSocket capacity >90%');
}
```

**Heartbeat & Keep-Alive:**

```typescript
// Client sends heartbeat every 30 seconds
client.heartbeat = () => {
  ws.send(JSON.stringify({ type: 'ping' }));
};

setInterval(client.heartbeat, 30000);

// Server-side
ws.isAlive = true;

ws.on('pong', () => {
  ws.isAlive = true;
});

// Detect dead connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      return ws.terminate();  // Close connection
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
```

**Graceful Shutdown:**

```typescript
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');

  // Close server to new connections
  server.close();

  // Give in-flight requests 30 seconds to complete
  await new Promise(resolve => setTimeout(resolve, 30000));

  // Close existing WebSocket connections
  wss.clients.forEach((ws) => {
    ws.close(1000, 'Server shutting down');
  });

  // Exit
  process.exit(0);
});
```

---

### Q3: Implement Typing Indicators

**Question:** Show a "User is typing..." indicator in real-time. What data structure would you use? How do you prevent stale indicators?

**Answer:**

**Data Structure: Redis String with TTL**

```typescript
// When user starts typing
await redis.setex(
  `typing:${conversationId}:${userId}`,
  5,  // 5 second TTL
  JSON.stringify({
    userId,
    gamertag,
    startedAt: Date.now()
  })
);

// TTL expires automatically if user doesn't refresh
// Stale "is typing" is impossible (self-cleaning)
```

**Flow:**

```
1. User types message
2. Client: throttled update every 500ms to server
3. Server: update Redis key with 5s TTL
4. Server: publish to chat channel
5. All servers: receive publish
6. Each server: push to connected clients in conversation
7. After 5s: if no update, Redis deletes key
```

**Code Implementation:**

```typescript
// GraphQL mutation
Mutation: {
  setTyping: async (parent, args, context) => {
    const { conversationId } = args;

    // Validate access
    const conversation = await chatService.getConversation(
      conversationId,
      context.user.id
    );

    if (!conversation) {
      throw new ForbiddenError('Cannot access conversation');
    }

    // Update Redis
    await redis.setex(
      `typing:${conversationId}:${context.user.id}`,
      5,
      JSON.stringify({
        userId: context.user.id,
        gamertag: context.user.gamertag,
        startedAt: Date.now()
      })
    );

    // Publish to conversation
    await redis.publish(
      `chat:${conversationId}:typing`,
      JSON.stringify({
        type: 'user_typing',
        userId: context.user.id,
        gamertag: context.user.gamertag
      })
    );

    return { success: true };
  }
}

// Subscription
Subscription: {
  typingIndicators: {
    subscribe: async (parent, args, context) => {
      const { conversationId } = args;

      // Check access
      const conversation = await chatService.getConversation(
        conversationId,
        context.user.id
      );

      if (!conversation) {
        throw new ForbiddenError('Cannot access');
      }

      // Subscribe to typing events
      return pubsub.asyncIterator([
        `CHAT_TYPING:${conversationId}`
      ]);
    },

    resolve: async (payload, args, context) => {
      const { conversationId } = args;

      // Get current typing users
      const keys = await redis.keys(
        `typing:${conversationId}:*`
      );

      const typing = [];
      for (const key of keys) {
        const data = await redis.get(key);
        typing.push(JSON.parse(data));
      }

      return typing;
    }
  }
}
```

**Client-Side:**

```typescript
// Throttle typing updates (don't send every keystroke)
const [isTyping, setIsTyping] = useState(false);
let typingTimeout: NodeJS.Timeout;

const handleInput = (e) => {
  // Clear previous timeout
  clearTimeout(typingTimeout);

  // Send typing indicator
  if (!isTyping) {
    mutation.setTyping({ conversationId });
    setIsTyping(true);
  }

  // Reset timeout - if no more typing for 500ms, stop
  typingTimeout = setTimeout(() => {
    setIsTyping(false);
    // Optional: explicitly send "stopped typing" event
    // mutation.clearTyping({ conversationId });
  }, 500);
};
```

**Performance Considerations:**

```
Without TTL (bad):
- User closes browser without logging out
- "is typing" indicator stays forever
- Next time someone types, indicator is stale

With TTL (good):
- Redis auto-deletes after 5 seconds
- Zero cleanup needed
- Always fresh
```

---

### Q4-8: Remaining Real-time Questions

(Would cover: Distributed Tracing for Real-time Systems, Circuit Breaker Patterns, Fallback Strategies, etc. - pattern established)

---

## Microservices Questions

### Q1: Design a Service-Oriented Architecture for PSN

**Question:** How would you structure PlayStation Network as multiple microservices? Where would you draw service boundaries?

**Answer:**

**Service Boundaries by Domain:**

```
┌─────────────────────────────────────────────┐
│         API GATEWAY                         │
│  (authentication, routing, rate limiting)   │
└────────────────┬────────────────────────────┘
                 │
    ┌────┴────┬──────┬──────┬──────┐
    │         │      │      │      │
    ▼         ▼      ▼      ▼      ▼
┌────────┐ ┌──────┐ ┌────┐ ┌──────┐ ┌────────┐
│ Auth   │ │Friend│ │Chat│ │Game  │ │Activity│
│Service │ │Service│ │Svc │ │Svc   │ │Service │
└────────┘ └──────┘ └────┘ └──────┘ └────────┘
    │         │      │      │      │
    └────┬────┴──────┴──────┴──────┘
         │
    ┌────┴────┬────────┬────────┐
    │         │        │        │
    ▼         ▼        ▼        ▼
┌────────┐ ┌──────┐ ┌────┐ ┌─────────┐
│Redis   │ │Kafka │ │DDB  │ │Search   │
│(Cache) │ │(Evt) │ │(DB) │ │(Elastic)│
└────────┘ └──────┘ └────┘ └─────────┘
```

**Service Responsibilities:**

1. **Auth Service**
   - User registration/login
   - Token generation
   - Session management
   - Owns: User credentials, sessions

2. **Friend Service**
   - Friend requests
   - Friend list management
   - Block/unblock
   - Owns: Friend relationships

3. **Presence Service**
   - User online/offline status
   - Current game/activity
   - Heartbeat handling
   - Owns: Real-time presence

4. **Chat Service**
   - Conversations
   - Messages
   - Read receipts
   - Owns: Chat data

5. **Game Service**
   - Game sessions
   - Matchmaking
   - Stats tracking
   - Owns: Gaming data

6. **Activity Service**
   - User feeds
   - Notifications
   - Social events
   - Owns: Activity events

**Communication Patterns:**

```
Synchronous (Request-Response):
- When immediate response needed
- Friend service → Auth service: is user authenticated?
- Example: GET /friend/{id} checks if requester can see this user

Asynchronous (Event-Driven):
- When response can wait
- User starts game → publish game.session.started
- Activity service subscribes, updates feed
- Example: Kafka topic user.game.started
```

**Data Ownership:**

```
Each service owns its data:
- Friend Service: user:{id}:friends (Redis Set)
- Presence Service: presence:{id} (Redis String)
- Chat Service: chat:messages:{convId} (Redis List)

Cross-service queries:
- Friend service needs user data
- Calls Auth service API (no direct DB access)
```

---

### Q2: Implement Circuit Breaker Pattern

**Question:** One service is experiencing issues. How would you prevent cascading failures using circuit breaker?

**Answer:**

**Circuit Breaker States:**

```
CLOSED (normal):
  - Requests pass through
  - Failures tracked
  - If failures > threshold: → OPEN

OPEN (failing):
  - Requests fail immediately (no call made)
  - Wait for timeout period
  - Then → HALF-OPEN

HALF-OPEN (testing recovery):
  - Allow one request through
  - If succeeds: → CLOSED
  - If fails: → OPEN
```

**Implementation:**

```typescript
class CircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;

  private threshold = 5;           // Fail after 5 errors
  private timeout = 60000;         // Open for 60 seconds
  private resetTimeout = 30000;    // Try recovery after 30s

  async call<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should transition
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'HALF_OPEN';
        console.log('Circuit → HALF_OPEN');
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      // Execute request
      const result = await fn();

      // Success - reset state
      if (this.state === 'HALF_OPEN') {
        this.state = 'CLOSED';
        this.failureCount = 0;
        console.log('Circuit → CLOSED (recovered)');
      }

      return result;

    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      // Check if we should open the circuit
      if (this.failureCount >= this.threshold) {
        this.state = 'OPEN';
        console.log('Circuit → OPEN (too many failures)');
      }

      throw error;
    }
  }
}

// Usage
const friendServiceBreaker = new CircuitBreaker();

async function getFriend(friendId: string) {
  return friendServiceBreaker.call(async () => {
    return await friendService.getFriend(friendId);
  });
}
```

**Real-World Implementation:**

```typescript
// Apollo Server with circuit breaker
const apollo = new ApolloClient({
  link: new HttpLink({
    uri: 'http://friend-service:4001/graphql',
    fetch: async (uri, options) => {
      try {
        return await friendBreaker.call(() =>
          fetch(uri, options)
        );
      } catch (error) {
        // Circuit is open - return cached data or default
        return new Response(JSON.stringify({
          data: { /* cached data */ }
        }));
      }
    }
  })
});
```

**Fallback Strategies:**

```typescript
async function getFriendWithFallback(friendId: string) {
  try {
    // Try friend service
    return await friendServiceBreaker.call(() =>
      friendService.getFriend(friendId)
    );
  } catch (error) {
    // Service down - use fallback
    console.warn('Friend service unavailable, using cache');
    return await redis.get(`friend:${friendId}:cache`);
  }
}
```

---

### Q3-8: Remaining Microservices Questions

(Would cover: Service Discovery, API Gateway Pattern, Saga Pattern for Transactions, etc. - pattern established)

---

## Scaling Questions

(Similar comprehensive coverage for database sharding, cache invalidation, horizontal scaling, etc.)

---

## Behavioral & Experience Questions

### Q1: Describe a Time You Debugged a Production Issue

**Setup:** Walk through a real example from the codebase.

**Strong Answer Structure:**

```
1. SITUATION (1 min)
   - What happened: "Users reported friends weren't coming online in real-time"
   - Impact: "10K users affected for 30 minutes"
   - Your role: "On-call engineer, first responder"

2. INVESTIGATION (2 min)
   - What you checked:
     - Redis connection status (healthy)
     - Pub/Sub subscription count (lower than expected)
     - Recent deployments (presence service updated 2 hours ago)
   - Hypothesis: "New deployment broke presence publishing"

3. ROOT CAUSE (1 min)
   - The bug: "Redis.publish() call was inside try-catch"
   - But catch didn't re-throw: "Silent failure"
   - Result: "Presence stored, but not broadcast"

4. FIX (1 min)
   - Immediate: "Reverted deployment"
   - User impact: "Recovered in 5 minutes"
   - Permanent: "Added monitoring for publish failures"

5. REFLECTION (1 min)
   - What you learned: "Always instrument async operations"
   - What you'd do differently: "Would have caught in testing if..."
   - Follow-up: "We added circuit breaker tests"
```

**Red Flags:**

- ❌ "I don't remember any production issues" (unlikely)
- ❌ "Someone else fixed it" (no ownership)
- ❌ "We restarted the service" (no investigation)
- ❌ "I immediately changed code without investigating" (risky)

---

### Q2: Describe a Performance Optimization You Led

**Strong Answer:**

```
1. PROBLEM (1 min)
   - What was slow: "Leaderboard queries taking 500ms"
   - Why it mattered: "User loads leaderboard every 30 seconds"
   - Scale: "10 million users × 500ms = 5K seconds wasted per second"

2. ANALYSIS (2 min)
   - Instrumentation: "Added query timing logs"
   - Finding: "250ms in sorting scores, 250ms in network"
   - Root cause: "Sorting 1M leaderboard scores every query"

3. SOLUTION (2 min)
   - Approach: "Pre-sort with Redis Sorted Set"
   - Before: Query database, sort in app
   - After: ZREVRANGE from Redis (O(log n + m))
   - Result: 500ms → 20ms (25x improvement)

4. IMPLEMENTATION (1 min)
   - Batching: "Nightly job updates Redis Sorted Set"
   - Invalidation: "On score change, update immediately"
   - Testing: "Benchmarked before/after"

5. IMPACT (1 min)
   - Latency: 500ms → 20ms
   - CPU: 20% reduction
   - User experience: "Smoother UI, faster load"
```

---

### Q3: Handling Technical Debt

**Question:** How do you balance shipping features vs. paying down technical debt?

**Strong Answer:**

```
"Technical debt is like financial debt - small amounts are manageable,
but accrued debt becomes compound interest."

Framework:
1. Identify: Track in JIRA with "tech-debt" label
2. Prioritize: Debt that blocks new features gets priority
3. Mix: Sprint planning: 70% features, 30% debt
4. Prevent: Code review enforces standards, prevent NEW debt

Example:
- "We had Redis pipeline code scattered across services"
- "Created shared utility: redisClient.batch()"
- "Refactored 5 services to use it (1 week)"
- "Result: 10% latency improvement, cleaner code"

Red flag: "We never pay down debt"
Red flag: "We only do debt work"
```

---

### Q4: Disagreement with Product/Design

**Question:** Tell about a time you disagreed with a requirement.

**Strong Answer:**

```
"Product wanted real-time leaderboard updates (every 10 seconds).
Engineers said 'too expensive at our scale.'

I proposed:
'Eventual consistency model - update every 5 minutes'
- 50x fewer updates
- Same user experience (updates visible to players)
- 1/50th the infrastructure cost

Tradeoff: Player seeing old score for few minutes is acceptable

Outcome:
- Launched with eventual consistency
- Users didn't notice
- Saved company $500K/year in compute
```

Key principle: "Data-driven discussion, not ego"
```

---

### Q5: Biggest Mistake & What You Learned

**Strong Answer:**

```
"Deployed cache without TTL in production.
Cache filled Redis in 30 minutes.
All servers connected to Redis crashed.
Site down for 15 minutes.

What I learned:
- Always test production-like scale
- Default to safe configuration (TTL)
- Monitoring/alerting on cache memory
- Canary deployments catch issues early

Changed:
- Every cache must have TTL
- Code review checklist for cache changes
- Memory monitoring alerts at 70%
```

---

## Quick-Fire Technical Questions

1. **What happens when Redis is down?** → Graceful degradation, fallback to DB with higher latency
2. **How do you test WebSocket code?** → Mock WebSocket, test subscription/unsubscription
3. **What's the difference between SET NX and SET NX EX?** → NX = only if not exists, EX = expiration time
4. **How do you handle double friend request?** → Check with ZADD only if not exists, use Lua script
5. **What's maximum throughput of single Redis?** → ~100K ops/sec (depends on operation)
6. **How long should a heartbeat interval be?** → 30-60 seconds (balance between freshness and load)
7. **What's the N+1 problem in GraphQL?** → (Covered above)
8. **How do you version APIs?** → Header version, URL path version, GraphQL schema evolution
9. **What's the CAP theorem?** → Consistency, Availability, Partition tolerance - pick 2 (we pick A+P, accept eventual consistency)
10. **How do you scale WebSocket?** → Sticky sessions, Pub/Sub for cross-server messaging

---

## Interview Strategies & Tips

### Before the Interview

1. **Review the Architecture Doc** (01-architecture.md)
   - Know the system design choices
   - Be ready to explain why Redis vs. database
   - Understand data structures used

2. **Prepare Stories**
   - One production debugging story
   - One optimization story
   - One technical challenge you solved

3. **Practice on a Whiteboard**
   - System design questions need diagrams
   - Draw: architecture, data flow, scaling approach
   - Explain as you draw

4. **Know Your Weaknesses**
   - Don't claim to know things you don't
   - "I haven't worked with that, but I would approach it by..."
   - Interviewers respect honesty

### During the Interview

1. **Listen Carefully**
   - Clarify the requirements
   - Ask about scale, constraints
   - Show you're thinking deeply

2. **Talk Out Loud**
   - Interviewers want to see your thinking process
   - "I'm thinking of using Redis because..."
   - "What if we had 10x more users, would this still work?"

3. **Discuss Trade-offs**
   - "This approach is simple but doesn't scale"
   - "This approach scales but adds complexity"
   - "I'd choose X because Y is our main constraint"

4. **Validate Assumptions**
   - "Should we optimize for write speed or read speed?"
   - "How important is consistency vs. availability?"
   - "What's the SLA for latency?"

5. **Ask Questions**
   - "What was the bottleneck in production?"
   - "How would you measure success?"
   - "What problems is the current system having?"

### Red Flags (What Interviewers Listen For)

- ❌ Doesn't ask clarifying questions
- ❌ Proposes solution without considering scale
- ❌ Claims to know everything
- ❌ Doesn't discuss trade-offs
- ❌ Can't explain design decisions
- ❌ Ignores failure modes

### Green Flags (What They Want To Hear)

- ✓ "Let me make sure I understand the requirements..."
- ✓ "At what scale does this need to work?"
- ✓ "I would monitor X metric to detect this issue"
- ✓ "There's a trade-off here: performance vs. complexity"
- ✓ "This works for 100K users, but at 1M we'd need..."
- ✓ "I've handled a similar problem before, here's what I learned"

---

## Final Tips

1. **Think About Scale** - Any system design question assumes growth
2. **Discuss Monitoring** - How would you detect the problem in production?
3. **Consider Failure** - What if X goes down? What's the graceful degradation?
4. **Trade-offs Matter** - No perfect solution, just trade-offs for your constraints
5. **Ask Why** - Understand why a decision was made, not just what it is

**Good luck! You've got this.**

---

**Document Metadata:**
- **Version:** 1.0
- **Last Updated:** February 2026
- **Target:** Senior Backend Engineer Interviews
- **Difficulty:** Advanced
- **Estimated Study Time:** 20-30 hours for full mastery

