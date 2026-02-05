/**
 * ==============================================================================
 * PLAYSTATION NETWORK - VOICE CHAT SERVICE
 * ==============================================================================
 *
 * This service handles voice chat rooms similar to PlayStation Party Chat.
 * It manages room creation, participant handling, and WebRTC signaling.
 *
 * VOICE CHAT ARCHITECTURE:
 * ========================
 *
 * MEDIA SERVER TOPOLOGY: Selective Forwarding Unit (SFU)
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                         SFU ARCHITECTURE                                 │
 * │                                                                          │
 * │  ┌─────────┐          ┌─────────────────┐          ┌─────────┐          │
 * │  │ User A  │────────▶ │                 │ ────────▶│ User B  │          │
 * │  │(speaker)│          │   SFU Server    │          │(listener)│         │
 * │  └─────────┘          │                 │          └─────────┘          │
 * │                       │ - Receives 1    │                                │
 * │  ┌─────────┐          │   stream from   │          ┌─────────┐          │
 * │  │ User C  │────────▶ │   each user     │ ────────▶│ User D  │          │
 * │  │(speaker)│          │ - Forwards to   │          │(listener)│         │
 * │  └─────────┘          │   all others    │          └─────────┘          │
 * │                       └─────────────────┘                                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * WHY SFU OVER MESH?
 * - Mesh: Each user sends to every other user (N^2 connections)
 * - SFU: Each user sends once to server, receives N-1 streams
 * - SFU scales better for parties > 3 people
 *
 * WEBRTC SIGNALING FLOW:
 * ======================
 *
 * 1. User joins room
 * 2. Server sends list of existing participants
 * 3. User creates RTCPeerConnection for each participant
 * 4. User sends "offer" to server (SDP)
 * 5. Server forwards offer to participant
 * 6. Participant sends "answer" (SDP)
 * 7. Both exchange ICE candidates
 * 8. Media streams flow through server
 *
 * REDIS DATA STRUCTURES:
 * ======================
 *
 * Voice Room:
 * - Key: voice:room:{roomId}
 * - Type: Hash
 * - Fields: name, hostId, state, maxParticipants, etc.
 *
 * Room Participants:
 * - Key: voice:room:{roomId}:participants
 * - Type: Hash
 * - Fields: {userId: participantData}
 *
 * User's Current Room:
 * - Key: voice:user:{userId}:room
 * - Type: String
 * - Value: roomId
 *
 * Available Rooms:
 * - Key: voice:rooms:available
 * - Type: Sorted Set (score = participant count)
 * - Members: roomId values
 *
 * INTERVIEW TIP:
 * "Voice chat requires careful state management. We track room state,
 * participant audio state (muted/deafened), and signaling all in Redis.
 * This allows horizontal scaling - any server can handle any room request
 * by reading state from Redis and publishing to the appropriate channels."
 * ==============================================================================
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  VoiceRoom,
  VoiceParticipant,
  VoiceRoomState,
  SignalingMessage,
} from '../../types';

/**
 * Service configuration.
 */
interface VoiceServiceConfig {
  /** Maximum participants per room */
  maxParticipantsDefault: number;

  /** Room inactivity timeout in seconds */
  roomTimeoutSeconds: number;

  /** Key prefix for Redis */
  keyPrefix: string;

  /** Pub/Sub channel prefix */
  channelPrefix: string;
}

/**
 * Input for creating a voice room.
 */
interface CreateRoomInput {
  name: string;
  hostId: string;
  hostGamertag: string;
  maxParticipants?: number;
  isPrivate?: boolean;
  gameId?: string;
  gameTitle?: string;
}

/**
 * Voice event for real-time updates.
 */
interface VoiceEvent {
  type:
    | 'room_created'
    | 'room_closed'
    | 'participant_joined'
    | 'participant_left'
    | 'participant_updated'
    | 'room_updated';
  roomId: string;
  room?: VoiceRoom;
  participant?: VoiceParticipant;
  timestamp: string;
}

// ============================================================================
// VOICE SERVICE IMPLEMENTATION
// ============================================================================

/**
 * VoiceService - Manages voice chat rooms and WebRTC signaling.
 *
 * NOTE: This service handles the signaling and state management.
 * Actual media routing would be handled by a dedicated media server
 * (like Janus, Mediasoup, or Jitsi) in production.
 */
export class VoiceService extends EventEmitter {
  private redis: Redis;
  private subscriber: Redis;
  private config: VoiceServiceConfig;

  constructor(redis: Redis, config?: Partial<VoiceServiceConfig>) {
    super();
    this.redis = redis;
    this.subscriber = redis.duplicate();
    this.config = {
      maxParticipantsDefault: config?.maxParticipantsDefault || 8,
      roomTimeoutSeconds: config?.roomTimeoutSeconds || 3600, // 1 hour
      keyPrefix: config?.keyPrefix || 'voice:',
      channelPrefix: config?.channelPrefix || 'voice:channel:',
    };

    // Start room cleanup
    this.startRoomCleanup();
  }

  // ============================================================================
  // ROOM MANAGEMENT
  // ============================================================================

  /**
   * Create a new voice room.
   *
   * ROOM CREATION FLOW:
   * 1. Generate unique room ID
   * 2. Store room metadata
   * 3. Add creator as first participant
   * 4. Add to available rooms list (if public)
   * 5. Emit room created event
   */
  async createRoom(input: CreateRoomInput): Promise<VoiceRoom> {
    const roomId = `room_${uuidv4()}`;
    const now = new Date().toISOString();

    const room: VoiceRoom = {
      id: roomId,
      name: input.name,
      hostId: input.hostId,
      hostGamertag: input.hostGamertag,
      state: 'active',
      maxParticipants: input.maxParticipants || this.config.maxParticipantsDefault,
      participantCount: 0,
      isPrivate: input.isPrivate || false,
      gameId: input.gameId,
      gameTitle: input.gameTitle,
      createdAt: now,
      updatedAt: now,
    };

    // Store room data
    const roomKey = this.getRoomKey(roomId);
    await this.redis.hset(roomKey, room as any);
    await this.redis.expire(roomKey, this.config.roomTimeoutSeconds);

    // Add to available rooms if public
    if (!room.isPrivate) {
      await this.redis.zadd(
        this.getAvailableRoomsKey(),
        0, // Initial participant count as score
        roomId
      );
    }

    console.log(`[VoiceService] Created room: ${room.name} (${roomId})`);

    // Add host as participant
    await this.joinRoom(
      roomId,
      input.hostId,
      input.hostGamertag,
      'https://example.com/avatar.png'
    );

    // Emit event
    const event: VoiceEvent = {
      type: 'room_created',
      roomId,
      room,
      timestamp: now,
    };
    this.emit('voiceEvent', event);

    return room;
  }

  /**
   * Get a room by ID.
   */
  async getRoom(roomId: string): Promise<VoiceRoom | null> {
    const data = await this.redis.hgetall(this.getRoomKey(roomId));

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      id: data.id,
      name: data.name,
      hostId: data.hostId,
      hostGamertag: data.hostGamertag,
      state: data.state as VoiceRoomState,
      maxParticipants: parseInt(data.maxParticipants || '8'),
      participantCount: parseInt(data.participantCount || '0'),
      isPrivate: data.isPrivate === 'true',
      gameId: data.gameId || undefined,
      gameTitle: data.gameTitle || undefined,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }

  /**
   * Get available (public, non-full) rooms.
   */
  async getAvailableRooms(): Promise<VoiceRoom[]> {
    const roomIds = await this.redis.zrange(
      this.getAvailableRoomsKey(),
      0,
      -1
    );

    const rooms: VoiceRoom[] = [];
    for (const roomId of roomIds) {
      const room = await this.getRoom(roomId);
      if (room && room.participantCount < room.maxParticipants) {
        rooms.push(room);
      }
    }

    return rooms;
  }

  /**
   * Get user's current room.
   */
  async getUserRoom(userId: string): Promise<VoiceRoom | null> {
    const roomId = await this.redis.get(this.getUserRoomKey(userId));
    if (!roomId) return null;
    return this.getRoom(roomId);
  }

  /**
   * Close a room (host only).
   */
  async closeRoom(roomId: string, userId: string): Promise<boolean> {
    const room = await this.getRoom(roomId);
    if (!room) return false;

    // Only host can close
    if (room.hostId !== userId) {
      throw new Error('Only the host can close the room');
    }

    // Get all participants
    const participants = await this.getParticipants(roomId);

    // Remove all participants
    for (const participant of participants) {
      await this.leaveRoom(participant.userId);
    }

    // Update room state
    await this.redis.hset(this.getRoomKey(roomId), {
      state: 'ended',
      updatedAt: new Date().toISOString(),
    });

    // Remove from available rooms
    await this.redis.zrem(this.getAvailableRoomsKey(), roomId);

    console.log(`[VoiceService] Room closed: ${roomId}`);

    // Emit event
    const event: VoiceEvent = {
      type: 'room_closed',
      roomId,
      timestamp: new Date().toISOString(),
    };
    this.emit('voiceEvent', event);

    return true;
  }

  // ============================================================================
  // PARTICIPANT MANAGEMENT
  // ============================================================================

  /**
   * Join a voice room.
   *
   * JOIN FLOW:
   * 1. Verify room exists and has space
   * 2. Leave current room if in one
   * 3. Add participant to room
   * 4. Update participant count
   * 5. Store user's current room reference
   * 6. Emit join event for WebRTC signaling
   */
  async joinRoom(
    roomId: string,
    userId: string,
    gamertag: string,
    avatar: string
  ): Promise<VoiceRoom> {
    const room = await this.getRoom(roomId);

    if (!room) {
      throw new Error('Room not found');
    }

    if (room.state === 'ended') {
      throw new Error('Room has ended');
    }

    if (room.participantCount >= room.maxParticipants) {
      throw new Error('Room is full');
    }

    // Leave current room if in one
    const currentRoom = await this.getUserRoom(userId);
    if (currentRoom) {
      await this.leaveRoom(userId);
    }

    const now = new Date().toISOString();

    // Create participant
    const participant: VoiceParticipant = {
      userId,
      gamertag,
      avatar,
      state: 'connected',
      isMuted: false,
      isDeafened: false,
      isSpeaking: false,
      volume: 100,
      joinedAt: now,
    };

    // Add to room participants
    await this.redis.hset(
      this.getParticipantsKey(roomId),
      userId,
      JSON.stringify(participant)
    );

    // Update participant count
    await this.redis.hincrby(this.getRoomKey(roomId), 'participantCount', 1);

    // Update available rooms score (participant count)
    if (!room.isPrivate) {
      await this.redis.zadd(
        this.getAvailableRoomsKey(),
        room.participantCount + 1,
        roomId
      );
    }

    // Store user's current room
    await this.redis.set(this.getUserRoomKey(userId), roomId);

    // Refresh room TTL
    await this.redis.expire(
      this.getRoomKey(roomId),
      this.config.roomTimeoutSeconds
    );

    console.log(`[VoiceService] ${gamertag} joined room ${roomId}`);

    // Emit event
    const event: VoiceEvent = {
      type: 'participant_joined',
      roomId,
      participant,
      timestamp: now,
    };
    this.emit('voiceEvent', event);

    // Return updated room
    return (await this.getRoom(roomId))!;
  }

  /**
   * Leave the current voice room.
   */
  async leaveRoom(userId: string): Promise<boolean> {
    const roomId = await this.redis.get(this.getUserRoomKey(userId));
    if (!roomId) return false;

    const room = await this.getRoom(roomId);
    if (!room) {
      // Clean up orphaned reference
      await this.redis.del(this.getUserRoomKey(userId));
      return false;
    }

    // Get participant data before removing
    const participantData = await this.redis.hget(
      this.getParticipantsKey(roomId),
      userId
    );

    // Remove participant
    await this.redis.hdel(this.getParticipantsKey(roomId), userId);
    await this.redis.del(this.getUserRoomKey(userId));

    // Update participant count
    await this.redis.hincrby(this.getRoomKey(roomId), 'participantCount', -1);

    // Update available rooms score
    if (!room.isPrivate) {
      await this.redis.zadd(
        this.getAvailableRoomsKey(),
        Math.max(0, room.participantCount - 1),
        roomId
      );
    }

    console.log(`[VoiceService] User ${userId} left room ${roomId}`);

    // If host left and room not empty, assign new host
    if (room.hostId === userId) {
      const remainingParticipants = await this.getParticipants(roomId);
      if (remainingParticipants.length > 0) {
        // Assign first remaining participant as new host
        const newHost = remainingParticipants[0];
        await this.redis.hset(this.getRoomKey(roomId), {
          hostId: newHost.userId,
          hostGamertag: newHost.gamertag,
          updatedAt: new Date().toISOString(),
        });
        console.log(`[VoiceService] New host: ${newHost.gamertag}`);
      } else {
        // Room is empty, close it
        await this.redis.del(this.getRoomKey(roomId));
        await this.redis.del(this.getParticipantsKey(roomId));
        await this.redis.zrem(this.getAvailableRoomsKey(), roomId);
        console.log(`[VoiceService] Room ${roomId} closed (empty)`);
      }
    }

    // Emit event
    if (participantData) {
      const participant = JSON.parse(participantData) as VoiceParticipant;
      const event: VoiceEvent = {
        type: 'participant_left',
        roomId,
        participant,
        timestamp: new Date().toISOString(),
      };
      this.emit('voiceEvent', event);
    }

    return true;
  }

  /**
   * Get all participants in a room.
   */
  async getParticipants(roomId: string): Promise<VoiceParticipant[]> {
    const data = await this.redis.hgetall(this.getParticipantsKey(roomId));

    if (!data || Object.keys(data).length === 0) {
      return [];
    }

    return Object.values(data).map(
      (json) => JSON.parse(json) as VoiceParticipant
    );
  }

  /**
   * Get a specific participant.
   */
  async getParticipant(
    roomId: string,
    userId: string
  ): Promise<VoiceParticipant | null> {
    const data = await this.redis.hget(
      this.getParticipantsKey(roomId),
      userId
    );

    if (!data) return null;
    return JSON.parse(data) as VoiceParticipant;
  }

  // ============================================================================
  // AUDIO STATE MANAGEMENT
  // ============================================================================

  /**
   * Toggle mute for a participant.
   */
  async toggleMute(userId: string): Promise<VoiceParticipant> {
    const roomId = await this.redis.get(this.getUserRoomKey(userId));
    if (!roomId) {
      throw new Error('Not in a voice room');
    }

    const participant = await this.getParticipant(roomId, userId);
    if (!participant) {
      throw new Error('Participant not found');
    }

    // Toggle mute
    participant.isMuted = !participant.isMuted;
    participant.state = participant.isMuted ? 'muted' : 'connected';

    // Update in Redis
    await this.redis.hset(
      this.getParticipantsKey(roomId),
      userId,
      JSON.stringify(participant)
    );

    console.log(`[VoiceService] ${participant.gamertag} mute: ${participant.isMuted}`);

    // Emit event
    const event: VoiceEvent = {
      type: 'participant_updated',
      roomId,
      participant,
      timestamp: new Date().toISOString(),
    };
    this.emit('voiceEvent', event);

    return participant;
  }

  /**
   * Toggle deafen for a participant.
   */
  async toggleDeafen(userId: string): Promise<VoiceParticipant> {
    const roomId = await this.redis.get(this.getUserRoomKey(userId));
    if (!roomId) {
      throw new Error('Not in a voice room');
    }

    const participant = await this.getParticipant(roomId, userId);
    if (!participant) {
      throw new Error('Participant not found');
    }

    // Toggle deafen (deafen also mutes)
    participant.isDeafened = !participant.isDeafened;
    if (participant.isDeafened) {
      participant.isMuted = true;
      participant.state = 'deafened';
    } else {
      participant.state = participant.isMuted ? 'muted' : 'connected';
    }

    // Update in Redis
    await this.redis.hset(
      this.getParticipantsKey(roomId),
      userId,
      JSON.stringify(participant)
    );

    console.log(`[VoiceService] ${participant.gamertag} deafened: ${participant.isDeafened}`);

    // Emit event
    const event: VoiceEvent = {
      type: 'participant_updated',
      roomId,
      participant,
      timestamp: new Date().toISOString(),
    };
    this.emit('voiceEvent', event);

    return participant;
  }

  /**
   * Update speaking state (called from WebRTC audio level detection).
   */
  async updateSpeakingState(
    userId: string,
    isSpeaking: boolean
  ): Promise<void> {
    const roomId = await this.redis.get(this.getUserRoomKey(userId));
    if (!roomId) return;

    const participant = await this.getParticipant(roomId, userId);
    if (!participant) return;

    // Only update if changed
    if (participant.isSpeaking === isSpeaking) return;

    participant.isSpeaking = isSpeaking;

    await this.redis.hset(
      this.getParticipantsKey(roomId),
      userId,
      JSON.stringify(participant)
    );

    // Emit event (for UI updates)
    const event: VoiceEvent = {
      type: 'participant_updated',
      roomId,
      participant,
      timestamp: new Date().toISOString(),
    };
    this.emit('voiceEvent', event);
  }

  // ============================================================================
  // WEBRTC SIGNALING
  // ============================================================================

  /**
   * Send a signaling message (offer, answer, or ICE candidate).
   *
   * SIGNALING FLOW:
   * 1. Caller creates offer (SDP)
   * 2. Send offer through signaling server
   * 3. Callee receives offer, creates answer
   * 4. Send answer through signaling server
   * 5. Both exchange ICE candidates
   * 6. Media connection established
   *
   * @param message - Signaling message to send
   */
  async sendSignalingMessage(message: SignalingMessage): Promise<void> {
    const channel = message.toUserId
      ? this.getSignalingChannel(message.roomId, message.toUserId)
      : this.getRoomChannel(message.roomId);

    await this.redis.publish(channel, JSON.stringify(message));

    console.log(
      `[VoiceService] Signaling ${message.type} from ${message.fromUserId} ` +
      `to ${message.toUserId || 'room'}`
    );
  }

  /**
   * Subscribe to signaling messages for a room/user.
   */
  async subscribeToSignaling(
    roomId: string,
    userId: string,
    callback: (message: SignalingMessage) => void
  ): Promise<() => Promise<void>> {
    const roomChannel = this.getRoomChannel(roomId);
    const userChannel = this.getSignalingChannel(roomId, userId);

    const handler = (channel: string, messageStr: string) => {
      if (channel === roomChannel || channel === userChannel) {
        try {
          const message = JSON.parse(messageStr) as SignalingMessage;
          // Don't receive own messages
          if (message.fromUserId !== userId) {
            callback(message);
          }
        } catch (error) {
          console.error('[VoiceService] Invalid signaling message:', error);
        }
      }
    };

    await this.subscriber.subscribe(roomChannel, userChannel);
    this.subscriber.on('message', handler);

    // Return unsubscribe function
    return async () => {
      await this.subscriber.unsubscribe(roomChannel, userChannel);
      this.subscriber.off('message', handler);
    };
  }

  // ============================================================================
  // ROOM CLEANUP
  // ============================================================================

  /**
   * Start periodic cleanup of inactive rooms.
   */
  private startRoomCleanup(): void {
    // Run every 5 minutes
    setInterval(async () => {
      try {
        await this.cleanupInactiveRooms();
      } catch (error) {
        console.error('[VoiceService] Room cleanup error:', error);
      }
    }, 300000);
  }

  /**
   * Clean up rooms with no participants.
   */
  private async cleanupInactiveRooms(): Promise<void> {
    const roomIds = await this.redis.zrange(
      this.getAvailableRoomsKey(),
      0,
      -1
    );

    for (const roomId of roomIds) {
      const room = await this.getRoom(roomId);
      if (!room) {
        // Room expired, remove from list
        await this.redis.zrem(this.getAvailableRoomsKey(), roomId);
        continue;
      }

      const participants = await this.getParticipants(roomId);
      if (participants.length === 0) {
        // Close empty room
        await this.redis.del(this.getRoomKey(roomId));
        await this.redis.del(this.getParticipantsKey(roomId));
        await this.redis.zrem(this.getAvailableRoomsKey(), roomId);
        console.log(`[VoiceService] Cleaned up empty room: ${roomId}`);
      }
    }
  }

  // ============================================================================
  // KEY HELPERS
  // ============================================================================

  private getRoomKey(roomId: string): string {
    return `${this.config.keyPrefix}room:${roomId}`;
  }

  private getParticipantsKey(roomId: string): string {
    return `${this.config.keyPrefix}room:${roomId}:participants`;
  }

  private getUserRoomKey(userId: string): string {
    return `${this.config.keyPrefix}user:${userId}:room`;
  }

  private getAvailableRoomsKey(): string {
    return `${this.config.keyPrefix}rooms:available`;
  }

  private getRoomChannel(roomId: string): string {
    return `${this.config.channelPrefix}room:${roomId}`;
  }

  private getSignalingChannel(roomId: string, userId: string): string {
    return `${this.config.channelPrefix}room:${roomId}:user:${userId}`;
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  async cleanup(): Promise<void> {
    await this.subscriber.quit();
    console.log('[VoiceService] Cleaned up');
  }
}
