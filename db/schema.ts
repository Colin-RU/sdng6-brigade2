import {sql} from 'drizzle-orm';
import {sqliteTable,text,integer,index,uniqueIndex,primaryKey,check} from 'drizzle-orm/sqlite-core';

export const profiles=sqliteTable('profiles',{
  id:text('id').primaryKey(),login:text('login').notNull(),passwordHash:text('password_hash').notNull(),nickname:text('nickname').notNull(),position:text('position').notNull(),grade:integer('grade'),avatarMediaId:text('avatar_media_id'),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull()
},t=>[uniqueIndex('profiles_login_unique').on(t.login),check('profiles_position',sql`${t.position} IN ('operator','master')`),check('profiles_grade',sql`${t.grade} IS NULL OR ${t.grade} BETWEEN 3 AND 6`)]);
export const sessions=sqliteTable('sessions',{
  tokenHash:text('token_hash').primaryKey(),userId:text('user_id').notNull().references(()=>profiles.id,{onDelete:'cascade'}),createdAt:integer('created_at').notNull(),expiresAt:integer('expires_at').notNull(),revokedAt:integer('revoked_at')
},t=>[index('sessions_user_created').on(t.userId,t.createdAt),index('sessions_expiry').on(t.expiresAt)]);
export const rateLimits=sqliteTable('rate_limits',{key:text('key').primaryKey(),count:integer('count').notNull(),expiresAt:integer('expires_at').notNull()},t=>[index('rate_limits_expiry').on(t.expiresAt)]);
export const media=sqliteTable('media',{
  id:text('id').primaryKey(),ownerId:text('owner_id').notNull().references(()=>profiles.id),bucketKey:text('bucket_key').notNull(),mimeType:text('mime_type').notNull(),size:integer('size').notNull(),createdAt:integer('created_at').notNull(),clientId:text('client_id'),contentHash:text('content_hash').notNull()
},t=>[uniqueIndex('media_bucket_key_unique').on(t.bucketKey),uniqueIndex('media_owner_client').on(t.ownerId,t.clientId),index('media_owner').on(t.ownerId),check('media_size',sql`${t.size}>0 AND ${t.size}<=2097152`)]);
export const chatMessages=sqliteTable('chat_messages',{
  seq:integer('seq').primaryKey({autoIncrement:true}),id:text('id').notNull(),userId:text('user_id').notNull().references(()=>profiles.id),clientId:text('client_id').notNull(),body:text('body').notNull(),mediaIds:text('media_ids').notNull().default('[]'),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull(),revision:integer('revision').notNull().default(1),replyToId:text('reply_to_id'),sharedPadId:text('shared_pad_id'),mentionedUserIds:text('mentioned_user_ids')
},t=>[uniqueIndex('chat_messages_id_unique').on(t.id),uniqueIndex('chat_messages_user_client').on(t.userId,t.clientId)]);
export const chatReactions=sqliteTable('chat_reactions',{
  messageId:text('message_id').notNull().references(()=>chatMessages.id,{onDelete:'cascade'}),userId:text('user_id').notNull().references(()=>profiles.id,{onDelete:'cascade'}),emoji:text('emoji').notNull(),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull()
},t=>[primaryKey({columns:[t.messageId,t.userId]}),index('chat_reactions_message_emoji').on(t.messageId,t.emoji),check('chat_reactions_emoji',sql`${t.emoji} IN ('👍','❤️','🔥','👏','👀','✅')`)]);
export const objectNotes=sqliteTable('object_notes',{
  seq:integer('seq').primaryKey({autoIncrement:true}),id:text('id').notNull(),objectKey:text('object_key').notNull(),parentId:text('parent_id'),userId:text('user_id').notNull().references(()=>profiles.id),clientId:text('client_id').notNull(),body:text('body').notNull(),mediaIds:text('media_ids').notNull().default('[]'),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull(),revision:integer('revision').notNull().default(1)
},t=>[uniqueIndex('object_notes_id_unique').on(t.id),uniqueIndex('object_notes_user_client').on(t.userId,t.clientId),index('object_notes_object_seq').on(t.objectKey,t.seq),index('object_notes_parent').on(t.parentId)]);
export const samples=sqliteTable('samples',{
  padId:text('pad_id').primaryKey(),sampled:integer('sampled').notNull(),note:text('note').notNull().default(''),revision:integer('revision').notNull(),updatedAt:integer('updated_at').notNull(),updatedBy:text('updated_by').notNull().references(()=>profiles.id),mutationId:text('mutation_id').notNull(),wellIds:text('well_ids'),roundKey:text('round_key')
},t=>[check('samples_sampled',sql`${t.sampled} IN (0,1)`)]);
export const sampleAudit=sqliteTable('sample_audit',{
  id:text('id').primaryKey(),padId:text('pad_id').notNull(),sampled:integer('sampled').notNull(),note:text('note').notNull(),revision:integer('revision').notNull(),userId:text('user_id').notNull().references(()=>profiles.id),createdAt:integer('created_at').notNull(),wellIds:text('well_ids'),roundKey:text('round_key')
},t=>[index('sample_audit_pad_revision').on(t.padId,t.revision)]);
export const objectStatuses=sqliteTable('object_statuses',{
  objectKey:text('object_key').primaryKey(),status:text('status').notNull(),note:text('note').notNull().default(''),revision:integer('revision').notNull(),updatedAt:integer('updated_at').notNull(),updatedBy:text('updated_by').notNull().references(()=>profiles.id),mutationId:text('mutation_id').notNull()
},t=>[check('object_status_value',sql`${t.status} IN ('unknown','ok','attention','stopped') OR (${t.status}='absent' AND ${t.objectKey} LIKE 'equipment:%')`)]);
export const statusAudit=sqliteTable('status_audit',{
  id:text('id').primaryKey(),objectKey:text('object_key').notNull(),status:text('status').notNull(),note:text('note').notNull(),revision:integer('revision').notNull(),userId:text('user_id').notNull().references(()=>profiles.id),createdAt:integer('created_at').notNull()
},t=>[index('status_audit_object_revision').on(t.objectKey,t.revision)]);
export const shifts=sqliteTable('shifts',{
  id:text('id').primaryKey(),userId:text('user_id').notNull().references(()=>profiles.id),date:text('date').notNull(),kind:text('kind').notNull(),note:text('note').notNull().default(''),createdAt:integer('created_at').notNull(),startAt:integer('start_at'),endAt:integer('end_at')
},t=>[uniqueIndex('shifts_user_date_kind').on(t.userId,t.date,t.kind),index('shifts_date').on(t.date),check('shifts_kind',sql`${t.kind} IN ('day','night')`)]);
export const notifications=sqliteTable('notifications',{
  seq:integer('seq').primaryKey({autoIncrement:true}),id:text('id').notNull(),recipientId:text('recipient_id').notNull().references(()=>profiles.id),actorId:text('actor_id').references(()=>profiles.id),type:text('type').notNull(),objectKey:text('object_key').notNull(),objectLabel:text('object_label').notNull(),noteId:text('note_id'),parentId:text('parent_id'),preview:text('preview').notNull(),createdAt:integer('created_at').notNull(),readAt:integer('read_at'),roundKey:text('round_key')
},t=>[uniqueIndex('notifications_id_unique').on(t.id),uniqueIndex('notifications_recipient_note').on(t.recipientId,t.noteId),index('notifications_recipient_seq').on(t.recipientId,t.seq),index('notifications_recipient_read').on(t.recipientId,t.readAt),index('notifications_round_seq').on(t.roundKey,t.seq)]);
export const pushSubscriptions=sqliteTable('push_subscriptions',{
  id:text('id').primaryKey(),userId:text('user_id').notNull().references(()=>profiles.id),endpoint:text('endpoint').notNull(),p256dh:text('p256dh').notNull(),auth:text('auth').notNull(),createdAt:integer('created_at').notNull()
},t=>[uniqueIndex('push_subscriptions_endpoint_unique').on(t.endpoint),index('push_subscriptions_user').on(t.userId)]);
export const nativePushTokens=sqliteTable('native_push_tokens',{
  id:text('id').primaryKey(),installationHash:text('installation_hash').notNull(),secretHash:text('secret_hash').notNull(),userId:text('user_id').notNull().references(()=>profiles.id,{onDelete:'cascade'}),sessionHash:text('session_hash').notNull().references(()=>sessions.tokenHash,{onDelete:'cascade'}),tokenHash:text('token_hash').notNull(),token:text('token').notNull(),deviceSlot:integer('device_slot').notNull(),appVersion:text('app_version'),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull()
},t=>[uniqueIndex('native_push_installation_unique').on(t.installationHash),uniqueIndex('native_push_token_unique').on(t.tokenHash),uniqueIndex('native_push_user_slot_unique').on(t.userId,t.deviceSlot),index('native_push_session').on(t.sessionHash),check('native_push_slot',sql`${t.deviceSlot} BETWEEN 1 AND 10`)]);
export const sampleRoundEvents=sqliteTable('sample_round_events',{
  periodKey:text('period_key').primaryKey(),startsAt:integer('starts_at').notNull(),endsAt:integer('ends_at').notNull(),createdAt:integer('created_at').notNull(),mutationId:text('mutation_id').notNull(),leaseToken:text('lease_token'),leaseUntil:integer('lease_until').notNull().default(0),dispatchCursor:integer('dispatch_cursor').notNull().default(0),completedAt:integer('completed_at'),retryIds:text('retry_ids').notNull().default('[]')
});
