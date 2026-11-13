package ru.brigade2.atlas;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.app.NotificationCompat;
import org.json.JSONObject;
import java.time.Instant;

/** FCM and fallback polling share channels, grouping, privacy and opaque tap destinations. */
final class NotificationPresenter {
    private NotificationPresenter() { }
    static android.app.Notification create(Context context,String id,JSONObject item) {
        JSONObject actor=item.optJSONObject("actor");
        NotificationContent.Summary content=NotificationContent.create(item.optString("type"),item.optString("objectKey"),actor==null?null:actor.optString("nickname"),item.optString("objectLabel"),item.optString("preview"),item.optBoolean("isMention"));
        Intent intent=new Intent(context,MainActivity.class).setData(Uri.parse("atlas://notification/"+Uri.encode(id)))
            .putExtra(NativeNotifications.EXTRA_ID,id).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap=PendingIntent.getActivity(context,id.hashCode(),intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        long when=System.currentTimeMillis();try{when=Math.min(when,Instant.parse(item.optString("createdAt")).toEpochMilli());}catch(Exception ignored){}
        return new NotificationCompat.Builder(context,content.channelId)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(content.title).setContentText(content.body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(content.body)).setContentIntent(tap).setAutoCancel(true)
            .setWhen(when).setCategory(NotificationCompat.CATEGORY_SOCIAL).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setGroup(content.groupKey).setOnlyAlertOnce(true).setColor(content.color).build();
    }
}
