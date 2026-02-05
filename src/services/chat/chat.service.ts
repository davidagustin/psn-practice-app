/**
 * ==============================================================================
 * PLAYSTATION NETWORK - CHAT SERVICE
 * ==============================================================================
 *
 * This service handles real-time messaging between users, similar to
 * PlayStation's Party Chat and direct messaging features.
 *
 * CHAT ARCHITECTURE AT SCALE:
 * ===========================
 *
 * CHALLENGE:
 * - Millions of concurrent conversations
 * - Messages must be delivered in real-time (<100ms)
 * - Messages must persist for history
 * - Support for 1:1 and group chats
 * - Handle offline users (deliver when they return)
 *
 * STORAGE STRATEGY (Two-Tier):
 * ============================
 *
 * TIER 1 - REDIS (Hot Data):
 * - Recent messages (last 100 per conversation)
 * - Active conversation metadata
 * - Unread counts
 * - Typing indicators
 *
 * WHY REDIS FOR RECENT MESSAGES?
 * - Sub-millisecond reads for the most accessed data
 * - List data structure perfect for message history
 * - Automatic eviction of old messages
 *
 * TIER 2 - DYNAMODB (Cold Data):
 * - Complete message history
 * - Archived conversations
 * - Search-indexed content
 *
 * WHY DYNAMODB FOR HISTORY?
 * - Unlimited storage capacity
 * - Time-based partitioning for efficient queries
 * - Cost-effective for rarely accessed data
 *
 * MESSAGE DELIVERY FLOW:
 * ======================
 *
 * 1. User A sends message to conversation
 * 2. Server receives message via GraphQL mutation
 * 3. Message stored in Redis list (recent) + DynamoDB (permanent)
 * 4. Publish to Redis channel "chat:conversation:{id}"
 * 5. All servers subscribed to that channel receive message
 * 6. Each server pushes to connected participants via WebSocket
 *
 * INTERVIEW TIP:
 * "For chat at scale, we use a two-tier storage strategy:
 * Redis for the hot path (recent messages, real-time delivery)
 * and DynamoDB for persistent history. This optimizes for both
 * latency and cost."
 * ==============================================================================
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  ChatMessage,
  Conversation,
  SendMessageInput,
} from '../../types';

/**
 * Configuration for the ChatService.
 */
interface ChatConfig {
  /** Maximum messages to keep in Redis per conversation */
  maxMessagesInCache: number;

  /** Channel prefix for chat updates */
  chatChannelPrefix: string;

  /** How long typing indicator stays active (seconds) */
  typingTTL: number;

  /** Rate limit: max messages per window */
  rateLimitMaxMessages: number;

  /** Rate limit: window in seconds */
  rateLimitWindowSeconds: number;
}

/**
 * Rate limit result for spam prevention.
 *
 * RATE LIMITING STRATEGY:
 * We use a sliding window approach with Redis:
 * - Key: ratelimit:chat:{userId}
 * - Store timestamps of recent messages
 * - Count messages within the window
 * - If over limit, reject with retry-after time
 *
 * INTERVIEW TIP:
 * "Rate limiting is essential for chat to prevent spam and abuse.
 * We use Redis sorted sets with timestamps as scores, allowing
 * efficient sliding window calculations with ZRANGEBYSCORE."
 */
interface RateLimitResult {
  /** Whether the action is allowed */
  allowed: boolean;

  /** Number of remaining actions in current window */
  remaining: number;

  /** Seconds until the limit resets */
  resetInSeconds: number;

  /** If not allowed, seconds until user can retry */
  retryAfterSeconds?: number;
}

/**
 * Event emitted when a new message is received.
 * Used by WebSocket handlers to push to clients.
 */
interface MessageEvent {
  type: 'new_message' | 'message_read' | 'typing_start' | 'typing_stop';
  conversationId: string;
  message?: ChatMessage;
  userId?: string;
  timestamp: number;
}

/**
 * ChatService - Manages real-time messaging.
 *
 * DESIGN PATTERNS:
 * ----------------
 * 1. EVENT SOURCING: Messages are append-only events
 * 2. CQRS: Separate read (get messages) and write (send message) paths
 * 3. PUB/SUB: Real-time delivery across servers
 *
 * REDIS DATA STRUCTURES USED:
 * --------------------------
 * - LIST: Message history (LPUSH for new, LRANGE for retrieval)
 * - HASH: Conversation metadata
 * - SET: Conversation participants
 * - STRING with TTL: Typing indicators
 * - SORTED SET: Conversations ordered by last activity
 */
export class ChatService extends EventEmitter {
  private redis: Redis;
  private subscriber: Redis;
  private config: ChatConfig;

  /**
   * In-memory cache of conversations.
   * In production: DynamoDB table with GSIs
   */
  private conversations: Map<string, Conversation> = new Map();

  /**
   * Create a new ChatService instance.
   *
   * @param redis - Redis client for storage and pub/sub
   * @param config - Service configuration
   */
  constructor(redis: Redis, config?: Partial<ChatConfig>) {
    super();
    this.redis = redis;
    this.subscriber = redis.duplicate();
    this.config = {
      maxMessagesInCache: config?.maxMessagesInCache || 100,
      chatChannelPrefix: config?.chatChannelPrefix || 'chat:',
      typingTTL: config?.typingTTL || 5,
      rateLimitMaxMessages: config?.rateLimitMaxMessages || 30,
      rateLimitWindowSeconds: config?.rateLimitWindowSeconds || 60,
    };

    // Initialize demo conversations
    this.initializeDemoData();
  }

  /**
   * Initialize demo conversations for testing.
   */
  private initializeDemoData(): void {
    const now = new Date().toISOString();

    // Create a demo conversation
    const demoConversation: Conversation = {
      id: 'conv_demo_1',
      type: 'direct',
      participantIds: ['demo_user_1', 'demo_user_2'],
      name: null,
      lastMessage: null,
      unreadCounts: { demo_user_1: 0, demo_user_2: 0 },
      createdAt: now,
      updatedAt: now,
    };

    this.conversations.set(demoConversation.id, demoConversation);
  }

  // ============================================================================
  // CONVERSATION MANAGEMENT
  // ============================================================================

  /**
   * Create a new conversation between users.
   *
   * CONVERSATION TYPES:
   * - 'direct': 1:1 chat between two users
   * - 'group': Multi-user chat (like PlayStation Party)
   *
   * FOR DIRECT CHATS:
   * We check if a conversation already exists between the two users.
   * This prevents duplicate conversations.
   *
   * @param participantIds - Array of user IDs in the conversation
   * @param type - Type of conversation
   * @param name - Optional name (for groups)
   * @returns The created conversation
   */
  async createConversation(
    participantIds: string[],
    type: 'direct' | 'group' = 'direct',
    name: string | null = null
  ): Promise<Conversation> {
    // -------------------------------------------------------------------------
    // VALIDATION
    // -------------------------------------------------------------------------
    if (participantIds.length < 2) {
      throw new Error('Conversation requires at least 2 participants');
    }

    if (type === 'direct' && participantIds.length !== 2) {
      throw new Error('Direct conversations must have exactly 2 participants');
    }

    // -------------------------------------------------------------------------
    // CHECK FOR EXISTING DIRECT CONVERSATION
    // -------------------------------------------------------------------------
    // For direct chats, check if conversation already exists
    // This prevents creating duplicate 1:1 conversations

    if (type === 'direct') {
      const existing = await this.findDirectConversation(
        participantIds[0],
        participantIds[1]
      );
      if (existing) {
        console.log(`[ChatService] Returning existing conversation: ${existing.id}`);
        return existing;
      }
    }

    // -------------------------------------------------------------------------
    // CREATE NEW CONVERSATION
    // -------------------------------------------------------------------------
    const now = new Date().toISOString();
    const conversationId = `conv_${uuidv4()}`;

    const conversation: Conversation = {
      id: conversationId,
      type,
      participantIds,
      name,
      lastMessage: null,
      unreadCounts: Object.fromEntries(
        participantIds.map((id) => [id, 0])
      ),
      createdAt: now,
      updatedAt: now,
    };

    // -------------------------------------------------------------------------
    // STORE IN REDIS
    // -------------------------------------------------------------------------
    // We store conversation metadata in a hash for easy field access

    const pipeline = this.redis.pipeline();

    // Store conversation metadata
    pipeline.hset(
      this.getConversationKey(conversationId),
      'data',
      JSON.stringify(conversation)
    );

    // Add to each participant's conversation list (sorted set by last update)
    for (const participantId of participantIds) {
      pipeline.zadd(
        this.getUserConversationsKey(participantId),
        Date.now(),
        conversationId
      );
    }

    // Store participant list as a set (for quick membership checks)
    pipeline.sadd(
      this.getParticipantsKey(conversationId),
      ...participantIds
    );

    await pipeline.exec();

    // Store in memory cache
    this.conversations.set(conversationId, conversation);

    console.log(`[ChatService] Created conversation: ${conversationId} (${type})`);

    return conversation;
  }

  /**
   * Find an existing direct conversation between two users.
   *
   * LOOKUP STRATEGY:
   * 1. Get all conversations for user A (sorted set)
   * 2. For each, check if user B is a participant
   * 3. Return first match of type 'direct'
   *
   * In production with DynamoDB, you'd use a GSI on participant pairs.
   *
   * @param userIdA - First user
   * @param userIdB - Second user
   * @returns Existing conversation or null
   */
  private async findDirectConversation(
    userIdA: string,
    userIdB: string
  ): Promise<Conversation | null> {
    // Check in-memory cache first
    for (const conv of this.conversations.values()) {
      if (
        conv.type === 'direct' &&
        conv.participantIds.includes(userIdA) &&
        conv.participantIds.includes(userIdB)
      ) {
        return conv;
      }
    }
    return null;
  }

  /**
   * Get a conversation by ID.
   *
   * @param conversationId - Conversation to retrieve
   * @param userId - User requesting (for permission check)
   * @returns Conversation or null if not found/unauthorized
   */
  async getConversation(
    conversationId: string,
    userId: string
  ): Promise<Conversation | null> {
    // Check cache first
    const cached = this.conversations.get(conversationId);
    if (cached) {
      // Verify user is a participant
      if (!cached.participantIds.includes(userId)) {
        console.warn(`[ChatService] User ${userId} not authorized for conversation ${conversationId}`);
        return null;
      }
      return cached;
    }

    // Check Redis
    const data = await this.redis.hget(
      this.getConversationKey(conversationId),
      'data'
    );

    if (!data) {
      return null;
    }

    const conversation = JSON.parse(data) as Conversation;

    // Verify user is a participant
    if (!conversation.participantIds.includes(userId)) {
      return null;
    }

    // Cache for future requests
    this.conversations.set(conversationId, conversation);

    return conversation;
  }

  /**
   * Get all conversations for a user.
   *
   * SORTED SET USAGE:
   * We store conversation IDs in a sorted set with the timestamp as score.
   * ZREVRANGE retrieves them in reverse chronological order.
   *
   * @param userId - User requesting their conversations
   * @param limit - Maximum number to return
   * @param offset - Number to skip (for pagination)
   * @returns Array of conversations
   */
  async getUserConversations(
    userId: string,
    limit: number = 20,
    offset: number = 0
  ): Promise<Conversation[]> {
    // Get conversation IDs sorted by last activity (most recent first)
    const conversationIds = await this.redis.zrevrange(
      this.getUserConversationsKey(userId),
      offset,
      offset + limit - 1
    );

    if (conversationIds.length === 0) {
      return [];
    }

    // Batch fetch conversations
    const conversations: Conversation[] = [];
    for (const convId of conversationIds) {
      const conv = await this.getConversation(convId, userId);
      if (conv) {
        conversations.push(conv);
      }
    }

    return conversations;
  }

  // ============================================================================
  // MESSAGE HANDLING
  // ============================================================================

  /**
   * Send a message to a conversation.
   *
   * MESSAGE FLOW:
   * 1. Validate sender is a participant
   * 2. Create message object with unique ID and timestamp
   * 3. Store in Redis list (recent messages cache)
   * 4. Store in DynamoDB (permanent storage) - simulated here
   * 5. Update conversation metadata (last message, timestamps)
   * 6. Increment unread counts for other participants
   * 7. Publish to chat channel for real-time delivery
   *
   * @param senderId - User sending the message
   * @param input - Message content and metadata
   * @returns The created message
   */
  async sendMessage(
    senderId: string,
    input: SendMessageInput
  ): Promise<ChatMessage> {
    const { conversationId, content, type = 'text', metadata } = input;

    // -------------------------------------------------------------------------
    // STEP 0: CHECK RATE LIMIT (Spam Prevention)
    // -------------------------------------------------------------------------
    const rateLimitResult = await this.checkRateLimit(senderId);
    if (!rateLimitResult.allowed) {
      throw new Error(
        `Rate limit exceeded. Please wait ${rateLimitResult.retryAfterSeconds} seconds before sending another message.`
      );
    }

    // -------------------------------------------------------------------------
    // STEP 1: VALIDATE SENDER IS A PARTICIPANT
    // -------------------------------------------------------------------------
    const conversation = await this.getConversation(conversationId, senderId);
    if (!conversation) {
      throw new Error('Conversation not found or access denied');
    }

    // Get sender's gamertag (would come from user service in production)
    const senderGamertag = `User_${senderId.slice(-4)}`;

    // -------------------------------------------------------------------------
    // STEP 2: CREATE MESSAGE OBJECT
    // -------------------------------------------------------------------------
    const now = new Date().toISOString();
    const messageId = `msg_${uuidv4()}`;

    const message: ChatMessage = {
      id: messageId,
      conversationId,
      senderId,
      senderGamertag,
      content,
      type,
      createdAt: now,
      readAt: null,
      metadata,
    };

    // -------------------------------------------------------------------------
    // STEP 3: STORE IN REDIS (Recent Messages Cache)
    // -------------------------------------------------------------------------
    // Using a Redis list:
    // - LPUSH adds to the front (newest first)
    // - LTRIM keeps only the most recent N messages
    // This is a "sliding window" pattern

    const messagesKey = this.getMessagesKey(conversationId);
    const pipeline = this.redis.pipeline();

    // Add message to front of list
    pipeline.lpush(messagesKey, JSON.stringify(message));

    // Keep only recent messages (trim the list)
    // LTRIM keeps elements from index 0 to maxMessages-1
    pipeline.ltrim(messagesKey, 0, this.config.maxMessagesInCache - 1);

    // -------------------------------------------------------------------------
    // STEP 4: STORE IN DYNAMODB (Simulated)
    // -------------------------------------------------------------------------
    // In production: dynamoDB.put({ TableName: 'Messages', Item: {...} })
    // DynamoDB key structure:
    // - PK: CONV#{conversationId}
    // - SK: MSG#{timestamp}#{messageId}
    // This allows efficient range queries by time

    // -------------------------------------------------------------------------
    // STEP 5: UPDATE CONVERSATION METADATA
    // -------------------------------------------------------------------------
    conversation.lastMessage = message;
    conversation.updatedAt = now;

    pipeline.hset(
      this.getConversationKey(conversationId),
      'data',
      JSON.stringify(conversation)
    );

    // Update conversation position in each participant's list
    for (const participantId of conversation.participantIds) {
      pipeline.zadd(
        this.getUserConversationsKey(participantId),
        Date.now(),
        conversationId
      );
    }

    // -------------------------------------------------------------------------
    // STEP 6: INCREMENT UNREAD COUNTS
    // -------------------------------------------------------------------------
    // Increment unread count for all participants except sender
    for (const participantId of conversation.participantIds) {
      if (participantId !== senderId) {
        conversation.unreadCounts[participantId] =
          (conversation.unreadCounts[participantId] || 0) + 1;
      }
    }

    await pipeline.exec();

    // Update in-memory cache
    this.conversations.set(conversationId, conversation);

    // -------------------------------------------------------------------------
    // STEP 7: PUBLISH FOR REAL-TIME DELIVERY
    // -------------------------------------------------------------------------
    await this.publishMessageEvent({
      type: 'new_message',
      conversationId,
      message,
      timestamp: Date.now(),
    });

    console.log(`[ChatService] Message sent: ${messageId} in ${conversationId}`);

    return message;
  }

  /**
   * Get messages from a conversation.
   *
   * PAGINATION STRATEGY:
   * - Use cursor-based pagination for real-time data
   * - Return messages in reverse chronological order (newest first)
   * - Client can load more by passing the oldest message ID
   *
   * CACHE-FIRST APPROACH:
   * 1. Try to get from Redis cache (fast, recent messages)
   * 2. If need more, fall back to DynamoDB (slow, all messages)
   *
   * @param conversationId - Conversation to get messages from
   * @param userId - User requesting (for permission check)
   * @param limit - Number of messages to return
   * @param before - Get messages before this message ID (for pagination)
   */
  async getMessages(
    conversationId: string,
    userId: string,
    limit: number = 50,
    before?: string
  ): Promise<ChatMessage[]> {
    // Validate access
    const conversation = await this.getConversation(conversationId, userId);
    if (!conversation) {
      throw new Error('Conversation not found or access denied');
    }

    // -------------------------------------------------------------------------
    // GET FROM REDIS CACHE
    // -------------------------------------------------------------------------
    // LRANGE gets elements from start to end index
    // Our list is newest-first, so LRANGE 0 49 gets 50 most recent

    const messagesKey = this.getMessagesKey(conversationId);
    const cachedMessages = await this.redis.lrange(messagesKey, 0, limit - 1);

    const messages: ChatMessage[] = cachedMessages.map(
      (m) => JSON.parse(m) as ChatMessage
    );

    // -------------------------------------------------------------------------
    // HANDLE PAGINATION (before cursor)
    // -------------------------------------------------------------------------
    // If 'before' is specified, filter to messages older than that ID
    // In production, this would query DynamoDB with a range key condition

    if (before) {
      const beforeIndex = messages.findIndex((m) => m.id === before);
      if (beforeIndex !== -1) {
        return messages.slice(beforeIndex + 1, beforeIndex + 1 + limit);
      }
    }

    return messages;
  }

  /**
   * Mark messages as read.
   *
   * UNREAD TRACKING:
   * - Each conversation tracks unread count per participant
   * - When user opens conversation, mark all as read
   * - Publish read receipt so sender sees "Read" status
   *
   * @param conversationId - Conversation to mark read
   * @param userId - User who is reading
   */
  async markAsRead(
    conversationId: string,
    userId: string
  ): Promise<void> {
    const conversation = await this.getConversation(conversationId, userId);
    if (!conversation) {
      throw new Error('Conversation not found or access denied');
    }

    // Reset unread count for this user
    conversation.unreadCounts[userId] = 0;

    // Update in Redis
    await this.redis.hset(
      this.getConversationKey(conversationId),
      'data',
      JSON.stringify(conversation)
    );

    // Update cache
    this.conversations.set(conversationId, conversation);

    // Publish read event (so other participants see "Read" indicator)
    await this.publishMessageEvent({
      type: 'message_read',
      conversationId,
      userId,
      timestamp: Date.now(),
    });

    console.log(`[ChatService] Marked conversation ${conversationId} as read for ${userId}`);
  }

  // ============================================================================
  // TYPING INDICATORS
  // ============================================================================

  /**
   * Set typing indicator for a user in a conversation.
   *
   * TYPING INDICATOR PATTERN:
   * - Use Redis key with short TTL (5 seconds)
   * - Client sends "typing" every few seconds while typing
   * - Key auto-expires when user stops typing
   * - Publish event for real-time UI updates
   *
   * @param conversationId - Conversation where user is typing
   * @param userId - User who is typing
   */
  async setTyping(
    conversationId: string,
    userId: string
  ): Promise<void> {
    const typingKey = this.getTypingKey(conversationId, userId);

    // Set typing indicator with TTL
    // Will auto-expire if user stops typing
    await this.redis.setex(typingKey, this.config.typingTTL, '1');

    // Publish typing event
    await this.publishMessageEvent({
      type: 'typing_start',
      conversationId,
      userId,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear typing indicator for a user.
   * Called when user sends message or explicitly stops typing.
   */
  async clearTyping(
    conversationId: string,
    userId: string
  ): Promise<void> {
    const typingKey = this.getTypingKey(conversationId, userId);
    await this.redis.del(typingKey);

    await this.publishMessageEvent({
      type: 'typing_stop',
      conversationId,
      userId,
      timestamp: Date.now(),
    });
  }

  /**
   * Get list of users currently typing in a conversation.
   *
   * @param conversationId - Conversation to check
   * @returns Array of user IDs who are typing
   */
  async getTypingUsers(conversationId: string): Promise<string[]> {
    // Pattern match all typing keys for this conversation
    const pattern = this.getTypingKey(conversationId, '*');
    const keys = await this.redis.keys(pattern);

    // Extract user IDs from keys
    return keys.map((key) => {
      const parts = key.split(':');
      return parts[parts.length - 1]; // Last part is userId
    });
  }

  // ============================================================================
  // SUBSCRIPTIONS (for WebSocket)
  // ============================================================================

  /**
   * Subscribe to chat updates for a conversation.
   *
   * SUBSCRIPTION FLOW:
   * 1. Client connects and subscribes to their conversations
   * 2. When message is sent, it's published to conversation channel
   * 3. All subscribed clients receive the update
   *
   * @param conversationId - Conversation to subscribe to
   * @param callback - Function called when new event received
   */
  async subscribeToConversation(
    conversationId: string,
    callback: (event: MessageEvent) => void
  ): Promise<() => void> {
    const channel = this.getChatChannel(conversationId);

    // Subscribe to Redis channel
    await this.subscriber.subscribe(channel);

    // Set up message handler
    const handler = (ch: string, message: string) => {
      if (ch === channel) {
        try {
          const event = JSON.parse(message) as MessageEvent;
          callback(event);
        } catch (error) {
          console.error('[ChatService] Failed to parse message event:', error);
        }
      }
    };

    this.subscriber.on('message', handler);

    // Return unsubscribe function
    return async () => {
      await this.subscriber.unsubscribe(channel);
      this.subscriber.off('message', handler);
    };
  }

  // ============================================================================
  // RATE LIMITING
  // ============================================================================

  /**
   * Check if user is within rate limits for sending messages.
   *
   * SLIDING WINDOW ALGORITHM:
   * 1. Store each message timestamp in a sorted set (score = timestamp)
   * 2. Remove old entries outside the window
   * 3. Count remaining entries
   * 4. If count < limit, allow and add new timestamp
   *
   * WHY SLIDING WINDOW?
   * - More fair than fixed windows (no "burst at window edge" problem)
   * - Memory efficient with automatic cleanup
   * - O(log N) operations with sorted sets
   *
   * @param userId - User attempting to send message
   * @returns Rate limit result with allowed status
   */
  async checkRateLimit(userId: string): Promise<RateLimitResult> {
    const key = `${this.config.chatChannelPrefix}ratelimit:${userId}`;
    const now = Date.now();
    const windowStart = now - this.config.rateLimitWindowSeconds * 1000;

    // Remove old entries outside the window
    await this.redis.zremrangebyscore(key, 0, windowStart);

    // Count current entries in window
    const currentCount = await this.redis.zcard(key);

    if (currentCount >= this.config.rateLimitMaxMessages) {
      // Get the oldest entry to calculate retry-after
      const oldest = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
      const oldestTimestamp = oldest.length > 1 ? parseInt(oldest[1]) : now;
      const retryAfterSeconds = Math.ceil(
        (oldestTimestamp + this.config.rateLimitWindowSeconds * 1000 - now) / 1000
      );

      console.log(`[ChatService] Rate limit exceeded for user ${userId}`);

      return {
        allowed: false,
        remaining: 0,
        resetInSeconds: this.config.rateLimitWindowSeconds,
        retryAfterSeconds: Math.max(1, retryAfterSeconds),
      };
    }

    // Add current timestamp and set expiry on the key
    await this.redis.zadd(key, now, `${now}-${uuidv4()}`);
    await this.redis.expire(key, this.config.rateLimitWindowSeconds + 1);

    return {
      allowed: true,
      remaining: this.config.rateLimitMaxMessages - currentCount - 1,
      resetInSeconds: this.config.rateLimitWindowSeconds,
    };
  }

  /**
   * Get current rate limit status without consuming a request.
   */
  async getRateLimitStatus(userId: string): Promise<RateLimitResult> {
    const key = `${this.config.chatChannelPrefix}ratelimit:${userId}`;
    const now = Date.now();
    const windowStart = now - this.config.rateLimitWindowSeconds * 1000;

    // Clean up and count without adding
    await this.redis.zremrangebyscore(key, 0, windowStart);
    const currentCount = await this.redis.zcard(key);

    return {
      allowed: currentCount < this.config.rateLimitMaxMessages,
      remaining: Math.max(0, this.config.rateLimitMaxMessages - currentCount),
      resetInSeconds: this.config.rateLimitWindowSeconds,
    };
  }

  // ============================================================================
  // INTERNAL HELPERS
  // ============================================================================

  /**
   * Publish a message event to Redis for real-time delivery.
   */
  private async publishMessageEvent(event: MessageEvent): Promise<void> {
    const channel = this.getChatChannel(event.conversationId);
    await this.redis.publish(channel, JSON.stringify(event));

    // Also emit locally for this server's WebSocket handlers
    this.emit('messageEvent', event);
  }

  /**
   * Generate Redis key for conversation metadata.
   */
  private getConversationKey(conversationId: string): string {
    return `${this.config.chatChannelPrefix}conversation:${conversationId}`;
  }

  /**
   * Generate Redis key for conversation messages list.
   */
  private getMessagesKey(conversationId: string): string {
    return `${this.config.chatChannelPrefix}messages:${conversationId}`;
  }

  /**
   * Generate Redis key for user's conversation list.
   */
  private getUserConversationsKey(userId: string): string {
    return `${this.config.chatChannelPrefix}user:${userId}:conversations`;
  }

  /**
   * Generate Redis key for conversation participants set.
   */
  private getParticipantsKey(conversationId: string): string {
    return `${this.config.chatChannelPrefix}participants:${conversationId}`;
  }

  /**
   * Generate Redis key for typing indicator.
   */
  private getTypingKey(conversationId: string, userId: string): string {
    return `${this.config.chatChannelPrefix}typing:${conversationId}:${userId}`;
  }

  /**
   * Generate Redis pub/sub channel name for a conversation.
   */
  private getChatChannel(conversationId: string): string {
    return `${this.config.chatChannelPrefix}channel:${conversationId}`;
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  /**
   * Clean up resources when shutting down.
   */
  async cleanup(): Promise<void> {
    await this.subscriber.quit();
    console.log('[ChatService] Cleaned up');
  }
}
