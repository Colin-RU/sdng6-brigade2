package ru.brigade2.atlas;

import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public final class AtlasMessagingService extends FirebaseMessagingService {
    @Override public void onNewToken(String token){if(NativePushPolicy.validFcmToken(token))NativePush.tokenRotated(this);}
    @Override public void onMessageReceived(RemoteMessage message){
        String id=message.getData().get("notificationId");NativeNotifications.Session session=NativeNotifications.session(this);
        if(!NativePush.configured()||session==null||!NativeNotifications.hasPermission(this)||!NotificationPolicy.validId(id))return;
        OneTimeWorkRequest.Builder request=new OneTimeWorkRequest.Builder(FcmNotificationWorker.class)
            .addTag("atlas_fcm_delivery")
            .setInputData(new Data.Builder().putString("notificationId",id).putString("generation",session.generation).build())
            .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL,10,java.util.concurrent.TimeUnit.SECONDS);
        if(message.getPriority()==RemoteMessage.PRIORITY_HIGH&&!NativeVisibility.visible())request.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST);
        // The service never launches a detached network task after its FCM callback has returned.
        WorkManager.getInstance(this).enqueueUniqueWork("atlas_push_"+id,ExistingWorkPolicy.KEEP,request.build());
    }
    @Override public void onDeletedMessages(){NativeNotifications.catchUp(this);}
}
