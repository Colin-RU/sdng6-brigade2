# Brigade API v1

The UI displays only product content. This document is for implementation and verification.

ES module entry: `handleApi(request, env, ctx, {sendPush} = {})` from `worker/api/index.mjs`. Returns `Response` for `/api/v1` and descendants; returns `null` for other paths. Root Worker serves static assets separately. Storage interface: `DB` and `BUCKET`. Production uses Supabase PostgreSQL/private Storage through server-only adapters; D1/R2 remain supported for local testing/fallback. The Supabase Edge entry rewrites `/functions/v1/brigade-api/<route>` into `/api/v1/<route>`; frontend base is `https://ufwrdwndlzwxtlkougrv.supabase.co/functions/v1/brigade-api`. Deploy with gateway JWT verification disabled, because the app checks its own opaque bearer sessions. SUPABASE_SERVICE_ROLE_KEY is an automatic Edge secret, never passed to the browser. Root owns push encryption/delivery.

All responses have `Cache-Control: no-store`. All shared reads/writes require `Authorization: Bearer <token>`. Health, registration and login are the only unauthenticated routes. Same-origin HTTPS clients may also use the optional HttpOnly/Secure/SameSite=Strict cookie. Cross-origin app clients use bearer tokens. Allowed origins: same origin, `https://colin-ru.github.io`, `https://appassets.androidplatform.net`, HTTP(S) loopback development. Others return 403. CORS is exact-origin, never `*`.

Success JSON is described below. Errors: `{error:{code,message,details?}}`, HTTP 400/401/403/404/409/413/415/429/500/503. No SQL errors or credential data reach the client. 429 includes Retry-After. Dates are ISO UTC. IDs are opaque strings. Text is plain text and must be rendered with textContent. Job position is descriptive and grants no administrative rights.

## Identity and profiles

- `GET /api/v1/health` → `{ok:true}` (no data or diagnostics).
- `POST /auth/register` body `{login,password,nickname,position,grade?,remember?}` → `{user,token,expiresAt}`. Login is lowercase, 3–40 ASCII letters/digits/`._-` and begins with a letter/digit. Nickname 2–60 characters. Password 10–128 characters, maximum 512 UTF-8 bytes. Position `operator|master`; grade `3|4|5|6|null`.
- `POST /auth/login` body `{login,password,remember?}` → same envelope. `remember` defaults true; true expires in 30 days, false in 24 hours. Password must never be saved by the client. Store bearer in localStorage for remember=true or sessionStorage for false.
- `POST /auth/logout` → `{ok:true}`; revokes this session on server.
- `GET /me`, `PATCH /me` → `{user}`. Patch permits `{nickname?,position?,grade?,avatarMediaId?:id|null}`; avatar must belong to the caller.
- `GET /profiles?after=<profile-id>&limit=100` → `{items:[user],nextCursor:null|string}` (authenticated only; max100).

`user = {id,login,nickname,position,grade,avatarMediaId,createdAt,updatedAt}`. Passwords use PBKDF2-SHA256, 100000 iterations, random 128-bit salt and 256-bit derived hash, with parameters embedded in the stored string. This is the hosted Workers PBKDF2 ceiling; verification never lowers it. Sessions use random 256-bit tokens; DB stores SHA-256 only, expiry/revocation; at most ten sessions per user. Registration: 30/hour/IP to allow a brigade on shared Wi-Fi/CGNAT. Login: 20/15min/IP and 10/15min/login, including failed attempts. All authenticated writes: 120/min/user. Rate keys are hashed and expired rows are pruned in bounded batches.

## Media

- `POST /media`: multipart/form-data, exactly one `file`, optional `clientId` (same rules as messages). JPEG/PNG/WebP, <=2097152 bytes, declared MIME must match magic bytes. → HTTP201 `{media:{id,mimeType,size,createdAt}}`; same clientId and content retry → HTTP200 same media with `duplicate:true`; changed content409. Upload limit20/hour/user. R2 keys and original filenames are not exposed.
- `GET /media/:id`: authenticated image body, no cache. Use authenticated fetch → Blob URL in the UI; no bearer in query strings.
- `DELETE /media/:id`: authenticated owner only, removes unreferenced media metadata and the private storage object → `{ok:true}`. Another owner403; missing404; any live chat/note attachment or profile avatar reference409 `media_in_use`. Detach/delete the referencing records first. Storage failure restores metadata so the owner can retry. No public storage URL or service credential is exposed.

All brigade users may view shared images after authentication. Only their uploader can attach media to a new message/note/avatar. Up to three distinct media IDs per message. The frontend resizes phone images before upload. No image processing credentials or public bucket are needed.

## Chat and object notes

- `GET /chat/messages?before=<cursor>|after=<cursor>&limit=50` → `{items,nextCursor}`.
- `POST /chat/messages` body `{clientId,body?,mediaIds?:[]}` → HTTP201 `{item,duplicate:false}`; exact retry → HTTP200 `{item,duplicate:true}`. A reused clientId with changed content returns409. clientId 8–80 ASCII letters/digits/`_-` (UUID works). body <=4000 characters, text or media required.
- `PATCH /chat/messages/:id` body `{body?,mediaIds?,revision?}` → `{item}`; `DELETE` → `{ok:true}`; owner only.
- `GET /objects/:encodedKey/notes`: same paging envelope.
- `GET /notes/:id` → `{item}` for direct links to older notes/replies, authenticated. `GET /chat/messages/:id` is also supported.
- `POST /objects/:encodedKey/notes`: same creation body plus `parentId?:noteId|null`. Parent must belong to the same object. Reply creates one persisted notification for parent author, excluding self-replies.
- `PATCH /notes/:id` body `{body?,mediaIds?,revision?}` → `{item}`. `DELETE /notes/:id` → `{ok:true}`. Owner only, independent of position. If revision is supplied, stale edits return409.

`item = {id,cursor,clientId,body,author,media:[],createdAt,updatedAt,revision,objectKey?,parentId?}`. `author = {id,login,nickname,position,grade,avatarMediaId}`. `media[]` entries use the media envelope fields above. Items are always oldest→newest within each page. Default page is latest50. `before` selects older records; `after` selects newer. `nextCursor` is the appropriate boundary only if another page exists. Each item.cursor is usable for polling newer messages with after.

Object keys, URI encoded as one path segment: `pad:<pad>`, `well:<pad>:<wellId>`, `equipment:<pad>:<kind>`. Pad/well combinations must exist in the imported registry. Equipment kinds: `agzu`, `btma`, `bg`, `drainage`, `control-stations`, `cable-racks`. Accepting an equipment key does not assert it physically exists. Default object status is unknown; no equipment/status data are fabricated.

For pads with multiple confirmed positions, equipment keys are `equipment:<pad>:p1:<kind>` and `equipment:<pad>:p2:<kind>`; only positions in the generated registry are accepted. Legacy three-part keys on such a pad canonicalize to p1. On a single-position pad, p1 canonicalizes to the legacy three-part key. Notes, media attachments, statuses and notifications preserve the canonical position key; a reply parent from another position is rejected.

## Samples, statuses and shifts

- `GET /samples?padId=<optional-pad>` → `{items:[{padId,sampled,revision,updatedAt,author,note}]}`. All32 pads when omitted. Missing state is `{sampled:false,revision:0,updatedAt:null,author:null,note:''}` (no recorded mark).
- `PUT /samples/:pad` body `{sampled:boolean,revision:number,note?:string}` → `{item}`. note<=1000. Optimistic revision is mandatory; first revision0. On stale revision409 includes `error.details.current`. Every successful change creates a sample audit row atomically.
- `GET /objects/:encodedKey/status` → `{status,revision,updatedAt,author,note}`. Missing state: unknown/revision0/null author and time.
- `PUT /objects/:encodedKey/status` body `{status:'unknown'|'ok'|'attention'|'stopped',revision,note?}` → status envelope. Same revision/audit rules as samples.
- `GET /shifts?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{items,nextCursor:null}`, max93-day range and1000 results. `POST /shifts` body `{date,kind:'day'|'night',note?,startAt?,endAt?}` → `{item}` (one record per user/date/kind; repeat updates note/times). Exact ISO times require explicit timezone, both values, end>start and duration<=36h. Start's UTC+05 local date must match date. note<=500. `DELETE /shifts/:id` owner only → `{ok:true}`.

Shift item: `{id,date,kind,startAt,endAt,note,author,createdAt}`. Without exact times, startAt/endAt are null and the entry is a calendar plan, never live presence. Shared calendar means saved shift declarations; it does not claim live GPS presence.

## Notifications and push

- `GET /notifications?before=<cursor>|after=<cursor>&unread=1&limit=50` → `{items,nextCursor}`, chronological paging as chat. Always scoped to caller.
- `GET /notifications/unread-count` → `{count}`.
- `GET /notifications/:id` → `{item}`, recipient only, for native notification taps even outside the latest page.
- `POST /notifications/:id/read`, `POST /notifications/read-all` → `{ok:true}`; only recipient can mark read.
- `GET /push/public-key` → `{publicKey:string|null}`. Null means push not configured; persisted notification list still works.
- `POST /push/subscriptions` standard body `{endpoint,keys:{p256dh,auth},expirationTime?}` → `{ok:true}`. HTTPS endpoints restricted to browser push providers. At most ten per user; another account cannot overwrite an existing subscription.
- `DELETE /push/subscriptions` body `{endpoint}` → `{ok:true}`, owner scoped.

Notification: `{id,cursor,actor:{id,nickname,avatarId,avatarMediaId},type:'comment',objectKey,objectLabel,noteId,parentId,preview,createdAt,readAt}`. Note and notification writes are atomic. Idempotent retries do not duplicate notifications or push. Root hook `sendPush(env,[recipientId],payload)` runs with ctx.waitUntil after persistence; provider failure never removes persisted notifications. Public key is safe to expose; VAPID private key stays in runtime secrets, never the client/repository.

Schema changes live in db/schema.ts, generated SQLite QA migrations under qa/sqlite-migrations (production uses supabase/migrations). Request handlers never create tables or seed field data. `worker/registry.mjs` is generated from existing dist/data.json without changing source records.

Production migrations are `supabase/migrations/202611130001_brigade.sql` and `202611130002_api_rpc.sql`: private schema brigade, RLS enabled with no client policies and no anon/authenticated grants. Only service_role can execute `public.brigade_query_batch`. Adapter sends fixed server statements and JSON scalar parameters; PostgreSQL quote_literal binds each literal without scanning its contents as SQL, and each batch is one transaction. This RPC is never called with a user's SQL. Private Storage bucket: brigade-media. Root provisions it with public=false, file size<=2097152 and allowed MIME image/jpeg,image/png,image/webp. VAPID runtime row `brigade.app_secrets` key webpush_vapid has shape `{publicKey,privateJwk,subject}`; Edge caches for60s. This row is absent from migrations and all product endpoints. Root supplies it directly server-side.

Edge wrapper supplies requestIp to the API's rate limiter, preferring canonical CF-Connecting-IP and otherwise the last X-Forwarded-For hop; raw first-hop forwarding headers are not trusted. API module alone falls back to local when no platform IP exists. Hosted gateway behavior should be verified in deployment smoke tests; no IP is returned in product responses.
