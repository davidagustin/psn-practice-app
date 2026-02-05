/**
 * ==============================================================================
 * PLAYSTATION NETWORK - KAFKA EVENT STREAMING
 * ==============================================================================
 *
 * Apache Kafka integration for event-driven microservices architecture.
 * Provides reliable, ordered, and scalable event streaming.
 *
 * KAFKA ARCHITECTURE:
 * ===================
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                         KAFKA CLUSTER                                    │
 * │                                                                          │
 * │  ┌──────────────────────────────────────────────────────────────────┐   │
 * │  │                      TOPIC: user-events                          │   │
 * │  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                  │   │
 * │  │  │ Partition 0│  │ Partition 1│  │ Partition 2│                  │   │
 * │  │  │ (users A-H)│  │ (users I-P)│  │ (users Q-Z)│                  │   │
 * │  │  └────────────┘  └────────────┘  └────────────┘                  │   │
 * │  └──────────────────────────────────────────────────────────────────┘   │
 * │                                                                          │
 * │  ┌──────────────────────────────────────────────────────────────────┐   │
 * │  │                      TOPIC: game-events                          │   │
 * │  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                  │   │
 * │  │  │ Partition 0│  │ Partition 1│  │ Partition 2│                  │   │
 * │  │  └────────────┘  └────────────┘  └────────────┘                  │   │
 * │  └──────────────────────────────────────────────────────────────────┘   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * KEY CONCEPTS:
 * =============
 *
 * 1. TOPICS: Named channels for events (e.g., user-events, game-events)
 * 2. PARTITIONS: Parallel lanes within a topic for scalability
 * 3. CONSUMERS: Read events from topics (grouped for load balancing)
 * 4. PRODUCERS: Publish events to topics
 * 5. OFFSETS: Position in the partition (for exactly-once processing)
 *
 * ORDERING GUARANTEES:
 * - Events with the same key go to the same partition
 * - Ordering is guaranteed within a partition
 * - Use userId as key for user-related events
 *
 * INTERVIEW TIP:
 * "We use Kafka for event-driven communication between services.
 * Events are partitioned by user ID to ensure ordering per user.
 * Consumer groups enable horizontal scaling - each partition is
 * processed by exactly one consumer in the group."
 * ==============================================================================
 */

import { Kafka, Producer, Consumer, EachMessagePayload, logLevel } from 'kafkajs';
import { EventEmitter } from 'events';

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Kafka configuration.
 */
interface KafkaConfig {
  /** Kafka broker addresses */
  brokers: string[];

  /** Client ID for this application */
  clientId: string;

  /** Consumer group ID */
  groupId: string;

  /** SSL configuration (for production) */
  ssl?: boolean;

  /** SASL authentication (for production) */
  sasl?: {
    mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
    username: string;
    password: string;
  };
}

/**
 * Topic definitions.
 */
const TOPICS = {
  // User lifecycle events
  USER_EVENTS: 'psn.user.events',

  // Game-related events
  GAME_EVENTS: 'psn.game.events',

  // Social events (friends, chat)
  SOCIAL_EVENTS: 'psn.social.events',

  // Activity feed events
  ACTIVITY_EVENTS: 'psn.activity.events',

  // Voice chat events
  VOICE_EVENTS: 'psn.voice.events',

  // Notification delivery
  NOTIFICATIONS: 'psn.notifications',

  // Dead letter queue for failed processing
  DLQ: 'psn.dlq',
} as const;

type TopicName = typeof TOPICS[keyof typeof TOPICS];

// ============================================================================
// EVENT TYPES
// ============================================================================

/**
 * Base event interface.
 *
 * EVENT DESIGN PRINCIPLES:
 * 1. Events are immutable facts about what happened
 * 2. Include timestamp for ordering and debugging
 * 3. Include correlation ID for distributed tracing
 * 4. Include source service for origin tracking
 */
interface BaseEvent {
  /** Unique event identifier */
  eventId: string;

  /** Event type (e.g., 'user.registered', 'game.started') */
  type: string;

  /** ISO 8601 timestamp */
  timestamp: string;

  /** Source service that produced this event */
  source: string;

  /** Correlation ID for distributed tracing */
  correlationId?: string;

  /** Event version for schema evolution */
  version: string;
}

/**
 * User events.
 */
interface UserRegisteredEvent extends BaseEvent {
  type: 'user.registered';
  payload: {
    userId: string;
    gamertag: string;
    email: string;
  };
}

interface UserLoggedInEvent extends BaseEvent {
  type: 'user.logged_in';
  payload: {
    userId: string;
    deviceInfo: string;
    ipAddress: string;
  };
}

interface UserStatusChangedEvent extends BaseEvent {
  type: 'user.status_changed';
  payload: {
    userId: string;
    previousStatus: string;
    newStatus: string;
  };
}

/**
 * Game events.
 */
interface GameStartedEvent extends BaseEvent {
  type: 'game.started';
  payload: {
    userId: string;
    gameId: string;
    sessionId: string;
  };
}

interface GameEndedEvent extends BaseEvent {
  type: 'game.ended';
  payload: {
    userId: string;
    gameId: string;
    sessionId: string;
    durationMinutes: number;
  };
}

interface AchievementUnlockedEvent extends BaseEvent {
  type: 'achievement.unlocked';
  payload: {
    userId: string;
    gameId: string;
    achievementId: string;
    trophyType: 'bronze' | 'silver' | 'gold' | 'platinum';
  };
}

/**
 * Social events.
 */
interface FriendRequestSentEvent extends BaseEvent {
  type: 'friend.request_sent';
  payload: {
    fromUserId: string;
    toUserId: string;
    message?: string;
  };
}

interface FriendshipCreatedEvent extends BaseEvent {
  type: 'friend.created';
  payload: {
    userId1: string;
    userId2: string;
  };
}

/**
 * Union type for all events.
 */
type PSNEvent =
  | UserRegisteredEvent
  | UserLoggedInEvent
  | UserStatusChangedEvent
  | GameStartedEvent
  | GameEndedEvent
  | AchievementUnlockedEvent
  | FriendRequestSentEvent
  | FriendshipCreatedEvent;

// ============================================================================
// KAFKA PRODUCER
// ============================================================================

/**
 * Event producer with retries and batching.
 *
 * PRODUCER PATTERNS:
 * 1. Fire-and-forget: Don't wait for ack (fast, unreliable)
 * 2. Synchronous: Wait for ack (reliable, slower)
 * 3. Batched: Accumulate events, send in batch (throughput)
 */
export class EventProducer extends EventEmitter {
  private kafka: Kafka;
  private producer: Producer;
  private isConnected = false;

  constructor(config: KafkaConfig) {
    super();
    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      ssl: config.ssl,
      sasl: config.sasl,
      logLevel: logLevel.WARN,
    });
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: false,
      transactionTimeout: 30000,
      // Idempotent producer for exactly-once semantics
      idempotent: true,
    });
  }

  /**
   * Connect to Kafka.
   */
  async connect(): Promise<void> {
    if (this.isConnected) return;

    await this.producer.connect();
    this.isConnected = true;
    console.log('[KafkaProducer] Connected');
  }

  /**
   * Publish an event.
   *
   * PARTITIONING STRATEGY:
   * - Use consistent key for related events
   * - userId for user-scoped events
   * - gameId for game-scoped events
   */
  async publish(topic: TopicName, event: PSNEvent, key?: string): Promise<void> {
    if (!this.isConnected) {
      await this.connect();
    }

    const message = {
      key: key || event.eventId,
      value: JSON.stringify(event),
      headers: {
        'event-type': event.type,
        'correlation-id': event.correlationId || '',
        'source': event.source,
      },
    };

    await this.producer.send({
      topic,
      messages: [message],
    });

    console.log(`[KafkaProducer] Published ${event.type} to ${topic}`);
  }

  /**
   * Publish multiple events in a batch.
   */
  async publishBatch(
    topic: TopicName,
    events: Array<{ event: PSNEvent; key?: string }>
  ): Promise<void> {
    if (!this.isConnected) {
      await this.connect();
    }

    const messages = events.map(({ event, key }) => ({
      key: key || event.eventId,
      value: JSON.stringify(event),
      headers: {
        'event-type': event.type,
        'correlation-id': event.correlationId || '',
        'source': event.source,
      },
    }));

    await this.producer.send({
      topic,
      messages,
    });

    console.log(`[KafkaProducer] Published batch of ${events.length} events to ${topic}`);
  }

  /**
   * Disconnect from Kafka.
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) return;

    await this.producer.disconnect();
    this.isConnected = false;
    console.log('[KafkaProducer] Disconnected');
  }
}

// ============================================================================
// KAFKA CONSUMER
// ============================================================================

/**
 * Event handler function type.
 */
type EventHandler<T extends PSNEvent = PSNEvent> = (
  event: T,
  metadata: {
    topic: string;
    partition: number;
    offset: string;
  }
) => Promise<void>;

/**
 * Event consumer with automatic offset management.
 *
 * CONSUMER GROUP BEHAVIOR:
 * - Multiple consumers in a group share partitions
 * - Each partition is assigned to exactly one consumer
 * - Automatic rebalancing when consumers join/leave
 */
export class EventConsumer extends EventEmitter {
  private kafka: Kafka;
  private consumer: Consumer;
  private handlers: Map<string, EventHandler> = new Map();
  private isRunning = false;

  constructor(config: KafkaConfig) {
    super();
    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      ssl: config.ssl,
      sasl: config.sasl,
      logLevel: logLevel.WARN,
    });
    this.consumer = this.kafka.consumer({
      groupId: config.groupId,
      // Start from earliest offset for new consumers
      fromBeginning: true,
      // Session timeout for rebalancing
      sessionTimeout: 30000,
      // Heartbeat interval
      heartbeatInterval: 3000,
    });
  }

  /**
   * Register an event handler for a specific event type.
   */
  on<T extends PSNEvent>(eventType: T['type'], handler: EventHandler<T>): this {
    this.handlers.set(eventType, handler as EventHandler);
    return this;
  }

  /**
   * Subscribe to topics and start consuming.
   */
  async subscribe(topics: TopicName[]): Promise<void> {
    await this.consumer.connect();

    for (const topic of topics) {
      await this.consumer.subscribe({ topic, fromBeginning: true });
    }

    console.log(`[KafkaConsumer] Subscribed to: ${topics.join(', ')}`);
  }

  /**
   * Start consuming events.
   *
   * MESSAGE PROCESSING:
   * 1. Parse event from message
   * 2. Find registered handler
   * 3. Process with retry logic
   * 4. Commit offset on success
   * 5. Send to DLQ on failure
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;

    await this.consumer.run({
      // Process one message at a time (ordered)
      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;

        if (!message.value) {
          console.warn('[KafkaConsumer] Empty message received');
          return;
        }

        try {
          const event: PSNEvent = JSON.parse(message.value.toString());
          const handler = this.handlers.get(event.type);

          if (!handler) {
            console.warn(`[KafkaConsumer] No handler for event type: ${event.type}`);
            return;
          }

          const metadata = {
            topic,
            partition,
            offset: message.offset,
          };

          console.log(
            `[KafkaConsumer] Processing ${event.type} from ${topic}:${partition}:${message.offset}`
          );

          await handler(event, metadata);

          console.log(`[KafkaConsumer] Processed ${event.type}`);
        } catch (error) {
          console.error('[KafkaConsumer] Error processing message:', error);
          // In production, send to DLQ
          this.emit('error', error, message);
        }
      },
    });

    console.log('[KafkaConsumer] Started');
  }

  /**
   * Stop consuming and disconnect.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    await this.consumer.disconnect();
    this.isRunning = false;
    console.log('[KafkaConsumer] Stopped');
  }
}

// ============================================================================
// EVENT BUS (FACADE)
// ============================================================================

/**
 * Event Bus - Unified interface for event publishing and consuming.
 *
 * DESIGN PATTERN: Facade
 * Simplifies interaction with the underlying Kafka infrastructure.
 */
export class EventBus {
  private producer: EventProducer;
  private consumer: EventConsumer;
  private serviceName: string;

  constructor(config: KafkaConfig, serviceName: string) {
    this.producer = new EventProducer(config);
    this.consumer = new EventConsumer(config);
    this.serviceName = serviceName;
  }

  /**
   * Initialize the event bus.
   */
  async initialize(
    subscribeTopics: TopicName[] = []
  ): Promise<void> {
    await this.producer.connect();

    if (subscribeTopics.length > 0) {
      await this.consumer.subscribe(subscribeTopics);
    }
  }

  /**
   * Publish an event with automatic metadata.
   */
  async publish<T extends PSNEvent['type']>(
    topic: TopicName,
    type: T,
    payload: Extract<PSNEvent, { type: T }>['payload'],
    key?: string,
    correlationId?: string
  ): Promise<void> {
    const event = {
      eventId: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      timestamp: new Date().toISOString(),
      source: this.serviceName,
      correlationId,
      version: '1.0',
      payload,
    } as PSNEvent;

    await this.producer.publish(topic, event, key);
  }

  /**
   * Register an event handler.
   */
  handle<T extends PSNEvent>(
    eventType: T['type'],
    handler: EventHandler<T>
  ): void {
    this.consumer.on(eventType, handler);
  }

  /**
   * Start consuming events.
   */
  async startConsuming(): Promise<void> {
    await this.consumer.start();
  }

  /**
   * Shutdown the event bus.
   */
  async shutdown(): Promise<void> {
    await this.consumer.stop();
    await this.producer.disconnect();
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export { TOPICS };
export type {
  KafkaConfig,
  TopicName,
  BaseEvent,
  PSNEvent,
  UserRegisteredEvent,
  UserLoggedInEvent,
  UserStatusChangedEvent,
  GameStartedEvent,
  GameEndedEvent,
  AchievementUnlockedEvent,
  FriendRequestSentEvent,
  FriendshipCreatedEvent,
  EventHandler,
};
