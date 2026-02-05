/**
 * ==============================================================================
 * PLAYSTATION NETWORK - AUTH MICROSERVICE
 * ==============================================================================
 *
 * Standalone authentication service extracted from the monolith.
 * This demonstrates the microservice extraction pattern.
 *
 * SERVICE RESPONSIBILITIES:
 * =========================
 * - User registration and login
 * - JWT token generation and validation
 * - Password hashing and verification
 * - Session management
 *
 * EXTRACTION STRATEGY:
 * ====================
 *
 * STRANGLER FIG PATTERN:
 * 1. Create new microservice alongside monolith
 * 2. Route new requests to microservice
 * 3. Gradually migrate functionality
 * 4. Eventually retire monolith component
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  BEFORE: Monolith                                                        │
 * │  ┌────────────────────────────────────────────────────────────────────┐  │
 * │  │  Auth │ Friends │ Games │ Chat │ Voice │ Activity │ Profile        │  │
 * │  └────────────────────────────────────────────────────────────────────┘  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 *                                    │
 *                                    ▼
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  AFTER: Microservices                                                    │
 * │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
 * │  │   Auth   │  │  Friend  │  │   Game   │  │   Chat   │  ...           │
 * │  │ Service  │  │ Service  │  │ Service  │  │ Service  │                 │
 * │  └──────────┘  └──────────┘  └──────────┘  └──────────┘                 │
 * │       │              │              │              │                     │
 * │       └──────────────┴──────────────┴──────────────┘                     │
 * │                             │                                            │
 * │                     ┌───────▼───────┐                                    │
 * │                     │     Redis     │                                    │
 * │                     │   (Shared)    │                                    │
 * │                     └───────────────┘                                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * DATA OWNERSHIP:
 * ===============
 * This service OWNS:
 * - User credentials (email, password hash)
 * - User sessions
 * - JWT tokens
 *
 * This service DOES NOT OWN:
 * - User profiles (Profile Service)
 * - Friend relationships (Friend Service)
 * - Game data (Game Service)
 *
 * INTERVIEW TIP:
 * "Data ownership is crucial in microservices. Each service owns its data
 * and exposes it via APIs. Other services should never directly access
 * another service's database - this creates tight coupling."
 * ==============================================================================
 */

import express, { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

// ============================================================================
// CONFIGURATION
// ============================================================================

interface AuthServiceConfig {
  port: number;
  jwtSecret: string;
  jwtExpiresIn: string;
  bcryptRounds: number;
  sessionTTLSeconds: number;
  redisUrl: string;
}

const config: AuthServiceConfig = {
  port: parseInt(process.env.AUTH_SERVICE_PORT || '4001'),
  jwtSecret: process.env.JWT_SECRET || 'your-secret-key',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
  bcryptRounds: 12,
  sessionTTLSeconds: 86400, // 24 hours
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
};

// ============================================================================
// TYPES
// ============================================================================

interface User {
  id: string;
  email: string;
  gamertag: string;
  passwordHash: string;
  avatar: string;
  level: number;
  trophyCount: number;
  createdAt: string;
  updatedAt: string;
}

interface Session {
  userId: string;
  gamertag: string;
  deviceInfo: string;
  ipAddress: string;
  createdAt: string;
  lastActivityAt: string;
}

interface JWTPayload {
  userId: string;
  gamertag: string;
}

// ============================================================================
// EVENT EMITTER (FOR INTEGRATION)
// ============================================================================

/**
 * Auth events for inter-service communication.
 *
 * EVENT-DRIVEN COMMUNICATION:
 * Instead of synchronous HTTP calls, services emit events:
 * - user.registered → Profile Service creates profile
 * - user.logged_in → Presence Service sets online
 * - user.logged_out → Presence Service sets offline
 *
 * INTERVIEW TIP:
 * "Event-driven architecture provides loose coupling. The Auth Service
 * doesn't need to know about the Profile Service - it just emits an event.
 * Any interested service can subscribe."
 */
class AuthEventEmitter extends EventEmitter {
  emitUserRegistered(userId: string, gamertag: string): void {
    this.emit('user.registered', { userId, gamertag, timestamp: new Date().toISOString() });
  }

  emitUserLoggedIn(userId: string): void {
    this.emit('user.logged_in', { userId, timestamp: new Date().toISOString() });
  }

  emitUserLoggedOut(userId: string): void {
    this.emit('user.logged_out', { userId, timestamp: new Date().toISOString() });
  }
}

// ============================================================================
// AUTH SERVICE
// ============================================================================

/**
 * Auth Service - Handles all authentication operations.
 */
class AuthService {
  private redis: Redis;
  private events: AuthEventEmitter;

  constructor(redis: Redis) {
    this.redis = redis;
    this.events = new AuthEventEmitter();
  }

  /**
   * Register a new user.
   */
  async register(
    email: string,
    gamertag: string,
    password: string
  ): Promise<{ token: string; user: Omit<User, 'passwordHash'> }> {
    // Check if email already exists
    const existingEmail = await this.redis.hget('users:email_to_id', email.toLowerCase());
    if (existingEmail) {
      throw new Error('Email already registered');
    }

    // Check if gamertag already exists
    const existingGamertag = await this.redis.hget('users:gamertag_to_id', gamertag.toLowerCase());
    if (existingGamertag) {
      throw new Error('Gamertag already taken');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

    // Create user
    const userId = `user_${uuidv4()}`;
    const now = new Date().toISOString();

    const user: User = {
      id: userId,
      email: email.toLowerCase(),
      gamertag,
      passwordHash,
      avatar: '🎮',
      level: 1,
      trophyCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Store user data
    await this.redis.hset(`user:${userId}`, user as any);

    // Create indexes
    await this.redis.hset('users:email_to_id', email.toLowerCase(), userId);
    await this.redis.hset('users:gamertag_to_id', gamertag.toLowerCase(), userId);

    // Generate token
    const token = this.generateToken(userId, gamertag);

    // Emit event
    this.events.emitUserRegistered(userId, gamertag);

    console.log(`[AuthService] User registered: ${gamertag} (${userId})`);

    const { passwordHash: _, ...publicUser } = user;
    return { token, user: publicUser };
  }

  /**
   * Login with email/gamertag and password.
   */
  async login(
    identifier: string,
    password: string,
    deviceInfo: string,
    ipAddress: string
  ): Promise<{ token: string; user: Omit<User, 'passwordHash'> }> {
    // Find user by email or gamertag
    let userId = await this.redis.hget('users:email_to_id', identifier.toLowerCase());
    if (!userId) {
      userId = await this.redis.hget('users:gamertag_to_id', identifier.toLowerCase());
    }

    if (!userId) {
      throw new Error('Invalid credentials');
    }

    // Get user data
    const userData = await this.redis.hgetall(`user:${userId}`);
    if (!userData || !userData.passwordHash) {
      throw new Error('Invalid credentials');
    }

    // Verify password
    const valid = await bcrypt.compare(password, userData.passwordHash);
    if (!valid) {
      throw new Error('Invalid credentials');
    }

    // Create session
    const session: Session = {
      userId,
      gamertag: userData.gamertag,
      deviceInfo,
      ipAddress,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };

    await this.redis.hset(`session:${userId}`, session as any);
    await this.redis.expire(`session:${userId}`, config.sessionTTLSeconds);

    // Generate token
    const token = this.generateToken(userId, userData.gamertag);

    // Emit event
    this.events.emitUserLoggedIn(userId);

    console.log(`[AuthService] User logged in: ${userData.gamertag}`);

    const { passwordHash: _, ...publicUser } = userData as any;
    return { token, user: publicUser };
  }

  /**
   * Logout and destroy session.
   */
  async logout(userId: string): Promise<void> {
    await this.redis.del(`session:${userId}`);
    this.events.emitUserLoggedOut(userId);
    console.log(`[AuthService] User logged out: ${userId}`);
  }

  /**
   * Validate a JWT token.
   */
  async validateToken(token: string): Promise<JWTPayload> {
    try {
      const payload = jwt.verify(token, config.jwtSecret) as JWTPayload;

      // Check if session exists
      const session = await this.redis.hgetall(`session:${payload.userId}`);
      if (!session || Object.keys(session).length === 0) {
        throw new Error('Session expired');
      }

      // Update last activity
      await this.redis.hset(`session:${payload.userId}`, 'lastActivityAt', new Date().toISOString());

      return payload;
    } catch (error) {
      throw new Error('Invalid or expired token');
    }
  }

  /**
   * Get user by ID.
   */
  async getUser(userId: string): Promise<Omit<User, 'passwordHash'> | null> {
    const userData = await this.redis.hgetall(`user:${userId}`);
    if (!userData || Object.keys(userData).length === 0) {
      return null;
    }

    const { passwordHash: _, ...publicUser } = userData as any;
    return publicUser;
  }

  /**
   * Generate JWT token.
   */
  private generateToken(userId: string, gamertag: string): string {
    const payload: JWTPayload = { userId, gamertag };
    return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
  }

  /**
   * Get event emitter for subscribing to auth events.
   */
  getEventEmitter(): AuthEventEmitter {
    return this.events;
  }
}

// ============================================================================
// EXPRESS APP
// ============================================================================

/**
 * Create the Auth Service Express application.
 */
export function createAuthService(redis: Redis): express.Application {
  const app = express();
  const authService = new AuthService(redis);

  app.use(express.json());

  // ---------------------------------------------------------------------------
  // HEALTH CHECK
  // ---------------------------------------------------------------------------
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      service: 'auth-service',
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  });

  // ---------------------------------------------------------------------------
  // REGISTER
  // ---------------------------------------------------------------------------
  app.post('/register', async (req: Request, res: Response) => {
    try {
      const { email, gamertag, password } = req.body;

      if (!email || !gamertag || !password) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const result = await authService.register(email, gamertag, password);
      res.status(201).json(result);
    } catch (error: any) {
      console.error('[AuthService] Registration error:', error.message);
      res.status(400).json({ error: error.message });
    }
  });

  // ---------------------------------------------------------------------------
  // LOGIN
  // ---------------------------------------------------------------------------
  app.post('/login', async (req: Request, res: Response) => {
    try {
      const { identifier, password } = req.body;
      const deviceInfo = req.headers['user-agent'] || 'unknown';
      const ipAddress = req.ip || 'unknown';

      if (!identifier || !password) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const result = await authService.login(identifier, password, deviceInfo, ipAddress);
      res.json(result);
    } catch (error: any) {
      console.error('[AuthService] Login error:', error.message);
      res.status(401).json({ error: error.message });
    }
  });

  // ---------------------------------------------------------------------------
  // LOGOUT
  // ---------------------------------------------------------------------------
  app.post('/logout', async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      await authService.logout(userId);
      res.json({ message: 'Logged out successfully' });
    } catch (error: any) {
      console.error('[AuthService] Logout error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------------------------------------------------------
  // VALIDATE TOKEN
  // ---------------------------------------------------------------------------
  app.post('/validate', async (req: Request, res: Response) => {
    try {
      const { token } = req.body;
      if (!token) {
        return res.status(400).json({ error: 'Missing token' });
      }

      const payload = await authService.validateToken(token);
      res.json({ valid: true, payload });
    } catch (error: any) {
      res.status(401).json({ valid: false, error: error.message });
    }
  });

  // ---------------------------------------------------------------------------
  // GET USER
  // ---------------------------------------------------------------------------
  app.get('/users/:userId', async (req: Request, res: Response) => {
    try {
      const user = await authService.getUser(req.params.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json(user);
    } catch (error: any) {
      console.error('[AuthService] Get user error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------------------------------------------------------
  // ERROR HANDLER
  // ---------------------------------------------------------------------------
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[AuthService] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// ============================================================================
// STANDALONE STARTUP (if run directly)
// ============================================================================

if (require.main === module) {
  const redis = new Redis(config.redisUrl);
  const app = createAuthService(redis);

  app.listen(config.port, () => {
    console.log(`[AuthService] Running on port ${config.port}`);
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

export { AuthService, AuthEventEmitter };
