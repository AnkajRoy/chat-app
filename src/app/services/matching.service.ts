import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { environment } from '../../environments/environment';

// Firebase imports
import { initializeApp, FirebaseApp } from 'firebase/app';
import {
  getDatabase,
  ref,
  set,
  onValue,
  remove,
  get,
  onDisconnect,
  Database
} from 'firebase/database';

// Gun.js imports
import Gun from 'gun/gun';
import 'gun/sea';

@Injectable({ providedIn: 'root' })
export class MatchingService {
  private myPeerId = '';
  matched$ = new Subject<{ peerId: string; isInitiator: boolean }>();
  noStrangersAvailable$ = new Subject<void>();

  // Track recently matched peers to avoid re-matching
  private recentPeers: Set<string> = new Set();

  // Firebase properties
  private db!: Database;
  private firebaseApp!: FirebaseApp;

  // Gun.js properties
  private gun: any;
  private matchListener: any = null;

  // Flag from environment
  private useFirebase = environment.useFirebase;

  init(): void {
    if (this.useFirebase) {
      this.initFirebase();
    } else {
      this.initGun();
    }
  }

  // ======================== FIREBASE ========================

  private initFirebase(): void {
    this.firebaseApp = initializeApp(environment.firebase);
    this.db = getDatabase(this.firebaseApp);
  }

  private async joinLobbyFirebase(peerId: string): Promise<void> {
    const waitingRef = ref(this.db, `waiting/${peerId}`);

    const waitingSnapshot = await get(ref(this.db, 'waiting'));
    const waitingUsers = waitingSnapshot.val() || {};
    // Filter out ourselves AND recently matched peers
    const availableUsers = Object.keys(waitingUsers)
      .filter(id => id !== peerId && !this.recentPeers.has(id));

    if (availableUsers.length > 0) {
      const randomIndex = Math.floor(Math.random() * availableUsers.length);
      const matchedPeerId = availableUsers[randomIndex];

      // Track this peer so we don't re-match
      this.recentPeers.add(matchedPeerId);

      await remove(ref(this.db, `waiting/${matchedPeerId}`));
      await set(ref(this.db, `matches/${matchedPeerId}`), peerId);

      // We found them — we are the initiator (caller)
      this.matched$.next({ peerId: matchedPeerId, isInitiator: true });
    } else {
      // No new strangers available — add to waiting pool
      await set(waitingRef, true);
      onDisconnect(waitingRef).remove();

      // Notify UI that no one new is available right now
      const allWaiting = Object.keys(waitingUsers).filter(id => id !== peerId);
      if (allWaiting.length > 0 && availableUsers.length === 0) {
        this.noStrangersAvailable$.next();
      }

      const matchRef = ref(this.db, `matches/${peerId}`);
      onValue(matchRef, async (snapshot) => {
        const matchedPeerId = snapshot.val();
        if (matchedPeerId) {
          this.recentPeers.add(matchedPeerId);
          await remove(matchRef);
          await remove(waitingRef);
          // They found us — we are the receiver (wait for incoming call)
          this.matched$.next({ peerId: matchedPeerId, isInitiator: false });
        }
      });
    }
  }

  private async leaveLobbyFirebase(): Promise<void> {
    await remove(ref(this.db, `waiting/${this.myPeerId}`)).catch(() => {});
    await remove(ref(this.db, `matches/${this.myPeerId}`)).catch(() => {});
  }

  // ======================== GUN.JS ========================

  private initGun(): void {
    this.gun = Gun({
      peers: environment.gunPeers
    });
  }

  private async joinLobbyGun(peerId: string): Promise<void> {
    const lobby = this.gun.get('strangerchat-lobby');

    lobby.once((data: any) => {
      if (!data) {
        this.addToWaitingAndListen(lobby, peerId);
        return;
      }

      const availableUsers = Object.keys(data)
        .filter(key => key !== '_' && key !== peerId && data[key] && data[key] !== 'matched' && !this.recentPeers.has(key));

      if (availableUsers.length > 0) {
        const randomIndex = Math.floor(Math.random() * availableUsers.length);
        const matchedPeerId = availableUsers[randomIndex];

        this.recentPeers.add(matchedPeerId);
        lobby.get(matchedPeerId).put('matched');
        this.gun.get('strangerchat-matches').get(matchedPeerId).put(peerId);
        lobby.get(peerId).put(null);

        this.matched$.next({ peerId: matchedPeerId, isInitiator: true });
      } else {
        this.addToWaitingAndListen(lobby, peerId);
      }
    });
  }

  private addToWaitingAndListen(lobby: any, peerId: string): void {
    lobby.get(peerId).put(peerId);

    this.matchListener = this.gun.get('strangerchat-matches').get(peerId).on((matchedPeerId: string) => {
      if (matchedPeerId && matchedPeerId !== 'null' && !this.recentPeers.has(matchedPeerId)) {
        this.recentPeers.add(matchedPeerId);
        this.gun.get('strangerchat-matches').get(peerId).put(null);
        lobby.get(peerId).put(null);

        if (this.matchListener) {
          this.gun.get('strangerchat-matches').get(peerId).off();
          this.matchListener = null;
        }

        this.matched$.next({ peerId: matchedPeerId, isInitiator: false });
      }
    });
  }

  private async leaveLobbyGun(): Promise<void> {
    const lobby = this.gun.get('strangerchat-lobby');
    lobby.get(this.myPeerId).put(null);
    this.gun.get('strangerchat-matches').get(this.myPeerId).put(null);

    if (this.matchListener) {
      this.gun.get('strangerchat-matches').get(this.myPeerId).off();
      this.matchListener = null;
    }
  }

  // ======================== PUBLIC API ========================

  async joinLobby(peerId: string): Promise<void> {
    this.myPeerId = peerId;

    if (this.useFirebase) {
      await this.joinLobbyFirebase(peerId);
    } else {
      await this.joinLobbyGun(peerId);
    }
  }

  async leaveLobby(): Promise<void> {
    if (!this.myPeerId) return;

    if (this.useFirebase) {
      await this.leaveLobbyFirebase();
    } else {
      await this.leaveLobbyGun();
    }
  }
}
