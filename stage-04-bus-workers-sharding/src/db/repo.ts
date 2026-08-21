import { ulid } from 'ulid';
import { query, withTransaction } from './pool.js';

export interface User {
  id: string;
  username: string;
  display_name: string;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_msg_id: string;
  seq: string; // bigint comes back as string from pg
  body: string;
  created_at: string;
}

export async function upsertUser(username: string, displayName: string): Promise<User> {
  const { rows } = await query<User>(
    `INSERT INTO users (id, username, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id, username, display_name, created_at`,
    [ulid(), username, displayName],
  );
  return rows[0]!;
}

export async function getOrCreateDirectConversation(userA: string, userB: string): Promise<string> {
  const directKey = [userA, userB].sort().join(':');
  return withTransaction(async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM conversations WHERE direct_key = $1`,
      [directKey],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const convId = ulid();
    await client.query(`INSERT INTO conversations (id, type, direct_key) VALUES ($1,'direct',$2)`, [
      convId,
      directKey,
    ]);
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2),($1,$3)`,
      [convId, userA, userB],
    );
    return convId;
  });
}

export async function createGroup(title: string, memberIds: string[]): Promise<string> {
  return withTransaction(async (client) => {
    const convId = ulid();
    await client.query(`INSERT INTO conversations (id, type, title) VALUES ($1,'group',$2)`, [
      convId,
      title,
    ]);
    for (const uid of memberIds) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [convId, uid],
      );
    }
    return convId;
  });
}

export async function isMember(conversationId: string, userId: string): Promise<boolean> {
  const { rows } = await query<{ one: number }>(
    `SELECT 1 AS one FROM conversation_members WHERE conversation_id=$1 AND user_id=$2`,
    [conversationId, userId],
  );
  return rows.length > 0;
}

export async function memberIdsExcept(conversationId: string, exceptUserId: string): Promise<string[]> {
  const { rows } = await query<{ user_id: string }>(
    `SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND user_id<>$2`,
    [conversationId, exceptUserId],
  );
  return rows.map((r) => r.user_id);
}

/**
 * Persist a message with a per-conversation sequence number.
 *
 * Ordering rule: `seq` is assigned as (current max seq for this conversation)
 * + 1, computed inside a transaction that locks nothing but relies on the
 * unique (conversation_id, client_msg_id) index for idempotency. Because a
 * given conversation is always processed by ONE worker at a time (Redis Streams
 * consumer group hands each stream entry to a single consumer, and we key the
 * bus by conversation), seq stays monotonic per conversation.
 *
 * Idempotent: a retry with the same (conversation_id, client_msg_id) returns
 * the already-stored row instead of inserting a duplicate.
 */
export async function persistMessage(input: {
  conversationId: string;
  senderId: string;
  clientMsgId: string;
  body: string;
}): Promise<{ message: Message; deduped: boolean }> {
  return withTransaction(async (client) => {
    const dup = await client.query<Message>(
      `SELECT id, conversation_id, sender_id, client_msg_id, seq::text AS seq, body, created_at
       FROM messages WHERE conversation_id=$1 AND client_msg_id=$2`,
      [input.conversationId, input.clientMsgId],
    );
    if (dup.rows[0]) return { message: dup.rows[0], deduped: true };

    const seqRow = await client.query<{ next: string }>(
      `SELECT COALESCE(MAX(seq),0)+1 AS next FROM messages WHERE conversation_id=$1`,
      [input.conversationId],
    );
    const nextSeq = seqRow.rows[0]!.next;
    const id = ulid();
    const inserted = await client.query<Message>(
      `INSERT INTO messages (id, conversation_id, sender_id, client_msg_id, seq, body)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, conversation_id, sender_id, client_msg_id, seq::text AS seq, body, created_at`,
      [id, input.conversationId, input.senderId, input.clientMsgId, nextSeq, input.body],
    );
    return { message: inserted.rows[0]!, deduped: false };
  });
}

export async function getMessagesPage(params: {
  conversationId: string;
  limit: number;
  beforeId?: string | undefined;
}): Promise<Message[]> {
  const { conversationId, limit, beforeId } = params;
  if (beforeId) {
    const { rows } = await query<Message>(
      `SELECT id, conversation_id, sender_id, client_msg_id, seq::text AS seq, body, created_at
       FROM messages WHERE conversation_id=$1 AND id<$2
       ORDER BY id DESC LIMIT $3`,
      [conversationId, beforeId, limit],
    );
    return rows;
  }
  const { rows } = await query<Message>(
    `SELECT id, conversation_id, sender_id, client_msg_id, seq::text AS seq, body, created_at
     FROM messages WHERE conversation_id=$1
     ORDER BY id DESC LIMIT $2`,
    [conversationId, limit],
  );
  return rows;
}

/** Which physical partition holds a conversation (for the sharding demo). */
export async function partitionForConversation(conversationId: string): Promise<string> {
  const { rows } = await query<{ tableoid: string }>(
    `SELECT tableoid::regclass::text AS tableoid FROM messages WHERE conversation_id=$1 LIMIT 1`,
    [conversationId],
  );
  return rows[0]?.tableoid ?? '(no rows yet)';
}

export async function countByPartition(): Promise<Array<{ partition: string; count: string }>> {
  const { rows } = await query<{ partition: string; count: string }>(
    `SELECT tableoid::regclass::text AS partition, count(*)::text AS count
     FROM messages GROUP BY tableoid ORDER BY partition`,
  );
  return rows;
}
