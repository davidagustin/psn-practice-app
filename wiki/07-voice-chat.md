# Voice Chat: Real-Time Audio Communication

This guide covers how PlayStation Network handles voice chat, from WebRTC fundamentals to scaling real-time audio for millions of concurrent users. Understanding voice architecture is critical for senior backend engineering interviews.

## Table of Contents

1. [Overview](#overview)
2. [Real-Time Audio Requirements](#real-time-audio-requirements)
3. [WebRTC Fundamentals](#webrtc-fundamentals)
4. [SFU Architecture](#sfu-architecture)
5. [Signaling Server Design](#signaling-server-design)
6. [Room States & Participant Management](#room-states--participant-management)
7. [Quality of Service](#quality-of-service)
8. [Code Walkthrough](#code-walkthrough)
9. [Interview Questions](#interview-questions)

---

## Overview

Voice chat enables real-time audio communication between users in parties or gaming sessions. Unlike chat messaging (asynchronous), voice requires:

- **Ultra-low latency** (< 150ms for natural conversation)
- **Continuous media streams** (not request/response)
- **Bandwidth optimization** (audio codecs, adaptive bitrate)
- **Complex state management** (ICE candidates, DTLS handshakes)

### High-Level Architecture

```
Player A                    Signaling Server              Player B
(WebRTC)                   (Room Management)             (WebRTC)
    │                              │                        │
    ├─ Join Room ───────────────>  │                        │
    │                              ├─ Create Room           │
    │                              ├─ Add Participant       │
    │                              │                        │
    │                              ├─ Notify Player B       │
    │<─ Peer List ────────────────┤                        │
    │                              <────── Join Room ───────┤
    │                              ├─ Add Participant       │
    │                              <────── Peer List ───────┤
    │                              │                        │
    ├─ Create Offer ───────────────>  (signaling channel)  │
    │                              ├─ Relay Offer ────────>│
    │                              │                        │
    │<─ Receive Answer ────────────┤<─ Send Answer ────────┤
    │                              │                        │
    ├─ Exchange ICE Candidates ────>  (signaling channel)  │
    │                              ├─ Exchange Candidates >│
    │                              │                        │
    └─ MEDIA FLOW STARTS ─────────────────────────────────>│
```

### Why This Matters

Voice chat infrastructure powers:
- **Party Chat**: Up to 100 players in a single voice room
- **Gaming Communication**: Squad voice for competitive games
- **Social Features**: Video calls, stream audio
- **Moderation**: Voice detection for compliance

---

## Real-Time Audio Requirements

### Latency Budget

End-to-end latency must be < 150ms for natural conversation:

```
Player A speaks
    ↓ (1ms)   Audio capture
    ↓ (20ms)  Encoding
    ↓ (50ms)  Network transit
    ↓ (10ms)  Media server processing
    ↓ (50ms)  Network transit to Player B
    ↓ (20ms)  Decoding
    ↓ (1ms)   Playback
─────────────────────────────────
Total: ~152ms (barely acceptable)
```

**If any step takes too long, echo or delay becomes noticeable.**

### Bandwidth Constraints

Voice audio is bandwidth-sensitive:

```
Codec          Bitrate    Quality    Latency
─────────────────────────────────────────────
PCM (RAW)     ~1.4 Mbps  Perfect    None
G.711         ~64 kbps   Telephone  2ms
Opus (32kbps) ~32 kbps   CD Quality 15ms
Opus (8kbps)  ~8 kbps    Speech     15ms
```

**PlayStation uses Opus** because it's optimized for variable bandwidth and can adapt from 6 kbps (speech-only) to 128 kbps (crystal clear).

### Jitter & Packet Loss

Networks are not perfect:

```
Scenario: Sending voice packets every 10ms

IDEAL:
┌──────────────────────────────────┐
│ Packet │ Packet │ Packet │ Packet │
│ 0-10ms │ 10-20ms│ 20-30ms│ 30-40ms│
└──────────────────────────────────┘

JITTER (Packets arrive out of order):
┌──────────────────────────────────┐
│ P1 │ P3 │ P2 │ P4 │ <- Reordered
└──────────────────────────────────┘
Solution: Jitter buffer (sort + playback)

PACKET LOSS (Some packets dropped):
┌──────────────────────────────────┐
│ P1 │    │ P3 │ P4 │ <- P2 missing
└──────────────────────────────────┘
Solution: FEC (Forward Error Correction) or concealment
```

### Audio Quality Metrics

```typescript
interface AudioMetrics {
  // Codec
  codec: 'opus' | 'g711' | 'pcm';
  bitrate: number;           // kbps
  sampleRate: 16000 | 48000; // Hz

  // Network
  jitter: number;            // milliseconds
  latency: number;           // milliseconds
  packetLoss: number;        // 0-100%
  bandwidth: number;         // kbps available

  // Quality
  mosScore: number;          // 1-5 (Mean Opinion Score)
  activeSpeakers: number;
}
```

**MOS Score: What listeners hear**

```
5.0 - Excellent (no degradation)
4.0 - Good (slight degradation)
3.0 - Fair (noticeable degradation)
2.0 - Poor (speech is distorted)
1.0 - Bad (unintelligible)
```

---

## WebRTC Fundamentals

WebRTC (Web Real-Time Communication) is the protocol stack for peer-to-peer media:

### Protocol Layers

```
┌─────────────────────────────────────┐
│       WEBRTC STACK                  │
├─────────────────────────────────────┤
│ Media Layer (Audio/Video)           │
│  - Audio capture/playback           │
│  - Encoding/Decoding                │
│  - Audio levels, VAD                │
├─────────────────────────────────────┤
│ RTP/RTCP (Realtime Protocols)       │
│  - RTP: Media stream transport      │
│  - RTCP: Statistics & feedback      │
├─────────────────────────────────────┤
│ SRTP (Secure RTP)                   │
│  - Encryption of media              │
│  - DTLS key exchange                │
├─────────────────────────────────────┤
│ ICE (Interactive Connectivity Est.) │
│  - Finds path through NATs          │
│  - Candidate gathering & testing    │
├─────────────────────────────────────┤
│ STUN / TURN (NAT Traversal)         │
│  - STUN: Discover public IP         │
│  - TURN: Relay through server       │
├─────────────────────────────────────┤
│ UDP (Transport)                     │
│  - Low latency vs TCP               │
└─────────────────────────────────────┘
```

### Connection Establishment: Offer/Answer

The WebRTC handshake involves exchanging Session Description Protocol (SDP) messages:

**Step 1: Caller creates offer**

```typescript
// Player A (initiates call)
const offer = await peerConnection.createOffer({
  offerToReceiveAudio: true,
  offerToReceiveVideo: false,
});

// SDP describes media capabilities:
// v=0
// o=- 123456 1 IN IP4 192.168.1.1
// s=WebRTC Session
// t=0 0
// m=audio 9 UDP/TLS/RTP/SAVP 111
// a=rtpmap:111 opus/48000/2
// a=fmtp:111 useinbandfec=1
// a=candidate:1 1 UDP ...
```

**Step 2: Caller sends offer via signaling**

```typescript
// Player A → Signaling Server → Player B
await voiceService.sendSignalingMessage({
  type: 'offer',
  roomId,
  fromUserId: 'player_a',
  toUserId: 'player_b',
  sdp: offer.sdp,
});
```

**Step 3: Callee creates answer**

```typescript
// Player B (receives offer)
await peerConnection.setRemoteDescription(
  new RTCSessionDescription({ type: 'offer', sdp: offer.sdp })
);

const answer = await peerConnection.createAnswer();

// Send answer back
await voiceService.sendSignalingMessage({
  type: 'answer',
  roomId,
  fromUserId: 'player_b',
  toUserId: 'player_a',
  sdp: answer.sdp,
});
```

**Step 4: Both sides have offer/answer → set local/remote descriptions**

```typescript
// Player A receives answer
await playerAPeerConnection.setRemoteDescription(answer);

// Player B sends answer
await playerBPeerConnection.setLocalDescription(answer);
```

### Offer/Answer Flow Diagram

```
Player A                    Signaling Server              Player B
   │                               │                         │
   │  1. createOffer() ─────────>  │                         │
   │     (determine media)          │                         │
   │                               │                         │
   │  2. sendSignaling ──offer────>│                         │
   │                               ├───── publish ──────────>│
   │                               │ (WebSocket/Redis)      │
   │                               │                         │
   │                               │  3. Receive offer       │
   │                               │     setRemoteDesc()     │
   │                               │                         │
   │                               │  4. createAnswer()      │
   │                               │     (configure audio)   │
   │                               │                         │
   │<──────────────── publish ─────┤<─── sendSignaling ──────┤
   │      answer                   │     (answer)           │
   │                               │                         │
   │  5. setRemoteDescription()     │                         │
   │     (we get their SDP)         │                         │
   │                               │                         │
   │  6. setLocalDescription()      │  6. setLocalDescription│
   │     (confirm our SDP)          │     (send answer)       │
   │                               │                         │
   └──── ICE Exchange Starts ──────────────────────────────>  │
        (candidates for connectivity)
```

### ICE Candidates

After offer/answer, both sides exchange **ICE candidates** - possible network paths to reach each other:

```typescript
peerConnection.onicecandidate = (event) => {
  if (event.candidate) {
    // Send this candidate to remote peer
    await voiceService.sendSignalingMessage({
      type: 'ice-candidate',
      roomId,
      fromUserId: userId,
      toUserId: remotePeerId,
      candidate: event.candidate,
    });
  }
};

// Receive candidates from remote peer
onSignalingMessage((message) => {
  if (message.type === 'ice-candidate') {
    peerConnection.addIceCandidate(
      new RTCIceCandidate(message.candidate)
    );
  }
});
```

**Candidate gathering process:**

```
ICE Candidate Discovery:

1. HOST CANDIDATES (direct from local network)
   └─ 192.168.1.100:54321
   └─ Fast, direct access

2. SERVER REFLEXIVE (via STUN server)
   └─ 203.0.113.45:54321  (public IP)
   └─ "My public IP is 203.0.113.45"
   └─ Works for most users (NAT hole punching)

3. RELAY CANDIDATES (via TURN server)
   └─ 198.51.100.1:3478  (relay server)
   └─ Last resort: relay through server
   └─ Most reliable but highest latency/cost

ICE tries all candidates in priority order:
1. Direct host → host (fastest)
2. Host → reflexive (common)
3. Via relay (fallback)

Usually 1-2 are successful.
```

**STUN vs TURN:**

| Aspect | STUN | TURN |
|--------|------|------|
| **What it does** | Tells you your public IP | Relays media through server |
| **Cost** | Free (simple protocol) | Expensive (bandwidth) |
| **Latency** | ~50ms for discovery | +50ms for relay |
| **Use case** | ~95% of cases | Firewalled corporate networks |
| **Example** | `stun:stun.l.google.com:19302` | `turn:turnserver.example.com` |

---

## SFU Architecture

### Why SFU Over Mesh

**Mesh (P2P):** Each user sends directly to every other

```
4 Users in call:

User A            User B
  │\              /│
  │ \────────────/ │
  │ /────────────\ │
  │/              \│
User C            User D

Each user sends 3 streams (one per other user)
Total upload bandwidth per user: 3× audio
Total connections: 4×3/2 = 6 connections

At scale (100 users):
  └─ Each user sends 99 streams
  └─ Upload: 99× audio bitrate
  └─ Unusable (users would need 99× 32kbps = 3.2 Mbps upload)
```

**SFU (Server):** Each user sends to server once, receives N-1 streams

```
4 Users in call:

         SFU Server
        /  │  │  \
       /   │  │   \
User A    User B  User C  User D

Each user sends 1 stream to server
Server forwards to all others
Total upload bandwidth per user: 1× audio (same for all)
Total download bandwidth per user: 3× audio (if room has 4)

At scale (100 users):
  └─ Each user sends 1 stream (upload manageable)
  └─ Each user receives 99 streams (download, but negotiated)
  └─ Server handles heavy lifting
```

### Why SFU Is Standard

```
MESH PROBLEMS:
├─ O(n²) connections = network explosion
├─ High upload bandwidth (impossible on mobile)
├─ Symmetric: Everyone needs same bandwidth
├─ Complex ICE/DTLS: Every peer needs key exchange
└─ CPU intense (codec per peer)

SFU ADVANTAGES:
├─ O(n) connections = scales linearly
├─ Single upload stream (efficient)
├─ Selective forwarding = optimize by use case
├─ Simulcast support = vary quality per receiver
└─ Server controls media = better QoS
```

### SFU Media Flow

```
SEND PATH (Player A → Server):
┌─────────────────────────────┐
│ Player A                    │
│ ├─ Capture audio (16kHz)    │
│ ├─ Encode (Opus 32kbps)     │
│ └─ Send RTP stream          │
└───────────┬─────────────────┘
            │
            ▼
┌─────────────────────────────┐
│ SFU Media Server            │
│ ├─ Receive RTP              │
│ ├─ Decode to PCM            │
│ ├─ Mix (combine audio)      │
│ ├─ Reencode per receiver    │
│ └─ Send N-1 streams         │
└───────┬───┬───┬─────────────┘
        │   │   │
        ▼   ▼   ▼
     Player B, C, D receive mixed audio
```

### Simulcast for Optimization

Simulcast = encode once, send multiple qualities:

```typescript
interface SimulcastLayer {
  rid: string;           // "high" | "medium" | "low"
  maxBitrate: number;    // kbps
  maxFramerate: number;  // fps (audio: fixed at sampleRate)
  scaleResolutionDownBy: number;  // (video only, 2.0 = half resolution)
}

// Send offer with simulcast
const offer = await peerConnection.createOffer({
  offerToReceiveAudio: true,
  // For video, would add:
  // offerToReceiveVideo: true,
});

// Add simulcast layers
offer.sdp = simulcast.addSimulcastToSdp(offer.sdp, [
  { rid: 'high', maxBitrate: 128 },   // Good network
  { rid: 'medium', maxBitrate: 64 },  // Medium network
  { rid: 'low', maxBitrate: 32 },     // Poor network
]);
```

**Server dynamically selects layer:**

```
If User B's bandwidth estimate is 100 kbps:
  └─ Accept 'high' quality stream

If User C's bandwidth estimate is 50 kbps:
  └─ Accept 'medium' quality stream

If User D has poor network:
  └─ Accept 'low' quality stream

Server sends different encodings to each, saving bandwidth.
```

---

## Signaling Server Design

The signaling server is NOT the media server. It only handles room management, participant coordination, and WebRTC offer/answer exchange.

### Room Management

```typescript
interface VoiceRoom {
  id: string;                     // "room_123abc"
  name: string;                   // "Gaming Session"
  hostId: string;                 // Creator's user ID
  hostGamertag: string;
  state: 'active' | 'closing' | 'ended';
  maxParticipants: number;        // e.g., 8
  participantCount: number;
  isPrivate: boolean;
  gameId?: string;                // e.g., "elden_ring"
  gameTitle?: string;
  createdAt: string;              // ISO timestamp
  updatedAt: string;
}
```

**Room lifecycle:**

```
1. Create Room (host initiates)
   └─ Generate room ID
   └─ Store in Redis with TTL
   └─ Add creator as first participant

2. Join Room (other players)
   └─ Verify room exists & has space
   └─ Add participant
   └─ Send list of existing participants
   └─ Trigger ICE/offer creation

3. Active Room (media flowing)
   └─ Server receives offers/answers/ICE candidates
   └─ Relays signaling messages
   └─ Monitors participant state (muted, deafened, etc.)

4. Close Room (host leaves or timeout)
   └─ Kick all participants
   └─ Delete room data
   └─ Close media connections
```

### Participant State Machine

```typescript
enum ParticipantState {
  CONNECTING = 'connecting',    // Joining, ICE setup
  CONNECTED = 'connected',      // Media flowing
  MUTED = 'muted',              // Not sending audio
  DEAFENED = 'deafened',        // Not receiving audio
  DISCONNECTING = 'disconnecting',
  DISCONNECTED = 'disconnected',
}

interface VoiceParticipant {
  userId: string;
  gamertag: string;
  avatar: string;
  state: ParticipantState;
  isMuted: boolean;             // Mic off
  isDeafened: boolean;          // Can't hear
  isSpeaking: boolean;          // Audio detected
  volume: number;               // 0-100
  joinedAt: string;             // ISO timestamp
}
```

**State transitions:**

```
User joins room:
  CONNECTING ──(ICE complete)──> CONNECTED
       │
       │ (connection fails)
       └──────────────────────> DISCONNECTED

User mutes:
  CONNECTED ─(toggleMute)─> MUTED ─(toggleMute)─> CONNECTED

User deafens (also mutes):
  CONNECTED ─(toggleDeafen)─> DEAFENED ─(toggleDeafen)─> CONNECTED
                                  │
                            (auto-mutes)

User leaves:
  CONNECTED ──(leaveRoom)──> DISCONNECTED
  MUTED ─────(leaveRoom)──> DISCONNECTED
```

### Redis Data Structures

```
Room metadata:
  voice:room:{roomId}
  Type: Hash
  Fields: {
    id, name, hostId, hostGamertag, state,
    maxParticipants, participantCount, isPrivate,
    gameId, gameTitle, createdAt, updatedAt
  }

Participants in room:
  voice:room:{roomId}:participants
  Type: Hash
  Fields: {
    {userId}: JSON.stringify(VoiceParticipant)
  }

User's current room:
  voice:user:{userId}:room
  Type: String
  Value: roomId (for quick lookup)

Available public rooms:
  voice:rooms:available
  Type: Sorted Set
  Members: roomId values
  Score: participant count (for sorting by fullness)

Signaling channel (for offer/answer relay):
  voice:channel:room:{roomId}
  Type: Pub/Sub channel
  Messages: Signaling messages (offer, answer, ICE)

User-specific signaling:
  voice:channel:room:{roomId}:user:{userId}
  Type: Pub/Sub channel
  Messages: Messages directed to this user
```

### Signaling Message Format

```typescript
interface SignalingMessage {
  type: 'offer' | 'answer' | 'ice-candidate';
  roomId: string;
  fromUserId: string;
  toUserId?: string;              // null = broadcast to room
  sdp?: string;                   // For offer/answer
  candidate?: RTCIceCandidate;    // For ICE
  timestamp: number;
}

// Example: Offer message
{
  type: 'offer',
  roomId: 'room_abc123',
  fromUserId: 'player_a',
  toUserId: 'player_b',
  sdp: 'v=0\no=- 123456...',
  timestamp: 1640000000000
}

// Example: ICE candidate
{
  type: 'ice-candidate',
  roomId: 'room_abc123',
  fromUserId: 'player_a',
  toUserId: 'player_b',
  candidate: {
    candidate: 'candidate:1 1 UDP 2130706431 203.0.113.45 54321 typ srflx',
    sdpMLineIndex: 0,
    sdpMid: 'audio'
  },
  timestamp: 1640000000001
}
```

### Signaling Flow: Multiple Participants

When Player C joins a room with A & B:

```
Server                  Player A              Player B              Player C
   │                       │                      │                     │
   │ 1. C joins            │                      │                     │
   │<──────────────────────────────────────────────────────────────────┤
   │                       │                      │                     │
   │ 2. Peer list (A, B)   │                      │                     │
   │──────────────────────────────────────────────────────────────────>│
   │                       │                      │                     │
   │                       │ 3. C joined          │ 3. C joined         │
   │                       │<──────────────────────────────────────────│
   │                       │                      │                     │
   │ 4. C requests audio   │                      │                     │
   │<──────────────────────────────────────────────────────────────────┤
   │                       │                      │                     │
   │ 5. Offer to A >       │ 6. Receive offer     │                     │
   │────────────────────────>                     │                     │
   │                       │                      │                     │
   │<────────────────────── Answer ───────────────<────────────────────┤
   │                       │ 7. Send answer       │                     │
   │                       │                      │                     │
   │ 5. Offer to B >       │                      │ 6. Receive offer    │
   │──────────────────────────────────────────────>                    │
   │                       │                      │                     │
   │<────────────────────────────────────── Answer ──────────────────────┤
   │                       │                      │ 7. Send answer      │
   │                       │                      │                     │
   │ 8. Exchange ICE candidates (ongoing)        │                     │
   │<─────────────────────────────────────────────────────────────────>
   │                       │                      │                     │
```

---

## Room States & Participant Management

### Room State Lifecycle

```typescript
enum VoiceRoomState {
  WAITING = 'waiting',      // Room created, waiting for participants
  ACTIVE = 'active',        // Participants connected, media flowing
  CLOSING = 'closing',      // Graceful shutdown in progress
  ENDED = 'ended',          // Room closed, no longer accepting joins
}
```

**State diagram:**

```
┌────────┐
│ WAITING │  (Room created, no participants yet)
└────┬───┘
     │ (participants join)
     ▼
┌────────────┐
│   ACTIVE   │  (At least one participant, media flowing)
└────┬───────┘
     │ (host initiates close)
     ▼
┌────────────┐
│  CLOSING   │  (All participants getting disconnected)
└────┬───────┘
     │ (cleanup complete)
     ▼
┌────────┐
│  ENDED │  (Room deleted, no new joins allowed)
└────────┘
```

### Participant Transitions

```
JOINING PROCESS:
┌─────────────┐
│ User calls  │
│  joinRoom() │
└──────┬──────┘
       │
       ▼
  ┌─────────────┐
  │ CONNECTING  │  (ICE gathering, offer/answer exchange)
  └──────┬──────┘
         │ (connection established)
         ▼
  ┌─────────────┐
  │ CONNECTED   │  (Media flowing, can speak/hear)
  └──────┬──────┘
         │
         ├─(toggleMute)──> MUTED ──(toggleMute)──> CONNECTED
         │
         ├─(toggleDeafen)─> DEAFENED ──(toggleDeafen)──> CONNECTED
         │
         │ (leaveRoom or timeout)
         ▼
  ┌──────────────────┐
  │ DISCONNECTED     │  (Removed from room, ICE closed)
  └──────────────────┘
```

### Host Management

Only the host can close a room:

```typescript
// Close room (host only)
async closeRoom(roomId: string, userId: string): Promise<boolean> {
  const room = await getRoom(roomId);

  // Authorization check
  if (room.hostId !== userId) {
    throw new Error('Only the host can close the room');
  }

  // Disconnect all participants
  const participants = await getParticipants(roomId);
  for (const participant of participants) {
    await leaveRoom(participant.userId);
  }

  // Mark room as ended
  await redis.hset(getRoomKey(roomId), {
    state: 'ended',
    updatedAt: new Date().toISOString(),
  });

  return true;
}
```

**If host leaves but others remain:**

```typescript
async leaveRoom(userId: string): Promise<boolean> {
  const room = await getRoom(roomId);

  if (room.hostId === userId) {
    // Host left, assign new host
    const remaining = await getParticipants(roomId);
    if (remaining.length > 0) {
      const newHost = remaining[0];
      await redis.hset(getRoomKey(roomId), {
        hostId: newHost.userId,
        hostGamertag: newHost.gamertag,
      });
      console.log(`New host assigned: ${newHost.gamertag}`);
    } else {
      // Room is empty, close it
      await redis.del(getRoomKey(roomId));
      await redis.del(getParticipantsKey(roomId));
    }
  }

  return true;
}
```

---

## Quality of Service

### Bandwidth Estimation

WebRTC uses REMB (Receiver Estimated Maximum Bitrate) to adapt to network conditions:

```
┌─────────────────────────────────┐
│ Sender Perspective              │
├─────────────────────────────────┤
│ "I'm sending at 64 kbps"        │
│                                 │
│ Receiver gives feedback:         │
│ "REMB: 48 kbps" (network worse) │
│         ↓                       │
│ Reduce bitrate to 48 kbps       │
│                                 │
│ Later: "REMB: 96 kbps" (better) │
│         ↓                       │
│ Increase bitrate to 96 kbps     │
└─────────────────────────────────┘
```

**Bandwidth adaptation in code:**

```typescript
peerConnection.addEventListener('track', (event) => {
  const receiver = event.transceiver.receiver;

  // Monitor REMB feedback
  receiver.getStats().then((stats) => {
    stats.forEach((report) => {
      if (report.type === 'inbound-rtp') {
        const bitrate = report.bytesReceived * 8 / reportDuration;
        const jitter = report.jitter * 1000; // milliseconds
        const loss = report.packetsLost / report.packetsReceived;

        console.log(`Bitrate: ${bitrate} kbps, Jitter: ${jitter}ms, Loss: ${(loss * 100).toFixed(2)}%`);

        // Sender automatically adapts via REMB
      }
    });
  });
});
```

### Codec Selection

Opus is the standard for voice:

```typescript
interface RTCRtpEncodingParameters {
  maxBitrate: 128000;     // 128 kbps (opus max)
  maxFramerate: 48;       // 48 kHz sample rate
  // For video would have:
  // scaleResolutionDownBy: 2.0;
}

// When creating offer, specify codec preference
const offer = await peerConnection.createOffer({
  offerToReceiveAudio: true,
});

// Modify SDP to prefer Opus
offer.sdp = preferCodec(offer.sdp, 'opus');

// Opus parameters in SDP:
// a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=128000
//            ^            ^              ^             ^
//            |            |              |             |
//       min packet     FEC enabled    DTX (silence    max bitrate
//       time           (loss recovery) removal)
```

**Why Opus for voice:**

```
┌─────────────────────────────────────────┐
│ Codec      │ Bitrate   │ Latency │ Use │
├─────────────────────────────────────────┤
│ PCM (RAW)  │ 1.4 Mbps  │ None    │ Dev │
│ G.711      │ 64 kbps   │ 2ms     │ Tel │
│ Opus       │ 6-128 kbps│ 15ms    │ VoIP│
│ G.729      │ 8 kbps    │ 10ms    │ Old │
└─────────────────────────────────────────┘

Opus wins because:
├─ Variable bitrate (6-128 kbps) = adapt to network
├─ Optimized for speech and music
├─ Low latency (15ms) = natural conversation
├─ Open source = freely usable
└─ Standardized = widespread support
```

### Jitter Buffer Management

Jitter buffer compensates for packet arrival variance:

```typescript
// WebRTC has automatic jitter buffer, but monitor it:

peerConnection.addEventListener('track', (event) => {
  const audioElement = new Audio();
  audioElement.srcObject = event.streams[0];
  audioElement.play();

  // Monitor jitter
  const checkJitter = () => {
    peerConnection.getStats((stats) => {
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp') {
          const jitterBuffer = report.jitterBufferDelay;
          const jitterBufferTarget = report.jitterBufferTarget;

          // If jitter too high, may cause latency
          if (jitterBufferDelay > 200) {
            console.warn(`High jitter: ${jitterBuffer}ms`);
            // Consider reducing quality or requesting lower bitrate
          }
        }
      });
    });
  };

  setInterval(checkJitter, 1000);
});
```

**Jitter buffer tradeoffs:**

```
SMALL BUFFER (50ms):
├─ Low latency (good for conversation)
├─ Risk of underrun (gaps in audio)
└─ More quality loss concealment needed

MEDIUM BUFFER (150ms):
├─ Sweet spot for most networks
├─ Handles typical jitter (50-100ms)
├─ Acceptable latency
└─ Good quality

LARGE BUFFER (300ms+):
├─ Handles extreme jitter
├─ Perceptible latency (feels delayed)
└─ Not recommended for real-time
```

---

## Code Walkthrough

### VoiceService Implementation

The signaling server (not media server) from `src/services/voice/voice.service.ts`:

#### 1. Creating a Room

```typescript
async createRoom(input: CreateRoomInput): Promise<VoiceRoom> {
  const roomId = `room_${uuidv4()}`;
  const now = new Date().toISOString();

  const room: VoiceRoom = {
    id: roomId,
    name: input.name,
    hostId: input.hostId,
    hostGamertag: input.hostGamertag,
    state: 'active',
    maxParticipants: input.maxParticipants || 8,
    participantCount: 0,
    isPrivate: input.isPrivate || false,
    gameId: input.gameId,
    gameTitle: input.gameTitle,
    createdAt: now,
    updatedAt: now,
  };

  // Store room metadata in Redis
  const roomKey = `voice:room:${roomId}`;
  await redis.hset(roomKey, room as any);

  // Set expiration (1 hour default)
  await redis.expire(roomKey, 3600);

  // Add to available rooms (if public)
  if (!room.isPrivate) {
    await redis.zadd(
      'voice:rooms:available',
      0, // Initial participant count
      roomId
    );
  }

  // Add host as first participant
  await joinRoom(roomId, hostId, hostGamertag, avatarUrl);

  // Emit event for subscriptions
  this.emit('voiceEvent', {
    type: 'room_created',
    roomId,
    room,
    timestamp: now,
  });

  return room;
}
```

**Why Redis?**
- Fast lookup: `O(1)` for room metadata
- TTL auto-cleanup: Rooms expire after 1 hour of inactivity
- Pub/Sub: Easy to notify all servers of updates
- Sorted set: Track available rooms by participant count

#### 2. Joining a Room

```typescript
async joinRoom(
  roomId: string,
  userId: string,
  gamertag: string,
  avatar: string
): Promise<VoiceRoom> {
  // Verify room exists and has space
  const room = await getRoom(roomId);
  if (!room) throw new Error('Room not found');
  if (room.participantCount >= room.maxParticipants) {
    throw new Error('Room is full');
  }

  // If user in another room, leave it first
  const currentRoom = await getUserRoom(userId);
  if (currentRoom) {
    await leaveRoom(userId);
  }

  const now = new Date().toISOString();

  // Create participant object
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

  // Add to room participants hash
  const participantsKey = `voice:room:${roomId}:participants`;
  await redis.hset(
    participantsKey,
    userId,
    JSON.stringify(participant)
  );

  // Increment participant count
  await redis.hincrby(`voice:room:${roomId}`, 'participantCount', 1);

  // Update available rooms score (by participant count)
  if (!room.isPrivate) {
    await redis.zadd(
      'voice:rooms:available',
      room.participantCount + 1,
      roomId
    );
  }

  // Store user's current room for quick lookup
  await redis.set(`voice:user:${userId}:room`, roomId);

  // Emit event to trigger WebRTC offer creation
  this.emit('voiceEvent', {
    type: 'participant_joined',
    roomId,
    participant,
    timestamp: now,
  });

  return getRoom(roomId);
}
```

**Flow:**
1. Validate room exists and has space
2. Leave current room (one room per user)
3. Add to participants list
4. Update counts and indexes
5. Emit event (triggers client to start ICE/offer creation)

#### 3. Sending Signaling Messages

```typescript
async sendSignalingMessage(message: SignalingMessage): Promise<void> {
  // Determine channel (broadcast or user-specific)
  const channel = message.toUserId
    ? `voice:channel:room:${message.roomId}:user:${message.toUserId}`
    : `voice:channel:room:${message.roomId}`;

  // Publish to Redis (all servers receive via Pub/Sub)
  await redis.publish(channel, JSON.stringify(message));

  console.log(
    `Signaling ${message.type} from ${message.fromUserId} ` +
    `to ${message.toUserId || 'room'}`
  );
}

// Example usage on client:
// Send offer from Player A to Player B
await voiceService.sendSignalingMessage({
  type: 'offer',
  roomId: 'room_123',
  fromUserId: 'player_a',
  toUserId: 'player_b',
  sdp: offer.sdp,
});
```

**Why this works:**
- **Broadcast channel**: All players in room get participant updates
- **User-specific channel**: Only Player B receives offer/answer/ICE
- **Redis Pub/Sub**: Relays across all servers (no hardcoded routing)

#### 4. Subscribing to Signaling

```typescript
async subscribeToSignaling(
  roomId: string,
  userId: string,
  callback: (message: SignalingMessage) => void
): Promise<() => Promise<void>> {
  // Subscribe to both room (broadcast) and user (personal)
  const roomChannel = `voice:channel:room:${roomId}`;
  const userChannel = `voice:channel:room:${roomId}:user:${userId}`;

  const handler = (channel: string, messageStr: string) => {
    if (channel === roomChannel || channel === userChannel) {
      try {
        const message = JSON.parse(messageStr) as SignalingMessage;

        // Don't receive own messages (prevent echo)
        if (message.fromUserId !== userId) {
          callback(message);
        }
      } catch (error) {
        console.error('Invalid signaling message:', error);
      }
    }
  };

  await subscriber.subscribe(roomChannel, userChannel);
  subscriber.on('message', handler);

  // Return unsubscribe function
  return async () => {
    await subscriber.unsubscribe(roomChannel, userChannel);
    subscriber.off('message', handler);
  };
}

// Example client usage:
const unsubscribe = await voiceService.subscribeToSignaling(
  roomId,
  userId,
  (message) => {
    if (message.type === 'offer') {
      handleOffer(message);
    } else if (message.type === 'answer') {
      handleAnswer(message);
    } else if (message.type === 'ice-candidate') {
      peerConnection.addIceCandidate(message.candidate);
    }
  }
);

// Later: unsubscribe when leaving room
await unsubscribe();
```

#### 5. Toggling Audio State

```typescript
async toggleMute(userId: string): Promise<VoiceParticipant> {
  const roomId = await redis.get(`voice:user:${userId}:room`);
  if (!roomId) throw new Error('Not in a voice room');

  // Get participant
  const participantData = await redis.hget(
    `voice:room:${roomId}:participants`,
    userId
  );
  const participant = JSON.parse(participantData);

  // Toggle mute
  participant.isMuted = !participant.isMuted;
  participant.state = participant.isMuted ? 'muted' : 'connected';

  // Update in Redis
  await redis.hset(
    `voice:room:${roomId}:participants`,
    userId,
    JSON.stringify(participant)
  );

  // Emit event (for UI updates across all servers)
  this.emit('voiceEvent', {
    type: 'participant_updated',
    roomId,
    participant,
    timestamp: new Date().toISOString(),
  });

  return participant;
}

// Client-side integration:
// When user presses mute button:
const updated = await voiceService.toggleMute(userId);
if (updated.isMuted) {
  // Disable audio track
  audioTrack.enabled = false;
} else {
  // Enable audio track
  audioTrack.enabled = true;
}
```

**Note:** Mute is handled both server-side (state tracking) and client-side (disable audio track). Server tracking allows showing mute status to other players.

---

## Interview Questions

### Q1: How would you handle 1000 players trying to join the same voice room simultaneously?

**The Challenge:**
```
1000 players join at once:
  ├─ Each creates N-1 PeerConnections
  ├─ Each gathers ICE candidates
  ├─ Each sends/receives offer/answer
  └─ SFU processes 1000 simultaneous connections
```

**Solution: Staggered Connection Establishment**

```typescript
// Client-side: Exponential backoff for connection
const joinVoiceRoom = async (roomId: string, attempt = 0) => {
  const delay = Math.random() * Math.pow(2, attempt) * 1000; // Jitter

  await new Promise(resolve => setTimeout(resolve, delay));

  try {
    await voiceService.joinRoom(roomId, userId, gamertag, avatar);
    await initiateWebRTC();
  } catch (error) {
    if (error.message.includes('room full')) {
      // Room full, try another
      return;
    }
    if (attempt < 5) {
      joinVoiceRoom(roomId, attempt + 1);
    }
  }
};

// Server-side: Limit concurrent signaling
const MAX_CONCURRENT_JOINS = 100; // Per second

async joinRoom(roomId, userId, ...) {
  // Rate limit joins
  const joinCounter = await redis.incr(`join:${roomId}:${Date.now() / 1000}`);
  if (joinCounter > MAX_CONCURRENT_JOINS) {
    throw new Error('Server busy, please retry');
  }

  // ... rest of join logic
}
```

**Why this works:**
- **Staggered**: Not all 1000 connections at once
- **Graceful degradation**: Rejections are retryable
- **Load distribution**: Players eventually get in
- **Total time**: 1000 / 100 = 10 seconds instead of instant crash

**For media server (SFU):**

```typescript
// Simulcast layers ensure manageable bandwidth
const simulcastLayers = [
  { rid: 'high', maxBitrate: 128, scaleResolutionDownBy: 1 },
  { rid: 'medium', maxBitrate: 64, scaleResolutionDownBy: 2 },
  { rid: 'low', maxBitrate: 32, scaleResolutionDownBy: 4 },
];

// Server adapts based on available bandwidth
// If network congested, lower layers are dropped
```

### Q2: A player's connection drops. How do they resume audio without losing their room position?

**The Problem:**

```
Player A in room:
├─ WebSocket connected
├─ PeerConnection established
├─ Audio flowing
    ↓
Network drops (WiFi → cellular switch)
    ↓
WebSocket disconnects
PeerConnections fail
Audio stops
    ↓
How do we resume?
```

**Solution: Reconnection with State Preservation**

```typescript
// Client-side
class VoiceClient {
  private roomId: string;
  private userId: string;
  private reconnectAttempts = 0;

  async onDisconnect() {
    // Don't leave room, just try to reconnect
    console.log('Connection lost, attempting reconnect...');

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 32000);

    setTimeout(() => {
      this.reconnect();
    }, delay);
  }

  async reconnect() {
    try {
      // Get current room state from server
      const room = await voiceService.getRoom(this.roomId);

      if (!room) {
        // Room was deleted
        this.onRoomClosed();
        return;
      }

      // Re-establish WebSocket
      await voiceService.subscribeToSignaling(
        this.roomId,
        this.userId,
        this.handleSignalingMessage.bind(this)
      );

      // Re-create PeerConnections for all participants
      const participants = await voiceService.getParticipants(this.roomId);
      for (const participant of participants) {
        if (participant.userId !== this.userId) {
          await this.createPeerConnectionFor(participant);
        }
      }

      this.reconnectAttempts = 0;
      console.log('Reconnected to room');
    } catch (error) {
      this.reconnectAttempts++;
      this.onDisconnect(); // Try again
    }
  }
}
```

**Server-side: Preserve state**

```typescript
// Server doesn't immediately remove user on disconnect
async leaveRoom(userId: string) {
  const roomId = await redis.get(`voice:user:${userId}:room`);
  if (!roomId) return false;

  // Option 1: Remove immediately (current behavior)
  await redis.hdel(`voice:room:${roomId}:participants`, userId);

  // Option 2: Mark as "away" for 30 seconds (more resilient)
  const participant = await getParticipant(roomId, userId);
  participant.state = 'away'; // temporary
  await redis.setex(
    `voice:room:${roomId}:participant:${userId}:away`,
    30, // 30 second grace period
    JSON.stringify(participant)
  );

  // Tell others user is away
  this.emit('voiceEvent', {
    type: 'participant_away',
    roomId,
    participant,
    timestamp: Date.now(),
  });
}

// If user reconnects within 30 seconds
async rejoinRoom(roomId: string, userId: string) {
  // Check if in grace period
  const awayData = await redis.get(
    `voice:room:${roomId}:participant:${userId}:away`
  );

  if (awayData) {
    // User is still in room! Re-activate
    await redis.del(`voice:room:${roomId}:participant:${userId}:away`);
    console.log('User resumed session');
    return;
  }

  // Otherwise, normal join
  return await joinRoom(roomId, userId, gamertag, avatar);
}
```

**Why this works:**
- **Graceful degradation**: Brief network hiccup doesn't eject user
- **Quick resume**: Peer connections re-establish faster than re-joining
- **Consistent UX**: Player stays in same room/position
- **Practical timeout**: 30 seconds is enough for most reconnects

### Q3: Design the audio level detection system (showing who's speaking)

**Challenge:** Detect voice activity efficiently without processing raw audio server-side

**Solution: Client-Side VAD (Voice Activity Detection)**

```typescript
// Client-side: Use WebRTC's built-in audio level reporting
class SpeakingIndicator {
  private userId: string;
  private isSpeaking = false;

  async startMonitoring(peerConnection: RTCPeerConnection) {
    const monitoringInterval = setInterval(() => {
      peerConnection.getStats((stats) => {
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.mediaType === 'audio') {
            // WebRTC provides audioLevel (0-1) every second
            const audioLevel = report.audioLevel || 0;
            const isSpeakingNow = audioLevel > 0.1; // Threshold

            if (isSpeakingNow !== this.isSpeaking) {
              this.isSpeaking = isSpeakingNow;

              // Send to server (but rate-limited)
              voiceService.updateSpeakingState(
                this.userId,
                this.isSpeaking
              );

              // Update UI
              updateUI({
                userId: this.userId,
                isSpeaking: this.isSpeaking,
              });
            }
          }
        });
      });
    }, 1000);

    return () => clearInterval(monitoringInterval);
  }
}
```

**Server-side: Aggregate and broadcast**

```typescript
// Voice service receives speaking updates
async updateSpeakingState(userId: string, isSpeaking: boolean) {
  const roomId = await redis.get(`voice:user:${userId}:room`);
  if (!roomId) return;

  const participant = await getParticipant(roomId, userId);
  if (!participant) return;

  // Only update if changed (avoid spam)
  if (participant.isSpeaking === isSpeaking) return;

  participant.isSpeaking = isSpeaking;

  // Update in Redis
  await redis.hset(
    `voice:room:${roomId}:participants`,
    userId,
    JSON.stringify(participant)
  );

  // Broadcast to room (all players see who's speaking)
  this.emit('voiceEvent', {
    type: 'participant_updated',
    roomId,
    participant,
    timestamp: Date.now(),
  });
}

// Clients receive update via GraphQL subscription
subscription OnParticipantSpeaking {
  voiceParticipantUpdated(roomId: "room_123") {
    userId
    gamertag
    isSpeaking  // <- Use for visual indicator
  }
}
```

**Why WebRTC's audioLevel?**

```
OPTION 1: Server processes audio (BAD)
├─ Server receives audio stream
├─ Decodes and analyzes
├─ Massive CPU cost (1000 users × analysis)
├─ Privacy concern (server hears everything)
└─ Not practical

OPTION 2: Client sends audioLevel (GOOD)
├─ WebRTC already computes audioLevel
├─ Client sends small number (0-1)
├─ Server just stores in Redis
├─ Broadcasts to other players
├─ Very efficient
└─ Privacy: no audio analysis on server
```

### Q4: How do you prevent echo (my own audio coming back to me)?

**The Problem:**

```
Player A speaks:
  ├─ Audio captured
  ├─ Sent to SFU
  ├─ SFU forwards to Player B
  ├─ SFU also forwards to Player A (!!)
  └─ Player A hears their own echo
```

**Solution 1: Server-Side Filtering (SFU)**

```
SFU receives stream from Player A:
  ├─ Don't forward to Player A
  ├─ Forward to Player B and C only
  └─ Other players hear Player A, but A doesn't hear self
```

**Solution 2: Client-Side Echo Cancellation**

WebRTC handles this automatically:

```typescript
const audioConstraints = {
  echoCancellation: true,      // Enable echo cancellation
  noiseSuppression: true,      // Remove background noise
  autoGainControl: true,       // Normalize volume
};

const audioStream = await navigator.mediaDevices.getUserMedia({
  audio: audioConstraints,
});

const audioTrack = audioStream.getAudioTracks()[0];
peerConnection.addTrack(audioTrack, audioStream);
```

**Under the hood:**

```
Echo cancellation algorithm:
1. Record local audio (what you're saying)
2. Record received audio (what they sent back)
3. Subtract local from received
4. Result: Only remote voice (no echo)

Quality depends on:
├─ Microphone quality
├─ Delay between send/receive (< 200ms needed)
└─ Room acoustics
```

**Best practice: Combine both**

```typescript
// Client-side: Enable all echo cancellation
const audioConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

// Server-side: Don't relay to sender
await forwardStreamToAllExcept(
  audioStream,
  senderUserId  // <- Exclude sender
);
```

### Q5: Explain simulcast and why it matters for voice/video calls

**The Problem:**

Without simulcast:

```
User A has amazing network (100 Mbps):
  ├─ Sends high quality video (5 Mbps)
  ├─ SFU must send same 5 Mbps to everyone
  ├─ User B on mobile (5 Mbps total)
  ├─ Can't keep up, drops quality
  └─ Everyone gets bad video

OR server must re-encode:
  ├─ SFU decodes User A's 5 Mbps
  ├─ Re-encodes to 100 kbps for User B
  ├─ Massive CPU cost
  └─ Unscalable (1000 users = 1000 encodings!)
```

**Solution: Simulcast (encode once, send multiple qualities)**

```typescript
// Client sends multiple layers simultaneously
const simulcastLayers = [
  {
    rid: 'high',
    maxBitrate: 1000,  // For desktop
    scaleResolutionDownBy: 1,
  },
  {
    rid: 'medium',
    maxBitrate: 500,   // For laptop
    scaleResolutionDownBy: 2,
  },
  {
    rid: 'low',
    maxBitrate: 100,   // For mobile
    scaleResolutionDownBy: 4,
  },
];

// Offer with simulcast
const offer = await peerConnection.createOffer();
offer.sdp = addSimulcastToSdp(offer.sdp, simulcastLayers);
await peerConnection.setLocalDescription(offer);
```

**Server-side switching:**

```
SFU receives all 3 layers from User A:
├─ Layer 1: high (1000 kbps, full res)
├─ Layer 2: medium (500 kbps, half res)
├─ Layer 3: low (100 kbps, quarter res)

Based on receiver's bandwidth:
├─ User B (100 Mbps) ← Send high layer
├─ User C (10 Mbps) ← Send medium layer
└─ User D (2 Mbps) ← Send low layer

All without re-encoding! Just select layer.
```

**For Voice (Simplified):**

For audio, simulcast means sending at multiple bitrates:

```
SFU receives Opus at 32 kbps from User A

Could also send:
├─ 32 kbps (highest quality)
├─ 16 kbps (medium quality)
├─ 8 kbps (minimal, speech-only)

Based on receiver:
├─ Good network ← 32 kbps
├─ Okay network ← 16 kbps
└─ Poor network ← 8 kbps
```

**Benefits:**

```
✅ Single encode on client (low CPU)
✅ Server just switches layers (no re-encode)
✅ Adapts to user's network
✅ Scales to thousands of users
✅ No quality loss (not compressed again)
```

### Q6: Design a spatial audio system (proximity chat)

**Challenge:** Only hear nearby players (like a game world)

**Solution: Geometry-Based Routing**

```typescript
interface PlayerPosition {
  x: number;
  y: number;
  z: number;
}

interface ProximityConfig {
  hearDistance: number;  // 100 units
  maxAudible: number;    // 8 players
}

async function updateProximity(
  roomId: string,
  userId: string,
  position: PlayerPosition
) {
  // Get all other participants
  const others = await getParticipants(roomId);

  // Calculate distance to each
  const distances = others.map(other => ({
    userId: other.userId,
    distance: calculateDistance(position, other.position),
  }));

  // Sort by distance
  distances.sort((a, b) => a.distance - b.distance);

  // Get N closest
  const audible = distances
    .filter(d => d.distance < 100) // Within hear distance
    .slice(0, 8) // Max 8 people
    .map(d => d.userId);

  // Update which streams to receive
  for (const other of others) {
    const transceiver = peerConnection.getTransceivers()
      .find(t => t.sender.track?.id === other.userId);

    if (audible.includes(other.userId)) {
      transceiver?.receiver.track?.enable(); // Hear them
    } else {
      transceiver?.receiver.track?.disable(); // Mute them
    }
  }

  // Store position for others to find
  await redis.hset(
    `voice:room:${roomId}:positions`,
    userId,
    JSON.stringify(position)
  );
}
```

**Add spatial panning:**

```typescript
// Pan audio based on direction
function applySpatialAudio(
  audioContext: AudioContext,
  myPosition: PlayerPosition,
  theirPosition: PlayerPosition,
  audioElement: HTMLAudioElement
) {
  // Create panner node
  const panner = audioContext.createPanner();
  panner.positionX.value = theirPosition.x - myPosition.x;
  panner.positionY.value = theirPosition.y - myPosition.y;
  panner.positionZ.value = theirPosition.z - myPosition.z;

  // Distance attenuation
  const distance = calculateDistance(myPosition, theirPosition);
  const gainNode = audioContext.createGain();
  gainNode.gain.value = Math.max(0, 1 - distance / 100); // Fade with distance

  // Wire up
  audioElement.connect(gainNode);
  gainNode.connect(panner);
  panner.connect(audioContext.destination);
}
```

**Benefits:**

```
✅ Immersive: Hear nearby teammates
✅ Scalable: Only connect to ~8 people
✅ Natural: Spatial cues help orientation
✅ Competitive: Can't eavesdrop on far teams
✅ Performance: Fewer connections = lower latency
```

### Q7: How would you debug audio quality issues in production?

**Symptoms & Root Causes:**

```
SYMPTOM: "Audio cuts out randomly"

Possible causes:
├─ Packet loss > 5%
│  └─ Solution: Check network path, enable FEC
├─ Jitter buffer underrun
│  └─ Solution: Increase jitter buffer size
├─ CPU overload on device
│  └─ Solution: Reduce quality/number of streams
└─ Receiver not accepting packets
   └─ Solution: Check firewall, TURN configuration

SYMPTOM: "High latency, sounds delayed"

├─ Jitter buffer too large
│  └─ Reduce buffer target
├─ Network latency > 150ms
│  └─ Use TURN to find better path
├─ SFU processing delay
│  └─ Check server CPU/memory
└─ Audio frame size too large
   └─ Reduce frame duration


SYMPTOM: "Echo or distortion"

├─ Echo cancellation not working
│  └─ Check browser constraints, noise suppression
├─ Microphone feedback
│  └─ Move speakers away from mic
├─ Codec mismatch
│  └─ Verify both sides using Opus
└─ Clipping (audio too loud)
   └─ Reduce input gain
```

**Debugging Toolkit:**

```typescript
async function diagnoseAudioQuality(peerConnection: RTCPeerConnection) {
  const stats = await peerConnection.getStats();

  stats.forEach(report => {
    if (report.type === 'inbound-rtp' && report.mediaType === 'audio') {
      console.log('=== AUDIO QUALITY ===');
      console.log(`Bitrate: ${(report.bytesReceived * 8 / reportDuration / 1000).toFixed(2)} kbps`);
      console.log(`Jitter: ${(report.jitter * 1000).toFixed(2)}ms`);
      console.log(`Packet Loss: ${((report.packetsLost / report.packetsReceived) * 100).toFixed(2)}%`);
      console.log(`Audio Level: ${report.audioLevel.toFixed(2)}`);
      console.log(`Jitter Buffer: ${(report.jitterBufferDelay).toFixed(2)}ms`);

      // Diagnose
      if (report.packetsLost / report.packetsReceived > 0.05) {
        console.warn('⚠ Excessive packet loss, consider lowering bitrate');
      }
      if (report.jitterBufferDelay > 200) {
        console.warn('⚠ High jitter detected');
      }
    }
  });
}

// Monitor continuously
setInterval(() => {
  diagnoseAudioQuality(peerConnection);
}, 5000);
```

**For Production (Monitoring):**

```typescript
// Send metrics to backend every 30 seconds
const reportMetrics = async () => {
  const stats = await peerConnection.getStats();

  const metrics = {
    userId,
    roomId,
    timestamp: Date.now(),
    bitrate: 0,
    jitter: 0,
    packetLoss: 0,
    jitterBuffer: 0,
  };

  stats.forEach(report => {
    if (report.type === 'inbound-rtp' && report.mediaType === 'audio') {
      metrics.bitrate = report.bytesReceived * 8 / 30 / 1000;
      metrics.jitter = report.jitter * 1000;
      metrics.packetLoss = report.packetsLost / report.packetsReceived;
      metrics.jitterBuffer = report.jitterBufferDelay;
    }
  });

  // Send to analytics backend
  await fetch('/api/voice/metrics', {
    method: 'POST',
    body: JSON.stringify(metrics),
  });
};

setInterval(reportMetrics, 30000);
```

---

## Summary

### Key Takeaways

1. **WebRTC is the protocol**: Handles offer/answer, ICE candidates, media transport
2. **SFU architecture**: Scales better than mesh (O(n) vs O(n²))
3. **Signaling vs Media**: Separate servers; signaling via Redis Pub/Sub
4. **Simulcast**: Send multiple qualities, server selects based on receiver bandwidth
5. **Quality metrics**: Monitor jitter, packet loss, latency via WebRTC stats

### Architecture Checklist

- [ ] SFU media server configured (Janus/Mediasoup/Jitsi)
- [ ] Signaling server manages rooms & participants in Redis
- [ ] WebSocket/Pub/Sub channels for offer/answer relay
- [ ] ICE candidate gathering (STUN/TURN configured)
- [ ] Codec selection (Opus preferred)
- [ ] Simulcast layers (high/medium/low)
- [ ] Audio level monitoring for speaking indicator
- [ ] Echo cancellation enabled client-side
- [ ] Jitter buffer managed
- [ ] Metrics/monitoring for production diagnostics

### Common Pitfalls

- Not handling latency budget (> 150ms breaks conversations)
- N+1 connections in mesh architecture (doesn't scale)
- No simulcast (server overloaded re-encoding)
- Poor ICE candidate gathering (no TURN causes failures)
- Missing audio metrics (can't diagnose issues)
- Echo not suppressed (confusing user experience)
- No rate limiting on joins (server crashes at scale)

---

## References

- [WebRTC Specification](https://w3c.github.io/webrtc-pc/)
- [Opus Codec](https://www.opus-codec.org/)
- [IETF RTP](https://tools.ietf.org/html/rfc3550)
- [ICE Protocol](https://tools.ietf.org/html/rfc8445)
- [SFU Architecture](https://www.webrtchacks.com/webrtc-sfu-architecture/)
- [Janus WebRTC Server](https://janus.conf.meetecho.com/)
- [Mediasoup](https://mediasoup.org/)
- [Simulcast in WebRTC](https://chromium.googlesource.com/external/webrtc/+/refs/heads/master/docs/native-code/rtp-hdrext/simulcast-layers.md)
