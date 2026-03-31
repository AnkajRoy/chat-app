import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { initializeApp } from 'firebase/app';
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
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class MatchingService {
  private db!: Database;
  private myPeerId = '';
  matched$ = new Subject<string>();

  init(): void {
    const app = initializeApp(environment.firebase);
    this.db = getDatabase(app);
  }

  async joinLobby(peerId: string): Promise<void> {
    this.myPeerId = peerId;
    const waitingRef = ref(this.db, `waiting/${peerId}`);

    // First check if someone is already waiting
    const waitingSnapshot = await get(ref(this.db, 'waiting'));
    const waitingUsers = waitingSnapshot.val() || {};
    const availableUsers = Object.keys(waitingUsers).filter(id => id !== peerId);

    if (availableUsers.length > 0) {
      // Match with a random waiting user
      const randomIndex = Math.floor(Math.random() * availableUsers.length);
      const matchedPeerId = availableUsers[randomIndex];

      // Remove matched user from waiting
      await remove(ref(this.db, `waiting/${matchedPeerId}`));

      // Create a match entry so the other user knows
      await set(ref(this.db, `matches/${matchedPeerId}`), peerId);

      this.matched$.next(matchedPeerId);
    } else {
      // No one waiting, add ourselves to waiting pool
      await set(waitingRef, true);
      onDisconnect(waitingRef).remove();

      // Listen for someone matching with us
      const matchRef = ref(this.db, `matches/${peerId}`);
      onValue(matchRef, async (snapshot) => {
        const matchedPeerId = snapshot.val();
        if (matchedPeerId) {
          await remove(matchRef);
          await remove(waitingRef);
          this.matched$.next(matchedPeerId);
        }
      });
    }
  }

  async leaveLobby(): Promise<void> {
    if (this.myPeerId) {
      await remove(ref(this.db, `waiting/${this.myPeerId}`)).catch(() => {});
      await remove(ref(this.db, `matches/${this.myPeerId}`)).catch(() => {});
    }
  }
}
