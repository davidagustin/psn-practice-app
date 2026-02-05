/**
 * ==============================================================================
 * PLAYSTATION NETWORK - GRAPHQL FEDERATION
 * ==============================================================================
 *
 * Apollo Federation allows composing a graph from multiple microservices.
 * Each service defines its own schema and the Gateway stitches them together.
 *
 * FEDERATION CONCEPTS:
 * ====================
 *
 * 1. SUBGRAPH: Each microservice exposes a GraphQL schema (subgraph)
 * 2. SUPERGRAPH: The Gateway composes all subgraphs into one schema
 * 3. ENTITIES: Types that can be extended across services (@key directive)
 * 4. REFERENCES: One service can reference entities from another
 *
 * ARCHITECTURE:
 * =============
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                        APOLLO GATEWAY                                    │
 * │                    (Composes Supergraph)                                 │
 * └────────────────────────────────┬─────────────────────────────────────────┘
 *                                  │
 *        ┌────────────┬────────────┼────────────┬────────────┐
 *        │            │            │            │            │
 *        ▼            ▼            ▼            ▼            ▼
 * ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
 * │   User   │ │  Friend  │ │   Game   │ │   Chat   │ │ Activity │
 * │ Subgraph │ │ Subgraph │ │ Subgraph │ │ Subgraph │ │ Subgraph │
 * │          │ │          │ │          │ │          │ │          │
 * │ @key:id  │ │ ref:User │ │ @key:id  │ │ ref:User │ │ ref:User │
 * │          │ │          │ │ ref:User │ │          │ │ ref:Game │
 * └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
 *
 * ENTITY RESOLUTION:
 * ==================
 *
 * When a query spans multiple subgraphs:
 * 1. Gateway queries the first subgraph
 * 2. Gets entity references (e.g., { __typename: "User", id: "123" })
 * 3. Resolves references in the owning subgraph
 * 4. Merges results
 *
 * EXAMPLE QUERY:
 * ```graphql
 * query {
 *   activity(id: "act_123") {   # → Activity Subgraph
 *     title
 *     user {                     # → User Subgraph (entity reference)
 *       gamertag
 *       friends {                # → Friend Subgraph
 *         gamertag
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * INTERVIEW TIP:
 * "Federation lets teams own their subgraphs independently. The User team
 * can deploy changes to their subgraph without coordinating with others.
 * The Gateway automatically picks up schema changes."
 * ==============================================================================
 */

import { ApolloServer } from '@apollo/server';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { gql } from 'graphql-tag';
import express from 'express';
import { expressMiddleware } from '@apollo/server/express4';
import cors from 'cors';
import Redis from 'ioredis';

// ============================================================================
// USER SUBGRAPH
// ============================================================================

/**
 * User Subgraph - Owns User entity.
 *
 * @key DIRECTIVE:
 * Marks User as a federated entity that can be referenced by other subgraphs.
 * The `id` field is the key used for entity resolution.
 *
 * When another subgraph references a User, it only needs to return
 * { __typename: "User", id: "user_123" } and the Gateway will resolve
 * the full User from this subgraph.
 */
const userTypeDefs = gql`
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key", "@shareable"])

  """
  A user in the PlayStation Network.
  This entity is owned by the User service and can be extended by other services.
  """
  type User @key(fields: "id") {
    "Unique user identifier"
    id: ID!
    "Display name visible to other players"
    gamertag: String!
    "User's avatar URL or emoji"
    avatar: String!
    "Experience level (1-999)"
    level: Int!
    "Total trophies earned across all games"
    trophyCount: Int!
    "Current online status"
    status: UserStatus!
    "Game currently being played"
    currentGame: String
    "Custom status message"
    statusMessage: String
  }

  enum UserStatus {
    ONLINE
    AWAY
    BUSY
    OFFLINE
    INVISIBLE
  }

  type Query {
    "Get a user by ID"
    user(id: ID!): User
    "Get the current authenticated user"
    me: User
    "Search for users by gamertag"
    searchUsers(query: String!, limit: Int = 10): [User!]!
  }

  type Mutation {
    "Update the current user's profile"
    updateProfile(input: UpdateProfileInput!): User!
    "Update online status"
    updateStatus(status: UserStatus!): User!
  }

  input UpdateProfileInput {
    avatar: String
    statusMessage: String
  }
`;

const userResolvers = {
  Query: {
    user: async (_: any, { id }: { id: string }, { dataSources }: any) => {
      return dataSources.userAPI.getUser(id);
    },
    me: async (_: any, __: any, { user, dataSources }: any) => {
      if (!user) return null;
      return dataSources.userAPI.getUser(user.userId);
    },
    searchUsers: async (_: any, { query, limit }: { query: string; limit: number }, { dataSources }: any) => {
      return dataSources.userAPI.searchUsers(query, limit);
    },
  },
  User: {
    // Federation entity resolver
    __resolveReference: async (reference: { id: string }, { dataSources }: any) => {
      return dataSources.userAPI.getUser(reference.id);
    },
  },
};

// ============================================================================
// FRIEND SUBGRAPH
// ============================================================================

/**
 * Friend Subgraph - Extends User with friend relationships.
 *
 * @extends DIRECTIVE:
 * Allows this subgraph to add fields to the User entity without owning it.
 * The User type must be defined with @key to enable extension.
 *
 * @external DIRECTIVE:
 * Marks fields that are defined in another subgraph (User subgraph).
 */
const friendTypeDefs = gql`
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key", "@external", "@requires"])

  """
  Extend User with friend-related fields.
  These fields are resolved by the Friend service.
  """
  type User @key(fields: "id") {
    id: ID! @external
    "List of user's friends"
    friends: [User!]!
    "Count of friends"
    friendCount: Int!
    "Pending friend requests received"
    incomingFriendRequests: [FriendRequest!]!
    "Pending friend requests sent"
    outgoingFriendRequests: [FriendRequest!]!
    "Check if two users are friends"
    isFriendWith(userId: ID!): Boolean!
  }

  type FriendRequest {
    id: ID!
    from: User!
    to: User!
    message: String
    status: FriendRequestStatus!
    createdAt: String!
  }

  enum FriendRequestStatus {
    PENDING
    ACCEPTED
    DECLINED
    CANCELED
  }

  type Mutation {
    "Send a friend request"
    sendFriendRequest(toUserId: ID!, message: String): FriendRequest!
    "Accept a friend request"
    acceptFriendRequest(requestId: ID!): User!
    "Decline a friend request"
    declineFriendRequest(requestId: ID!): Boolean!
    "Remove a friend"
    removeFriend(friendId: ID!): Boolean!
    "Block a user"
    blockUser(userId: ID!): Boolean!
  }
`;

const friendResolvers = {
  User: {
    __resolveReference: async (reference: { id: string }, { dataSources }: any) => {
      // Return just the ID - other fields come from User subgraph
      return { id: reference.id };
    },
    friends: async (user: { id: string }, _: any, { dataSources }: any) => {
      const friendIds = await dataSources.friendAPI.getFriendIds(user.id);
      // Return entity references
      return friendIds.map((id: string) => ({ __typename: 'User', id }));
    },
    friendCount: async (user: { id: string }, _: any, { dataSources }: any) => {
      return dataSources.friendAPI.getFriendCount(user.id);
    },
    incomingFriendRequests: async (user: { id: string }, _: any, { dataSources }: any) => {
      return dataSources.friendAPI.getIncomingRequests(user.id);
    },
    outgoingFriendRequests: async (user: { id: string }, _: any, { dataSources }: any) => {
      return dataSources.friendAPI.getOutgoingRequests(user.id);
    },
    isFriendWith: async (user: { id: string }, { userId }: { userId: string }, { dataSources }: any) => {
      return dataSources.friendAPI.areFriends(user.id, userId);
    },
  },
  FriendRequest: {
    from: (request: { fromUserId: string }) => ({ __typename: 'User', id: request.fromUserId }),
    to: (request: { toUserId: string }) => ({ __typename: 'User', id: request.toUserId }),
  },
};

// ============================================================================
// GAME SUBGRAPH
// ============================================================================

/**
 * Game Subgraph - Owns Game entity, extends User with game library.
 */
const gameTypeDefs = gql`
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key", "@external"])

  type Game @key(fields: "id") {
    id: ID!
    title: String!
    description: String!
    coverUrl: String!
    developer: String!
    publisher: String!
    releaseDate: String!
    genres: [String!]!
    platforms: [String!]!
    achievements: [Achievement!]!
    achievementCount: Int!
    playerCount: Int!
  }

  type Achievement @key(fields: "id") {
    id: ID!
    name: String!
    description: String!
    iconUrl: String!
    trophyType: TrophyType!
    rarity: AchievementRarity!
    unlockPercentage: Float!
    game: Game!
  }

  enum TrophyType {
    BRONZE
    SILVER
    GOLD
    PLATINUM
  }

  enum AchievementRarity {
    COMMON
    RARE
    ULTRA_RARE
    LEGENDARY
  }

  """
  Extend User with game-related fields.
  """
  type User @key(fields: "id") {
    id: ID! @external
    "Games in user's library"
    gameLibrary: [UserGame!]!
    "Total games owned"
    gamesOwned: Int!
    "User's unlocked achievements"
    achievements: [UserAchievement!]!
    "Current play session"
    currentPlaySession: PlaySession
  }

  type UserGame {
    game: Game!
    purchasedAt: String!
    lastPlayedAt: String
    playtimeHours: Float!
    completionPercentage: Float!
    achievementsUnlocked: Int!
  }

  type UserAchievement {
    achievement: Achievement!
    unlockedAt: String!
  }

  type PlaySession {
    id: ID!
    game: Game!
    startedAt: String!
    durationMinutes: Int!
  }

  type Query {
    game(id: ID!): Game
    games(limit: Int = 20, offset: Int = 0): [Game!]!
    searchGames(query: String!, limit: Int = 10): [Game!]!
    achievement(id: ID!): Achievement
  }

  type Mutation {
    addGameToLibrary(gameId: ID!): UserGame!
    startPlaySession(gameId: ID!): PlaySession!
    endPlaySession: PlaySession
    unlockAchievement(achievementId: ID!): UserAchievement!
  }
`;

// ============================================================================
// ACTIVITY SUBGRAPH
// ============================================================================

/**
 * Activity Subgraph - Manages activity feed.
 */
const activityTypeDefs = gql`
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key", "@external"])

  type Activity @key(fields: "id") {
    id: ID!
    type: ActivityType!
    user: User!
    title: String!
    description: String
    game: Game
    achievement: Achievement
    createdAt: String!
    likeCount: Int!
    commentCount: Int!
    isLiked: Boolean!
  }

  enum ActivityType {
    GAME_STARTED
    GAME_ENDED
    ACHIEVEMENT_UNLOCKED
    GAME_COMPLETED
    FRIEND_ADDED
    STATUS_CHANGED
    TROPHY_MILESTONE
  }

  type User @key(fields: "id") {
    id: ID! @external
    "User's activity feed (from friends)"
    activityFeed(limit: Int = 50, offset: Int = 0): [Activity!]!
    "User's own activities"
    activities(limit: Int = 20): [Activity!]!
  }

  type Game @key(fields: "id") {
    id: ID! @external
  }

  type Achievement @key(fields: "id") {
    id: ID! @external
  }

  type Query {
    activity(id: ID!): Activity
  }

  type Mutation {
    likeActivity(activityId: ID!): Activity!
    unlikeActivity(activityId: ID!): Activity!
  }

  type Subscription {
    activityAdded(userId: ID!): Activity!
  }
`;

// ============================================================================
// GATEWAY SETUP (Apollo Gateway)
// ============================================================================

/**
 * Create an Apollo Gateway that composes all subgraphs.
 *
 * PRODUCTION SETUP:
 * In production, you would use @apollo/gateway to compose subgraphs:
 *
 * ```typescript
 * import { ApolloGateway, IntrospectAndCompose } from '@apollo/gateway';
 *
 * const gateway = new ApolloGateway({
 *   supergraphSdl: new IntrospectAndCompose({
 *     subgraphs: [
 *       { name: 'users', url: 'http://users-service:4001/graphql' },
 *       { name: 'friends', url: 'http://friends-service:4002/graphql' },
 *       { name: 'games', url: 'http://games-service:4003/graphql' },
 *       { name: 'activities', url: 'http://activities-service:4004/graphql' },
 *     ],
 *   }),
 * });
 * ```
 *
 * ROVER CLI:
 * For schema management, use Apollo Rover:
 * ```bash
 * rover supergraph compose --config ./supergraph.yaml > supergraph.graphql
 * ```
 */
interface SubgraphConfig {
  name: string;
  typeDefs: any;
  resolvers: any;
  port: number;
}

/**
 * Start a subgraph server.
 */
async function startSubgraph(config: SubgraphConfig, redis: Redis): Promise<void> {
  const app = express();

  const schema = buildSubgraphSchema({
    typeDefs: config.typeDefs,
    resolvers: config.resolvers,
  });

  const server = new ApolloServer({
    schema,
  });

  await server.start();

  app.use(
    '/graphql',
    cors<cors.CorsRequest>(),
    express.json(),
    expressMiddleware(server, {
      context: async ({ req }) => ({
        user: (req as any).user,
        dataSources: {
          // Add data sources based on subgraph
          userAPI: createUserDataSource(redis),
          friendAPI: createFriendDataSource(redis),
          gameAPI: createGameDataSource(redis),
          activityAPI: createActivityDataSource(redis),
        },
      }),
    })
  );

  app.get('/health', (_req, res) => {
    res.json({ service: config.name, status: 'healthy' });
  });

  app.listen(config.port, () => {
    console.log(`[${config.name}] Running at http://localhost:${config.port}/graphql`);
  });
}

// ============================================================================
// DATA SOURCES
// ============================================================================

/**
 * Data source factories for each subgraph.
 * These would connect to the respective service's database.
 */
function createUserDataSource(redis: Redis) {
  return {
    async getUser(id: string) {
      const data = await redis.hgetall(`user:${id}`);
      if (!data || Object.keys(data).length === 0) return null;
      return {
        id: data.id,
        gamertag: data.gamertag,
        avatar: data.avatar,
        level: parseInt(data.level || '1'),
        trophyCount: parseInt(data.trophyCount || '0'),
        status: data.status || 'OFFLINE',
        currentGame: data.currentGame || null,
        statusMessage: data.statusMessage || null,
      };
    },
    async searchUsers(query: string, _limit: number) {
      // In production, use search index
      console.log(`Searching users for: ${query}`);
      return [];
    },
  };
}

function createFriendDataSource(redis: Redis) {
  return {
    async getFriendIds(userId: string) {
      return redis.smembers(`user:${userId}:friends`);
    },
    async getFriendCount(userId: string) {
      return redis.scard(`user:${userId}:friends`);
    },
    async getIncomingRequests(_userId: string) {
      return [];
    },
    async getOutgoingRequests(_userId: string) {
      return [];
    },
    async areFriends(userId: string, otherUserId: string) {
      return redis.sismember(`user:${userId}:friends`, otherUserId);
    },
  };
}

function createGameDataSource(_redis: Redis) {
  return {
    async getGame(_id: string) {
      return null;
    },
    async getGames(_limit: number, _offset: number) {
      return [];
    },
  };
}

function createActivityDataSource(_redis: Redis) {
  return {
    async getActivity(_id: string) {
      return null;
    },
    async getFeed(_userId: string, _limit: number, _offset: number) {
      return [];
    },
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  userTypeDefs,
  userResolvers,
  friendTypeDefs,
  friendResolvers,
  gameTypeDefs,
  activityTypeDefs,
  startSubgraph,
};

export type { SubgraphConfig };
