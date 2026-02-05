# PlayStation Network Practice App - Wiki

Welcome to the documentation wiki for the PSN practice app. This is designed to help you understand backend patterns for interview preparation.

---

## Documentation Index

### Architecture & Design

| Document | Description |
|----------|-------------|
| [01-ARCHITECTURE.md](./01-ARCHITECTURE.md) | High-level architecture, layer design, event-driven patterns |
| [02-GRAPHQL-DEEP-DIVE.md](./02-GRAPHQL-DEEP-DIVE.md) | GraphQL concepts, resolvers, subscriptions, N+1 problem |
| [03-FRIEND-SYSTEM.md](./03-FRIEND-SYSTEM.md) | Friend system design, Redis data structures, real-time notifications |
| [04-REDIS-PATTERNS.md](./04-REDIS-PATTERNS.md) | Redis data structures, caching, Pub/Sub, scaling |

### Coming Soon

- Authentication & JWT
- Presence System Deep Dive
- Chat System Design
- Rate Limiting & Circuit Breakers
- Microservices Migration
- AWS Deployment Guide

---

## Quick Reference

### Key Files

| File | Purpose |
|------|---------|
| `src/server.ts` | Application entry point, server setup |
| `src/graphql/schema.ts` | GraphQL type definitions |
| `src/graphql/resolvers.ts` | Query/mutation implementations |
| `src/services/auth/auth.service.ts` | Authentication logic |
| `src/services/presence/presence.service.ts` | Real-time presence |
| `src/services/friends/friend.service.ts` | Friend management |
| `src/services/chat/chat.service.ts` | Messaging system |
| `src/types/index.ts` | TypeScript interfaces |

### Redis Keys

| Pattern | Data Type | Purpose |
|---------|-----------|---------|
| `session:{userId}` | String | User session data |
| `presence:{userId}` | String | Presence with TTL |
| `presence:online` | Set | All online user IDs |
| `user:{userId}:friends` | Set | Friend user IDs |
| `user:{userId}:friend_requests:incoming` | Sorted Set | Incoming requests |
| `user:{userId}:blocked` | Set | Blocked user IDs |
| `chat:{conversationId}:messages` | List | Recent messages |

### GraphQL Operations

```graphql
# Authentication
mutation { register(input: {...}) { token user { id } } }
mutation { login(input: {...}) { token } }
mutation { logout { success } }

# Presence
mutation { updatePresence(input: {...}) { status currentGame } }
mutation { heartbeat { lastActiveAt } }
subscription { friendPresenceUpdated { userId status } }

# Friends
mutation { sendFriendRequest(userId: "...") { id status } }
mutation { acceptFriendRequest(userId: "...") { user { gamertag } } }
query { friends { user { gamertag } isOnline } }
subscription { friendEventReceived { type fromUser { gamertag } } }

# Chat
mutation { sendMessage(input: {...}) { id content } }
query { messages(conversationId: "...") { content createdAt } }
subscription { messageReceived(conversationId: "...") { content } }
```

---

## Interview Prep Checklist

### System Design Topics

- [ ] Horizontal vs vertical scaling
- [ ] Load balancing algorithms
- [ ] Caching strategies (write-through, write-behind, cache-aside)
- [ ] Database sharding and replication
- [ ] Message queues and async processing
- [ ] Rate limiting algorithms
- [ ] Circuit breaker pattern
- [ ] CAP theorem and consistency models

### GraphQL Topics

- [ ] Schema design best practices
- [ ] Resolver architecture
- [ ] N+1 problem and solutions
- [ ] Subscription implementation
- [ ] Authentication patterns
- [ ] Error handling
- [ ] Caching challenges

### Redis Topics

- [ ] Data structure selection
- [ ] Key naming conventions
- [ ] TTL and expiration
- [ ] Pub/Sub for real-time
- [ ] Transactions and atomicity
- [ ] Cluster and scaling

### JavaScript/Node.js Topics

- [ ] Event loop phases
- [ ] Async/await patterns
- [ ] Error handling
- [ ] EventEmitter pattern
- [ ] Streaming and buffers

---

## Study Resources

### Books
- "Designing Data-Intensive Applications" by Martin Kleppmann
- "System Design Interview" by Alex Xu
- "Redis in Action" by Josiah Carlson

### Online Resources
- [Redis University](https://university.redis.com/)
- [Apollo GraphQL Docs](https://www.apollographql.com/docs/)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)

### Practice
- [LeetCode](https://leetcode.com/) - Algorithm practice
- [NeetCode](https://neetcode.io/) - Curated problems
- [System Design Primer](https://github.com/donnemartin/system-design-primer)

---

## Contributing

Found an error or want to add content? Feel free to:
1. Edit the relevant markdown file
2. Add new documentation following the existing pattern
3. Keep code examples up to date with the actual implementation

Happy studying! 🎮
