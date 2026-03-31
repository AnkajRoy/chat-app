import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
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
  activeUsers$ = new BehaviorSubject<number>(0);

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
    this.cleanupFirebaseListener();

    const waitingRef = ref(this.db, `waiting/${peerId}`);
    const waitingRootRef = ref(this.db, 'waiting');
    const matchRef = ref(this.db, `matches/${peerId}`);

    let matched = false;

    // Step 1: Add self to waiting pool immediately
    await set(waitingRef, true);
    onDisconnect(waitingRef).remove();

    // Step 2: Listen for incoming match (the other user picked us)
    onValue(matchRef, async (snapshot) => {
      const matchedPeerId = snapshot.val();
      if (matchedPeerId && !matched) {
        matched = true;
        this.recentPeers.add(matchedPeerId);
        this.cleanupFirebaseListener();
        await remove(matchRef);
        await remove(waitingRef);
        this.matched$.next({ peerId: matchedPeerId, isInitiator: false });
      }
    });

    // Step 3: Watch waiting pool reactively — when someone else appears, match
    onValue(waitingRootRef, async (snapshot) => {
      if (matched) return;

      const data = snapshot.val() || {};
      const allOthers = Object.keys(data).filter(id => id !== peerId);
      let available = allOthers.filter(id => !this.recentPeers.has(id));

      if (available.length === 0 && allOthers.length > 0) {
        this.recentPeers.clear();
        available = allOthers;
      }

      if (available.length > 0) {
        const matchedPeerId = available[Math.floor(Math.random() * available.length)];

        // Deterministic: only the peer with the smaller ID initiates
        // This prevents both sides from trying to match simultaneously
        if (peerId < matchedPeerId) {
          matched = true;
          this.recentPeers.add(matchedPeerId);
          this.cleanupFirebaseListener();
          await remove(ref(this.db, `waiting/${matchedPeerId}`));
          await remove(waitingRef);
          await set(ref(this.db, `matches/${matchedPeerId}`), peerId);
          this.matched$.next({ peerId: matchedPeerId, isInitiator: true });
        }
        // If our ID is larger, we wait — the other side will initiate
      }
    });

    this.firebaseMatchUnsub = () => {
      off(matchRef);
      off(waitingRootRef);
    };
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
    if (this.matchListener) {
      this.gun.get('strangerchat-matches').get(peerId).off();
      this.matchListener = null;
    }

    const lobby = this.gun.get('strangerchat-lobby');
    let matched = false;

    // Add self to lobby
    lobby.get(peerId).put(peerId);

    // Listen for incoming match
    this.matchListener = this.gun.get('strangerchat-matches').get(peerId).on((matchedPeerId: string) => {
      if (matchedPeerId && matchedPeerId !== 'null' && !matched) {
        matched = true;
        this.recentPeers.add(matchedPeerId);
        this.gun.get('strangerchat-matches').get(peerId).put(null);
        lobby.get(peerId).put(null);
        this.gun.get('strangerchat-matches').get(peerId).off();
        this.matchListener = null;
        this.matched$.next({ peerId: matchedPeerId, isInitiator: false });
      }
    });

    // Watch lobby reactively
    lobby.on((data: any) => {
      if (matched || !data) return;

      const allOthers = Object.keys(data)
        .filter(key => key !== '_' && key !== peerId && data[key] && data[key] !== 'matched' && data[key] !== 'null');
      let available = allOthers.filter(key => !this.recentPeers.has(key));

      if (available.length === 0 && allOthers.length > 0) {
        this.recentPeers.clear();
        available = allOthers;
      }

      if (available.length > 0) {
        const matchedPeerId = available[Math.floor(Math.random() * available.length)];

        if (peerId < matchedPeerId) {
          matched = true;
          this.recentPeers.add(matchedPeerId);
          lobby.get(matchedPeerId).put('matched');
          this.gun.get('strangerchat-matches').get(matchedPeerId).put(peerId);
          lobby.get(peerId).put(null);
          if (this.matchListener) {
            this.gun.get('strangerchat-matches').get(peerId).off();
            this.matchListener = null;
          }
          lobby.off();
          this.matched$.next({ peerId: matchedPeerId, isInitiator: true });
        }
      }
    });
  }

  private async leaveLobbyGun(): Promise<void> {
    const lobby = this.gun.get('strangerchat-lobby');
    lobby.get(this.myPeerId).put(null);
    lobby.off();
    this.gun.get('strangerchat-matches').get(this.myPeerId).put(null);

    if (this.matchListener) {
      this.gun.get('strangerchat-matches').get(this.myPeerId).off();
      this.matchListener = null;
    }
  }

  // ======================== PRESENCE ========================

  trackPresence(peerId: string): void {
    if (this.useFirebase) {
      const onlineRef = ref(this.db, `online/${peerId}`);
      set(onlineRef, true);
      onDisconnect(onlineRef).remove();

      // Listen for live count
      const onlineRootRef = ref(this.db, 'online');
      onValue(onlineRootRef, (snapshot) => {
        const data = snapshot.val();
        this.activeUsers$.next(data ? Object.keys(data).length : 0);
      });
    } else {
      const presence = this.gun.get('strangerchat-online');
      presence.get(peerId).put(true);
      presence.on((data: any) => {
        if (!data) { this.activeUsers$.next(0); return; }
        const count = Object.keys(data).filter(k => k !== '_' && data[k]).length;
        this.activeUsers$.next(count);
      });
    }
  }

  removePresence(): void {
    if (!this.myPeerId) return;
    if (this.useFirebase) {
      remove(ref(this.db, `online/${this.myPeerId}`)).catch(() => {});
    } else {
      this.gun.get('strangerchat-online').get(this.myPeerId).put(null);
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
