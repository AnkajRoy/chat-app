import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { MatchingService } from './matching.service';
import {
  ref,
  set,
  onValue,
  off,
  remove,
  push,
  onChildAdded,
  DatabaseReference
} from 'firebase/database';

export interface ChatMessage {
  text: string;
  sender: 'me' | 'stranger';
  timestamp: Date;
}

@Injectable({ providedIn: 'root' })
export class PeerService {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private signalingRefs: DatabaseReference[] = [];

  private myId = '';

  peerId$ = new BehaviorSubject<string>('');
  remoteStream$ = new BehaviorSubject<MediaStream | null>(null);
  messages$ = new BehaviorSubject<ChatMessage[]>([]);
  connectionStatus$ = new BehaviorSubject<'disconnected' | 'connecting' | 'connected'>('disconnected');
  peerDisconnected$ = new Subject<void>();

  private readonly METERED_API_KEY = '6cd6b7e2cc7ccbab5fa6c49c3fb4f9ce4dc2';
  private cachedIceServers: RTCIceServer[] | null = null;

  constructor(private matchingService: MatchingService) {}

  // ======================== INIT ========================

  async init(): Promise<string> {
    // Generate a unique ID (no PeerJS server needed)
    this.myId = crypto.randomUUID();
    this.peerId$.next(this.myId);

    // Fetch TURN servers in background
    this.fetchIceServers();

    return this.myId;
  }

  async getLocalStream(): Promise<MediaStream> {
    if (this.localStream) return this.localStream;
    this.localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    return this.localStream;
  }

  // ======================== ICE SERVERS ========================

  private async fetchIceServers(): Promise<RTCIceServer[]> {
    if (this.cachedIceServers) return this.cachedIceServers;

    const stun: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(
        `https://app-ak.metered.live/api/v1/turn/credentials?apiKey=${this.METERED_API_KEY}`,
        { signal: controller.signal }
      );
      clearTimeout(timeout);
      const turnServers = await response.json();
      this.cachedIceServers = [...stun, ...turnServers];
    } catch {
      this.cachedIceServers = stun;
    }
    return this.cachedIceServers;
  }

  // ======================== CONNECT ========================

  async connectToPeer(remotePeerId: string, isInitiator: boolean): Promise<void> {
    this.connectionStatus$.next('connecting');
    this.messages$.next([]);
    this.cleanupConnection();

    const db = this.matchingService.db;
    const iceServers = await this.fetchIceServers();

    // Create RTCPeerConnection
    const pc = new RTCPeerConnection({ iceServers });
    this.peerConnection = pc;

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream!);
      });
    }

    // Receive remote tracks
    pc.ontrack = (event) => {
      if (event.streams[0]) {
        this.remoteStream$.next(event.streams[0]);
      }
    };

    // Firebase signaling paths — unique room based on sorted peer IDs
    const roomId = [this.myId, remotePeerId].sort().join('_');
    const roomRef = ref(db, `signaling/${roomId}`);
    const offerRef = ref(db, `signaling/${roomId}/offer`);
    const answerRef = ref(db, `signaling/${roomId}/answer`);
    const callerCandidatesRef = ref(db, `signaling/${roomId}/callerCandidates`);
    const calleeCandidatesRef = ref(db, `signaling/${roomId}/calleeCandidates`);

    // Track refs for cleanup
    this.signalingRefs = [offerRef, answerRef, callerCandidatesRef, calleeCandidatesRef, roomRef];

    // Connection state monitoring
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.connectionStatus$.next('connected');
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.connectionStatus$.next('disconnected');
        this.remoteStream$.next(null);
        this.peerDisconnected$.next();
      }
    };

    if (isInitiator) {
      // === CALLER ===

      // Create data channel
      const dc = pc.createDataChannel('chat', { ordered: true });
      this.setupDataChannel(dc);

      // Send ICE candidates to Firebase
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          push(callerCandidatesRef, event.candidate.toJSON());
        }
      };

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await set(offerRef, { type: offer.type, sdp: offer.sdp });

      // Listen for answer
      onValue(answerRef, async (snapshot) => {
        const data = snapshot.val();
        if (data && !pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(data));
        }
      });

      // Listen for callee ICE candidates
      onChildAdded(calleeCandidatesRef, (snapshot) => {
        const data = snapshot.val();
        if (data) {
          pc.addIceCandidate(new RTCIceCandidate(data));
        }
      });

    } else {
      // === CALLEE ===

      // Receive data channel
      pc.ondatachannel = (event) => {
        this.setupDataChannel(event.channel);
      };

      // Send ICE candidates to Firebase
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          push(calleeCandidatesRef, event.candidate.toJSON());
        }
      };

      // Listen for offer
      onValue(offerRef, async (snapshot) => {
        const data = snapshot.val();
        if (data && !pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(data));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await set(answerRef, { type: answer.type, sdp: answer.sdp });
        }
      });

      // Listen for caller ICE candidates
      onChildAdded(callerCandidatesRef, (snapshot) => {
        const data = snapshot.val();
        if (data) {
          pc.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    }

    // Timeout: if not connected within 10s, retry
    const timeout = setTimeout(() => {
      if (this.connectionStatus$.value !== 'connected') {
        this.disconnect();
        this.peerDisconnected$.next();
      }
    }, 10000);

    const sub = this.connectionStatus$.subscribe(s => {
      if (s === 'connected') {
        clearTimeout(timeout);
        sub.unsubscribe();
      }
    });
  }

  // ======================== DATA CHANNEL ========================

  private setupDataChannel(dc: RTCDataChannel): void {
    this.dataChannel = dc;

    dc.onopen = () => {
      this.connectionStatus$.next('connected');
    };

    dc.onmessage = (event) => {
      const msgs = this.messages$.value;
      this.messages$.next([...msgs, {
        text: event.data,
        sender: 'stranger',
        timestamp: new Date()
      }]);
    };

    dc.onclose = () => {
      this.connectionStatus$.next('disconnected');
      this.remoteStream$.next(null);
      this.peerDisconnected$.next();
    };
  }

  // ======================== MESSAGING ========================

  sendMessage(text: string): void {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(text);
      const msgs = this.messages$.value;
      this.messages$.next([...msgs, {
        text,
        sender: 'me',
        timestamp: new Date()
      }]);
    }
  }

  // ======================== MEDIA CONTROLS ========================

  toggleAudio(enabled: boolean): void {
    this.localStream?.getAudioTracks().forEach(t => t.enabled = enabled);
  }

  toggleVideo(enabled: boolean): void {
    this.localStream?.getVideoTracks().forEach(t => t.enabled = enabled);
  }

  // ======================== CLEANUP ========================

  private cleanupConnection(): void {
    // Remove Firebase signaling listeners
    this.signalingRefs.forEach(r => off(r));

    // Clean up signaling data in Firebase
    if (this.signalingRefs.length > 0) {
      const roomRef = this.signalingRefs[this.signalingRefs.length - 1];
      remove(roomRef).catch(() => {});
    }
    this.signalingRefs = [];

    // Close data channel
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.onclose = null;
      this.dataChannel.close();
      this.dataChannel = null;
    }

    // Close peer connection
    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.ondatachannel = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }

  disconnect(): void {
    this.cleanupConnection();
    this.remoteStream$.next(null);
    this.messages$.next([]);
    this.connectionStatus$.next('disconnected');
  }

  destroy(): void {
    this.disconnect();
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
  }
}
