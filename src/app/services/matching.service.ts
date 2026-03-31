import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { environment } from '../../environments/environment';

import { initializeApp, getApp, FirebaseApp } from 'firebase/app';
import {
  getDatabase,
  ref,
  set,
  get,
  onValue,
  off,
  remove,
  onDisconnect,
  Database
} from 'firebase/database';

@Injectable({ providedIn: 'root' })
export class MatchingService {
  private myPeerId = '';
  matched$ = new Subject<{ peerId: string; isInitiator: boolean }>();
  noStrangersAvailable$ = new Subject<void>();
  activeUsers$ = new BehaviorSubject<number>(0);

  db!: Database;
  private firebaseApp!: FirebaseApp;
  private matchUnsub: (() => void) | null = null;
  private pollTimer: any = null;
  private matched = false;

  init(): void {
    try {
      this.firebaseApp = getApp();
    } catch {
      this.firebaseApp = initializeApp(environment.firebase);
    }
    this.db = getDatabase(this.firebaseApp);
  }

  // ======================== MATCHING ========================

  async joinLobby(peerId: string): Promise<void> {
    this.myPeerId = peerId;
    this.matched = false;
    this.cleanup();

    const waitingRef = ref(this.db, `waiting/${peerId}`);
    const matchRef = ref(this.db, `matches/${peerId}`);

    // 1. Add self to waiting pool
    await set(waitingRef, true);
    onDisconnect(waitingRef).remove();

    // 2. Try to match RIGHT NOW using transaction
    await this.tryMatch(peerId);
    if (this.matched) return;

    // 3. Listen for incoming match (other peer matched with us)
    const matchHandler = onValue(matchRef, (snap) => {
      const matchedPeerId = snap.val();
      if (matchedPeerId && !this.matched) {
        this.matched = true;
        this.cleanup();
        remove(matchRef).catch(() => {});
        remove(waitingRef).catch(() => {});
        this.matched$.next({ peerId: matchedPeerId, isInitiator: false });
      }
    });

    // 4. Poll every 2 seconds — try to grab someone from waiting pool
    this.pollTimer = setInterval(() => {
      if (!this.matched) this.tryMatch(peerId);
    }, 2000);

    this.matchUnsub = () => off(matchRef);
  }

  private async tryMatch(peerId: string): Promise<void> {
    if (this.matched) return;

    try {
      const snapshot = await get(ref(this.db, 'waiting'));
      const data = snapshot.val() || {};
      const others = Object.keys(data).filter(id => id !== peerId);

      if (others.length === 0) return;

      const matchedPeerId = others[Math.floor(Math.random() * others.length)];

      // Only smaller ID initiates — prevents both sides matching simultaneously
      if (peerId < matchedPeerId) {
        this.matched = true;
        this.cleanup();
        // Remove both from waiting, notify the other peer
        await remove(ref(this.db, `waiting/${peerId}`));
        await remove(ref(this.db, `waiting/${matchedPeerId}`));
        await set(ref(this.db, `matches/${matchedPeerId}`), peerId);
        this.matched$.next({ peerId: matchedPeerId, isInitiator: true });
      }
    } catch {
      // Will retry on next poll
    }
  }

  async leaveLobby(): Promise<void> {
    if (!this.myPeerId) return;
    this.cleanup();
    await remove(ref(this.db, `waiting/${this.myPeerId}`)).catch(() => {});
    await remove(ref(this.db, `matches/${this.myPeerId}`)).catch(() => {});
  }

  private cleanup(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.matchUnsub) {
      this.matchUnsub();
      this.matchUnsub = null;
    }
  }

  // ======================== PRESENCE ========================

  trackPresence(peerId: string): void {
    this.myPeerId = peerId;
    const onlineRef = ref(this.db, `online/${peerId}`);
    set(onlineRef, true);
    onDisconnect(onlineRef).remove();

    const onlineRootRef = ref(this.db, 'online');
    onValue(onlineRootRef, (snapshot) => {
      const data = snapshot.val();
      this.activeUsers$.next(data ? Object.keys(data).length : 0);
    });
  }

  removePresence(): void {
    if (!this.myPeerId) return;
    remove(ref(this.db, `online/${this.myPeerId}`)).catch(() => {});
  }
}
