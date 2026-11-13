package ru.brigade2.atlas;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Credentials stay encrypted in private preferences; only a Keystore key can decrypt them. */
final class NativeNotifications {
    static final String CHANNEL = "brigade_replies_v1";
    static final String EXTRA_ID = "atlas_notification_id";
    private static final String PREFS = "atlas_notifications_v1", KEY = "atlas_notification_session_v1";
    private static final String PERIODIC = "atlas_notification_poll", IMMEDIATE = "atlas_notification_check";
    private static final Object LOCK = new Object();

    static final class Session {
        final String token, generation;
        final long createdAt;
        Session(String token, String generation, long createdAt) { this.token = token; this.generation = generation; this.createdAt = createdAt; }
    }
    private NativeNotifications() { }
    private static SharedPreferences prefs(Context context) { return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    private static SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(KEY)) return (SecretKey) store.getKey(KEY, null);
        if (!create) throw new IllegalStateException("Key unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    static void configure(Context context, String apiBase, String token, boolean enabled) throws Exception {
        if (!enabled) { disable(context); return; }
        if (!NotificationPolicy.allowedApiBase(apiBase) || !apiBase.equals(context.getString(R.string.notification_api_base))
                || !NotificationPolicy.validToken(token)) throw new IllegalArgumentException("Не удалось включить уведомления. Войдите ещё раз.");
        synchronized (LOCK) {
            Session previous = session(context);
            boolean same = previous != null && previous.token.equals(token);
            long createdAt = same ? previous.createdAt : System.currentTimeMillis();
            String generation = same ? previous.generation : UUID.randomUUID().toString();
            JSONObject payload = new JSONObject().put("token", token).put("createdAt", createdAt).put("generation", generation);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(true));
            cipher.updateAAD(KEY.getBytes(StandardCharsets.UTF_8));
            byte[] encrypted = cipher.doFinal(payload.toString().getBytes(StandardCharsets.UTF_8));
            String blob = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(encrypted, Base64.NO_WRAP);
            SharedPreferences.Editor edit = prefs(context).edit().putString("secret", blob).putBoolean("requested", true).putString("generation", generation);
            if (!same) edit.remove("notifiedIds").remove("lastCheckedAt").remove("nextAllowedAt").remove("lastError");
            if (!edit.commit()) throw new IllegalStateException("Не удалось сохранить вход для уведомлений.");
        }
        createChannel(context); schedule(context, true);
    }

    static Session session(Context context) {
        synchronized (LOCK) {
            SharedPreferences preferences = prefs(context);
            if (!preferences.getBoolean("requested", false)) return null;
            try {
                String[] parts = preferences.getString("secret", "").split("\\.", -1);
                if (parts.length != 2) throw new IllegalStateException();
                byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
                if (iv.length != 12) throw new IllegalStateException();
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
                cipher.updateAAD(KEY.getBytes(StandardCharsets.UTF_8));
                JSONObject payload = new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
                String token = payload.getString("token"), generation = payload.getString("generation"); long createdAt = payload.getLong("createdAt");
                if (!NotificationPolicy.validToken(token) || !generation.equals(preferences.getString("generation", "")) || NotificationPolicy.expired(createdAt, System.currentTimeMillis())) throw new IllegalStateException();
                return new Session(token, generation, createdAt);
            } catch (Exception ignored) {
                preferences.edit().remove("secret").remove("generation").remove("notifiedIds").putBoolean("requested", false).putString("lastError", "session_expired").commit();
                cancelWork(context); return null;
            }
        }
    }

    static boolean current(Context context, Session session) {
        SharedPreferences p = prefs(context);
        return p.getBoolean("requested", false) && session.generation.equals(p.getString("generation", ""))
            && !NotificationPolicy.expired(session.createdAt, System.currentTimeMillis());
    }

    static void disable(Context context) {
        synchronized (LOCK) { prefs(context).edit().clear().commit(); }
        cancelWork(context);
        NotificationManager manager = context.getSystemService(NotificationManager.class); if (manager != null) manager.cancelAll();
    }
    static void disableIfCurrent(Context context, Session session) { synchronized (LOCK) { if (current(context, session)) disable(context); } }
    private static void cancelWork(Context context) { WorkManager manager = WorkManager.getInstance(context); manager.cancelUniqueWork(PERIODIC); manager.cancelUniqueWork(IMMEDIATE); }

    static void createChannel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) { NotificationChannel channel = new NotificationChannel(CHANNEL, "Сообщения бригады", NotificationManager.IMPORTANCE_DEFAULT); channel.setDescription("Новые сообщения в чате и ответы на ваши записи"); manager.createNotificationChannel(channel); }
    }
    static boolean hasPermission(Context context) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager == null ? null : manager.getNotificationChannel(CHANNEL);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    static void permissionRequested(Context context) { prefs(context).edit().putBoolean("permissionAsked", true).apply(); }

    static void schedule(Context context, boolean immediate) {
        if (session(context) == null) return;
        if (!hasPermission(context)) { cancelWork(context); return; }
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest periodic = new PeriodicWorkRequest.Builder(NotificationWorker.class, 15, TimeUnit.MINUTES)
            .setInitialDelay(15, TimeUnit.MINUTES).setConstraints(constraints).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build();
        WorkManager manager = WorkManager.getInstance(context);
        manager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, periodic);
        if (immediate && System.currentTimeMillis() - prefs(context).getLong("lastCheckedAt", 0) > 60000)
            manager.enqueueUniqueWork(IMMEDIATE, ExistingWorkPolicy.REPLACE, new OneTimeWorkRequest.Builder(NotificationWorker.class).setConstraints(constraints).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build());
    }

    static Set<String> notified(Context context) {
        synchronized (LOCK) {
            Set<String> result = new LinkedHashSet<>();
            try { JSONArray list = new JSONArray(prefs(context).getString("notifiedIds", "[]")); for (int i=0;i<list.length();i++) if (NotificationPolicy.validId(list.optString(i))) result.add(list.optString(i)); } catch (Exception ignored) { }
            return result;
        }
    }
    static void remember(Context context, Session session, String id) {
        synchronized (LOCK) {
            if (!current(context, session)) return;
            Set<String> ids = notified(context); ids.remove(id); ids.add(id);
            while (ids.size() > 1000) ids.remove(ids.iterator().next());
            JSONArray list = new JSONArray(); for (String item : ids) list.put(item);
            prefs(context).edit().putString("notifiedIds", list.toString()).commit();
        }
    }
    static boolean postIfCurrent(Context context, Session session, String id, android.app.Notification notification) {
        synchronized (LOCK) {
            if (!current(context, session) || !hasPermission(context)) return false;
            NotificationManagerCompat.from(context).notify(id, 1, notification);
            remember(context, session, id);
            return true;
        }
    }
    static long nextAllowedAt(Context context) { return prefs(context).getLong("nextAllowedAt", 0); }
    static void backoff(Context context, Session session, long millis) { synchronized (LOCK) { if (current(context, session)) prefs(context).edit().putLong("nextAllowedAt", System.currentTimeMillis() + Math.max(60000, Math.min(86400000, millis))).apply(); } }
    static void checked(Context context, Session session, String error) { synchronized (LOCK) { if (current(context, session)) prefs(context).edit().putLong("lastCheckedAt", System.currentTimeMillis()).putString("lastError", error).apply(); } }
    static JSONObject state(Context context) {
        JSONObject result = new JSONObject();
        try {
            Session session = session(context); SharedPreferences p = prefs(context); boolean allowed = hasPermission(context);
            result.put("available", true).put("configured", session != null).put("requested", p.getBoolean("requested", false))
                .put("enabled", session != null && allowed).put("permissionGranted", allowed).put("intervalMinutes", 15)
                .put("permission", allowed ? "granted" : Build.VERSION.SDK_INT >= 33 && !p.getBoolean("permissionAsked", false) ? "prompt" : "denied")
                .put("background", "periodic")
                .put("lastCheckedAt", p.getLong("lastCheckedAt", 0)).put("lastError", p.getString("lastError", ""));
        } catch (Exception ignored) { }
        return result;
    }
}
