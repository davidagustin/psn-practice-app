# PlayStation Network Practice App - Wiki

Welcome to the comprehensive documentation for the PSN Backend Interview Practice App.

## Quick Links

| Topic | Description |
|-------|-------------|
| [Architecture](./01-architecture.md) | System design, data flow, scaling |
| [Redis Patterns](./02-redis-patterns.md) | Data structures, caching, Pub/Sub |
| [GraphQL Design](./03-graphql-design.md) | Schema, resolvers, subscriptions |
| [Real-time Systems](./04-realtime-systems.md) | Presence, WebSocket, Pub/Sub |
| [Rate Limiting](./05-rate-limiting.md) | Algorithms, Redis implementation, interview Qs |
| [Activity Feeds](./06-activity-feeds.md) | Fan-out patterns, aggregation |
| [Voice Chat](./07-voice-chat.md) | WebRTC, SFU architecture |
| [Microservices](./08-microservices.md) | Gateway, circuit breaker, federation |
| [Production Scaling](./09-production-scaling.md) | Redis Cluster, Kafka, caching, distributed locks |
| [AWS Deployment](./10-aws-deployment.md) | Terraform, ECS, ElastiCache |
| [Interview Questions](./11-interview-questions.md) | 50+ common questions with answers |

---

## Learning Path

### Week 1: Foundations
1. Read [Architecture](./01-architecture.md)
2. Study [Redis Patterns](./02-redis-patterns.md)
3. Explore `auth.service.ts` and `friend.service.ts`
4. Practice: Implement friend request flow on paper

### Week 2: Real-time & GraphQL
1. Read [GraphQL Design](./03-graphql-design.md)
2. Read [Real-time Systems](./04-realtime-systems.md)
3. Explore `presence.service.ts` and `resolvers.ts`
4. Practice: Design a presence system whiteboard

### Week 3: Advanced Patterns
1. Read [Rate Limiting](./05-rate-limiting.md)
2. Read [Activity Feeds](./06-activity-feeds.md)
3. Explore `chat.service.ts` and `activity.service.ts`
4. Practice: Compare feed architectures

### Week 4: Production Systems
1. Read [Microservices](./08-microservices.md)
2. Read [Production Scaling](./09-production-scaling.md)
3. Read [AWS Deployment](./10-aws-deployment.md)
4. Practice: Full system design mock interview

---

## Key Interview Themes

### Theme 1: Data Structure Selection
**Question Pattern:** "How would you store X efficiently?"

| Use Case | Redis Structure | Why |
|----------|-----------------|-----|
| User friends | Set | O(1) membership check |
| Friend requests | Sorted Set | Ordered by time, pagination |
| Session data | Hash | Multiple fields, atomic ops |
| Presence TTL | String + EXPIRE | Auto-cleanup |
| Message history | List | LPUSH/LRANGE for recency |

### Theme 2: Scaling Patterns
**Question Pattern:** "How would this work at 100M users?"

| Challenge | Solution |
|-----------|----------|
| Single Redis bottleneck | Redis Cluster (sharding) |
| Database writes | Event-driven + async |
| WebSocket distribution | Pub/Sub across servers |
| API overload | Rate limiting + caching |
| Service failures | Circuit breaker |

### Theme 3: Real-time Architecture
**Question Pattern:** "How do you deliver updates instantly?"

```
Event Occurs → Publish to Redis → All Servers Receive
                                          ↓
                              Filter to Relevant Clients
                                          ↓
                              Push via WebSocket
```

---

## Code Reference Quick Guide

| Concept | File | Lines |
|---------|------|-------|
| JWT Authentication | `auth.service.ts` | 200-300 |
| Heartbeat Pattern | `presence.service.ts` | 150-200 |
| Friend Requests | `friend.service.ts` | 300-400 |
| Rate Limiting | `chat.service.ts` | 100-150 |
| Fan-out on Write | `activity.service.ts` | 180-270 |
| WebRTC Signaling | `voice.service.ts` | 650-720 |
| Circuit Breaker | `gateway/index.ts` | 80-180 |
| Distributed Lock | `redis-cluster/index.ts` | 300-400 |

---

## Common Mistakes to Avoid

### 1. Forgetting Edge Cases
- What if user blocks someone mid-request?
- What if session expires during operation?
- What if Redis is temporarily unavailable?

### 2. Ignoring Scale
- "I'd use a database query" → How many queries at scale?
- "I'd iterate through all friends" → O(n) is too slow for 1000 friends

### 3. Missing Real-time Requirements
- "I'd poll every 5 seconds" → Too slow for presence
- "I'd send to everyone" → Need friend filtering

### 4. Oversimplifying Consistency
- "Just update both tables" → What if one fails?
- "Use a transaction" → Doesn't work across Redis + DB

---

## Next Steps

1. **Run the project** → `npm run dev`
2. **Explore GraphQL** → http://localhost:4000/graphql
3. **Read the services** → Start with `auth.service.ts`
4. **Practice whiteboarding** → Use the diagrams as templates
5. **Mock interviews** → Use [Interview Questions](./11-interview-questions.md)

Good luck! 🎮
