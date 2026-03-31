import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import Peer, { DataConnection, MediaConnection } from 'peerjs';

export interface ChatMessage {
  text: string;
  sender: 'me' | 'stranger';
  timestamp: Date;
}

@Injectable({ providedIn: 'root' })
export class PeerService {
  private peer!: Peer;
  private dataConnection: DataConnection | null = null;
  private mediaConnection: MediaConnection | null = null;
  private localStream: MediaStream | null = null;

  peerId$ = new BehaviorSubject<string>('');
  remoteStream$ = new BehaviorSubject<MediaStream | null>(null);
  messages$ = new BehaviorSubject<ChatMessage[]>([]);
  connectionStatus$ = new BehaviorSubject<'disconnected' | 'connecting' | 'connected'>('disconnected');
  peerDisconnected$ = new Subject<void>();

  private readonly METERED_API_KEY = '6cd6b7e2cc7ccbab5fa6c49c3fb4f9ce4dc2';

  async initPeer(): Promise<string> {
    // Fetch fresh TURN credentials from Metered API
    let iceServers: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' }
    ];

    try {
      const response = await fetch(
        `https://app-ak.metered.live/api/v1/turn/credentials?apiKey=${this.METERED_API_KEY}`
      );
      const turnServers = await response.json();
      iceServers = [...iceServers, ...turnServers];
    } catch (err) {
      console.warn('Failed to fetch TURN credentials, using STUN only:', err);
    }

    return new Promise((resolve, reject) => {
      this.peer = new Peer({
        config: { iceServers }
      });

      this.peer.on('open', (id) => {
        this.peerId$.next(id);
        resolve(id);
      });

      this.peer.on('call', (call) => {
        if (this.localStream) {
          call.answer(this.localStream);
          this.handleMediaConnection(call);
        }
      });

      this.peer.on('connection', (conn) => {
        this.handleDataConnection(conn);
      });

      this.peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        if (!this.peerId$.value) reject(err);
      });
    });
  }

  async getLocalStream(): Promise<MediaStream> {
    if (this.localStream) return this.localStream;
    this.localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    return this.localStream;
  }

  connectToPeer(remotePeerId: string): void {
    this.connectionStatus$.next('connecting');
    this.messages$.next([]);

    const dataConn = this.peer.connect(remotePeerId, { reliable: true });
    this.handleDataConnection(dataConn);

    if (this.localStream) {
      const mediaConn = this.peer.call(remotePeerId, this.localStream);
      this.handleMediaConnection(mediaConn);
    }
  }

  private handleDataConnection(conn: DataConnection): void {
    this.dataConnection = conn;

    conn.on('open', () => {
      this.connectionStatus$.next('connected');
    });

    conn.on('data', (data) => {
      const msgs = this.messages$.value;
      this.messages$.next([...msgs, {
        text: data as string,
        sender: 'stranger',
        timestamp: new Date()
      }]);
    });

    conn.on('close', () => {
      this.connectionStatus$.next('disconnected');
      this.remoteStream$.next(null);
      this.peerDisconnected$.next();
    });
  }

  private handleMediaConnection(call: MediaConnection): void {
    this.mediaConnection = call;

    call.on('stream', (stream) => {
      this.remoteStream$.next(stream);
    });

    call.on('close', () => {
      this.remoteStream$.next(null);
    });
  }

  sendMessage(text: string): void {
    if (this.dataConnection && this.dataConnection.open) {
      this.dataConnection.send(text);
      const msgs = this.messages$.value;
      this.messages$.next([...msgs, {
        text,
        sender: 'me',
        timestamp: new Date()
      }]);
    }
  }

  toggleAudio(enabled: boolean): void {
    this.localStream?.getAudioTracks().forEach(t => t.enabled = enabled);
  }

  toggleVideo(enabled: boolean): void {
    this.localStream?.getVideoTracks().forEach(t => t.enabled = enabled);
  }

  disconnect(): void {
    this.dataConnection?.close();
    this.mediaConnection?.close();
    this.dataConnection = null;
    this.mediaConnection = null;
    this.remoteStream$.next(null);
    this.messages$.next([]);
    this.connectionStatus$.next('disconnected');
  }

  destroy(): void {
    this.disconnect();
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.peer?.destroy();
  }
}
