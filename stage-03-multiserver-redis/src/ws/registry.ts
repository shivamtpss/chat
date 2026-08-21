import type { WebSocket } from 'ws';
import type { ServerMessage } from './protocol.js';

/**
 * Sockets held by THIS process only.
 *
 * In Stage 00 this Map was the whole story ("who is online"). In Stage 03 it is
 * only half the story: it knows the users connected to THIS server. To find a
 * user on ANOTHER server we consult Redis (see routing.ts). A user id can map
 * to multiple sockets (multi-tab / multi-device).
 */
class LocalRegistry {
  private readonly byUser = new Map<string, Set<WebSocket>>();

  add(userId: string, ws: WebSocket): void {
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    set.add(ws);
  }

  remove(userId: string, ws: WebSocket): boolean {
    const set = this.byUser.get(userId);
    if (!set) return false;
    set.delete(ws);
    if (set.size === 0) {
      this.byUser.delete(userId);
      return true; // user has no more sockets on this server
    }
    return false;
  }

  has(userId: string): boolean {
    return this.byUser.has(userId);
  }

  deliverLocal(userId: string, msg: ServerMessage): boolean {
    const set = this.byUser.get(userId);
    if (!set || set.size === 0) return false;
    const payload = JSON.stringify(msg);
    let delivered = false;
    for (const ws of set) {
      if (ws.readyState === 1) {
        ws.send(payload);
        delivered = true;
      }
    }
    return delivered;
  }

  localUserCount(): number {
    return this.byUser.size;
  }
}

export const local = new LocalRegistry();
