import { ulid } from 'ulid';
import { query, withTransaction } from './pool.js';

/** Domain types kept small and explicit. */
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
  body: string;
  created_at: string;
}

/** Create a user if the username is free; otherwise return the existing one. */
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

export async function getUserById(id: string): Promise<User | null> {
  const { rows } = await query<User>(
    `SELECT id, username, display_name, created_at FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Get (or create) the single canonical 1:1 conversation for two users.
 * The direct_key is the two user ids sorted and joined, so order does not
 * matter and duplicates are impossible (enforced by the UNIQUE constraint).
 */
export async function getOrCreateDirectConversation(
  userA: string,
  userB: string,
): Promise<string> {
  const directKey = [userA, userB].sort().join(':');
  return withTransaction(async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM conversations WHERE direct_key = $1`,
      [directKey],
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const convId = ulid();
    await client.query(
      `INSERT INTO conversations (id, type, direct_key) VALUES ($1, 'direct', $2)`,
      [convId, directKey],
    );
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [convId, userA, userB],
    );
    return convId;
  });
}

/** Is a user a member of a conversation? Used for authorization on every action. */
export async function isMember(conversationId: string, userId: string): Promise<boolean> {
  const { rows } = await query<{ one: number }>(
    `SELECT 1 AS one FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  return rows.length > 0;
}

/** The recipients of a message in a conversation (everyone except the sender). */
export async function memberIdsExcept(
  conversationId: string,
  exceptUserId: string,
): Promise<string[]> {
  const { rows } = await query<{ user_id: string }>(
    `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2`,
    [conversationId, exceptUserId],
  );
  return rows.map((r) => r.user_id);
}

/**
 * Persist a message. Idempotent on (conversation_id, client_msg_id): if the
 * client retries the same send, we return the already-stored row instead of
 * creating a duplicate. This is the "no duplicate messages" guarantee, built
 * in from Stage 00.
 */
export async function insertMessage(input: {
  conversationId: string;
  senderId: string;
  clientMsgId: string;
  body: string;
}): Promise<{ message: Message; deduped: boolean }> {
  const id = ulid();
  const { rows } = await query<Message>(
    `INSERT INTO messages (id, conversation_id, sender_id, client_msg_id, body)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (conversation_id, client_msg_id) DO NOTHING
     RETURNING id, conversation_id, sender_id, client_msg_id, body, created_at`,
    [id, input.conversationId, input.senderId, input.clientMsgId, input.body],
  );

  if (rows[0]) return { message: rows[0], deduped: false };

  // Conflict: fetch the existing message for this idempotency key.
  const existing = await query<Message>(
    `SELECT id, conversation_id, sender_id, client_msg_id, body, created_at
     FROM messages WHERE conversation_id = $1 AND client_msg_id = $2`,
    [input.conversationId, input.clientMsgId],
  );
  return { message: existing.rows[0]!, deduped: true };
}

/**
 * KEYSET (a.k.a. cursor) pagination.
 *
 * This is the important best practice for your question about pagination.
 * We fetch the newest `limit` messages, or the newest `limit` OLDER than a
 * given cursor id. Because ids are ULIDs (sortable) and we have the index
 * (conversation_id, id DESC), this is a direct index jump + short read,
 * regardless of how deep into history you scroll.
 *
 * Contrast with OFFSET pagination (page 500 => OFFSET 25000): the database
 * must still walk and discard 25,000 rows every time. Keyset never does that.
 */
export async function getMessagesPage(params: {
  conversationId: string;
  limit: number;
  beforeId?: string | undefined; // exclusive cursor: return messages older than this id
}): Promise<Message[]> {
  const { conversationId, limit, beforeId } = params;
  if (beforeId) {
    const { rows } = await query<Message>(
      `SELECT id, conversation_id, sender_id, client_msg_id, body, created_at
       FROM messages
       WHERE conversation_id = $1 AND id < $2
       ORDER BY id DESC
       LIMIT $3`,
      [conversationId, beforeId, limit],
    );
    return rows;
  }
  const { rows } = await query<Message>(
    `SELECT id, conversation_id, sender_id, client_msg_id, body, created_at
     FROM messages
     WHERE conversation_id = $1
     ORDER BY id DESC
     LIMIT $2`,
    [conversationId, limit],
  );
  return rows;
}
