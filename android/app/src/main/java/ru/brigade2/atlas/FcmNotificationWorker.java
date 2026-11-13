package ru.brigade2.atlas;

import android.content.Context;
import android.net.Uri;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.ForegroundInfo;
import androidx.core.app.NotificationCompat;
import org.json.JSONObject;

/** Authenticated content fetch extends the short FCM callback through an expedited job. */
public final class FcmNotificationWorker extends Worker {
    public FcmNotificationWorker(Context context,WorkerParameters parameters){super(context,parameters);}
    // WorkManager uses a brief foreground notification for expedited jobs only below Android 12.
    // It ends with this single content fetch; no persistent service or polling loop is started.
    @Override public ForegroundInfo getForegroundInfo(){
        Context context=getApplicationContext();NativeNotifications.createChannel(context);
        String id=getInputData().getString("notificationId");
        return new ForegroundInfo(100000+(id==null?0:(id.hashCode()&0xfffff)),
            new NotificationCompat.Builder(context,NotificationContent.WORK_CHANNEL).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Сообщения бригады").setContentText("Получаем новое сообщение…")
                .setOngoing(true).setSilent(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build());
    }
    @Override public Result doWork(){
        Context context=getApplicationContext();String id=getInputData().getString("notificationId");NativeNotifications.Session session=NativeNotifications.session(context);
        if(session==null||!NativePushPolicy.sameGeneration(getInputData().getString("generation"),session.generation)||!NotificationPolicy.validId(id)||!NativeNotifications.hasPermission(context)||isStopped())return Result.success();
        if(NativeNotifications.notified(context).contains(id))return Result.success();
        try{
            NotificationApi.Response response=NotificationApi.request(context,session,"GET","/notifications/"+Uri.encode(id),null);
            if(!NativeNotifications.current(context,session)||isStopped())return Result.success();
            if(response.code==401){NativeNotifications.disableIfCurrent(context,session);return Result.success();}
            if(response.code==403||response.code==404||response.code==410)return Result.success();
            if(response.code!=200)return (response.code==429||response.code>=500)&&getRunAttemptCount()<3?Result.retry():Result.success();
            JSONObject item=response.json.optJSONObject("item");
            if(item==null||!id.equals(item.optString("id"))||!item.isNull("readAt")&&!item.optString("readAt","").isEmpty())return Result.success();
            NativeNotifications.createChannel(context);
            if(NativeNotifications.postIfCurrent(context,session,id,NotificationPresenter.create(context,id,item)))NativePush.received(context,session);
            return Result.success();
        }catch(Exception ignored){return getRunAttemptCount()<3&&NativeNotifications.current(context,session)&&!isStopped()?Result.retry():Result.success();}
    }
}
