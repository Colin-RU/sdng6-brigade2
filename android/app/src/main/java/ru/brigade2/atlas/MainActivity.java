package ru.brigade2.atlas;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
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

/** Local-only atlas. Satellite fixes come directly from the Android LocationManager. */
public final class MainActivity extends Activity implements LocationListener {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String HOME = ORIGIN + "/assets/www/index.html";
    private static final int LOCATION_REQUEST = 10, OPEN_FILE = 11, SAVE_FILE = 12;
    private WebView webView;
    private LocationManager locations;
    private Location lastGpsFix;
    private boolean requestedGps, listening, foreground, permissionRequestPending;
    private ValueCallback<Uri[]> fileCallback;
    private byte[] pendingExport;
    private GeolocationPermissions.Callback pendingGeolocation;
    private String pendingOrigin;

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
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
                if (!isLocal(request.getUrl())) return blocked();
                WebResourceResponse response = loader.shouldInterceptRequest(request.getUrl());
                if (response == null) return blocked();
                Map<String, String> headers = new HashMap<>();
                headers.put("Content-Security-Policy", "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'");
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
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json");
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
    @Override protected void onResume() { super.onResume(); foreground = true; if (webView != null) webView.onResume(); startGps(); }
    @Override protected void onPause() { foreground = false; stopGps(); if (webView != null) webView.onPause(); super.onPause(); }
    @Override protected void onSaveInstanceState(Bundle state) { if (webView != null) webView.saveState(state); super.onSaveInstanceState(state); }
    @Override protected void onDestroy() {
        stopGps();
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (webView != null) { webView.removeJavascriptInterface("SdngGps"); webView.destroy(); webView = null; }
        super.onDestroy();
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != LOCATION_REQUEST) return;
        permissionRequestPending = false;
        boolean allowed = hasLocationPermission();
        if (pendingGeolocation != null) { pendingGeolocation.invoke(pendingOrigin, allowed, false); pendingGeolocation = null; pendingOrigin = null; }
        if (allowed) startGps(); else { requestedGps = false; gpsError(1, "Доступ к местоположению запрещён. Разрешите его в настройках приложения."); }
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == OPEN_FILE && fileCallback != null) {
            Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
            fileCallback.onReceiveValue(uri == null ? null : new Uri[]{uri}); fileCallback = null;
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
        if (trustedPage()) webView.evaluateJavascript("(()=>{const m=document.querySelector('#modal');if(m&&m.open){m.close();return true}const d=document.querySelector('#drawer');if(d&&!d.classList.contains('hidden')&&typeof closeDrawer==='function'){closeDrawer();return true}if(document.documentElement.classList.contains('map-expanded')){document.querySelector('[data-map-expand]')?.click();return true}return false})()", handled -> { if (!"true".equals(handled)) finish(); });
        else super.onBackPressed();
    }
}
