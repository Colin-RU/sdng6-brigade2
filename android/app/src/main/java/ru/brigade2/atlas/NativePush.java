package ru.brigade2.atlas;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailabilityLight;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;

/** FCM registration is opt-in and belongs to exactly the current encrypted native session. */
final class NativePush {
    static final Object NETWORK_LOCK=new Object();
    static final String REGISTER_WORK="atlas_fcm_registration";
    private static final String PREFS="atlas_fcm_installation_v1";
    private static final ExecutorService cleanup=Executors.newSingleThreadExecutor();
    private static volatile boolean initialized;
    private static WeakReference<MainActivity> activity=new WeakReference<>(null);
    static final class Identity { final String id,secret; Identity(String id,String secret){this.id=id;this.secret=secret;} }
    private NativePush() { }
    private static SharedPreferences prefs(Context c){return c.getSharedPreferences(PREFS,Context.MODE_PRIVATE);}
    static boolean configured(){return NativePushPolicy.validConfig(BuildConfig.FIREBASE_APP_ID,BuildConfig.FIREBASE_API_KEY,BuildConfig.FIREBASE_PROJECT_ID,BuildConfig.FIREBASE_SENDER_ID);}
    static void initialize(Context context){
        if(!configured())return;
        try{
            synchronized(NativePush.class){if(!initialized){
                FirebaseOptions options=new FirebaseOptions.Builder().setApplicationId(BuildConfig.FIREBASE_APP_ID).setApiKey(BuildConfig.FIREBASE_API_KEY).setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build();
                if(FirebaseApp.getApps(context).isEmpty())FirebaseApp.initializeApp(context.getApplicationContext(),options);
                initialized=true;
            }}
            NativeNotifications.Session session=NativeNotifications.session(context);
            FirebaseMessaging.getInstance().setAutoInitEnabled(session!=null&&NativeNotifications.hasPermission(context)&&registered(context,session));
            ensureRegistration(context,false);
        }catch(Exception ignored){status(context,null,"registration_unavailable");}
    }
    static void attach(MainActivity current){activity=new WeakReference<>(current);}
    static void detach(MainActivity current){if(activity.get()==current)activity.clear();}
    static void changed(){MainActivity current=activity.get();if(current!=null)current.runOnUiThread(current::refreshNativeNotificationState);}
    static boolean playServicesAvailable(Context context){try{return GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context)==ConnectionResult.SUCCESS;}catch(Exception ignored){return false;}}
    static void ensureRegistration(Context context,boolean force){
        NativeNotifications.Session session=NativeNotifications.session(context);
        if(!initialized||session==null||!NativeNotifications.hasPermission(context))return;
        if(!playServicesAvailable(context)){status(context,session,"play_services_unavailable");return;}
        if(!force&&registered(context,session)&&System.currentTimeMillis()-prefs(context).getLong("registeredAt",0)<12*60*60*1000)return;
        synchronized(NativePush.class){long now=System.currentTimeMillis();if(!NativePushPolicy.registrationDue(now,prefs(context).getLong("lastEnqueuedAt",0),force))return;prefs(context).edit().putLong("lastEnqueuedAt",now).apply();}
        Constraints constraints=new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest request=new OneTimeWorkRequest.Builder(FcmRegistrationWorker.class).setConstraints(constraints)
            .setInputData(new Data.Builder().putString("generation",session.generation).build())
            .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS).build();
        if(force)status(context,session,"pending");
        WorkManager.getInstance(context).enqueueUniqueWork(REGISTER_WORK,force?ExistingWorkPolicy.REPLACE:ExistingWorkPolicy.KEEP,request);
    }
    static FirebaseMessaging messaging(){if(!initialized)throw new IllegalStateException();return FirebaseMessaging.getInstance();}
    static Identity identity(Context context)throws Exception{
        synchronized(NativePush.class){
            String stored=prefs(context).getString("identity","");
            if(!stored.isEmpty()){
                String[] parts=stored.split("\\.",-1);if(parts.length!=2)throw new IllegalStateException();byte[] iv=Base64.decode(parts[0],Base64.NO_WRAP);if(iv.length!=12)throw new IllegalStateException();
                Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,NativeNotifications.key(false),new GCMParameterSpec(128,iv));cipher.updateAAD(PREFS.getBytes(StandardCharsets.UTF_8));
                JSONObject object=new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8));String id=object.getString("id"),secret=object.getString("secret");if(!NativePushPolicy.validIdentity(id,secret))throw new IllegalStateException();return new Identity(id,secret);
            }
            byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);Identity identity=new Identity(UUID.randomUUID().toString(),Base64.encodeToString(bytes,Base64.URL_SAFE|Base64.NO_PADDING|Base64.NO_WRAP));java.util.Arrays.fill(bytes,(byte)0);
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,NativeNotifications.key(true));cipher.updateAAD(PREFS.getBytes(StandardCharsets.UTF_8));
            String blob=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+"."+Base64.encodeToString(cipher.doFinal(new JSONObject().put("id",identity.id).put("secret",identity.secret).toString().getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
            if(!prefs(context).edit().putString("identity",blob).commit())throw new IllegalStateException();return identity;
        }
    }
    static boolean registered(Context context,NativeNotifications.Session session){return initialized&&session!=null&&NativePushPolicy.sameGeneration(session.generation,prefs(context).getString("generation",null))&&BuildConfig.FIREBASE_PROJECT_ID.equals(prefs(context).getString("projectId",null))&&playServicesAvailable(context);}
    static void registered(Context context,NativeNotifications.Session session,String token)throws Exception{
        if(!NativeNotifications.current(context,session))return;
        String hash=Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
        prefs(context).edit().putString("generation",session.generation).putString("tokenHash",hash).putString("projectId",BuildConfig.FIREBASE_PROJECT_ID).putLong("registeredAt",System.currentTimeMillis()).remove("error").commit();changed();
        if(NativeNotifications.current(context,session))messaging().setAutoInitEnabled(true);
        NativeNotifications.schedule(context,false);
        NativeNotifications.catchUp(context);
    }
    static void status(Context context,NativeNotifications.Session session,String error){if(session!=null&&!NativeNotifications.current(context,session))return;prefs(context).edit().putString("error",error).apply();changed();}
    static void registrationUnavailable(Context context,NativeNotifications.Session session,String error){
        if(!NativeNotifications.current(context,session))return;
        prefs(context).edit().remove("generation").remove("tokenHash").apply();status(context,session,error);NativeNotifications.schedule(context,false);
    }
    static void tokenRotated(Context context){prefs(context).edit().remove("generation").remove("tokenHash").apply();ensureRegistration(context,true);NativeNotifications.schedule(context,true);changed();}
    static void removeBinding(Context context,NativeNotifications.Session previous,boolean disabling){
        Context app=context.getApplicationContext();prefs(app).edit().remove("generation").remove("tokenHash").remove("registeredAt").remove("receivedGeneration").remove("lastPushAt").remove("lastEnqueuedAt").remove("error").apply();WorkManager.getInstance(app).cancelUniqueWork(REGISTER_WORK);
        WorkManager.getInstance(app).cancelAllWorkByTag("atlas_fcm_delivery");
        if(disabling&&initialized)try{messaging().setAutoInitEnabled(false);}catch(Exception ignored){}
        cleanup.execute(()->{synchronized(NETWORK_LOCK){
            if(disabling&&initialized&&NativeNotifications.session(app)==null)try{messaging().setAutoInitEnabled(false);}catch(Exception ignored){}
            if(previous!=null)try{unregister(app,previous,identity(app));}catch(Exception ignored){}
        }});changed();
    }
    static void unregister(Context context,NativeNotifications.Session session,Identity identity)throws Exception{
        NotificationApi.request(context,session,"DELETE","/devices/fcm",new JSONObject().put("installationId",identity.id).put("installationSecret",identity.secret));
    }
    static void received(Context context,NativeNotifications.Session session){if(NativeNotifications.current(context,session)){prefs(context).edit().putString("receivedGeneration",session.generation).putLong("lastPushAt",System.currentTimeMillis()).apply();changed();}}
    static void addState(Context context,JSONObject result,NativeNotifications.Session session)throws Exception{
        boolean registered=registered(context,session);SharedPreferences p=prefs(context);
        result.put("pushAvailable",configured()&&playServicesAvailable(context)).put("pushRegistered",registered)
            .put("pushValidated",registered&&session.generation.equals(p.getString("receivedGeneration",null)))
            .put("pushStatus",registered?"registered":p.getString("error",configured()?"pending":"not_configured"))
            .put("lastPushAt",p.getLong("lastPushAt",0));
        if(registered)result.put("background","fcm").put("intervalMinutes",0);
    }
}
