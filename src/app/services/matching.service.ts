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
  off,
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

  // Firebase listener cleanup
  private firebaseMatchUnsub: (() => void) | null = null;

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
    // Clean up any previous Firebase match listener
    this.cleanupFirebaseListener();

    const waitingRef = ref(this.db, `waiting/${peerId}`);

    // Try to find a match, with retries to handle the race condition
    // when both users click "Next" at roughly the same time
    const maxRetries = 3;
    const retryDelay = 1500; // ms

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const waitingSnapshot = await get(ref(this.db, 'waiting'));
      const waitingUsers = waitingSnapshot.val() || {};
      const allOtherUsers = Object.keys(waitingUsers).filter(id => id !== peerId);
      let availableUsers = allOtherUsers.filter(id => !this.recentPeers.has(id));

      // If no new strangers but others exist, clear history and allow re-matching
      if (availableUsers.length === 0 && allOtherUsers.length > 0) {
        this.recentPeers.clear();
        availableUsers = allOtherUsers;
      }

      if (availableUsers.length > 0) {
        const randomIndex = Math.floor(Math.random() * availableUsers.length);
        const matchedPeerId = availableUsers[randomIndex];

        this.recentPeers.add(matchedPeerId);

        await remove(ref(this.db, `waiting/${matchedPeerId}`));
        await set(ref(this.db, `matches/${matchedPeerId}`), peerId);

        this.matched$.next({ peerId: matchedPeerId, isInitiator: true });
        return;
      }

      // No one found yet — wait briefly for the other user to re-join
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    // After retries, add self to waiting pool and listen for incoming match
    await set(waitingRef, true);
    onDisconnect(waitingRef).remove();

    const matchRef = ref(this.db, `matches/${peerId}`);
    const unsubscribe = onValue(matchRef, async (snapshot) => {
      const matchedPeerId = snapshot.val();
      if (matchedPeerId) {
        this.recentPeers.add(matchedPeerId);
        this.cleanupFirebaseListener();
        await remove(matchRef);
        await remove(waitingRef);
        this.matched$.next({ peerId: matchedPeerId, isInitiator: false });
      }
    });
    this.firebaseMatchUnsub = () => off(matchRef);
  }

  private cleanupFirebaseListener(): void {
    if (this.firebaseMatchUnsub) {
      this.firebaseMatchUnsub();
      this.firebaseMatchUnsub = null;
    }
  }

  private async leaveLobbyFirebase(): Promise<void> {
    this.cleanupFirebaseListener();
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

      const allOtherUsers = Object.keys(data)
        .filter(key => key !== '_' && key !== peerId && data[key] && data[key] !== 'matched');
      let availableUsers = allOtherUsers.filter(key => !this.recentPeers.has(key));

      // If no new strangers but others exist, clear history and allow re-matching
      if (availableUsers.length === 0 && allOtherUsers.length > 0) {
        this.recentPeers.clear();
        availableUsers = allOtherUsers;
      }

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
      if (matchedPeerId && matchedPeerId !== 'null') {
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
