import type { WebSocket } from 'ws';
import type { ServerMessage } from './protocol.js';

/**
 * In-memory registry of connected users, for THIS single process.
 *
 * This is exactly the Stage 00 simplification: because there is only one
 * server, "who is online and how do I reach them" is just a Map in memory.
 * The moment we run a second server (Stage 03) this stops working, because a
 * user on server B is not in server A's Map, which is precisely what forces us
 * to introduce Redis for shared routing. We isolate that assumption here so the
 * upgrade later is contained to this one file.
 */
class ConnectionRegistry {
  private readonly byUser = new Map<string, Set<WebSocket>>();

  add(userId: string, ws: WebSocket): void {
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    set.add(ws);
  }

  remove(userId: string, ws: WebSocket): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.byUser.delete(userId);
  }

  /** Deliver to every live socket a user has open (multi-tab/multi-device). */
  deliver(userId: string, msg: ServerMessage): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    const payload = JSON.stringify(msg);
    for (const ws of set) {
      // readyState 1 === OPEN
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  onlineCount(): number {
    return this.byUser.size;
  }
}

export const connections = new ConnectionRegistry();
