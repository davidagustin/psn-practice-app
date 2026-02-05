# PlayStation Network Social Platform - Study Project

A full-stack real-time social gaming platform built to study PlayStation's backend architecture patterns for interview preparation.

## Architecture Overview

This project demonstrates PlayStation's core architecture patterns:

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENTS                                  │
│                  (React Web App)                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    GRAPHQL SERVER                               │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │  HTTP :4000 (Queries/Mutations)                         │  │
│   │  WebSocket :4000 (Subscriptions)                        │  │
│   └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       SERVICES                                  │
│   ┌────────────┐  ┌────────────┐  ┌────────────┐              │
│   │    Auth    │  │  Presence  │  │    Chat    │              │
│   │   Service  │  │  Service   │  │  Service   │              │
│   └────────────┘  └────────────┘  └────────────┘              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    INFRASTRUCTURE                               │
│   ┌────────────┐  ┌────────────┐  ┌────────────┐              │
│   │   Redis    │  │   Kafka    │  │  DynamoDB  │              │
│   │  (Cache)   │  │  (Events)  │  │   (Local)  │              │
│   └────────────┘  └────────────┘  └────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

## Tech Stack

### Backend (what PlayStation uses)
- **Node.js/TypeScript** - Server runtime
- **GraphQL + Apollo Server** - API layer with subscriptions
- **Redis** - Sessions, presence, pub/sub for real-time
- **WebSocket** - Real-time communication (graphql-ws)
- **JWT** - Authentication

### Frontend
- **React 18** - UI library
- **Apollo Client** - GraphQL client with caching
- **TypeScript** - Type safety
- **Vite** - Build tool

## Quick Start

### 1. Start Infrastructure (Docker)

```bash
# Start Redis (required for presence/sessions)
docker-compose up -d redis

# Optional: Start Redis UI to visualize data
docker-compose up -d redis-commander
# Access at http://localhost:8081
```

### 2. Start Backend Server

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Server will be available at:
- GraphQL API: http://localhost:4000/graphql
- GraphQL Sandbox: http://localhost:4000/graphql
- Health Check: http://localhost:4000/health
- WebSocket: ws://localhost:4000/graphql

### 3. Start Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm run dev
```

Frontend will be available at http://localhost:3000

### 4. Test the App

1. Open http://localhost:3000
2. Create an account or login with demo credentials:
   - Gamertag: `DemoPlayer`
   - Password: `demo123`
3. Change your status, set a game you're playing
4. Open another browser (incognito) to test real-time updates

## Key Concepts to Study

### 1. Authentication (JWT + Redis Sessions)

```
src/services/auth/auth.service.ts
```

- JWT for stateless auth tokens
- Redis for session management (enables logout)
- bcrypt for password hashing
- Token validation on every request

### 2. Real-Time Presence (Redis Pub/Sub + WebSocket)

```
src/services/presence/presence.service.ts
```

- Redis stores presence with TTL (auto-offline)
- Pub/Sub broadcasts updates to all servers
- WebSocket pushes to connected clients
- Heartbeat keeps presence alive

### 3. GraphQL with Subscriptions

```
src/graphql/schema.ts
src/graphql/resolvers.ts
```

- Schema defines the API contract
- Resolvers implement data fetching
- Subscriptions for real-time updates
- Type safety throughout

### 4. Apollo Client (Frontend)

```
frontend/src/apollo/client.ts
```

- Link chain (error → auth → http/ws split)
- Normalized cache
- Automatic updates on mutations
- Subscription handling

## Interview Topics Covered

### Algorithms / Coding (JavaScript)
- Async/await patterns
- Event-driven programming
- Data structure usage (Map, Set)
- Error handling patterns

### System Design / Architecture
- Microservices communication
- Real-time at scale (Redis Pub/Sub)
- Caching strategies (TTL, invalidation)
- WebSocket vs HTTP trade-offs

### GraphQL Server Knowledge
- Schema design
- Resolver patterns
- Subscription implementation
- N+1 problem solutions
- Authentication in GraphQL

## Project Structure

```
psn-practice-app/
├── src/
│   ├── server.ts              # Main entry point
│   ├── types/                 # TypeScript types
│   │   └── index.ts           # All type definitions
│   ├── services/
│   │   ├── auth/              # Authentication service
│   │   ├── presence/          # Real-time presence
│   │   └── chat/              # Messaging service
│   └── graphql/
│       ├── schema.ts          # GraphQL schema (SDL)
│       └── resolvers.ts       # Resolver implementations
├── frontend/
│   ├── src/
│   │   ├── main.tsx           # React entry point
│   │   ├── App.tsx            # Main component
│   │   ├── apollo/
│   │   │   └── client.ts      # Apollo Client setup
│   │   └── styles/
│   │       └── global.css     # PlayStation-style CSS
│   └── package.json
├── docker-compose.yml         # Infrastructure setup
├── package.json               # Backend dependencies
└── tsconfig.json              # TypeScript config
```

## Common Interview Questions This Covers

1. **"How would you design a real-time presence system?"**
   - See `presence.service.ts` for the implementation

2. **"How do GraphQL subscriptions work?"**
   - See `schema.ts` and `resolvers.ts` for the pattern

3. **"How would you handle authentication in a GraphQL API?"**
   - See `auth.service.ts` and the context setup in `server.ts`

4. **"How would you scale a chat system?"**
   - See `chat.service.ts` for the two-tier storage strategy

5. **"What's your approach to caching?"**
   - Redis for hot data, TTL-based expiration, pub/sub for invalidation

## Development Commands

```bash
# Backend
npm run dev          # Start with hot reload
npm run build        # Compile TypeScript
npm start            # Run compiled code

# Frontend
cd frontend
npm run dev          # Start Vite dev server
npm run build        # Production build

# Docker
docker-compose up -d         # Start all services
docker-compose down          # Stop all services
docker-compose logs -f redis # View Redis logs
```

## Resources for Further Study

- [GraphQL Subscriptions](https://www.apollographql.com/docs/apollo-server/data/subscriptions/)
- [Redis Pub/Sub](https://redis.io/docs/manual/pubsub/)
- [JWT Best Practices](https://auth0.com/blog/a-look-at-the-latest-draft-for-jwt-bcp/)
- [Apollo Client Cache](https://www.apollographql.com/docs/react/caching/overview/)

Good luck with your PlayStation interview!
