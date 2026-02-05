/**
 * ==============================================================================
 * PLAYSTATION NETWORK - MAIN SERVER
 * ==============================================================================
 *
 * This is the entry point for the backend server. It sets up:
 * 1. Express HTTP server
 * 2. Apollo GraphQL server with subscriptions
 * 3. WebSocket server for real-time communication
 * 4. Service initialization with dependency injection
 *
 * SERVER ARCHITECTURE:
 * ====================
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │                       CLIENTS                                │
 * │            (PlayStation App, Web, Mobile)                    │
 * └──────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌──────────────────────────────────────────────────────────────┐
 * │                    EXPRESS SERVER                            │
 * │   ┌─────────────────┐  ┌─────────────────┐                   │
 * │   │   HTTP :4000    │  │  WebSocket :4000│                   │
 * │   │  (GraphQL API)  │  │  (Subscriptions)│                   │
 * │   └─────────────────┘  └─────────────────┘                   │
 * └──────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌──────────────────────────────────────────────────────────────┐
 * │                    APOLLO SERVER                             │
 * │   ┌─────────────────────────────────────────────────────┐   │
 * │   │                     CONTEXT                          │   │
 * │   │  - Authenticated user (from JWT)                     │   │
 * │   │  - Request ID                                        │   │
 * │   │  - Client IP                                         │   │
 * │   └─────────────────────────────────────────────────────┘   │
 * │   ┌─────────────────────────────────────────────────────┐   │
 * │   │                    RESOLVERS                         │   │
 * │   │  - Query (read operations)                           │   │
 * │   │  - Mutation (write operations)                       │   │
 * │   │  - Subscription (real-time streams)                  │   │
 * │   └─────────────────────────────────────────────────────┘   │
 * └──────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌──────────────────────────────────────────────────────────────┐
 * │                      SERVICES                                │
 * │   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
 * │   │   Auth   │  │ Presence │  │   Chat   │  │  Notif   │    │
 * │   │ Service  │  │ Service  │  │ Service  │  │ Service  │    │
 * │   └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
 * └──────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌──────────────────────────────────────────────────────────────┐
 * │                   INFRASTRUCTURE                             │
 * │   ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
 * │   │  Redis   │  │  Kafka   │  │ DynamoDB │                  │
 * │   │ (Cache)  │  │ (Events) │  │   (DB)   │                  │
 * │   └──────────┘  └──────────┘  └──────────┘                  │
 * └──────────────────────────────────────────────────────────────┘
 *
 * WEBSOCKET VS HTTP:
 * ==================
 *
 * HTTP (Queries & Mutations):
 * - Request-response pattern
 * - New connection per request
 * - Good for: Data fetching, state changes
 *
 * WebSocket (Subscriptions):
 * - Long-lived connection
 * - Server can push to client
 * - Good for: Real-time updates, notifications
 *
 * INTERVIEW TIP:
 * "We use a single port for both HTTP and WebSocket. The initial
 * connection is HTTP, then upgrades to WebSocket for subscriptions.
 * This simplifies deployment and load balancer configuration."
 * ==============================================================================
 */

import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import { PubSub } from 'graphql-subscriptions';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

// Import our modules
import { typeDefs } from './graphql/schema';
import { createResolvers } from './graphql/resolvers';
import { AuthService } from './services/auth/auth.service';
import { PresenceService } from './services/presence/presence.service';
import { ChatService } from './services/chat/chat.service';
import { GraphQLContext, JWTPayload } from './types';

/**
 * Server configuration from environment variables.
 *
 * CONFIGURATION PATTERN:
 * - Default values for development
 * - Override with environment variables for production
 * - Type-safe configuration object
 */
const CONFIG = {
  port: parseInt(process.env.PORT || '4000', 10),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  nodeEnv: process.env.NODE_ENV || 'development',
};

/**
 * Main server initialization function.
 *
 * WHY ASYNC IIFE (Immediately Invoked Function Expression)?
 * - Allows top-level await
 * - Contains all initialization logic
 * - Easy to handle errors
 */
async function startServer(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('     PLAYSTATION NETWORK - SOCIAL GAMING PLATFORM          ');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Environment: ${CONFIG.nodeEnv}`);
  console.log(`Port: ${CONFIG.port}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // ===========================================================================
  // STEP 1: INITIALIZE INFRASTRUCTURE CONNECTIONS
  // ===========================================================================

  console.log('[Server] Initializing infrastructure...');

  /**
   * REDIS CONNECTION
   *
   * Single Redis client used by all services.
   * In production, you'd use Redis Cluster for high availability.
   *
   * CONNECTION PATTERN:
   * - Create client on startup
   * - Handle connection errors
   * - Implement reconnection logic
   */
  let redis: Redis;
  try {
    redis = new Redis(CONFIG.redisUrl, {
      // Retry strategy for connection failures
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        console.log(`[Redis] Reconnecting... attempt ${times}, delay ${delay}ms`);
        return delay;
      },
      // Connection timeout
      connectTimeout: 10000,
      // Max retries for commands
      maxRetriesPerRequest: 3,
    });

    // Handle connection events
    redis.on('connect', () => {
      console.log('[Redis] Connected successfully');
    });

    redis.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });

    // Test connection
    await redis.ping();
    console.log('[Redis] Connection verified with PING');
  } catch (error) {
    console.error('[Redis] Failed to connect:', error);
    console.log('[Redis] Running in demo mode without Redis');
    // Create a mock Redis for demo purposes
    redis = new Redis({ lazyConnect: true });
  }

  // ===========================================================================
  // STEP 2: INITIALIZE SERVICES
  // ===========================================================================

  console.log('[Server] Initializing services...');

  /**
   * SERVICE INITIALIZATION WITH DEPENDENCY INJECTION
   *
   * Services are created with their dependencies passed in.
   * This pattern enables:
   * - Easy testing with mocks
   * - Clear dependency relationships
   * - Centralized configuration
   */
  const authService = new AuthService(redis);
  const presenceService = new PresenceService(redis);
  const chatService = new ChatService(redis);

  console.log('[Server] ✓ AuthService initialized');
  console.log('[Server] ✓ PresenceService initialized');
  console.log('[Server] ✓ ChatService initialized');

  /**
   * PUBSUB FOR GRAPHQL SUBSCRIPTIONS
   *
   * PubSub is the in-memory event bus for subscriptions.
   *
   * SCALING NOTE:
   * In production, use graphql-redis-subscriptions to share
   * events across multiple server instances:
   *
   * import { RedisPubSub } from 'graphql-redis-subscriptions';
   * const pubsub = new RedisPubSub({ connection: redisOptions });
   */
  const pubsub = new PubSub();

  // Wire up service events to PubSub
  presenceService.on('presenceUpdate', (event) => {
    pubsub.publish('FRIEND_PRESENCE_UPDATED', {
      friendPresenceUpdated: event.presence,
    });
  });

  chatService.on('messageEvent', (event) => {
    if (event.type === 'new_message' && event.message) {
      pubsub.publish(`MESSAGE_RECEIVED.${event.conversationId}`, {
        messageReceived: event.message,
      });
    }
  });

  // ===========================================================================
  // STEP 3: CREATE EXPRESS APP AND HTTP SERVER
  // ===========================================================================

  console.log('[Server] Setting up Express and HTTP server...');

  const app = express();

  /**
   * HTTP SERVER CREATION
   *
   * We create the HTTP server explicitly (rather than letting Express
   * create it implicitly) because:
   * 1. We need to attach WebSocket server to the same port
   * 2. Apollo needs it for graceful shutdown
   */
  const httpServer = createServer(app);

  // ===========================================================================
  // STEP 4: CREATE GRAPHQL SCHEMA
  // ===========================================================================

  console.log('[Server] Building GraphQL schema...');

  /**
   * EXECUTABLE SCHEMA
   *
   * makeExecutableSchema combines:
   * - Type definitions (what data looks like)
   * - Resolvers (how to fetch/compute data)
   *
   * The resulting schema is used by both:
   * - Apollo Server (HTTP queries/mutations)
   * - WebSocket Server (subscriptions)
   */
  const resolvers = createResolvers(authService, presenceService, chatService, pubsub);
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers,
  });

  // ===========================================================================
  // STEP 5: SET UP WEBSOCKET SERVER FOR SUBSCRIPTIONS
  // ===========================================================================

  console.log('[Server] Configuring WebSocket server for subscriptions...');

  /**
   * WEBSOCKET SERVER SETUP
   *
   * graphql-ws is the modern protocol for GraphQL subscriptions.
   * (subscriptions-transport-ws is deprecated)
   *
   * WebSocket connections flow:
   * 1. Client connects to ws://localhost:4000/graphql
   * 2. Server accepts and creates subscription
   * 3. Server pushes updates when events occur
   * 4. Connection stays open until client disconnects
   */
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: '/graphql',
  });

  /**
   * GRAPHQL-WS SERVER
   *
   * Handles the GraphQL subscription protocol over WebSocket.
   *
   * IMPORTANT: Context for subscriptions is different from HTTP!
   * - HTTP: Context created per request
   * - WebSocket: Context created per connection
   */
  const serverCleanup = useServer(
    {
      schema,

      /**
       * CONTEXT FOR SUBSCRIPTIONS
       *
       * Called when WebSocket connection is established.
       * Extract auth token and create context that persists
       * for the lifetime of the connection.
       */
      context: async (ctx) => {
        // Get auth token from connection params
        const token = ctx.connectionParams?.authorization as string || '';

        // Validate token and get user
        let user: JWTPayload | null = null;
        if (token) {
          try {
            user = await authService.validateToken(token.replace('Bearer ', ''));
            console.log(`[WebSocket] Authenticated connection: ${user.gamertag}`);
          } catch (error) {
            console.log('[WebSocket] Invalid token, anonymous connection');
          }
        }

        const context: GraphQLContext = {
          user,
          session: null,
          clientIp: 'websocket',
          requestId: uuidv4(),
        };

        return context;
      },

      /**
       * CONNECTION LIFECYCLE HOOKS
       *
       * These are useful for:
       * - Logging
       * - Analytics
       * - Resource cleanup
       */
      onConnect: async (ctx) => {
        console.log('[WebSocket] Client connected');

        // You could require auth here:
        // if (!ctx.connectionParams?.authorization) {
        //   return false; // Reject connection
        // }

        return true;
      },

      onDisconnect: async (ctx, code, reason) => {
        console.log(`[WebSocket] Client disconnected: ${code} ${reason}`);
      },

      onSubscribe: async (ctx, msg) => {
        console.log(`[WebSocket] New subscription: ${msg.payload.operationName || 'anonymous'}`);
      },

      onError: async (ctx, msg, errors) => {
        console.error('[WebSocket] Error:', errors);
      },
    },
    wsServer
  );

  // ===========================================================================
  // STEP 6: CREATE APOLLO SERVER
  // ===========================================================================

  console.log('[Server] Creating Apollo GraphQL server...');

  /**
   * APOLLO SERVER CONFIGURATION
   *
   * Apollo Server is the GraphQL engine that:
   * - Parses queries
   * - Validates against schema
   * - Executes resolvers
   * - Formats responses
   */
  const apolloServer = new ApolloServer<GraphQLContext>({
    schema,

    /**
     * PLUGINS
     *
     * Plugins extend Apollo Server functionality.
     * DrainHttpServer ensures in-flight requests complete on shutdown.
     */
    plugins: [
      // Graceful shutdown for HTTP
      ApolloServerPluginDrainHttpServer({ httpServer }),

      // Graceful shutdown for WebSocket
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await serverCleanup.dispose();
            },
          };
        },
      },
    ],

    /**
     * INTROSPECTION & PLAYGROUND
     *
     * Introspection allows clients to query the schema.
     * Enable in development, disable in production for security.
     */
    introspection: CONFIG.nodeEnv !== 'production',

    /**
     * ERROR FORMATTING
     *
     * Customize error messages sent to clients.
     * In production, hide internal error details.
     */
    formatError: (formattedError, error) => {
      console.error('[GraphQL Error]', error);

      // In production, hide internal errors
      if (CONFIG.nodeEnv === 'production') {
        // Hide stack traces and internal messages
        return {
          message: formattedError.message,
          extensions: {
            code: formattedError.extensions?.code || 'INTERNAL_ERROR',
          },
        };
      }

      return formattedError;
    },
  });

  // Start Apollo Server
  await apolloServer.start();
  console.log('[Server] ✓ Apollo Server started');

  // ===========================================================================
  // STEP 7: CONFIGURE EXPRESS MIDDLEWARE
  // ===========================================================================

  console.log('[Server] Configuring Express middleware...');

  /**
   * CORS (Cross-Origin Resource Sharing)
   *
   * Allows the frontend (running on different port/domain)
   * to make requests to this API.
   *
   * SECURITY NOTE:
   * In production, restrict to your actual frontend domains.
   */
  app.use(
    cors({
      origin: CONFIG.corsOrigin,
      credentials: true,
    })
  );

  // Parse JSON request bodies
  app.use(express.json());

  /**
   * HEALTH CHECK ENDPOINT
   *
   * Used by:
   * - Load balancers to check if server is healthy
   * - Kubernetes for liveness/readiness probes
   * - Monitoring systems
   */
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  /**
   * GRAPHQL ENDPOINT
   *
   * This is the main API endpoint.
   * All GraphQL queries and mutations go here.
   */
  app.use(
    '/graphql',
    expressMiddleware(apolloServer, {
      /**
       * CONTEXT FUNCTION
       *
       * Called for every request.
       * Creates the context object available to all resolvers.
       *
       * AUTHENTICATION FLOW:
       * 1. Extract Authorization header
       * 2. Validate JWT token
       * 3. Attach user to context
       * 4. Resolvers check context.user for auth
       */
      context: async ({ req }): Promise<GraphQLContext> => {
        const requestId = uuidv4();
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

        // Extract auth token
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace('Bearer ', '');

        // Validate token and get user
        let user: JWTPayload | null = null;
        let session = null;

        if (token) {
          try {
            user = await authService.validateToken(token);
            session = await authService.getSession(user.userId);
          } catch (error) {
            // Invalid token - user remains null
            // Resolvers will throw if auth required
            console.log(`[Auth] Invalid token for request ${requestId}`);
          }
        }

        return {
          user,
          session,
          clientIp,
          requestId,
        };
      },
    })
  );

  // ===========================================================================
  // STEP 8: START LISTENING
  // ===========================================================================

  await new Promise<void>((resolve) => {
    httpServer.listen(CONFIG.port, () => {
      resolve();
    });
  });

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                    SERVER READY                           ');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`GraphQL API:     http://localhost:${CONFIG.port}/graphql`);
  console.log(`WebSocket:       ws://localhost:${CONFIG.port}/graphql`);
  console.log(`Health Check:    http://localhost:${CONFIG.port}/health`);
  console.log(`GraphQL Sandbox: http://localhost:${CONFIG.port}/graphql`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // ===========================================================================
  // STEP 9: GRACEFUL SHUTDOWN HANDLING
  // ===========================================================================

  /**
   * GRACEFUL SHUTDOWN
   *
   * Properly close connections when the server stops.
   * This is critical for:
   * - Not losing in-flight requests
   * - Releasing database connections
   * - Kubernetes pod termination
   *
   * SIGNALS:
   * - SIGTERM: Kubernetes sends this before killing pod
   * - SIGINT: Ctrl+C in terminal
   */
  const shutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}, starting graceful shutdown...`);

    try {
      // Stop accepting new connections
      httpServer.close();
      console.log('[Server] HTTP server closed');

      // Close WebSocket connections
      await serverCleanup.dispose();
      console.log('[Server] WebSocket server closed');

      // Stop Apollo Server
      await apolloServer.stop();
      console.log('[Server] Apollo Server stopped');

      // Clean up services
      await presenceService.cleanup();
      await chatService.cleanup();
      console.log('[Server] Services cleaned up');

      // Close Redis connection
      await redis.quit();
      console.log('[Server] Redis connection closed');

      console.log('[Server] Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('[Server] Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ===========================================================================
// START THE SERVER
// ===========================================================================

startServer().catch((error) => {
  console.error('[Server] Fatal error during startup:', error);
  process.exit(1);
});
