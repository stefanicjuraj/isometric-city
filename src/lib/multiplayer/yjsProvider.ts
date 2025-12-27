// Y.js provider with internal Edge Config signaling for WebRTC connections

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import {
  GameAction,
  GameActionInput,
  Player,
  AwarenessState,
  generatePlayerId,
  generatePlayerColor,
} from './types';

// Signaling message types
interface SignalMessage {
  type: 'offer' | 'answer' | 'ice-candidate';
  from: string;
  to?: string;
  payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
  timestamp: number;
}

// Data channel message types
interface DataChannelMessage {
  type: 'sync' | 'update' | 'awareness' | 'state-sync' | 'state-request';
  data?: unknown;
}

export interface MultiplayerProviderOptions {
  roomCode: string;
  cityName: string;
  playerName: string;
  isHost: boolean;
  initialGameState?: unknown; // Host provides initial state to share with guests
  onConnectionChange?: (connected: boolean, peerCount: number) => void;
  onPlayersChange?: (players: Player[]) => void;
  onAction?: (action: GameAction) => void;
  onStateReceived?: (state: unknown) => void; // Guest receives state from host
}

export class MultiplayerProvider {
  public readonly doc: Y.Doc;
  public readonly awareness: Awareness;
  public readonly roomCode: string;
  public readonly peerId: string;
  public readonly isHost: boolean;

  private player: Player;
  private options: MultiplayerProviderOptions;
  private operationsArray: Y.Array<GameAction>;
  private metaMap: Y.Map<unknown>;
  private lastAppliedIndex = 0;
  private destroyed = false;

  // WebRTC connections
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel> = new Map();

  // Polling-based signaling
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private lastSeenSignals = '';
  private connectedPeers: Set<string> = new Set();
  
  // Initial game state for P2P sync (host stores this to send to guests)
  private initialGameState: unknown = null;
  
  // Buffer ICE candidates that arrive before the offer
  private pendingIceCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
  
  // Buffer outgoing ICE candidates (bundled with offer/answer)
  private outgoingIceCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
  
  // BroadcastChannel for localhost fallback (when WebRTC fails due to mDNS)
  private broadcastChannel: BroadcastChannel | null = null;
  private useLocalFallback = false;

  constructor(options: MultiplayerProviderOptions) {
    this.options = options;
    this.roomCode = options.roomCode;
    this.isHost = options.isHost;
    this.peerId = generatePlayerId();

    // Create Y.js document
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);

    // Get shared types
    this.operationsArray = this.doc.getArray<GameAction>('operations');
    this.metaMap = this.doc.getMap('meta');

    // Create player info
    this.player = {
      id: this.peerId,
      name: options.playerName,
      color: generatePlayerColor(),
      joinedAt: Date.now(),
      isHost: options.isHost,
    };

    // Set up awareness
    this.awareness.setLocalState({
      player: this.player,
    } as AwarenessState);

    // If host, initialize meta and store game state for sharing
    if (options.isHost) {
      this.metaMap.set('hostId', this.peerId);
      this.metaMap.set('createdAt', Date.now());
      this.metaMap.set('cityName', options.cityName);
      this.metaMap.set('roomCode', options.roomCode);
      this.initialGameState = options.initialGameState;
    }

    // Listen for operations
    this.operationsArray.observe((event) => {
      if (event.changes.added.size > 0) {
        const newOps = this.operationsArray.slice(this.lastAppliedIndex);
        console.log(`[MP] Ops observer: ${newOps.length} new ops, total: ${this.operationsArray.length}`);
        for (const op of newOps) {
          const isRemote = op.playerId !== this.peerId;
          console.log(`[MP] Op: ${op.type} from ${op.playerId}, isRemote: ${isRemote}, hasCallback: ${!!this.options.onAction}`);
          if (isRemote && this.options.onAction) {
            this.options.onAction(op);
          }
        }
        this.lastAppliedIndex = this.operationsArray.length;
      }
    });

    // Listen for awareness changes
    this.awareness.on('change', () => {
      this.notifyPlayersChange();
    });
    
    // Set up BroadcastChannel for localhost fallback
    // This allows multiple tabs to communicate when WebRTC fails (mDNS issues)
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      this.setupLocalFallback();
    }
  }
  
  private setupLocalFallback(): void {
    this.broadcastChannel = new BroadcastChannel(`coop-${this.roomCode}`);
    
    this.broadcastChannel.onmessage = (event) => {
      const msg = event.data as DataChannelMessage & { from?: string; peerId?: string };
      
      // Ignore our own messages
      if (msg.from === this.peerId || msg.peerId === this.peerId) return;
      
      
      // Handle peer announcement via broadcast channel
      if (msg.type === 'awareness') {
        const remotePeerId = msg.from || msg.peerId;
        if (remotePeerId && !this.connectedPeers.has(remotePeerId)) {
          this.connectedPeers.add(remotePeerId);
          this.updateConnectionStatus();
          
          // Send acknowledgement so they know we're here too
          if (this.useLocalFallback) {
            this.broadcastChannel?.postMessage({
              type: 'awareness',
              from: this.peerId,
              data: { player: this.player },
            });
          }
        }
      }
      
      // Always process state-sync (critical for guests to receive initial state)
      // Also process when useLocalFallback is enabled
      if (msg.type === 'state-sync' || msg.type === 'state-request' || this.useLocalFallback) {
        this.handleBroadcastMessage(msg);
      }
    };
  }
  
  private handleBroadcastMessage(msg: DataChannelMessage & { from?: string; peerId?: string }): void {
    switch (msg.type) {
      case 'state-request':
        // Guest is requesting state
        if (this.isHost && this.initialGameState) {
          this.broadcastChannel?.postMessage({
            type: 'state-sync',
            data: this.initialGameState,
            from: this.peerId,
          });
        }
        break;
        
      case 'state-sync':
        // Received state from host
        if (this.options.onStateReceived) {
          this.options.onStateReceived(msg.data);
        }
        break;
        
      case 'sync':
      case 'update':
        // Y.js document update
        if (msg.data) {
          const update = new Uint8Array(msg.data as ArrayBuffer | number[]);
          Y.applyUpdate(this.doc, update, 'remote');
        }
        break;
    }
  }
  
  private enableLocalFallback(): void {
    if (this.useLocalFallback) return;
    if (!this.broadcastChannel) return;
    
    this.useLocalFallback = true;
    
    // Announce ourselves via broadcast channel
    this.broadcastChannel.postMessage({
      type: 'awareness',
      from: this.peerId,
      data: { player: this.player },
    });
    
    // If guest, request state from host (with slight delay to ensure host is ready)
    if (!this.isHost) {
      setTimeout(() => {
        this.broadcastChannel?.postMessage({
          type: 'state-request',
          from: this.peerId,
        });
      }, 100);
    }
    
    // Set up Y.js document sync via broadcast channel
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return; // Don't echo remote updates
      if (!this.useLocalFallback) return;
      
      this.broadcastChannel?.postMessage({
        type: 'update',
        data: Array.from(update),
        from: this.peerId,
      });
    });
    
    // Update connection status
    this.updateConnectionStatus();
  }

  async connect(): Promise<void> {
    if (this.destroyed) return;


    // Notify initial connection
    if (this.options.onConnectionChange) {
      this.options.onConnectionChange(true, 1);
    }

    // Notify initial players list
    this.notifyPlayersChange();

    // On localhost, use BroadcastChannel directly (WebRTC mDNS doesn't work between tabs)
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      this.enableLocalFallback();
      return;
    }

    // Start polling for signaling messages (production WebRTC mode)
    this.startSignalPolling();

    // If not host, send an announcement so host knows we joined
    if (!this.isHost) {
      await this.announcePresence();
    }

  }

  private async announcePresence(): Promise<void> {
    // Send a "hello" signal to announce our presence
    // The host will respond with an offer
    try {
      const response = await fetch('/api/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: this.roomCode,
          type: 'offer',
          from: this.peerId,
          payload: { type: 'announce', peerId: this.peerId, playerName: this.player.name },
        }),
      });
      if (!response.ok) {
        console.error('[Multiplayer] Announcement failed');
      }
    } catch (error) {
      console.error('[Multiplayer] Failed to announce presence:', error);
    }
  }

  private startSignalPolling(): void {
    if (this.pollingInterval) return;

    let pollCount = 0;
    let roomReady = !this.isHost; // Guests know room exists (they just fetched it)
    
    const pollSignals = async () => {
      if (this.destroyed) return;
      pollCount++;

      try {
        const response = await fetch(
          `/api/signal?roomCode=${this.roomCode}&peerId=${this.peerId}&lastSeen=${encodeURIComponent(this.lastSeenSignals)}`
        );

        if (response.ok) {
          roomReady = true;
          const { signals, lastSeen, allSignalsCount } = await response.json();
          this.lastSeenSignals = lastSeen || '';

          for (const signal of signals) {
            await this.handleSignal(signal);
          }
        } else if (response.status === 404) {
          // Room not propagated yet - only log occasionally
          if (pollCount % 5 === 1) {
          }
        }
      } catch (error) {
      }
    };

    // Host waits for Edge Config propagation before starting
    const startPolling = async () => {
      if (this.isHost) {
        // Wait for our room to be readable (up to 3 seconds)
        for (let i = 0; i < 6; i++) {
          const check = await fetch(`/api/room?code=${this.roomCode}`);
          if (check.ok) {
            break;
          }
          await new Promise(r => setTimeout(r, 500));
        }
      }
      
      // Poll every 2s - only needed until WebRTC connects
      this.pollingInterval = setInterval(pollSignals, 2000);
      pollSignals(); // Initial poll
    };
    
    startPolling();
  }

  private async handleSignal(signal: SignalMessage): Promise<void> {
    // Handle announcement (peer joined) - has a special 'announce' type in payload
    const payloadType = (signal.payload as { type?: string })?.type;
    if (signal.type === 'offer' && payloadType === 'announce') {
      if (this.isHost) {
        await this.createPeerConnection(signal.from, true);
      }
      return;
    }

    // Handle real WebRTC offer (bundled format with sdp+candidates, or legacy format)
    const hasSdpPayload = (signal.payload as { sdp?: unknown })?.sdp;
    if (signal.type === 'offer' && (payloadType === 'offer' || hasSdpPayload)) {
      await this.handleOffer(signal);
    } else if (signal.type === 'answer') {
      await this.handleAnswer(signal);
    } else if (signal.type === 'ice-candidate') {
      await this.handleLegacyIceCandidate(signal);
    }
  }

  private async createPeerConnection(remotePeerId: string, createOffer: boolean): Promise<RTCPeerConnection> {
    // Check if connection already exists
    let pc = this.peerConnections.get(remotePeerId);
    if (pc) return pc;

    // Use STUN servers for connectivity
    pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
      ],
      iceCandidatePoolSize: 10,
    });
    
    // ICE connection state handling
    pc.oniceconnectionstatechange = () => {
      // Connection state is handled by onconnectionstatechange
    };
    
    pc.onicegatheringstatechange = () => {
      // Gathering state changes are handled in offer/answer creation
    };

    this.peerConnections.set(remotePeerId, pc);

    // Collect ICE candidates - we'll bundle them with offer/answer
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const pending = this.outgoingIceCandidates.get(remotePeerId) || [];
        pending.push(event.candidate.toJSON());
        this.outgoingIceCandidates.set(remotePeerId, pending);
      } else {
      }
    };

    // Handle connection state
    pc.onconnectionstatechange = () => {
      if (pc!.connectionState === 'connected') {
        this.connectedPeers.add(remotePeerId);
        this.updateConnectionStatus();
        this.stopPollingIfConnected();
      } else if (pc!.connectionState === 'disconnected' || pc!.connectionState === 'failed') {
        this.connectedPeers.delete(remotePeerId);
        this.peerConnections.delete(remotePeerId);
        this.dataChannels.delete(remotePeerId);
        this.updateConnectionStatus();
        
        // On localhost, fallback to BroadcastChannel when WebRTC fails
        if (this.broadcastChannel && !this.useLocalFallback) {
          this.enableLocalFallback();
        }
      }
    };

    // Handle data channel
    pc.ondatachannel = (event) => {
      this.setupDataChannel(event.channel, remotePeerId);
    };

    // Create data channel if we're the initiator
    if (createOffer) {
      const channel = pc.createDataChannel('yjs');
      this.setupDataChannel(channel, remotePeerId);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      // Wait for ICE gathering to complete (or timeout after 3 seconds)
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        } else {
          const checkComplete = () => {
            if (pc.iceGatheringState === 'complete') resolve();
          };
          pc.addEventListener('icegatheringstatechange', checkComplete);
          setTimeout(resolve, 3000); // Timeout after 3 seconds
        }
      });
      
      // Bundle ICE candidates WITH the offer to avoid race conditions
      const candidates = this.outgoingIceCandidates.get(remotePeerId) || [];
      await this.sendSignal('offer', {
        sdp: pc.localDescription!.toJSON(),
        candidates: candidates,
      }, remotePeerId);
      this.outgoingIceCandidates.delete(remotePeerId);
    }

    return pc;
  }

  private setupDataChannel(channel: RTCDataChannel, remotePeerId: string): void {
    this.dataChannels.set(remotePeerId, channel);
    console.log(`[MP] Data channel set up with ${remotePeerId}, state: ${channel.readyState}`);

    channel.onopen = () => {
      console.log(`[MP] Data channel OPEN with ${remotePeerId}`);
      // Sync Y.js document
      this.syncDocument(remotePeerId);
      
      // If we're a guest, request the game state from host
      if (!this.isHost) {
        channel.send(JSON.stringify({ type: 'state-request' } as DataChannelMessage));
      }
    };

    channel.onmessage = (event) => {
      this.handleDataChannelMessage(event.data, remotePeerId);
    };

    channel.onclose = () => {
      console.log(`[MP] Data channel CLOSED with ${remotePeerId}`);
      this.dataChannels.delete(remotePeerId);
    };
  }

  private syncDocument(remotePeerId: string): void {
    // Send full Y.js state
    const state = Y.encodeStateAsUpdate(this.doc);
    const channel = this.dataChannels.get(remotePeerId);
    if (channel && channel.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'sync', data: Array.from(state) }));
    }

    // Send awareness state
    const awarenessState = this.awareness.getLocalState();
    if (awarenessState && channel && channel.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'awareness', data: awarenessState }));
    }
  }

  private handleDataChannelMessage(data: string, remotePeerId: string): void {
    try {
      const message = JSON.parse(data) as DataChannelMessage;
      console.log(`[MP] Received: ${message.type} from ${remotePeerId}`);

      if (message.type === 'sync') {
        // Apply Y.js update
        const update = new Uint8Array(message.data as number[]);
        Y.applyUpdate(this.doc, update);
      } else if (message.type === 'update') {
        // Apply incremental Y.js update
        const update = new Uint8Array(message.data as number[]);
        Y.applyUpdate(this.doc, update);
        console.log(`[MP] Applied Y.js update, ops count: ${this.operationsArray.length}`);
      } else if (message.type === 'awareness') {
        // Update remote awareness
        // Note: This is simplified - full awareness protocol is more complex
        this.notifyPlayersChange();
      } else if (message.type === 'state-request') {
        // Guest is requesting game state - send it if we're host
        if (this.isHost && this.initialGameState) {
          const channel = this.dataChannels.get(remotePeerId);
          if (channel && channel.readyState === 'open') {
            channel.send(JSON.stringify({ 
              type: 'state-sync', 
              data: this.initialGameState 
            } as DataChannelMessage));
          }
        }
      } else if (message.type === 'state-sync') {
        // Received game state from host
        if (this.options.onStateReceived && message.data) {
          this.options.onStateReceived(message.data);
        }
      }
    } catch (error) {
      console.error('[Multiplayer] Failed to handle data channel message:', error);
    }
  }

  private async handleOffer(signal: SignalMessage): Promise<void> {
    try {
      // Parse bundled offer (SDP + ICE candidates)
      const payload = signal.payload as { sdp: RTCSessionDescriptionInit; candidates: RTCIceCandidateInit[] };
      const offerSdp = payload.sdp || signal.payload as RTCSessionDescriptionInit;
      const offerCandidates = payload.candidates || [];
      
      const pc = await this.createPeerConnection(signal.from, false);
      
      await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
      
      // Apply ICE candidates from the bundled offer
      if (offerCandidates.length > 0) {
        for (const candidate of offerCandidates) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error('[Multiplayer] Error adding ICE candidate:', e, candidate);
          }
        }
      }
      
      // Apply any buffered ICE candidates that arrived before the offer
      const bufferedCandidates = this.pendingIceCandidates.get(signal.from) || [];
      if (bufferedCandidates.length > 0) {
        for (const candidate of bufferedCandidates) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error('[Multiplayer] Error adding buffered ICE candidate:', e);
          }
        }
        this.pendingIceCandidates.delete(signal.from);
      }
      
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      // Wait for ICE gathering (or timeout after 3 seconds)
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        } else {
          const checkComplete = () => {
            if (pc.iceGatheringState === 'complete') resolve();
          };
          pc.addEventListener('icegatheringstatechange', checkComplete);
          setTimeout(resolve, 3000);
        }
      });
      
      // Bundle ICE candidates WITH the answer
      const candidates = this.outgoingIceCandidates.get(signal.from) || [];
      await this.sendSignal('answer', {
        sdp: pc.localDescription!.toJSON(),
        candidates: candidates,
      }, signal.from);
      this.outgoingIceCandidates.delete(signal.from);
    } catch (error) {
      console.error('[Multiplayer] Error handling offer:', error);
    }
  }

  private async handleAnswer(signal: SignalMessage): Promise<void> {
    const pc = this.peerConnections.get(signal.from);
    if (pc) {
      // Parse bundled answer (SDP + ICE candidates)
      const payload = signal.payload as { sdp: RTCSessionDescriptionInit; candidates: RTCIceCandidateInit[] };
      const answerSdp = payload.sdp || signal.payload as RTCSessionDescriptionInit;
      const answerCandidates = payload.candidates || [];
      
      await pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
      
      // Apply ICE candidates from the bundled answer
      if (answerCandidates.length > 0) {
        for (const candidate of answerCandidates) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error('[Multiplayer] Error adding ICE candidate:', e);
          }
        }
      }
      
    } else {
      console.warn('[Multiplayer] Received answer but no peer connection exists for:', signal.from);
    }
  }

  // ICE candidates are now bundled with offer/answer, this handles legacy separate ice-candidate signals
  private async handleLegacyIceCandidate(signal: SignalMessage): Promise<void> {
    const payload = signal.payload as RTCIceCandidateInit | { candidates: RTCIceCandidateInit[] };
    const candidates = 'candidates' in payload ? payload.candidates : [payload];
    
    const pc = this.peerConnections.get(signal.from);
    if (pc) {
      for (const candidate of candidates) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
          console.error('[Multiplayer] Error adding ICE candidate:', error);
        }
      }
    } else {
      const pending = this.pendingIceCandidates.get(signal.from) || [];
      pending.push(...candidates);
      this.pendingIceCandidates.set(signal.from, pending);
    }
  }

  private async sendSignal(type: SignalMessage['type'], payload: unknown, to?: string): Promise<void> {
    try {
      const response = await fetch('/api/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: this.roomCode,
          type,
          from: this.peerId,
          to,
          payload,
        }),
      });
      if (!response.ok) {
        console.error('[Multiplayer] Signal POST failed:', response.status, await response.text());
      }
    } catch (error) {
      console.error('[Multiplayer] Failed to send signal:', error);
    }
  }

  private stopPollingIfConnected(): void {
    // Once we have at least one peer connected, stop polling Edge Config
    // All future signaling happens over WebRTC data channels
    if (this.connectedPeers.size > 0 && this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  private updateConnectionStatus(): void {
    const peerCount = this.connectedPeers.size + 1; // +1 for self
    if (this.options.onConnectionChange) {
      this.options.onConnectionChange(true, peerCount);
    }
    this.notifyPlayersChange();
  }

  private notifyPlayersChange(): void {
    if (!this.options.onPlayersChange) return;

    const players: Player[] = [this.player]; // Always include self

    // Add connected peers (in a full implementation, we'd track their player info)
    // For now, we create placeholder players for connected peers
    this.connectedPeers.forEach((peerId) => {
      players.push({
        id: peerId,
        name: `Player ${peerId.slice(-4)}`,
        color: generatePlayerColor(),
        joinedAt: Date.now(),
        isHost: false,
      });
    });

    this.options.onPlayersChange(players);
  }

  // Dispatch an action to all peers
  dispatchAction(action: GameActionInput): void {
    if (this.destroyed) return;

    const fullAction = {
      ...action,
      timestamp: Date.now(),
      playerId: this.peerId,
    } as GameAction;

    // Add to Y.js array
    this.operationsArray.push([fullAction]);

    // Broadcast to all peers via data channels
    const update = Y.encodeStateAsUpdate(this.doc);
    
    // Debug: Log dispatch info
    console.log(`[MP] Dispatch: ${action.type}, channels: ${this.dataChannels.size}, localFallback: ${this.useLocalFallback}`);
    
    this.dataChannels.forEach((channel, peerId) => {
      console.log(`[MP] Channel to ${peerId}: ${channel.readyState}`);
      if (channel.readyState === 'open') {
        channel.send(JSON.stringify({ type: 'update', data: Array.from(update) }));
      }
    });
    
    // Also broadcast via BroadcastChannel if using local fallback
    if (this.useLocalFallback && this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'update',
        data: Array.from(update),
        from: this.peerId,
      });
    }
  }

  // Update local awareness state
  updateAwareness(update: Partial<AwarenessState>): void {
    if (this.destroyed) return;

    const currentState = this.awareness.getLocalState() as AwarenessState || {};
    this.awareness.setLocalState({
      ...currentState,
      ...update,
      player: this.player,
    });
  }

  // Get all connected players
  getPlayers(): Player[] {
    const players: Player[] = [this.player];
    this.connectedPeers.forEach((peerId) => {
      players.push({
        id: peerId,
        name: `Player ${peerId.slice(-4)}`,
        color: generatePlayerColor(),
        joinedAt: Date.now(),
        isHost: false,
      });
    });
    return players;
  }

  getHost(): Player | undefined {
    return this.getPlayers().find((p) => p.isHost);
  }

  amIHost(): boolean {
    return this.isHost;
  }

  getOperationsSince(index: number): GameAction[] {
    return this.operationsArray.slice(index);
  }

  getAllOperations(): GameAction[] {
    return this.operationsArray.toArray();
  }

  getMeta<T>(key: string): T | undefined {
    return this.metaMap.get(key) as T | undefined;
  }

  setMeta(key: string, value: unknown): void {
    this.metaMap.set(key, value);
  }
  
  // Update the game state that will be sent to new peers
  updateGameState(state: unknown): void {
    this.initialGameState = state;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    // Close all peer connections
    this.peerConnections.forEach((pc) => pc.close());
    this.peerConnections.clear();
    this.dataChannels.clear();
    
    // Close broadcast channel
    if (this.broadcastChannel) {
      this.broadcastChannel.close();
      this.broadcastChannel = null;
    }

    this.awareness.destroy();
    this.doc.destroy();
  }
}

// Create and connect a multiplayer provider
export async function createMultiplayerProvider(
  options: MultiplayerProviderOptions
): Promise<MultiplayerProvider> {
  const provider = new MultiplayerProvider(options);
  await provider.connect();
  return provider;
}
