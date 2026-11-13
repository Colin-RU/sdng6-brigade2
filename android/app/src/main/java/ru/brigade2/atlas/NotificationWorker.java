package ru.brigade2.atlas;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.app.NotificationCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Set;
import javax.net.ssl.HttpsURLConnection;

/** Deferrable periodic polling; Android can delay execution while conserving battery. */
public final class NotificationWorker extends Worker {
    private static final Object RUN_LOCK = new Object();
    public NotificationWorker(Context context, WorkerParameters parameters) { super(context, parameters); }
    @Override public Result doWork() { synchronized (RUN_LOCK) { return poll(); } }

    private Result poll() {
        Context context = getApplicationContext();
        NativeNotifications.Session session = NativeNotifications.session(context);
        if (session == null || !NativeNotifications.hasPermission(context) || isStopped()
                || System.currentTimeMillis() < NativeNotifications.nextAllowedAt(context)) return Result.success();
        HttpsURLConnection connection = null;
        try {
            String base = context.getString(R.string.notification_api_base);
            if (!NotificationPolicy.allowedApiBase(base)) return Result.failure();
            connection = (HttpsURLConnection) new URL(base + "/notifications?unread=1&limit=50").openConnection();
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(15000);
            connection.setRequestMethod("GET"); connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json"); connection.setRequestProperty("Authorization", "Bearer " + session.token);
            int code = connection.getResponseCode();
            if (!NativeNotifications.current(context, session) || isStopped()) return Result.success();
            if (code == 401 || code == 403) { NativeNotifications.disableIfCurrent(context,session); return Result.success(); }
            if (code == 429) { long seconds=900; try { seconds=Long.parseLong(connection.getHeaderField("Retry-After")); } catch (Exception ignored) { } NativeNotifications.backoff(context,session,seconds*1000); return Result.success(); }
            if (code != 200) { NativeNotifications.checked(context,session,"connection_unavailable"); return code>=500&&getRunAttemptCount()<3 ? Result.retry():Result.success(); }
            String type = connection.getContentType(); if (type == null || !type.toLowerCase(java.util.Locale.ROOT).contains("json")) throw new IllegalStateException();
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] chunk = new byte[8192]; int length;
                while ((length=input.read(chunk))!=-1) { if (body.size()+length>1048576 || isStopped()) throw new IllegalStateException(); body.write(chunk,0,length); }
            }
            JSONObject response = new JSONObject(body.toString(StandardCharsets.UTF_8.name())); JSONArray items = response.getJSONArray("items");
            if (items.length()>50) throw new IllegalStateException();
            Set<String> seen = NativeNotifications.notified(context); NativeNotifications.createChannel(context);
            for (int i=0;i<items.length();i++) {
                if (isStopped() || !NativeNotifications.current(context,session) || !NativeNotifications.hasPermission(context)) return Result.success();
                JSONObject item=items.optJSONObject(i); if(item==null)continue;String id=item.optString("id","");
                if (!NotificationPolicy.validId(id) || seen.contains(id) || !item.isNull("readAt") && !item.optString("readAt","").isEmpty()) continue;
                if (!NativeNotifications.postIfCurrent(context,session,id,notification(context,id,item))) return Result.success();seen.add(id);
            }
            NativeNotifications.checked(context,session,""); return Result.success();
        } catch (Exception ignored) {
            if (!NativeNotifications.current(context,session) || isStopped()) return Result.success();
            NativeNotifications.checked(context,session,"connection_unavailable"); return getRunAttemptCount()<3 ? Result.retry():Result.success();
        } finally { if(connection!=null)connection.disconnect(); }
    }

    private static android.app.Notification notification(Context context,String id,JSONObject item) {
        JSONObject actor=item.optJSONObject("actor");
        NotificationContent.Summary content=NotificationContent.create(item.optString("type"),item.optString("objectKey"),actor==null?null:actor.optString("nickname"),item.optString("objectLabel"),item.optString("preview"));
        Intent intent=new Intent(context,MainActivity.class).setData(Uri.parse("atlas://notification/"+Uri.encode(id)))
            .putExtra(NativeNotifications.EXTRA_ID,id).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap=PendingIntent.getActivity(context,id.hashCode(),intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        long when=System.currentTimeMillis();try{when=Math.min(when,Instant.parse(item.optString("createdAt")).toEpochMilli());}catch(Exception ignored){}
        NotificationCompat.Builder builder=new NotificationCompat.Builder(context,NativeNotifications.CHANNEL)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(content.title).setContentText(content.body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(content.body)).setContentIntent(tap).setAutoCancel(true)
            .setWhen(when).setCategory(NotificationCompat.CATEGORY_SOCIAL).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setGroup("brigade_replies").setOnlyAlertOnce(true).setColor(0xff167c8a);
        return builder.build();
    }
}
