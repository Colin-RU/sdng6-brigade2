package ru.brigade2.atlas;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import androidx.webkit.WebViewAssetLoader;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Bundled atlas with satellite GPS and optional authenticated brigade notifications. */
public final class MainActivity extends Activity implements LocationListener {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String HOME = ORIGIN + "/assets/www/index.html";
    private static final int LOCATION_REQUEST = 10, OPEN_FILE = 11, SAVE_FILE = 12, NOTIFICATION_REQUEST = 13;
    private WebView webView;
    private LocationManager locations;
    private Location lastGpsFix;
    private boolean requestedGps, listening, foreground, permissionRequestPending;
    private ValueCallback<Uri[]> fileCallback;
    private int selectedFileLimit = 1;
    private byte[] pendingExport;
    private GeolocationPermissions.Callback pendingGeolocation;
    private String pendingOrigin;
    private final ExecutorService notificationCommands = Executors.newSingleThreadExecutor();
    private volatile boolean trustedDocument;
    private boolean notificationPageReady;
    private String pendingNotificationId;

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        NativePush.attach(this);
        captureNotificationIntent(getIntent());
        if (android.os.Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        locations = (LocationManager) getSystemService(LOCATION_SERVICE);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(18, 60, 75));
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return insets;
            });
        }
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        // Required for a JSON file explicitly selected through the system document picker.
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(true);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.addJavascriptInterface(new NativeBridge(), "SdngGps");
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (isAllowedApi(request.getUrl()) && !request.isForMainFrame()) return null;
                if (!isLocal(request.getUrl())) return blocked();
                WebResourceResponse response = loader.shouldInterceptRequest(request.getUrl());
                if (response == null) return blocked();
                Map<String, String> headers = new HashMap<>();
                headers.put("Content-Security-Policy", "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://ufwrdwndlzwxtlkougrv.supabase.co; frame-src 'none'; object-src 'none'; base-uri 'self'");
                headers.put("X-Content-Type-Options", "nosniff");
                response.setResponseHeaders(headers);
                return response;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (isLocal(request.getUrl())) return false;
                if (request.isForMainFrame()) openExternal(request.getUrl());
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                trustedDocument = isLocal(Uri.parse(url));
                notificationPageReady = false;
                if (!isLocal(Uri.parse(url))) {
                    view.removeJavascriptInterface("SdngGps");
                    view.stopLoading();
                    stopGps();
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!ORIGIN.equals(origin) || !trustedPage()) { callback.invoke(origin, false, false); return; }
                if (hasLocationPermission()) callback.invoke(origin, true, false);
                else {
                    pendingGeolocation = callback; pendingOrigin = origin;
                    requestLocationPermission();
                }
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (!trustedPage()) return false;
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                boolean images = false, json = false;
                for (String accepted : params.getAcceptTypes()) for (String value : accepted.split(",")) {
                    String type = value.trim().toLowerCase(java.util.Locale.ROOT);
                    if (type.startsWith("image/") || type.matches("\\.(jpg|jpeg|png|webp)")) images = true;
                    if (type.equals("application/json") || type.equals(".json")) json = true;
                }
                String mime = images ? (json ? "*/*" : "image/*") : "application/json";
                boolean multiple = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
                selectedFileLimit = multiple ? 3 : 1;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
                if (images && json) intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "application/json"});
                try { startActivityForResult(intent, OPEN_FILE); }
                catch (ActivityNotFoundException e) { fileCallback.onReceiveValue(null); fileCallback = null; }
                return true;
            }
        });
        if (savedState == null || webView.restoreState(savedState) == null) webView.loadUrl(HOME);
    }

    private static boolean isLocal(Uri url) {
        return "https".equals(url.getScheme()) && "appassets.androidplatform.net".equals(url.getHost())
            && url.getPort() == -1 && url.getPath() != null && url.getPath().startsWith("/assets/www/");
    }
    private static boolean isAllowedApi(Uri url) {
        String path = url.getEncodedPath();
        return "https".equals(url.getScheme()) && "ufwrdwndlzwxtlkougrv.supabase.co".equals(url.getHost())
            && url.getPort() == -1 && url.getUserInfo() == null && url.getFragment() == null
            && path != null && (path.equals("/functions/v1/brigade-api") || path.startsWith("/functions/v1/brigade-api/"));
    }
    private boolean trustedPage() { return webView != null && webView.getUrl() != null && isLocal(Uri.parse(webView.getUrl())); }
    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }
    private void openExternal(Uri uri) {
        String scheme = uri.getScheme();
        if (!"https".equals(scheme) && !"http".equals(scheme) && !"geo".equals(scheme) && !"mailto".equals(scheme) && !"tel".equals(scheme)) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException e) { Toast.makeText(this, "Нет приложения для открытия ссылки", Toast.LENGTH_SHORT).show(); }
    }
    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }
    private void requestLocationPermission() {
        if (permissionRequestPending) return;
        permissionRequestPending = true;
        requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST);
    }

    public final class NativeBridge {
        @JavascriptInterface public String getSystemTheme() { return trustedDocument ? systemTheme() : "light"; }
        @JavascriptInterface public void configureNotifications(String apiBase, String token, boolean enabled) {
            runOnUiThread(() -> {
                if (!trustedPage()) return;
                notificationCommands.execute(() -> {
                    String error = null;
                    try { NativeNotifications.configure(MainActivity.this, apiBase, token, enabled); }
                    catch (Exception ignored) { error = "Не удалось сохранить настройки уведомлений. Войдите ещё раз."; }
                    final String message = error;
                    runOnUiThread(() -> {
                        JSONObject state = NativeNotifications.state(MainActivity.this);
                        if (message != null) try { state.put("error", message); } catch (org.json.JSONException ignored) { }
                        send("atlas-native-notification-state", state);
                    });
                });
            });
        }
        @JavascriptInterface public String getNotificationState() {
            return trustedDocument ? NativeNotifications.state(MainActivity.this).toString() : "{\"available\":false}";
        }
        @JavascriptInterface public void retryPushRegistration() {
            runOnUiThread(() -> {
                if (!trustedPage()) return;
                notificationCommands.execute(() -> NativePush.ensureRegistration(MainActivity.this,true));
            });
        }
        @JavascriptInterface public void requestNotificationPermission() {
            runOnUiThread(() -> {
                if (!trustedPage()) return;
                NativeNotifications.createChannel(MainActivity.this);
                if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    NativeNotifications.permissionRequested(MainActivity.this);
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
                } else if (!NativeNotifications.hasPermission(MainActivity.this)) {
                    try { startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())); }
                    catch (ActivityNotFoundException ignored) { }
                } else {
                    NativeNotifications.schedule(MainActivity.this, true);
                    send("atlas-native-notification-state", NativeNotifications.state(MainActivity.this));
                }
            });
        }
        @JavascriptInterface public void notificationsPageReady() {
            runOnUiThread(() -> {
                if (!trustedPage()) return;
                notificationPageReady = true;
                sendSystemTheme();
                send("atlas-native-notification-state", NativeNotifications.state(MainActivity.this));
                flushNotificationIntent();
            });
        }
        @JavascriptInterface public void start() {
            runOnUiThread(() -> {
                if (!trustedPage()) return;
                requestedGps = true;
                if (!hasLocationPermission()) requestLocationPermission();
                else startGps();
            });
        }
        @JavascriptInterface public void stop() { runOnUiThread(() -> { requestedGps = false; stopGps(); }); }
        @JavascriptInterface public void saveExport(String name, String json) {
            if (json == null || json.length() > 4 * 1024 * 1024) return;
            runOnUiThread(() -> {
                if (!trustedPage() || pendingExport != null) return;
                String safeName = name == null ? "brigade2-backup.json" : name.replaceAll("[^a-zA-Z0-9._-]", "_");
                if (!safeName.endsWith(".json")) safeName += ".json";
                pendingExport = json.getBytes(StandardCharsets.UTF_8);
                try {
                    startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("application/json").putExtra(Intent.EXTRA_TITLE, safeName), SAVE_FILE);
                } catch (ActivityNotFoundException e) { pendingExport = null; Toast.makeText(MainActivity.this, "Не удалось открыть сохранение файла", Toast.LENGTH_SHORT).show(); }
            });
        }
    }

    private String systemTheme() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES ? "dark" : "light";
    }
    private void sendSystemTheme() {
        try { send("atlas-system-theme-change", new JSONObject().put("theme", systemTheme())); }
        catch (org.json.JSONException ignored) { }
    }
    @Override public void onConfigurationChanged(Configuration configuration) { super.onConfigurationChanged(configuration); sendSystemTheme(); }

    private void captureNotificationIntent(Intent intent) {
        if (intent == null) return;
        String id = intent.getStringExtra(NativeNotifications.EXTRA_ID);
        if (NotificationPolicy.validId(id)) pendingNotificationId = id;
        intent.removeExtra(NativeNotifications.EXTRA_ID);
    }
    private void flushNotificationIntent() {
        if (!notificationPageReady || !trustedPage() || pendingNotificationId == null) return;
        try { JSONObject detail = new JSONObject().put("id", pendingNotificationId); pendingNotificationId = null; send("atlas-notification-open", detail); }
        catch (org.json.JSONException ignored) { }
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); captureNotificationIntent(intent); flushNotificationIntent(); }

    private void startGps() {
        if (!requestedGps || !foreground || listening || !trustedPage()) return;
        if (!hasLocationPermission()) { gpsError(1, "Разрешите доступ к местоположению в настройках приложения."); return; }
        boolean enabled = false;
        try {
            // GPS_PROVIDER works from satellites without mobile data, Google Play Services or a map API.
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                    && locations.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 1f, this);
                enabled = true;
            }
            if (locations.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locations.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 2000L, 2f, this);
                enabled = true;
            }
            listening = enabled;
            if (!enabled) { gpsError(2, "Включите геолокацию и точное местоположение в настройках телефона."); return; }
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } catch (SecurityException e) { gpsError(1, "Нет разрешения на местоположение."); }
    }
    private void stopGps() {
        if (locations != null) locations.removeUpdates(this);
        listening = false;
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
    private void send(String event, JSONObject detail) {
        if (trustedPage()) webView.evaluateJavascript("window.dispatchEvent(new CustomEvent(" + JSONObject.quote(event) + ",{detail:" + detail + "}));", null);
    }
    private void gpsError(int code, String message) {
        try { JSONObject error = new JSONObject(); error.put("code", code); error.put("message", message); send("sdng:gps-error", error); }
        catch (org.json.JSONException ignored) { }
    }
    @Override public void onLocationChanged(Location location) {
        if (!requestedGps || !foreground) return;
        if (LocationManager.GPS_PROVIDER.equals(location.getProvider())) lastGpsFix = location;
        else if (lastGpsFix != null && android.os.SystemClock.elapsedRealtimeNanos() - lastGpsFix.getElapsedRealtimeNanos() < 15_000_000_000L
                && lastGpsFix.hasAccuracy() && location.hasAccuracy() && location.getAccuracy() > lastGpsFix.getAccuracy() * 2) return;
        try {
            JSONObject point = new JSONObject();
            point.put("latitude", location.getLatitude()); point.put("longitude", location.getLongitude());
            point.put("accuracy", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL);
            point.put("altitude", location.hasAltitude() ? location.getAltitude() : JSONObject.NULL);
            point.put("altitudeAccuracy", android.os.Build.VERSION.SDK_INT >= 26 && location.hasVerticalAccuracy() ? location.getVerticalAccuracyMeters() : JSONObject.NULL);
            point.put("speed", location.hasSpeed() ? location.getSpeed() : JSONObject.NULL);
            point.put("heading", location.hasBearing() ? location.getBearing() : JSONObject.NULL);
            point.put("timestamp", location.getTime());
            send("sdng:gps", point);
        } catch (org.json.JSONException ignored) { }
    }
    @Override public void onProviderEnabled(String provider) { if (requestedGps) { stopGps(); startGps(); } }
    @Override public void onProviderDisabled(String provider) { if (requestedGps) { stopGps(); startGps(); } }
    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
    void refreshNativeNotificationState() { if (notificationPageReady && trustedPage()) send("atlas-native-notification-state", NativeNotifications.state(this)); }
    @Override protected void onResume() { super.onResume(); foreground = true; if (webView != null) webView.onResume(); sendSystemTheme(); startGps(); NativeNotifications.schedule(this, false); refreshNativeNotificationState(); }
    @Override protected void onPause() { foreground = false; stopGps(); if (webView != null) webView.onPause(); super.onPause(); }
    @Override protected void onSaveInstanceState(Bundle state) { if (webView != null) webView.saveState(state); super.onSaveInstanceState(state); }
    @Override protected void onDestroy() {
        NativePush.detach(this);
        stopGps();
        trustedDocument = false; notificationCommands.shutdown();
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (webView != null) { webView.removeJavascriptInterface("SdngGps"); webView.destroy(); webView = null; }
        super.onDestroy();
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_REQUEST) {
            NativeNotifications.schedule(this, true);
            send("atlas-native-notification-state", NativeNotifications.state(this));
            return;
        }
        if (requestCode != LOCATION_REQUEST) return;
        permissionRequestPending = false;
        boolean allowed = hasLocationPermission();
        if (pendingGeolocation != null) { pendingGeolocation.invoke(pendingOrigin, allowed, false); pendingGeolocation = null; pendingOrigin = null; }
        if (allowed) startGps(); else { requestedGps = false; gpsError(1, "Доступ к местоположению запрещён. Разрешите его в настройках приложения."); }
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == OPEN_FILE && fileCallback != null) {
            List<Uri> selected = new ArrayList<>();
            if (resultCode == RESULT_OK && data != null) {
                ClipData clips = data.getClipData();
                if (clips != null) for (int i=0;i<clips.getItemCount() && selected.size()<selectedFileLimit;i++) {
                    Uri uri = clips.getItemAt(i).getUri(); if (uri != null && "content".equals(uri.getScheme()) && !selected.contains(uri)) selected.add(uri);
                }
                else { Uri uri=data.getData();if(uri!=null && "content".equals(uri.getScheme()))selected.add(uri); }
            }
            fileCallback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0])); fileCallback = null; selectedFileLimit = 1;
        }
        if (requestCode == SAVE_FILE) {
            byte[] bytes = pendingExport; pendingExport = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && bytes != null) {
                try (OutputStream stream = getContentResolver().openOutputStream(data.getData())) {
                    if (stream != null) { stream.write(bytes); Toast.makeText(this, "Файл сохранён", Toast.LENGTH_SHORT).show(); }
                } catch (Exception e) { Toast.makeText(this, "Не удалось сохранить файл", Toast.LENGTH_SHORT).show(); }
            }
        }
    }
    @Override public void onBackPressed() {
        handleBack();
    }
    private void handleBack() {
        if (trustedPage()) webView.evaluateJavascript("(()=>{const m=document.querySelector('#modal');if(m&&m.open){m.close();return true}const d=document.querySelector('#drawer');if(d&&!d.classList.contains('hidden')&&typeof closeDrawer==='function'){closeDrawer();return true}if(document.documentElement.classList.contains('map-expanded')){document.querySelector('[data-map-expand]')?.click();return true}const menu=document.querySelector('#work-menu');if(menu&&!menu.classList.contains('hidden')&&window.WorkShell?.closeMenu){WorkShell.closeMenu();return true}return false})()", handled -> { if (!"true".equals(handled)) finish(); });
        else super.onBackPressed();
    }
}
