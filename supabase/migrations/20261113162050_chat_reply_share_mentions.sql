-- New optional context only; existing messages and permissions are preserved.
ALTER TABLE brigade.chat_messages ADD COLUMN reply_to_id text;
ALTER TABLE brigade.chat_messages ADD COLUMN shared_pad_id text;
ALTER TABLE brigade.chat_messages ADD COLUMN mentioned_user_ids text;
