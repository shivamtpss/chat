import { z } from 'zod';

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

export const clientMessage = z.discriminatedUnion('type', [clientSend, clientHistory, clientPing]);
export type ClientMessage = z.infer<typeof clientMessage>;

export type ServerMessage =
  | { type: 'ready'; userId: string; server: string }
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
      viaServer: string; // which server delivered it (teaching aid: shows cross-server hops)
    }
  | {
      type: 'history';
      conversationId: string;
      messages: Array<{ id: string; senderId: string; body: string; createdAt: string }>;
      nextBeforeId: string | null;
    }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };

/**
 * The envelope we publish on Redis pub/sub to hand a message from the server
 * that received it to the server that holds the recipient's socket.
 */
export interface DeliveryEnvelope {
  targetUserId: string;
  fromServer: string;
  message: {
    id: string;
    conversationId: string;
    senderId: string;
    body: string;
    createdAt: string;
  };
}
