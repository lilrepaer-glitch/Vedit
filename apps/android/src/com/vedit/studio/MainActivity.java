package com.vedit.studio;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQ = 7001;
    private static final String APP_HOST = "appassets.vedit.studio";

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private boolean immersiveFullscreen = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        Window win = getWindow();
        win.setStatusBarColor(Color.parseColor("#0B0D11"));
        win.setNavigationBarColor(Color.parseColor("#0B0D11"));
        win.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0B0D11"));

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + " VedStudioAPK/0.7.0");

        webView.addJavascriptInterface(new AndroidBridge(), "VeditAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && APP_HOST.equalsIgnoreCase(uri.getHost())) {
                    String path = uri.getPath();
                    if (path == null || path.isEmpty() || "/".equals(path)) {
                        path = "/index.html";
                    }
                    String assetPath = "public" + path;
                    try {
                        InputStream stream = getAssets().open(assetPath);
                        Map<String, String> headers = new HashMap<String, String>();
                        headers.put("Access-Control-Allow-Origin", "*");
                        headers.put("Cache-Control", "no-cache");
                        return new WebResourceResponse(guessMime(assetPath), "UTF-8", 200, "OK", headers, stream);
                    } catch (Exception ignored) {
                        // Fall through if not a static asset
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                WebView webView,
                ValueCallback<Uri[]> callback,
                FileChooserParams fileChooserParams
            ) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;

                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"video/*", "audio/*", "image/*"});
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivityForResult(Intent.createChooser(intent, "Select Video, Audio or Photo"), FILE_CHOOSER_REQ);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        request.grant(request.getResources());
                    }
                });
            }
        });

        setContentView(webView);
        webView.loadUrl("https://" + APP_HOST + "/index.html");
    }

    private String guessMime(String path) {
        String lower = path.toLowerCase();
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".mp4")) return "video/mp4";
        if (lower.endsWith(".webm")) return "video/webm";
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".wav")) return "audio/wav";
        return "application/octet-stream";
    }

    @SuppressWarnings("deprecation")
    private void applyImmersiveMode(final boolean enable) {
        immersiveFullscreen = enable;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (Build.VERSION.SDK_INT >= 30) {
                    getWindow().setDecorFitsSystemWindows(!enable);
                    WindowInsetsController ctrl = getWindow().getInsetsController();
                    if (ctrl != null) {
                        if (enable) {
                            ctrl.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                            ctrl.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                        } else {
                            ctrl.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                        }
                    }
                    return;
                }
                View decor = getWindow().getDecorView();
                if (enable) {
                    decor.setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                    );
                } else {
                    decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
                }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQ) {
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                ClipData clipData = data.getClipData();
                if (clipData != null && clipData.getItemCount() > 0) {
                    results = new Uri[clipData.getItemCount()];
                    for (int i = 0; i < clipData.getItemCount(); i++) {
                        results[i] = clipData.getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (immersiveFullscreen) {
            applyImmersiveMode(false);
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    public class AndroidBridge {
        @JavascriptInterface
        public boolean isAndroid() {
            return true;
        }

        @JavascriptInterface
        public boolean toggleFullscreen(String mode) {
            boolean target;
            if ("on".equalsIgnoreCase(mode)) target = true;
            else if ("off".equalsIgnoreCase(mode)) target = false;
            else if ("state".equalsIgnoreCase(mode)) return immersiveFullscreen;
            else target = !immersiveFullscreen;
            applyImmersiveMode(target);
            return target;
        }

        @JavascriptInterface
        public String saveExportBase64(String fileName, String mimeType, String base64Data) {
            try {
                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                Uri savedUri = null;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentResolver resolver = getContentResolver();
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                    values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Vedit");
                    savedUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (savedUri != null) {
                        OutputStream os = resolver.openOutputStream(savedUri);
                        if (os != null) {
                            os.write(bytes);
                            os.flush();
                            os.close();
                        }
                    }
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Vedit");
                    if (!dir.exists()) dir.mkdirs();
                    File out = new File(dir, fileName);
                    FileOutputStream fos = new FileOutputStream(out);
                    fos.write(bytes);
                    fos.flush();
                    fos.close();
                }

                final String msg = "Saved to Downloads/Vedit/" + fileName;
                final Uri shareUri = savedUri;
                final String shareMime = mimeType;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
                        if (shareUri != null) {
                            Intent share = new Intent(Intent.ACTION_SEND);
                            share.setType(shareMime);
                            share.putExtra(Intent.EXTRA_STREAM, shareUri);
                            share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            startActivity(Intent.createChooser(share, "Share Exported Video"));
                        }
                    }
                });
                return "Downloads/Vedit/" + fileName;
            } catch (final Exception e) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "Save failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
                    }
                });
                return fileName;
            }
        }

        @JavascriptInterface
        public void openExternalUrl(String url) {
            try {
                Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(view);
            } catch (Exception ignored) {
            }
        }
    }
}
