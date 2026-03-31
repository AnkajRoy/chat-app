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
  private currentRoomId = '';
  private myId = '';

  peerId$ = new BehaviorSubject<string>('');
  remoteStream$ = new BehaviorSubject<MediaStream | null>(null);
  messages$ = new BehaviorSubject<ChatMessage[]>([]);
  connectionStatus$ = new BehaviorSubject<'disconnected' | 'connecting' | 'connected'>('disconnected');
  peerDisconnected$ = new Subject<void>();

  constructor(private matchingService: MatchingService) {}

  // ======================== INIT ========================

  init(): string {
    this.myId = crypto.randomUUID();
    this.peerId$.next(this.myId);
    return this.myId;
  }

  async getLocalStream(): Promise<MediaStream> {
    if (this.localStream) return this.localStream;
    this.localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    return this.localStream;
  }

  // ======================== CONNECT ========================

  async connectToPeer(remotePeerId: string, isInitiator: boolean): Promise<void> {
    // Fully destroy old connection
    this.fullCleanup();
    this.connectionStatus$.next('connecting');
    this.messages$.next([]);

    const db = this.matchingService.db;

    // Create fresh RTCPeerConnection with just STUN (no slow TURN fetch)
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
    this.peerConnection = pc;

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream!));
    }

    // Receive remote tracks
    pc.ontrack = (event) => {
      if (event.streams[0]) this.remoteStream$.next(event.streams[0]);
    };

    // Room ID: use timestamp to avoid stale data from previous sessions
    const roomId = [this.myId, remotePeerId].sort().join('_');
    const roomRef = ref(db, `signaling/${roomId}`);
    const statusRef = ref(db, `signaling/${roomId}/status`);
    const offerRef = ref(db, `signaling/${roomId}/offer`);
    const answerRef = ref(db, `signaling/${roomId}/answer`);
    const callerCandidatesRef = ref(db, `signaling/${roomId}/callerCandidates`);
    const calleeCandidatesRef = ref(db, `signaling/${roomId}/calleeCandidates`);

    this.currentRoomId = roomId;
    this.signalingRefs = [statusRef, offerRef, answerRef, callerCandidatesRef, calleeCandidatesRef, roomRef];

    // Initiator clears stale room data and sets status to 'active'
    if (isInitiator) {
      await remove(roomRef);
      await set(statusRef, 'active');
    }

    // Watch room status — if it becomes 'closed', the other peer left
    onValue(statusRef, (snapshot) => {
      if (snapshot.val() === 'closed') {
        this.fullCleanup();
        this.remoteStream$.next(null);
        this.messages$.next([]);
        this.connectionStatus$.next('disconnected');
        this.peerDisconnected$.next();
      }
    });

    // WebRTC connection state
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.connectionStatus$.next('connected');
      } else if (pc.connectionState === 'failed') {
        this.fullCleanup();
        this.remoteStream$.next(null);
        this.connectionStatus$.next('disconnected');
        this.peerDisconnected$.next();
      }
    };

    if (isInitiator) {
      // === CALLER ===
      const dc = pc.createDataChannel('chat', { ordered: true });
      this.setupDataChannel(dc);

      pc.onicecandidate = (event) => {
        if (event.candidate) push(callerCandidatesRef, event.candidate.toJSON());
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await set(offerRef, { type: offer.type, sdp: offer.sdp });

      onValue(answerRef, async (snapshot) => {
        const data = snapshot.val();
        if (data && !pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(data));
        }
      });

      onChildAdded(calleeCandidatesRef, (snapshot) => {
        const data = snapshot.val();
        if (data) pc.addIceCandidate(new RTCIceCandidate(data));
      });

    } else {
      // === CALLEE ===
      pc.ondatachannel = (event) => this.setupDataChannel(event.channel);

      pc.onicecandidate = (event) => {
        if (event.candidate) push(calleeCandidatesRef, event.candidate.toJSON());
      };

      onValue(offerRef, async (snapshot) => {
        const data = snapshot.val();
        if (data && !pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(data));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await set(answerRef, { type: answer.type, sdp: answer.sdp });
        }
      });

      onChildAdded(callerCandidatesRef, (snapshot) => {
        const data = snapshot.val();
        if (data) pc.addIceCandidate(new RTCIceCandidate(data));
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
    dc.onopen = () => this.connectionStatus$.next('connected');
    dc.onmessage = (event) => {
      const msgs = this.messages$.value;
      this.messages$.next([...msgs, { text: event.data, sender: 'stranger', timestamp: new Date() }]);
    };
    dc.onclose = () => {
      this.connectionStatus$.next('disconnected');
      this.remoteStream$.next(null);
      this.peerDisconnected$.next();
    };
  }

  // ======================== MESSAGING ========================

  sendMessage(text: string): void {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(text);
      const msgs = this.messages$.value;
      this.messages$.next([...msgs, { text, sender: 'me', timestamp: new Date() }]);
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

  private fullCleanup(): void {
    // Remove all Firebase listeners
    this.signalingRefs.forEach(r => off(r));
    this.signalingRefs = [];
    this.currentRoomId = '';

    // Destroy data channel
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.onclose = null;
      this.dataChannel.close();
      this.dataChannel = null;
    }

    // Destroy peer connection completely
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
    const roomId = this.currentRoomId;

    // 1. Remove OUR listeners (so we don't self-trigger from status change)
    this.signalingRefs.forEach(r => off(r));
    this.signalingRefs = [];
    this.currentRoomId = '';

    // 2. Set room status to 'closed' — other peer detects this INSTANTLY
    if (roomId && this.matchingService.db) {
      set(ref(this.matchingService.db, `signaling/${roomId}/status`), 'closed').catch(() => {});
    }

    // 3. Fully destroy WebRTC
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.onclose = null;
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.ondatachannel = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }

    // 4. Reset state
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
