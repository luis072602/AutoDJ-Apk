package co.autodj.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/**
 * La app es la interfaz web de AutoDJ (assets/www) dentro de un WebView.
 * Las peticiones a /api/… no salen a internet: las responde {@link YouTube} desde el propio teléfono.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Android 13+ pide permiso para mostrar la notificación de lo que suena
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }

        final YouTube youTube = new YouTube(getCacheDir());
        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        web.setBackgroundColor(0xFF0D0C14);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String path = u.getPath();
                if (HOST.equals(u.getHost()) && path != null && path.startsWith("/api/")) {
                    return youTube.handle(u);
                }
                return assets.shouldInterceptRequest(u);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));   // enlaces externos: al navegador
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        // Puente con la interfaz: ella avisa qué suena; los botones de la notificación vuelven a ella
        web.addJavascriptInterface(new Bridge(), "AutoDJNative");
        PlaybackService.controls = c -> runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript("window.autodjCommand&&window.autodjCommand('" + c + "')", null);
        });

        setContentView(web);
        web.loadUrl("https://" + HOST + "/www/index.html");
    }

    @Override
    public void onBackPressed() {
        moveTaskToBack(true);   // «atrás» minimiza en vez de cerrar y cortar la música
    }

    /** Lo que la interfaz (js/native.js) puede pedirle a la app. Llega en un hilo aparte. */
    private final class Bridge {
        @JavascriptInterface
        public void nowPlaying(final String vid, final String title, final String artist, final boolean playing,
                               final double durMs, final double posMs, final double rate) {
            runOnUiThread(() -> PlaybackService.show(MainActivity.this, vid, title, artist, playing,
                    (long) durMs, (long) posMs, (float) rate));
        }

        @JavascriptInterface
        public void stopped() {
            runOnUiThread(PlaybackService::hide);
        }
    }

    @Override
    protected void onDestroy() {
        PlaybackService.controls = null;
        PlaybackService.hide();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
