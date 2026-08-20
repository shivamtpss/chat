import { z } from 'zod';

/**
 * Wire protocol for the WebSocket. Every inbound message is validated with zod
 * before we touch it. Never trust the network.
 */

export const clientSend = z.object({
  type: z.literal('send'),
  conversationId: z.string().min(1),
  clientMsgId: z.string().min(1).max(64),
  body: z.string().min(1).max(4000),
});

export const clientHistory = z.object({
  type: z.literal('history'),
  conversationId: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(50),
  beforeId: z.string().min(1).optional(),
});

export const clientPing = z.object({ type: z.literal('ping') });

export const clientMessage = z.discriminatedUnion('type', [
  clientSend,
  clientHistory,
  clientPing,
]);

export type ClientMessage = z.infer<typeof clientMessage>;

/** Server -> client events. */
export type ServerMessage =
  | { type: 'ready'; userId: string }
  | { type: 'ack'; clientMsgId: string; messageId: string; createdAt: string; deduped: boolean }
  | {
      type: 'message';
      message: {
        id: string;
        conversationId: string;
        senderId: string;
        body: string;
        createdAt: string;
      };
    }
  | {
      type: 'history';
      conversationId: string;
      messages: Array<{
        id: string;
        senderId: string;
        body: string;
        createdAt: string;
      }>;
      nextBeforeId: string | null; // cursor for the next older page, or null if no more
    }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };
