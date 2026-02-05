/**
 * ==============================================================================
 * PLAYSTATION NETWORK - API GATEWAY SERVICE
 * ==============================================================================
 *
 * The API Gateway is the single entry point for all client requests.
 * It implements the Gateway Aggregation Pattern and GraphQL Federation.
 *
 * GATEWAY RESPONSIBILITIES:
 * =========================
 *
 * 1. REQUEST ROUTING:
 *    - Route requests to appropriate microservices
 *    - Handle path-based and header-based routing
 *
 * 2. AUTHENTICATION:
 *    - Validate JWT tokens centrally
 *    - Attach user context to downstream requests
 *
 * 3. RATE LIMITING:
 *    - Global rate limiting per user/IP
 *    - Per-endpoint rate limits
 *
 * 4. CIRCUIT BREAKING:
 *    - Prevent cascade failures
 *    - Fallback responses when services are down
 *
 * 5. GRAPHQL FEDERATION:
 *    - Stitch schemas from multiple services
 *    - Resolve cross-service references
 *
 * ARCHITECTURE:
 * =============
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                           CLIENT REQUESTS                                │
 * └────────────────────────────────┬─────────────────────────────────────────┘
 *                                  │
 *                                  ▼
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                          API GATEWAY                                     │
 * │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐         │
 * │  │   Auth     │  │   Rate     │  │  Circuit   │  │   Router   │         │
 * │  │ Middleware │──│  Limiter   │──│  Breaker   │──│            │         │
 * │  └────────────┘  └────────────┘  └────────────┘  └────────────┘         │
 * └────────────────────────────────┬─────────────────────────────────────────┘
 *                                  │
 *        ┌────────────┬────────────┼────────────┬────────────┐
 *        ▼            ▼            ▼            ▼            ▼
 * ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
 * │   Auth   │ │  Friend  │ │   Game   │ │   Chat   │ │  Voice   │
 * │ Service  │ │ Service  │ │ Service  │ │ Service  │ │ Service  │
 * └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
 *
 * INTERVIEW TIP:
 * "The API Gateway pattern centralizes cross-cutting concerns like auth,
 * rate limiting, and logging. This avoids duplicating this logic in every
 * microservice and provides a single point for monitoring and security."
 * ==============================================================================
 */

import express, { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Service registry configuration.
 *
 * SERVICE DISCOVERY PATTERNS:
 * 1. Static Configuration (used here for simplicity)
 * 2. DNS-based (Kubernetes Services, AWS Cloud Map)
 * 3. Client-side (Consul, Eureka)
 * 4. Server-side (NGINX, AWS ALB)
 *
 * INTERVIEW TIP:
 * "In production, we use Kubernetes Services for service discovery.
 * The DNS resolves service names to pod IPs, and the service mesh
 * handles load balancing and health checks."
 */
interface ServiceConfig {
  name: string;
  url: string;
  healthEndpoint: string;
  timeout: number;
  retries: number;
}

const SERVICE_REGISTRY: Record<string, ServiceConfig> = {
  auth: {
    name: 'auth-service',
    url: process.env.AUTH_SERVICE_URL || 'http://localhost:4001',
    healthEndpoint: '/health',
    timeout: 5000,
    retries: 3,
  },
  friend: {
    name: 'friend-service',
    url: process.env.FRIEND_SERVICE_URL || 'http://localhost:4002',
    healthEndpoint: '/health',
    timeout: 5000,
    retries: 3,
  },
  game: {
    name: 'game-service',
    url: process.env.GAME_SERVICE_URL || 'http://localhost:4003',
    healthEndpoint: '/health',
    timeout: 10000,
    retries: 3,
  },
  chat: {
    name: 'chat-service',
    url: process.env.CHAT_SERVICE_URL || 'http://localhost:4004',
    healthEndpoint: '/health',
    timeout: 5000,
    retries: 3,
  },
  voice: {
    name: 'voice-service',
    url: process.env.VOICE_SERVICE_URL || 'http://localhost:4005',
    healthEndpoint: '/health',
    timeout: 5000,
    retries: 3,
  },
  activity: {
    name: 'activity-service',
    url: process.env.ACTIVITY_SERVICE_URL || 'http://localhost:4006',
    healthEndpoint: '/health',
    timeout: 5000,
    retries: 3,
  },
  profile: {
    name: 'profile-service',
    url: process.env.PROFILE_SERVICE_URL || 'http://localhost:4007',
    healthEndpoint: '/health',
    timeout: 5000,
    retries: 3,
  },
};

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

/**
 * Circuit Breaker states.
 *
 * CIRCUIT BREAKER PATTERN:
 * Prevents cascade failures when a service is down.
 *
 * States:
 * 1. CLOSED: Normal operation, requests pass through
 * 2. OPEN: Service is failing, requests are rejected immediately
 * 3. HALF_OPEN: Testing if service has recovered
 *
 * FLOW:
 * CLOSED → (failures exceed threshold) → OPEN
 * OPEN → (timeout expires) → HALF_OPEN
 * HALF_OPEN → (request succeeds) → CLOSED
 * HALF_OPEN → (request fails) → OPEN
 */
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreaker {
  state: CircuitState;
  failures: number;
  lastFailureTime: number;
  successCount: number;
}

class CircuitBreakerManager {
  private circuits: Map<string, CircuitBreaker> = new Map();
  private readonly failureThreshold = 5;
  private readonly resetTimeout = 30000; // 30 seconds
  private readonly halfOpenSuccessThreshold = 3;

  /**
   * Check if a request should be allowed through.
   */
  canRequest(serviceName: string): boolean {
    const circuit = this.getOrCreateCircuit(serviceName);

    switch (circuit.state) {
      case 'CLOSED':
        return true;

      case 'OPEN':
        // Check if timeout has expired
        if (Date.now() - circuit.lastFailureTime > this.resetTimeout) {
          circuit.state = 'HALF_OPEN';
          circuit.successCount = 0;
          console.log(`[CircuitBreaker] ${serviceName}: OPEN → HALF_OPEN`);
          return true;
        }
        return false;

      case 'HALF_OPEN':
        return true;
    }
  }

  /**
   * Record a successful request.
   */
  recordSuccess(serviceName: string): void {
    const circuit = this.getOrCreateCircuit(serviceName);

    if (circuit.state === 'HALF_OPEN') {
      circuit.successCount++;
      if (circuit.successCount >= this.halfOpenSuccessThreshold) {
        circuit.state = 'CLOSED';
        circuit.failures = 0;
        console.log(`[CircuitBreaker] ${serviceName}: HALF_OPEN → CLOSED`);
      }
    } else if (circuit.state === 'CLOSED') {
      circuit.failures = 0;
    }
  }

  /**
   * Record a failed request.
   */
  recordFailure(serviceName: string): void {
    const circuit = this.getOrCreateCircuit(serviceName);

    if (circuit.state === 'HALF_OPEN') {
      circuit.state = 'OPEN';
      circuit.lastFailureTime = Date.now();
      console.log(`[CircuitBreaker] ${serviceName}: HALF_OPEN → OPEN`);
    } else if (circuit.state === 'CLOSED') {
      circuit.failures++;
      if (circuit.failures >= this.failureThreshold) {
        circuit.state = 'OPEN';
        circuit.lastFailureTime = Date.now();
        console.log(`[CircuitBreaker] ${serviceName}: CLOSED → OPEN`);
      }
    }
  }

  /**
   * Get circuit state for monitoring.
   */
  getState(serviceName: string): CircuitBreaker {
    return this.getOrCreateCircuit(serviceName);
  }

  private getOrCreateCircuit(serviceName: string): CircuitBreaker {
    if (!this.circuits.has(serviceName)) {
      this.circuits.set(serviceName, {
        state: 'CLOSED',
        failures: 0,
        lastFailureTime: 0,
        successCount: 0,
      });
    }
    return this.circuits.get(serviceName)!;
  }
}

// ============================================================================
// RATE LIMITER
// ============================================================================

/**
 * Distributed rate limiter using Redis.
 *
 * ALGORITHM: Token Bucket
 * - Each user has a bucket with N tokens
 * - Tokens refill at rate R per second
 * - Each request consumes 1 token
 * - Request rejected if bucket empty
 *
 * INTERVIEW TIP:
 * "We use Redis for distributed rate limiting because all gateway instances
 * need to share the same rate limit counters. The sliding window algorithm
 * provides smooth rate limiting without burst allowance."
 */
class RateLimiter {
  private redis: Redis;
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(redis: Redis, windowMs = 60000, maxRequests = 100) {
    this.redis = redis;
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  /**
   * Check if request is allowed and consume a token.
   */
  async isAllowed(key: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const redisKey = `ratelimit:${key}`;

    // Remove old entries
    await this.redis.zremrangebyscore(redisKey, 0, windowStart);

    // Count current requests
    const count = await this.redis.zcard(redisKey);

    if (count >= this.maxRequests) {
      // Get oldest entry to calculate reset time
      const oldest = await this.redis.zrange(redisKey, 0, 0, 'WITHSCORES');
      const resetAt = oldest.length >= 2 ? parseInt(oldest[1]) + this.windowMs : now + this.windowMs;

      return {
        allowed: false,
        remaining: 0,
        resetAt,
      };
    }

    // Add current request
    await this.redis.zadd(redisKey, now, `${now}:${Math.random()}`);
    await this.redis.expire(redisKey, Math.ceil(this.windowMs / 1000));

    return {
      allowed: true,
      remaining: this.maxRequests - count - 1,
      resetAt: now + this.windowMs,
    };
  }
}

// ============================================================================
// REQUEST LOGGING
// ============================================================================

/**
 * Request context for distributed tracing.
 *
 * DISTRIBUTED TRACING:
 * Every request gets a unique ID that's passed to all services.
 * This allows correlating logs across the entire request flow.
 *
 * HEADERS:
 * - X-Request-ID: Unique request identifier
 * - X-Correlation-ID: Parent request ID for nested calls
 * - X-User-ID: Authenticated user ID
 */
interface RequestContext {
  requestId: string;
  correlationId?: string;
  userId?: string;
  startTime: number;
  path: string;
  method: string;
}

// ============================================================================
// GATEWAY MIDDLEWARE
// ============================================================================

/**
 * Create the API Gateway Express application.
 */
export function createGateway(redis: Redis): express.Application {
  const app = express();
  const circuitBreaker = new CircuitBreakerManager();
  const rateLimiter = new RateLimiter(redis);

  // ---------------------------------------------------------------------------
  // MIDDLEWARE: Request ID and Logging
  // ---------------------------------------------------------------------------
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = req.headers['x-request-id'] as string || uuidv4();
    const correlationId = req.headers['x-correlation-id'] as string;

    // Attach context to request
    (req as any).context = {
      requestId,
      correlationId,
      startTime: Date.now(),
      path: req.path,
      method: req.method,
    } as RequestContext;

    // Set request ID header for downstream services
    res.setHeader('X-Request-ID', requestId);

    // Log request start
    console.log(
      `[Gateway] ${req.method} ${req.path} - Request ID: ${requestId}`
    );

    // Log request completion
    res.on('finish', () => {
      const duration = Date.now() - (req as any).context.startTime;
      console.log(
        `[Gateway] ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`
      );
    });

    next();
  });

  // ---------------------------------------------------------------------------
  // MIDDLEWARE: Rate Limiting
  // ---------------------------------------------------------------------------
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    // Skip rate limiting for health checks
    if (req.path === '/health') {
      return next();
    }

    // Use IP for unauthenticated, user ID for authenticated
    const key = (req as any).user?.userId || req.ip || 'unknown';
    const result = await rateLimiter.isAllowed(key);

    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', result.resetAt);

    if (!result.allowed) {
      console.log(`[Gateway] Rate limit exceeded for ${key}`);
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
      });
    }

    next();
  });

  // ---------------------------------------------------------------------------
  // MIDDLEWARE: Authentication
  // ---------------------------------------------------------------------------
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Skip auth for public endpoints
    const publicPaths = ['/health', '/auth/login', '/auth/register', '/graphql'];
    if (publicPaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);

    try {
      const payload = jwt.verify(
        token,
        process.env.JWT_SECRET || 'your-secret-key'
      );
      (req as any).user = payload;
      (req as any).context.userId = (payload as any).userId;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  });

  // ---------------------------------------------------------------------------
  // HEALTH CHECK
  // ---------------------------------------------------------------------------
  app.get('/health', async (_req: Request, res: Response) => {
    const health: Record<string, any> = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {},
    };

    // Check each service health
    for (const [name, config] of Object.entries(SERVICE_REGISTRY)) {
      const circuit = circuitBreaker.getState(name);
      health.services[name] = {
        url: config.url,
        circuitState: circuit.state,
        failures: circuit.failures,
      };
    }

    res.json(health);
  });

  // ---------------------------------------------------------------------------
  // SERVICE ROUTES
  // ---------------------------------------------------------------------------

  // Helper to create proxy with circuit breaker
  const createServiceProxy = (serviceName: string): express.RequestHandler => {
    const config = SERVICE_REGISTRY[serviceName];
    if (!config) {
      return (_req, res) => {
        res.status(500).json({ error: `Unknown service: ${serviceName}` });
      };
    }

    const proxyOptions: Options = {
      target: config.url,
      changeOrigin: true,
      timeout: config.timeout,
      pathRewrite: {
        [`^/${serviceName}`]: '',
      },
      on: {
        proxyReq: (proxyReq, req) => {
          // Forward context headers
          const context = (req as any).context as RequestContext;
          proxyReq.setHeader('X-Request-ID', context.requestId);
          if (context.userId) {
            proxyReq.setHeader('X-User-ID', context.userId);
          }
        },
        proxyRes: () => {
          circuitBreaker.recordSuccess(serviceName);
        },
        error: (err: Error) => {
          console.error(`[Gateway] Proxy error for ${serviceName}:`, err.message);
          circuitBreaker.recordFailure(serviceName);
        },
      },
    };

    const proxy = createProxyMiddleware(proxyOptions);

    return (req: Request, res: Response, next: NextFunction) => {
      // Check circuit breaker
      if (!circuitBreaker.canRequest(serviceName)) {
        return res.status(503).json({
          error: 'Service Unavailable',
          message: `${serviceName} is temporarily unavailable. Please try again later.`,
        });
      }

      return proxy(req, res, next);
    };
  };

  // Mount service routes
  app.use('/auth', createServiceProxy('auth'));
  app.use('/friends', createServiceProxy('friend'));
  app.use('/games', createServiceProxy('game'));
  app.use('/chat', createServiceProxy('chat'));
  app.use('/voice', createServiceProxy('voice'));
  app.use('/activity', createServiceProxy('activity'));
  app.use('/profile', createServiceProxy('profile'));

  // ---------------------------------------------------------------------------
  // GRAPHQL FEDERATION (Would use Apollo Gateway in production)
  // ---------------------------------------------------------------------------
  app.use('/graphql', (_req: Request, res: Response) => {
    // In production, this would be Apollo Gateway with Federation
    res.json({
      message: 'GraphQL Federation endpoint',
      note: 'Use Apollo Gateway with @apollo/gateway for production federation',
    });
  });

  // ---------------------------------------------------------------------------
  // FALLBACK
  // ---------------------------------------------------------------------------
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found' });
  });

  return app;
}

// ============================================================================
// EXPORTS
// ============================================================================

export { CircuitBreakerManager, RateLimiter, SERVICE_REGISTRY };
export type { ServiceConfig, CircuitBreaker, RequestContext };
