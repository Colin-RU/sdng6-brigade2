package ru.brigade2.atlas;

import android.content.Context;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;

/** Only the fixed brigade HTTPS API can receive the encrypted native session bearer. */
final class NotificationApi {
    static final class Response { final int code; final JSONObject json; Response(int code, JSONObject json) { this.code=code; this.json=json; } }
    private NotificationApi() { }
    static Response request(Context context, NativeNotifications.Session session, String method, String path, JSONObject payload) throws Exception {
        String base=context.getString(R.string.notification_api_base);
        if (!NotificationPolicy.allowedApiBase(base) || !path.matches("/(?:devices/fcm(?:/config)?|notifications/[A-Za-z0-9%._:-]+)")) throw new IllegalArgumentException();
        HttpsURLConnection connection=(HttpsURLConnection)new URL(base+path).openConnection();
        try {
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(12000); connection.setReadTimeout(12000);
            connection.setRequestMethod(method); connection.setUseCaches(false);
            connection.setRequestProperty("Accept","application/json"); connection.setRequestProperty("Authorization","Bearer "+session.token);
            if(payload!=null){byte[] bytes=payload.toString().getBytes(StandardCharsets.UTF_8);connection.setDoOutput(true);connection.setRequestProperty("Content-Type","application/json");connection.setFixedLengthStreamingMode(bytes.length);try(OutputStream output=connection.getOutputStream()){output.write(bytes);}}
            int code=connection.getResponseCode();String type=connection.getContentType();
            if(code==204)return new Response(code,new JSONObject());
            if(type==null||!type.toLowerCase(java.util.Locale.ROOT).contains("json"))return new Response(code,new JSONObject());
            InputStream stream=code>=400?connection.getErrorStream():connection.getInputStream();if(stream==null)return new Response(code,new JSONObject());
            ByteArrayOutputStream body=new ByteArrayOutputStream();try(InputStream input=stream){byte[] bytes=new byte[4096];int count;while((count=input.read(bytes))!=-1){if(body.size()+count>131072)throw new IllegalStateException();body.write(bytes,0,count);}}
            return new Response(code,new JSONObject(body.toString(StandardCharsets.UTF_8.name())));
        } finally { connection.disconnect(); }
    }
}
