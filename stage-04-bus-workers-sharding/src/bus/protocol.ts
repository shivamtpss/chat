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
  | { type: 'accepted'; clientMsgId: string } // gateway accepted + queued to bus
  | {
      type: 'ack';
      clientMsgId: string;
      messageId: string;
      seq: string;
      createdAt: string;
      deduped: boolean;
    } // worker persisted it durably
  | {
      type: 'message';
      message: {
        id: string;
        conversationId: string;
        senderId: string;
        seq: string;
        body: string;
        createdAt: string;
      };
      viaServer: string;
    }
  | {
      type: 'history';
      conversationId: string;
      messages: Array<{ id: string; senderId: string; seq: string; body: string; createdAt: string }>;
      nextBeforeId: string | null;
    }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };

/** Payload we put on the durable bus for the workers to process. */
export interface BusJob {
  conversationId: string;
  senderId: string;
  clientMsgId: string;
  body: string;
  /** the gateway that accepted it, so the ack can be routed back to the sender */
  originServer: string;
}
