/**
 * ==============================================================================
 * PLAYSTATION NETWORK - REDIS CLUSTER CONFIGURATION
 * ==============================================================================
 *
 * Production Redis Cluster setup for high availability and scalability.
 * This implements the distributed caching layer with automatic failover.
 *
 * REDIS CLUSTER ARCHITECTURE:
 * ===========================
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                        REDIS CLUSTER                                     │
 * │                                                                          │
 * │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                   │
 * │  │  Master 1    │  │  Master 2    │  │  Master 3    │                   │
 * │  │  Slots 0-5461│  │ Slots 5462-  │  │ Slots 10923- │                   │
 * │  │              │  │     10922    │  │     16383    │                   │
 * │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                   │
 * │         │                 │                 │                            │
 * │  ┌──────▼───────┐  ┌──────▼───────┐  ┌──────▼───────┐                   │
 * │  │  Replica 1   │  │  Replica 2   │  │  Replica 3   │                   │
 * │  │  (Failover)  │  │  (Failover)  │  │  (Failover)  │                   │
 * │  └──────────────┘  └──────────────┘  └──────────────┘                   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * SLOT DISTRIBUTION:
 * - Redis Cluster uses 16384 hash slots
 * - Keys are assigned to slots via CRC16(key) mod 16384
 * - Each master owns a range of slots
 * - Replicas provide automatic failover
 *
 * HASH TAGS:
 * Keys with the same hash tag {tag} go to the same slot:
 * - user:{123}:friends and user:{123}:sessions → same slot
 * - Enables multi-key operations like MGET, MSET
 *
 * INTERVIEW TIP:
 * "We use Redis Cluster for horizontal scaling. Data is automatically
 * sharded across nodes, and replicas provide failover. For multi-key
 * operations, we use hash tags to ensure related keys are co-located."
 * ==============================================================================
 */

import Redis, { Cluster, ClusterOptions, ClusterNode } from 'ioredis';
import { EventEmitter } from 'events';

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Redis Cluster node configuration.
 */
interface RedisClusterConfig {
  /** Cluster nodes (host:port) */
  nodes: ClusterNode[];

  /** Enable read from replicas */
  readFromReplicas: boolean;

  /** Retry strategy configuration */
  maxRetries: number;
  retryDelayMs: number;

  /** Connection timeout */
  connectTimeoutMs: number;

  /** Enable cluster slots refresh */
  slotsRefreshTimeoutMs: number;
}

/**
 * Default configuration for Redis Cluster.
 */
const defaultConfig: RedisClusterConfig = {
  nodes: [
    { host: 'redis-node-1', port: 6379 },
    { host: 'redis-node-2', port: 6379 },
    { host: 'redis-node-3', port: 6379 },
  ],
  readFromReplicas: true,
  maxRetries: 3,
  retryDelayMs: 100,
  connectTimeoutMs: 5000,
  slotsRefreshTimeoutMs: 1000,
};

// ============================================================================
// CLUSTER MANAGER
// ============================================================================

/**
 * Cluster events for monitoring.
 */
interface ClusterEvent {
  type: 'node_connected' | 'node_disconnected' | 'failover' | 'slot_moved' | 'error';
  node?: string;
  message?: string;
  timestamp: string;
}

/**
 * Redis Cluster Manager - Handles cluster connections and monitoring.
 */
export class RedisClusterManager extends EventEmitter {
  private cluster: Cluster | null = null;
  private config: RedisClusterConfig;
  private isConnected = false;

  constructor(config?: Partial<RedisClusterConfig>) {
    super();
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * Connect to Redis Cluster.
   *
   * CONNECTION FLOW:
   * 1. Connect to seed nodes
   * 2. Discover all cluster nodes
   * 3. Map slot assignments
   * 4. Establish connections to all masters/replicas
   */
  async connect(): Promise<Cluster> {
    if (this.cluster && this.isConnected) {
      return this.cluster;
    }

    const options: ClusterOptions = {
      // Scale reads across replicas
      scaleReads: this.config.readFromReplicas ? 'slave' : 'master',

      // Retry strategy
      clusterRetryStrategy: (times: number) => {
        if (times > this.config.maxRetries) {
          console.error('[RedisCluster] Max retries exceeded');
          return null;
        }
        return Math.min(times * this.config.retryDelayMs, 2000);
      },

      // Slot refresh for topology changes
      slotsRefreshTimeout: this.config.slotsRefreshTimeoutMs,

      // Enable read-only mode for replicas
      enableReadyCheck: true,

      // DNS lookup for cloud deployments
      dnsLookup: (address, callback) => callback(null, address),

      // NAT support for cloud deployments
      natMap: undefined,
    };

    this.cluster = new Cluster(this.config.nodes, options);

    // Event handlers
    this.cluster.on('connect', () => {
      console.log('[RedisCluster] Connected');
      this.isConnected = true;
      this.emitEvent('node_connected');
    });

    this.cluster.on('close', () => {
      console.log('[RedisCluster] Connection closed');
      this.isConnected = false;
      this.emitEvent('node_disconnected');
    });

    this.cluster.on('error', (err) => {
      console.error('[RedisCluster] Error:', err.message);
      this.emitEvent('error', undefined, err.message);
    });

    this.cluster.on('+node', (node: any) => {
      console.log(`[RedisCluster] Node added: ${node.options?.host}:${node.options?.port}`);
      this.emitEvent('node_connected', `${node.options?.host}:${node.options?.port}`);
    });

    this.cluster.on('-node', (node: any) => {
      console.log(`[RedisCluster] Node removed: ${node.options?.host}:${node.options?.port}`);
      this.emitEvent('node_disconnected', `${node.options?.host}:${node.options?.port}`);
    });

    // Wait for ready
    await new Promise<void>((resolve, reject) => {
      this.cluster!.once('ready', () => {
        console.log('[RedisCluster] Ready');
        resolve();
      });
      this.cluster!.once('error', reject);
    });

    return this.cluster;
  }

  /**
   * Get the cluster instance.
   */
  getCluster(): Cluster {
    if (!this.cluster) {
      throw new Error('Cluster not connected. Call connect() first.');
    }
    return this.cluster;
  }

  /**
   * Get cluster info for monitoring.
   */
  async getClusterInfo(): Promise<Record<string, any>> {
    if (!this.cluster) {
      throw new Error('Cluster not connected');
    }

    const nodes = this.cluster.nodes('master');
    const info: Record<string, any> = {
      connected: this.isConnected,
      masterCount: nodes.length,
      nodes: [],
    };

    for (const node of nodes) {
      try {
        const nodeInfo = await node.info('replication');
        info.nodes.push({
          host: node.options.host,
          port: node.options.port,
          role: nodeInfo.includes('role:master') ? 'master' : 'replica',
        });
      } catch {
        info.nodes.push({
          host: node.options.host,
          port: node.options.port,
          role: 'unknown',
          error: 'Failed to get info',
        });
      }
    }

    return info;
  }

  /**
   * Disconnect from cluster.
   */
  async disconnect(): Promise<void> {
    if (this.cluster) {
      await this.cluster.quit();
      this.cluster = null;
      this.isConnected = false;
      console.log('[RedisCluster] Disconnected');
    }
  }

  private emitEvent(type: ClusterEvent['type'], node?: string, message?: string): void {
    const event: ClusterEvent = {
      type,
      node,
      message,
      timestamp: new Date().toISOString(),
    };
    this.emit('clusterEvent', event);
  }
}

// ============================================================================
// HASH TAG UTILITIES
// ============================================================================

/**
 * Hash tag utilities for key co-location.
 *
 * HASH TAG PATTERN:
 * Keys with matching {tag} parts hash to the same slot.
 *
 * Example:
 * - user:{123}:profile → slot based on "123"
 * - user:{123}:friends → slot based on "123"
 * - Both keys on the same node!
 */
export const HashTags = {
  /**
   * Create a key with hash tag.
   */
  withTag(prefix: string, tag: string, suffix: string): string {
    return `${prefix}:{${tag}}:${suffix}`;
  },

  /**
   * User-scoped keys (same user = same slot).
   */
  user(userId: string, suffix: string): string {
    return `user:{${userId}}:${suffix}`;
  },

  /**
   * Game-scoped keys.
   */
  game(gameId: string, suffix: string): string {
    return `game:{${gameId}}:${suffix}`;
  },

  /**
   * Room-scoped keys (chat/voice).
   */
  room(roomId: string, suffix: string): string {
    return `room:{${roomId}}:${suffix}`;
  },

  /**
   * Activity-scoped keys.
   */
  activity(userId: string, suffix: string): string {
    return `activity:{${userId}}:${suffix}`;
  },
};

// ============================================================================
// PIPELINING UTILITIES
// ============================================================================

/**
 * Batch operations utility for optimal performance.
 *
 * PIPELINING:
 * Instead of waiting for each command's response,
 * send multiple commands and read all responses at once.
 *
 * Without pipeline: N round trips
 * With pipeline: 1 round trip
 */
export class RedisBatch {
  private cluster: Cluster;
  private pipeline: ReturnType<Cluster['pipeline']>;

  constructor(cluster: Cluster) {
    this.cluster = cluster;
    this.pipeline = cluster.pipeline();
  }

  /**
   * Add a GET command to the batch.
   */
  get(key: string): this {
    this.pipeline.get(key);
    return this;
  }

  /**
   * Add a SET command to the batch.
   */
  set(key: string, value: string, ttl?: number): this {
    if (ttl) {
      this.pipeline.set(key, value, 'EX', ttl);
    } else {
      this.pipeline.set(key, value);
    }
    return this;
  }

  /**
   * Add an HGETALL command to the batch.
   */
  hgetall(key: string): this {
    this.pipeline.hgetall(key);
    return this;
  }

  /**
   * Add an HSET command to the batch.
   */
  hset(key: string, data: Record<string, string>): this {
    this.pipeline.hset(key, data);
    return this;
  }

  /**
   * Add a ZADD command to the batch.
   */
  zadd(key: string, score: number, member: string): this {
    this.pipeline.zadd(key, score, member);
    return this;
  }

  /**
   * Add a ZRANGE command to the batch.
   */
  zrange(key: string, start: number, stop: number): this {
    this.pipeline.zrange(key, start, stop);
    return this;
  }

  /**
   * Execute all batched commands.
   */
  async exec(): Promise<any[]> {
    const results = await this.pipeline.exec();
    if (!results) return [];

    return results.map(([err, result]) => {
      if (err) throw err;
      return result;
    });
  }
}

// ============================================================================
// CACHE PATTERNS
// ============================================================================

/**
 * Cache-aside pattern implementation.
 *
 * CACHE-ASIDE (Lazy Loading):
 * 1. Check cache first
 * 2. If miss, fetch from database
 * 3. Store in cache for next time
 *
 * PROS: Only caches what's used
 * CONS: First request is slow (cache miss)
 */
export class CacheAside<T> {
  private cluster: Cluster;
  private prefix: string;
  private ttlSeconds: number;
  private fetchFn: (key: string) => Promise<T | null>;

  constructor(
    cluster: Cluster,
    prefix: string,
    ttlSeconds: number,
    fetchFn: (key: string) => Promise<T | null>
  ) {
    this.cluster = cluster;
    this.prefix = prefix;
    this.ttlSeconds = ttlSeconds;
    this.fetchFn = fetchFn;
  }

  /**
   * Get value with cache-aside pattern.
   */
  async get(key: string): Promise<T | null> {
    const cacheKey = `${this.prefix}:${key}`;

    // Try cache first
    const cached = await this.cluster.get(cacheKey);
    if (cached) {
      console.log(`[Cache] HIT: ${cacheKey}`);
      return JSON.parse(cached);
    }

    console.log(`[Cache] MISS: ${cacheKey}`);

    // Fetch from source
    const value = await this.fetchFn(key);
    if (value === null) {
      return null;
    }

    // Store in cache
    await this.cluster.set(cacheKey, JSON.stringify(value), 'EX', this.ttlSeconds);

    return value;
  }

  /**
   * Invalidate cached value.
   */
  async invalidate(key: string): Promise<void> {
    await this.cluster.del(`${this.prefix}:${key}`);
    console.log(`[Cache] INVALIDATED: ${this.prefix}:${key}`);
  }

  /**
   * Refresh cache (for write-through).
   */
  async refresh(key: string, value: T): Promise<void> {
    const cacheKey = `${this.prefix}:${key}`;
    await this.cluster.set(cacheKey, JSON.stringify(value), 'EX', this.ttlSeconds);
    console.log(`[Cache] REFRESHED: ${cacheKey}`);
  }
}

// ============================================================================
// DISTRIBUTED LOCK
// ============================================================================

/**
 * Distributed lock using Redis.
 *
 * USE CASES:
 * - Prevent double-processing of events
 * - Serialize access to shared resources
 * - Leader election in distributed systems
 *
 * ALGORITHM: Redlock (simplified)
 * Uses SET NX EX for atomic lock acquisition.
 */
export class DistributedLock {
  private cluster: Cluster;
  private lockPrefix: string;
  private defaultTTLMs: number;

  constructor(cluster: Cluster, prefix = 'lock', defaultTTLMs = 30000) {
    this.cluster = cluster;
    this.lockPrefix = prefix;
    this.defaultTTLMs = defaultTTLMs;
  }

  /**
   * Acquire a lock.
   */
  async acquire(
    resource: string,
    ttlMs: number = this.defaultTTLMs
  ): Promise<{ acquired: boolean; lockId: string }> {
    const lockKey = `${this.lockPrefix}:${resource}`;
    const lockId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const result = await this.cluster.set(
      lockKey,
      lockId,
      'PX',
      ttlMs,
      'NX'
    );

    if (result === 'OK') {
      console.log(`[Lock] Acquired: ${resource}`);
      return { acquired: true, lockId };
    }

    console.log(`[Lock] Failed to acquire: ${resource}`);
    return { acquired: false, lockId: '' };
  }

  /**
   * Release a lock (only if we own it).
   */
  async release(resource: string, lockId: string): Promise<boolean> {
    const lockKey = `${this.lockPrefix}:${resource}`;

    // Lua script for atomic check-and-delete
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await this.cluster.eval(script, 1, lockKey, lockId);

    if (result === 1) {
      console.log(`[Lock] Released: ${resource}`);
      return true;
    }

    console.log(`[Lock] Release failed (not owner): ${resource}`);
    return false;
  }

  /**
   * Execute with lock (automatic acquire/release).
   */
  async withLock<T>(
    resource: string,
    fn: () => Promise<T>,
    ttlMs?: number
  ): Promise<T | null> {
    const { acquired, lockId } = await this.acquire(resource, ttlMs);

    if (!acquired) {
      return null;
    }

    try {
      return await fn();
    } finally {
      await this.release(resource, lockId);
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { RedisClusterConfig, ClusterEvent };
