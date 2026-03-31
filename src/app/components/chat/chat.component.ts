import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { PeerService, ChatMessage } from '../../services/peer.service';
import { MatchingService } from '../../services/matching.service';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss'
})
export class ChatComponent implements OnInit, OnDestroy {
  @ViewChild('localVideo') localVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('remoteVideo') remoteVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('chatContainer') chatContainer!: ElementRef<HTMLDivElement>;

  messages: ChatMessage[] = [];
  messageText = '';
  status: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  isAudioEnabled = true;
  isVideoEnabled = true;
  isSearching = false;
  noOneAvailable = false;

  private subs: Subscription[] = [];

  constructor(
    private peerService: PeerService,
    private matchingService: MatchingService,
    private router: Router
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      this.matchingService.init();
      const stream = await this.peerService.getLocalStream();
      await this.peerService.initPeer();

      setTimeout(() => {
        if (this.localVideo?.nativeElement) {
          this.localVideo.nativeElement.srcObject = stream;
        }
      });

      this.subs.push(
        this.peerService.remoteStream$.subscribe(stream => {
          if (this.remoteVideo?.nativeElement) {
            this.remoteVideo.nativeElement.srcObject = stream;
          }
        }),
        this.peerService.messages$.subscribe(msgs => {
          this.messages = msgs;
          setTimeout(() => this.scrollChat());
        }),
        this.peerService.connectionStatus$.subscribe(s => {
          this.status = s;
          if (s === 'connected') this.isSearching = false;
        }),
        this.matchingService.matched$.subscribe(({ peerId, isInitiator }) => {
          this.noOneAvailable = false;
          this.peerService.connectToPeer(peerId, isInitiator);
        }),
        this.matchingService.noStrangersAvailable$.subscribe(() => {
          this.isSearching = false;
          this.noOneAvailable = true;
          this.status = 'disconnected';
        }),
        this.peerService.peerDisconnected$.subscribe(() => {
          this.status = 'disconnected';
        })
      );

      this.findStranger();
    } catch (err) {
      console.error('Failed to initialize:', err);
      alert('Camera/mic access is required. Please allow permissions and refresh.');
    }
  }

  async findStranger(): Promise<void> {
    this.peerService.disconnect();
    this.isSearching = true;
    this.noOneAvailable = false;
    this.status = 'connecting';
    const peerId = this.peerService.peerId$.value;
    if (peerId) {
      await this.matchingService.leaveLobby();
      await this.matchingService.joinLobby(peerId);
    }
  }

  sendMessage(): void {
    const text = this.messageText.trim();
    if (text && this.status === 'connected') {
      this.peerService.sendMessage(text);
      this.messageText = '';
    }
  }

  toggleAudio(): void {
    this.isAudioEnabled = !this.isAudioEnabled;
    this.peerService.toggleAudio(this.isAudioEnabled);
  }

  toggleVideo(): void {
    this.isVideoEnabled = !this.isVideoEnabled;
    this.peerService.toggleVideo(this.isVideoEnabled);
  }

  nextStranger(): void {
    this.findStranger();
  }

  endChat(): void {
    this.peerService.destroy();
    this.matchingService.leaveLobby();
    this.router.navigate(['/']);
  }

  private scrollChat(): void {
    if (this.chatContainer?.nativeElement) {
      this.chatContainer.nativeElement.scrollTop = this.chatContainer.nativeElement.scrollHeight;
    }
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    this.peerService.destroy();
    this.matchingService.leaveLobby();
  }
}
