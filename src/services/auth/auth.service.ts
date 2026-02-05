/**
 * ==============================================================================
 * PLAYSTATION NETWORK - AUTHENTICATION SERVICE
 * ==============================================================================
 *
 * This service handles all authentication-related operations for the PSN platform.
 * It's the FOUNDATION of PlayStation's architecture - every other service depends on it.
 *
 * AUTHENTICATION FLOW:
 * ====================
 *
 * REGISTRATION:
 * 1. User submits gamertag, email, password
 * 2. Validate input (unique gamertag, valid email, strong password)
 * 3. Hash password with bcrypt (NEVER store plain text!)
 * 4. Create user record in database
 * 5. Generate JWT token
 * 6. Create session in Redis
 * 7. Return token + user profile
 *
 * LOGIN:
 * 1. User submits gamertag/email + password
 * 2. Look up user in database
 * 3. Compare password hash with bcrypt
 * 4. Generate new JWT token
 * 5. Create session in Redis
 * 6. Return token + user profile
 *
 * TOKEN VALIDATION (on every request):
 * 1. Extract token from Authorization header
 * 2. Verify JWT signature and expiration
 * 3. Check session exists in Redis (handles logout/revocation)
 * 4. Attach user to request context
 *
 * SECURITY PATTERNS USED:
 * =======================
 * - bcrypt for password hashing (adaptive cost factor)
 * - JWT for stateless authentication (with Redis for revocation)
 * - Short-lived tokens with refresh capability
 * - Session tracking for logout/security
 *
 * INTERVIEW TIP:
 * "We use a hybrid approach: JWT for stateless auth (scalability) plus
 * Redis sessions for revocation capability (security). This gives us
 * the best of both worlds."
 * ==============================================================================
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';
import {
  User,
  PublicUser,
  JWTPayload,
  UserSession,
  AuthResponse,
  CreateUserInput,
  LoginInput,
} from '../../types';

/**
 * Configuration for the AuthService.
 * In production, these would come from environment variables.
 */
interface AuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  sessionTTL: number; // in seconds
  bcryptRounds: number;
}

/**
 * In-memory user store for demo purposes.
 * In production, this would be DynamoDB or another database.
 *
 * INTERVIEW TIP:
 * When building demos, it's fine to use in-memory storage.
 * Just be clear about what you'd do differently in production.
 */
const users: Map<string, User> = new Map();

// Initialize with a demo user
const demoPasswordHash = bcrypt.hashSync('demo123', 10);
users.set('demo_user_1', {
  id: 'demo_user_1',
  gamertag: 'DemoPlayer',
  passwordHash: demoPasswordHash,
  email: 'demo@example.com',
  avatar: '🎮',
  level: 42,
  trophyCount: 1337,
  status: 'offline',
  currentGame: null,
  statusMessage: 'Ready to play!',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastLoginAt: new Date().toISOString(),
});

/**
 * AuthService - Handles all authentication operations.
 *
 * DESIGN PATTERN: Service Class
 * -----------------------------
 * This class encapsulates all authentication logic. Benefits:
 * - Single responsibility: Only handles auth
 * - Testable: Can mock Redis and test in isolation
 * - Reusable: Can be used by GraphQL, REST, WebSocket handlers
 *
 * DEPENDENCY INJECTION:
 * The Redis client is passed in (constructor injection) rather than
 * created internally. This allows:
 * - Easy testing with mock Redis
 * - Shared Redis connection across services
 * - Configuration flexibility
 */
export class AuthService {
  private redis: Redis;
  private config: AuthConfig;

  /**
   * Create a new AuthService instance.
   *
   * @param redis - Redis client for session management
   * @param config - Authentication configuration
   *
   * INTERVIEW TIP:
   * "Dependency injection makes services testable and flexible.
   * Instead of hardcoding dependencies, we inject them, which
   * allows us to swap implementations for testing or different environments."
   */
  constructor(redis: Redis, config?: Partial<AuthConfig>) {
    this.redis = redis;
    this.config = {
      jwtSecret: config?.jwtSecret || process.env.JWT_SECRET || 'default-secret-change-me',
      jwtExpiresIn: config?.jwtExpiresIn || process.env.JWT_EXPIRES_IN || '7d',
      sessionTTL: config?.sessionTTL || parseInt(process.env.SESSION_TTL || '3600'),
      bcryptRounds: config?.bcryptRounds || 10,
    };
  }

  // ============================================================================
  // REGISTRATION
  // ============================================================================

  /**
   * Register a new user account.
   *
   * PROCESS:
   * 1. Validate input data
   * 2. Check for existing gamertag/email
   * 3. Hash the password
   * 4. Create user record
   * 5. Generate auth tokens
   * 6. Create session
   *
   * @param input - User registration data
   * @returns AuthResponse with token and user profile
   * @throws Error if gamertag or email already exists
   *
   * SECURITY CONSIDERATIONS:
   * - Password hashing with bcrypt (adaptive work factor)
   * - Unique constraint on gamertag and email
   * - Input validation to prevent injection attacks
   */
  async register(input: CreateUserInput): Promise<AuthResponse> {
    const { gamertag, email, password } = input;

    // -------------------------------------------------------------------------
    // STEP 1: INPUT VALIDATION
    // -------------------------------------------------------------------------
    // Always validate input at the service boundary.
    // Don't trust that GraphQL/REST layer did it.

    if (!gamertag || gamertag.length < 3 || gamertag.length > 16) {
      throw new Error('Gamertag must be between 3 and 16 characters');
    }

    if (!this.isValidEmail(email)) {
      throw new Error('Invalid email format');
    }

    if (!this.isStrongPassword(password)) {
      throw new Error('Password must be at least 8 characters with a number and special character');
    }

    // -------------------------------------------------------------------------
    // STEP 2: CHECK FOR EXISTING USER
    // -------------------------------------------------------------------------
    // In production: Query DynamoDB GSI on gamertag and email
    // Using linear search here for simplicity

    for (const user of users.values()) {
      if (user.gamertag.toLowerCase() === gamertag.toLowerCase()) {
        throw new Error('Gamertag already taken');
      }
      if (user.email.toLowerCase() === email.toLowerCase()) {
        throw new Error('Email already registered');
      }
    }

    // -------------------------------------------------------------------------
    // STEP 3: HASH PASSWORD
    // -------------------------------------------------------------------------
    // bcrypt.hash is async and CPU-intensive (by design for security)
    //
    // WHY BCRYPT?
    // - Adaptive: Work factor can increase as hardware gets faster
    // - Salt: Automatically generates and includes salt
    // - Slow: Makes brute force attacks impractical
    //
    // ROUNDS (work factor):
    // - 10 rounds ≈ 100ms to hash
    // - Each +1 doubles the time
    // - 12+ recommended for production

    const passwordHash = await bcrypt.hash(password, this.config.bcryptRounds);

    // -------------------------------------------------------------------------
    // STEP 4: CREATE USER RECORD
    // -------------------------------------------------------------------------
    const userId = uuidv4();
    const now = new Date().toISOString();

    const newUser: User = {
      id: userId,
      gamertag,
      passwordHash,
      email: email.toLowerCase(), // Normalize email
      avatar: this.generateDefaultAvatar(),
      level: 1, // New users start at level 1
      trophyCount: 0,
      status: 'online', // Set to online upon registration
      currentGame: null,
      statusMessage: null,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    };

    // In production: await dynamoDB.put(...)
    users.set(userId, newUser);

    console.log(`[AuthService] User registered: ${gamertag} (${userId})`);

    // -------------------------------------------------------------------------
    // STEP 5 & 6: Generate token and create session
    // -------------------------------------------------------------------------
    return this.createAuthResponse(newUser, 'Registration successful');
  }

  // ============================================================================
  // LOGIN
  // ============================================================================

  /**
   * Authenticate a user with their credentials.
   *
   * PROCESS:
   * 1. Find user by gamertag or email
   * 2. Compare password with stored hash
   * 3. Update last login timestamp
   * 4. Generate new JWT token
   * 5. Create Redis session
   *
   * @param input - Login credentials
   * @returns AuthResponse with token and user profile
   * @throws Error if credentials are invalid
   *
   * SECURITY NOTES:
   * - Use constant-time comparison for passwords (bcrypt does this)
   * - Don't reveal whether username or password was wrong
   * - Rate limit login attempts (handled at middleware level)
   */
  async login(input: LoginInput): Promise<AuthResponse> {
    const { identifier, password } = input;

    // -------------------------------------------------------------------------
    // STEP 1: FIND USER
    // -------------------------------------------------------------------------
    // Search by gamertag OR email (common UX pattern)
    // In production: Two DynamoDB queries with GSIs

    let user: User | undefined;
    for (const u of users.values()) {
      if (
        u.gamertag.toLowerCase() === identifier.toLowerCase() ||
        u.email.toLowerCase() === identifier.toLowerCase()
      ) {
        user = u;
        break;
      }
    }

    // -------------------------------------------------------------------------
    // SECURITY: Use generic error message
    // -------------------------------------------------------------------------
    // Don't say "user not found" vs "wrong password" - that helps attackers
    // enumerate valid usernames.

    if (!user) {
      // Add artificial delay to prevent timing attacks
      await this.artificialDelay();
      throw new Error('Invalid credentials');
    }

    // -------------------------------------------------------------------------
    // STEP 2: VERIFY PASSWORD
    // -------------------------------------------------------------------------
    // bcrypt.compare is constant-time to prevent timing attacks
    // It extracts the salt from the stored hash automatically

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);

    if (!isValidPassword) {
      console.log(`[AuthService] Failed login attempt for: ${identifier}`);
      throw new Error('Invalid credentials');
    }

    // -------------------------------------------------------------------------
    // STEP 3: UPDATE LAST LOGIN
    // -------------------------------------------------------------------------
    user.lastLoginAt = new Date().toISOString();
    user.status = 'online';
    users.set(user.id, user);

    console.log(`[AuthService] User logged in: ${user.gamertag} (${user.id})`);

    // -------------------------------------------------------------------------
    // STEPS 4 & 5: Generate token and create session
    // -------------------------------------------------------------------------
    return this.createAuthResponse(user, 'Login successful');
  }

  // ============================================================================
  // LOGOUT
  // ============================================================================

  /**
   * Log out a user by destroying their session.
   *
   * WHY SESSION-BASED LOGOUT WITH JWT?
   * ----------------------------------
   * JWTs are stateless - you can't truly "invalidate" them without
   * checking a blacklist. By requiring a valid Redis session,
   * we can effectively logout users by deleting the session.
   *
   * ALTERNATIVES:
   * 1. Token blacklist: Store revoked tokens in Redis (doesn't scale well)
   * 2. Short token expiry: Force re-auth frequently (bad UX)
   * 3. Session check: Our approach - validate session exists ✓
   *
   * @param userId - User ID to logout
   * @returns Success confirmation
   */
  async logout(userId: string): Promise<{ success: boolean; message: string }> {
    // Delete the session from Redis
    const sessionKey = this.getSessionKey(userId);
    const deleted = await this.redis.del(sessionKey);

    if (deleted > 0) {
      console.log(`[AuthService] User logged out: ${userId}`);

      // Update user status to offline
      const user = users.get(userId);
      if (user) {
        user.status = 'offline';
        users.set(userId, user);
      }

      return { success: true, message: 'Logged out successfully' };
    }

    return { success: false, message: 'No active session found' };
  }

  // ============================================================================
  // TOKEN VALIDATION
  // ============================================================================

  /**
   * Validate a JWT token and return the user payload.
   *
   * VALIDATION STEPS:
   * 1. Verify JWT signature (ensures token wasn't tampered)
   * 2. Check token hasn't expired
   * 3. Verify session exists in Redis (handles logout/revocation)
   *
   * @param token - JWT token from Authorization header
   * @returns Decoded JWT payload with user info
   * @throws Error if token is invalid or session doesn't exist
   *
   * INTERVIEW TIP:
   * "We validate both the JWT and check Redis because:
   * - JWT validation is fast (no network call)
   * - Redis check enables logout/session management
   * - If Redis is down, we can fall back to JWT-only (degraded mode)"
   */
  async validateToken(token: string): Promise<JWTPayload> {
    // -------------------------------------------------------------------------
    // STEP 1: VERIFY JWT SIGNATURE AND EXPIRATION
    // -------------------------------------------------------------------------
    // jwt.verify throws if:
    // - Signature doesn't match (tampered token)
    // - Token has expired
    // - Token is malformed

    let decoded: JWTPayload;
    try {
      decoded = jwt.verify(token, this.config.jwtSecret) as JWTPayload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error('Token has expired');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new Error('Invalid token');
      }
      throw error;
    }

    // -------------------------------------------------------------------------
    // STEP 2: CHECK SESSION EXISTS IN REDIS
    // -------------------------------------------------------------------------
    // This enables:
    // - Logout functionality (delete session = invalidate token)
    // - Session management (see all active sessions)
    // - Security: Revoke compromised sessions

    const sessionKey = this.getSessionKey(decoded.userId);
    const sessionData = await this.redis.get(sessionKey);

    if (!sessionData) {
      throw new Error('Session expired or invalidated');
    }

    // -------------------------------------------------------------------------
    // STEP 3: REFRESH SESSION TTL
    // -------------------------------------------------------------------------
    // Slide the session expiration forward on each valid request
    // This keeps active users logged in, while inactive users timeout

    await this.redis.expire(sessionKey, this.config.sessionTTL);

    return decoded;
  }

  /**
   * Get the full session data for a user.
   *
   * @param userId - User ID
   * @returns Session data or null if not found
   */
  async getSession(userId: string): Promise<UserSession | null> {
    const sessionKey = this.getSessionKey(userId);
    const sessionData = await this.redis.get(sessionKey);

    if (!sessionData) {
      return null;
    }

    return JSON.parse(sessionData) as UserSession;
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  /**
   * Create the complete authentication response with token and session.
   *
   * This is a helper that:
   * 1. Generates JWT token
   * 2. Creates Redis session
   * 3. Returns public user profile
   *
   * @param user - The authenticated user
   * @param message - Success message for logging
   */
  private async createAuthResponse(user: User, _message: string): Promise<AuthResponse> {
    // Generate JWT token
    const token = this.generateToken(user);

    // Create session in Redis
    await this.createSession(user);

    // Calculate expiration time for client
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days from now

    return {
      token,
      user: this.toPublicUser(user),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Generate a JWT token for a user.
   *
   * JWT STRUCTURE:
   * - Header: Algorithm + token type (added automatically)
   * - Payload: Our data (userId, gamertag) + standard claims (iat, exp)
   * - Signature: HMAC-SHA256 of header + payload using secret
   *
   * @param user - User to generate token for
   * @returns Signed JWT token string
   */
  private generateToken(user: User): string {
    const payload: Omit<JWTPayload, 'iat' | 'exp'> = {
      userId: user.id,
      gamertag: user.gamertag,
    };

    // jwt.sign automatically adds:
    // - iat (issued at): Current timestamp
    // - exp (expiration): Based on expiresIn option
    return jwt.sign(payload, this.config.jwtSecret, {
      expiresIn: this.config.jwtExpiresIn as string,
    } as jwt.SignOptions);
  }

  /**
   * Create a session in Redis for the authenticated user.
   *
   * WHY STORE SESSION DATA IN REDIS?
   * --------------------------------
   * 1. Fast access: Session is checked on every request
   * 2. Auto-expiration: Redis TTL handles cleanup
   * 3. Device info: Track where user is logged in
   * 4. Security: Can invalidate session without touching JWT
   *
   * @param user - User to create session for
   * @param deviceInfo - Optional device/client information
   * @param ipAddress - Optional client IP address
   */
  private async createSession(
    user: User,
    deviceInfo: string = 'Unknown Device',
    ipAddress: string = '0.0.0.0'
  ): Promise<void> {
    const sessionKey = this.getSessionKey(user.id);
    const now = new Date().toISOString();

    const session: UserSession = {
      userId: user.id,
      gamertag: user.gamertag,
      status: user.status,
      deviceInfo,
      ipAddress,
      createdAt: now,
      lastActivityAt: now,
    };

    // SETEX = SET with EXpiration
    // Stores the session and automatically deletes it after TTL seconds
    await this.redis.setex(
      sessionKey,
      this.config.sessionTTL,
      JSON.stringify(session)
    );

    console.log(`[AuthService] Session created for: ${user.gamertag} (TTL: ${this.config.sessionTTL}s)`);
  }

  /**
   * Generate Redis key for user session.
   *
   * KEY NAMING CONVENTION:
   * Using "session:{userId}" pattern allows:
   * - Easy identification of key purpose
   * - Bulk operations (SCAN for all sessions)
   * - Clear data organization
   *
   * INTERVIEW TIP:
   * "Consistent key naming is crucial at scale. We use prefixes
   * like 'session:', 'presence:', 'chat:' to organize data and
   * enable efficient batch operations."
   */
  private getSessionKey(userId: string): string {
    return `session:${userId}`;
  }

  /**
   * Convert full User to PublicUser (excludes sensitive data).
   *
   * SECURITY PATTERN:
   * Never expose internal user data directly. Always map to a
   * "public" version that excludes:
   * - Passwords (even hashed)
   * - Email (privacy)
   * - Internal metadata
   */
  private toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      gamertag: user.gamertag,
      avatar: user.avatar,
      level: user.level,
      trophyCount: user.trophyCount,
      status: user.status,
      currentGame: user.currentGame,
      statusMessage: user.statusMessage,
    };
  }

  /**
   * Validate email format.
   * Simple regex - production would use a more robust validator.
   */
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Check password strength requirements.
   *
   * REQUIREMENTS:
   * - Minimum 8 characters
   * - At least one number
   * - At least one special character
   *
   * INTERVIEW TIP:
   * "Password requirements balance security with usability.
   * Too strict = users write them down. Too weak = easy to crack.
   * We also implement rate limiting and lockout policies."
   */
  private isStrongPassword(password: string): boolean {
    if (password.length < 8) return false;
    if (!/\d/.test(password)) return false; // Has number
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) return false; // Has special char
    return true;
  }

  /**
   * Generate a random default avatar for new users.
   * In production, this would be a proper avatar system.
   */
  private generateDefaultAvatar(): string {
    const avatars = ['🎮', '🎯', '⚡', '🔥', '🌟', '💫', '🚀', '🎪'];
    return avatars[Math.floor(Math.random() * avatars.length)];
  }

  /**
   * Add artificial delay to prevent timing attacks.
   *
   * TIMING ATTACK PREVENTION:
   * If we return immediately when user not found, but take longer
   * when comparing passwords, attackers can detect valid usernames.
   *
   * By adding random delay when user not found, response times
   * become unpredictable and timing attacks are harder.
   */
  private async artificialDelay(): Promise<void> {
    const delay = Math.random() * 100 + 50; // 50-150ms
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  // ============================================================================
  // USER RETRIEVAL (would be in a separate UserService in production)
  // ============================================================================

  /**
   * Get a user by their ID.
   * Returns public user profile (no sensitive data).
   */
  async getUserById(userId: string): Promise<PublicUser | null> {
    const user = users.get(userId);
    return user ? this.toPublicUser(user) : null;
  }

  /**
   * Get a user by their gamertag.
   */
  async getUserByGamertag(gamertag: string): Promise<PublicUser | null> {
    for (const user of users.values()) {
      if (user.gamertag.toLowerCase() === gamertag.toLowerCase()) {
        return this.toPublicUser(user);
      }
    }
    return null;
  }

  /**
   * Get multiple users by their IDs (batch operation).
   *
   * BATCH OPERATIONS:
   * When you need multiple records, always batch the request.
   * N individual queries = N network round trips = slow
   * 1 batch query = 1 network round trip = fast
   *
   * DynamoDB equivalent: BatchGetItem
   */
  async getUsersByIds(userIds: string[]): Promise<PublicUser[]> {
    const result: PublicUser[] = [];
    for (const userId of userIds) {
      const user = users.get(userId);
      if (user) {
        result.push(this.toPublicUser(user));
      }
    }
    return result;
  }
}
