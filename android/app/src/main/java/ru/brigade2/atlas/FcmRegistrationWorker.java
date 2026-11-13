package ru.brigade2.atlas;

import android.content.Context;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import com.google.android.gms.tasks.Tasks;
import org.json.JSONObject;
import java.util.concurrent.TimeUnit;

public final class FcmRegistrationWorker extends Worker {
    public FcmRegistrationWorker(Context context,WorkerParameters parameters){super(context,parameters);}
    @Override public Result doWork(){synchronized(NativePush.NETWORK_LOCK){
        Context context=getApplicationContext();NativeNotifications.Session session=NativeNotifications.session(context);
        if(session==null||!NativePushPolicy.sameGeneration(getInputData().getString("generation"),session.generation)||!NativeNotifications.hasPermission(context)||isStopped())return Result.success();
        try{
            NotificationApi.Response config=NotificationApi.request(context,session,"GET","/devices/fcm/config",null);
            if(!NativeNotifications.current(context,session)||isStopped())return Result.success();
            if(config.code==401){NativeNotifications.disableIfCurrent(context,session);return Result.success();}
            if(config.code!=200){NativePush.status(context,session,"connection_unavailable");return getRunAttemptCount()<5?Result.retry():Result.success();}
            if(!config.json.optBoolean("enabled")){NativePush.registrationUnavailable(context,session,"server_not_configured");return Result.success();}
            NativePush.messaging().setAutoInitEnabled(true);String token=Tasks.await(NativePush.messaging().getToken(),25,TimeUnit.SECONDS);
            if(!NativePushPolicy.validFcmToken(token))throw new IllegalStateException();
            if(!NativeNotifications.current(context,session)||!NativeNotifications.hasPermission(context)||isStopped())return Result.success();
            NativePush.Identity identity=NativePush.identity(context);
            JSONObject body=new JSONObject().put("installationId",identity.id).put("installationSecret",identity.secret).put("token",token).put("platform","android").put("appVersion",BuildConfig.VERSION_NAME).put("replaceOwner",true);
            NotificationApi.Response response=NotificationApi.request(context,session,"POST","/devices/fcm",body);
            if(!NativeNotifications.current(context,session)||isStopped()){
                if(response.code>=200&&response.code<300)try{NativePush.unregister(context,session,identity);}catch(Exception ignored){}
                return Result.success();
            }
            if(response.code==401){NativeNotifications.disableIfCurrent(context,session);return Result.success();}
            if(response.code==200&&response.json.optBoolean("ok")&&response.json.optBoolean("enabled")){NativePush.registered(context,session,token);return Result.success();}
            if(response.code>=400&&response.code<500||response.code==200)NativePush.registrationUnavailable(context,session,response.code==409?"binding_conflict":"registration_unavailable");
            else NativePush.status(context,session,"registration_unavailable");
            return (response.code==429||response.code>=500)&&getRunAttemptCount()<5?Result.retry():Result.success();
        }catch(Exception ignored){NativePush.status(context,session,"registration_unavailable");return getRunAttemptCount()<5&&!isStopped()?Result.retry():Result.success();}
    }}
}
