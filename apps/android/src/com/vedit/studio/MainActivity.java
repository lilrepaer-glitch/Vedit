package com.vedit.studio;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
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
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native Android shell for Vedit Studio (v1.0.0).
 *
 * Provides:
 *  - Local zero-latency HTTPS asset serving (`https://appassets.vedit.studio/*`)
 *  - Non-blocking background thread-pool HTTP/HTTPS API bridge (`httpRequestAsync` + `httpRequest`)
 *    with automatic stale-keepalive socket recovery & transient error retries so repeated AI calls
 *    never freeze the UI or fail on pooled TLS socket resets
 *  - Multi-file native Android Gallery / Document picker (Videos, Audio, Photos, Subtitles)
 *  - Microphone & Camera WebRTC permission bridge for in-app Voiceover recording
 *  - Direct MediaStore export into Android Gallery (`Movies/Vedit/`) + native Share Sheet
 */
public class MainActivity extends Activity {
    private static final String VIRTUAL_HOST = "appassets.vedit.studio";
    private static final int FILE_CHOOSER_REQ = 4101;
    private static final int RUNTIME_PERM_REQ = 4102;

    private final ExecutorService networkPool = Executors.newCachedThreadPool();
    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private PermissionRequest pendingWebPermission;
    private boolean immersiveFullscreen = false;
    private Uri lastExportedUri = null;
    private String lastExportedMime = "video/mp4";

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window win = getWindow();
        win.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        win.setStatusBarColor(Color.parseColor("#09090B"));
        win.setNavigationBarColor(Color.parseColor("#09090B"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#09090B"));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " VedStudioAPK/1.0.0");

        webView.addJavascriptInterface(new AndroidBridge(), "VeditAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && VIRTUAL_HOST.equalsIgnoreCase(uri.getHost())) {
                    String rawPath = uri.getPath();
                    if (rawPath == null || rawPath.isEmpty() || "/".equals(rawPath)) {
                        rawPath = "/index.html";
                    }
                    String assetPath = "public" + rawPath;
                    try {
                        InputStream stream = getAssets().open(assetPath);
                        String mime = guessMimeType(rawPath);
                        Map<String, String> headers = new HashMap<>();
                        headers.put("Access-Control-Allow-Origin", "*");
                        headers.put("Cache-Control", "no-cache");
                        return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, stream);
                    } catch (IOException ignored) {
                        Map<String, String> headers = new HashMap<>();
                        headers.put("Access-Control-Allow-Origin", "*");
                        return new WebResourceResponse(
                            "text/plain",
                            "UTF-8",
                            404,
                            "Not Found",
                            headers,
                            new ByteArrayInputStream("Not Found".getBytes(StandardCharsets.UTF_8))
                        );
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;
                if (VIRTUAL_HOST.equalsIgnoreCase(uri.getHost())) {
                    return false;
                }
                try {
                    Intent external = new Intent(Intent.ACTION_VIEW, uri);
                    startActivity(external);
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (Build.VERSION.SDK_INT >= 23
                            && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                            pendingWebPermission = request;
                            requestPermissions(
                                new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA},
                                RUNTIME_PERM_REQ
                            );
                        } else {
                            request.grant(request.getResources());
                        }
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(
                WebView view,
                ValueCallback<Uri[]> filePathCb,
                FileChooserParams fileChooserParams
            ) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = filePathCb;

                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

                String[] acceptTypes = fileChooserParams != null ? fileChooserParams.getAcceptTypes() : null;
                if (acceptTypes != null && acceptTypes.length == 1
                    && acceptTypes[0] != null && !acceptTypes[0].isEmpty() && !acceptTypes[0].contains(",")) {
                    intent.setType(acceptTypes[0]);
                } else {
                    intent.setType("*/*");
                    intent.putExtra(
                        Intent.EXTRA_MIME_TYPES,
                        new String[]{"video/*", "audio/*", "image/*", "text/plain", "text/vtt", "application/x-subrip"}
                    );
                }

                try {
                    startActivityForResult(Intent.createChooser(intent, "Select media"), FILE_CHOOSER_REQ);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }
        });

        setContentView(webView);
        webView.loadUrl("https://" + VIRTUAL_HOST + "/index.html");
    }

    @Override
    protected void onDestroy() {
        networkPool.shutdownNow();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == RUNTIME_PERM_REQ && pendingWebPermission != null) {
            final PermissionRequest req = pendingWebPermission;
            pendingWebPermission = null;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        req.grant(req.getResources());
                    } catch (Exception ignored) {
                    }
                }
            });
        }
    }

    private String guessMimeType(String path) {
        String lower = path.toLowerCase(Locale.US);
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
        if (lower.endsWith(".woff2")) return "font/woff2";
        String ext = MimeTypeMap.getFileExtensionFromUrl(lower);
        if (ext != null) {
            String detected = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (detected != null) return detected;
        }
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

    private static byte[] readAllBytes(InputStream is) throws IOException {
        if (is == null) return new byte[0];
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = is.read(chunk)) != -1) {
            buffer.write(chunk, 0, n);
        }
        return buffer.toByteArray();
    }

    private interface StreamProgressCallback {
        void onChunk(int totalChars);
    }

    private static final ConcurrentHashMap<String, HttpURLConnection> activeConnections = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, Boolean> abortedRequests = new ConcurrentHashMap<>();

    private static String readSseStreamAsJson(
        InputStream stream,
        StreamProgressCallback progressCb
    ) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8), 8192);
        StringBuilder contentBuilder = new StringBuilder();
        StringBuilder reasoningBuilder = new StringBuilder();
        StringBuilder rawFallback = new StringBuilder();
        String detectedModel = "";
        boolean sawSseData = false;
        long lastProgressMs = 0L;

        String line;
        while ((line = reader.readLine()) != null) {
            if (rawFallback.length() < 262144) {
                rawFallback.append(line).append('\n');
            }
            String trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            String payload = trimmed.substring(5).trim();
            if (payload.isEmpty() || "[DONE]".equals(payload)) {
                sawSseData = true;
                continue;
            }
            sawSseData = true;
            try {
                JSONObject ev = new JSONObject(payload);
                if (detectedModel.isEmpty() && ev.has("model")) {
                    detectedModel = ev.optString("model", "");
                }
                // Anthropic streaming event (`content_block_delta`)
                JSONObject topDelta = ev.optJSONObject("delta");
                if (topDelta != null && topDelta.has("text")) {
                    contentBuilder.append(topDelta.optString("text", ""));
                }
                // OpenAI / OpenRouter / Gemini / Groq / DeepSeek streaming chunk
                JSONArray choices = ev.optJSONArray("choices");
                if (choices != null && choices.length() > 0) {
                    JSONObject c0 = choices.optJSONObject(0);
                    if (c0 != null) {
                        JSONObject delta = c0.optJSONObject("delta");
                        if (delta != null) {
                            String piece = delta.optString("content", "");
                            if (!piece.isEmpty() && !"null".equals(piece)) {
                                contentBuilder.append(piece);
                            }
                            String rPiece = delta.optString("reasoning_content", "");
                            if (rPiece.isEmpty() || "null".equals(rPiece)) {
                                rPiece = delta.optString("reasoning", "");
                            }
                            if (!rPiece.isEmpty() && !"null".equals(rPiece)) {
                                reasoningBuilder.append(rPiece);
                            }
                        } else if (c0.has("text")) {
                            contentBuilder.append(c0.optString("text", ""));
                        }
                    }
                }
                long nowMs = System.currentTimeMillis();
                if (progressCb != null && nowMs - lastProgressMs >= 200L) {
                    lastProgressMs = nowMs;
                    progressCb.onChunk(contentBuilder.length() + reasoningBuilder.length());
                }
            } catch (Exception ignored) {
                // Ignore non-JSON keepalive comments or partial metadata frames
            }
        }

        if (!sawSseData) {
            return rawFallback.toString();
        }
        try {
            JSONObject msgObj = new JSONObject();
            msgObj.put("role", "assistant");
            msgObj.put("content", contentBuilder.length() > 0 ? contentBuilder.toString() : reasoningBuilder.toString());
            JSONObject choiceObj = new JSONObject();
            choiceObj.put("index", 0);
            choiceObj.put("message", msgObj);
            JSONArray choicesArr = new JSONArray();
            choicesArr.put(choiceObj);
            JSONObject assembled = new JSONObject();
            assembled.put("streamed", true);
            if (!detectedModel.isEmpty()) {
                assembled.put("model", detectedModel);
            }
            assembled.put("choices", choicesArr);
            return assembled.toString();
        } catch (Exception e) {
            return rawFallback.toString();
        }
    }

    /**
     * Executes a native HTTP/HTTPS call with live SSE token streaming, instant cancellation,
     * and automatic stale pooled-socket retry.
     */
    private static String performNativeHttp(
        String requestId,
        String method,
        String urlString,
        String headersJson,
        String body,
        StreamProgressCallback progressCb
    ) {
        Exception lastError = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            if (requestId != null && Boolean.TRUE.equals(abortedRequests.get(requestId))) {
                break;
            }
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlString);
                conn = (HttpURLConnection) url.openConnection();
                if (requestId != null && !requestId.isEmpty()) {
                    activeConnections.put(requestId, conn);
                }
                conn.setInstanceFollowRedirects(true);
                conn.setUseCaches(false);
                conn.setConnectTimeout(15000);
                // 95s per-chunk read timeout (with SSE streaming, active generation never times out!)
                conn.setReadTimeout(95000);
                String safeMethod = (method != null && !method.isEmpty()) ? method.toUpperCase(Locale.US) : "GET";
                conn.setRequestMethod(safeMethod);
                conn.setRequestProperty("Accept", "application/json, text/event-stream");
                conn.setRequestProperty("Accept-Encoding", "identity");
                conn.setRequestProperty("User-Agent", "VeditStudio/1.0.1 (Android)");
                if (attempt > 0) {
                    conn.setRequestProperty("Connection", "close");
                }

                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject headersObj = new JSONObject(headersJson);
                    Iterator<String> keys = headersObj.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        String value = headersObj.optString(key, "");
                        if (!value.isEmpty()) {
                            conn.setRequestProperty(key, value);
                        }
                    }
                }

                if (body != null && !body.isEmpty()
                    && !"GET".equalsIgnoreCase(safeMethod)
                    && !"HEAD".equalsIgnoreCase(safeMethod)) {
                    conn.setDoOutput(true);
                    byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                    conn.setRequestProperty("Content-Length", Integer.toString(payload.length));
                    OutputStream os = conn.getOutputStream();
                    os.write(payload);
                    os.flush();
                    os.close();
                }

                int status = conn.getResponseCode();
                InputStream respStream = (status >= 200 && status < 400)
                    ? conn.getInputStream()
                    : conn.getErrorStream();
                String contentType = conn.getContentType();
                boolean isEventStream = status >= 200 && status < 300
                    && ((contentType != null && contentType.toLowerCase(Locale.US).contains("text/event-stream"))
                        || (body != null && body.contains("\"stream\":true")));

                String responseBody;
                if (isEventStream && respStream != null) {
                    responseBody = readSseStreamAsJson(respStream, progressCb);
                    respStream.close();
                } else {
                    byte[] respBytes = readAllBytes(respStream);
                    if (respStream != null) respStream.close();
                    responseBody = new String(respBytes, StandardCharsets.UTF_8);
                }

                if ((status == 502 || status == 503 || status == 504 || status == 520 || status == 522 || status == 524)
                    && attempt < 2) {
                    try {
                        Thread.sleep(600L * (attempt + 1));
                    } catch (InterruptedException ignored) {
                    }
                    continue;
                }

                JSONObject result = new JSONObject();
                result.put("ok", status >= 200 && status < 300);
                result.put("status", status);
                result.put("statusText", conn.getResponseMessage() != null ? conn.getResponseMessage() : "");
                result.put("body", responseBody);
                return result.toString();
            } catch (SocketTimeoutException timeoutEx) {
                // Never repeat slow multi-minute retries on a read timeout
                lastError = timeoutEx;
                break;
            } catch (IOException ioEx) {
                lastError = ioEx;
                if (requestId != null && Boolean.TRUE.equals(abortedRequests.get(requestId))) {
                    break;
                }
                if (attempt < 2) {
                    try {
                        Thread.sleep(350L * (attempt + 1));
                    } catch (InterruptedException ignored) {
                    }
                    continue;
                }
            } catch (Exception e) {
                lastError = e;
                break;
            } finally {
                if (requestId != null) {
                    activeConnections.remove(requestId);
                }
                if (conn != null) {
                    try {
                        conn.disconnect();
                    } catch (Exception ignored) {
                    }
                }
            }
        }

        boolean wasAborted = requestId != null && Boolean.TRUE.equals(abortedRequests.remove(requestId));
        try {
            JSONObject err = new JSONObject();
            err.put("ok", false);
            err.put("status", 0);
            err.put("statusText", wasAborted ? "Aborted" : (lastError != null ? lastError.getClass().getSimpleName() : "IOException"));
            err.put("body", "");
            err.put("error", wasAborted
                ? "Cancelled"
                : (lastError != null && lastError.getMessage() != null
                    ? lastError.getMessage()
                    : (lastError != null ? lastError.toString() : "Network request failed")));
            return err.toString();
        } catch (Exception ignored) {
            return "{\"ok\":false,\"status\":0,\"error\":\"Network error\"}";
        }
    }

    public class AndroidBridge {
        @JavascriptInterface
        public boolean isAndroid() {
            return true;
        }

        @JavascriptInterface
        public String getVersion() {
            return "1.0.2";
        }

        @JavascriptInterface
        public String httpRequest(String method, String urlString, String headersJson, String body) {
            return performNativeHttp(null, method, urlString, headersJson, body, null);
        }

        @JavascriptInterface
        public void abortHttpRequest(String requestId) {
            if (requestId == null || requestId.isEmpty()) return;
            abortedRequests.put(requestId, Boolean.TRUE);
            HttpURLConnection active = activeConnections.remove(requestId);
            if (active != null) {
                try {
                    active.disconnect();
                } catch (Exception ignored) {
                }
            }
        }

        @JavascriptInterface
        public void httpRequestAsync(
            final String requestId,
            final String method,
            final String urlString,
            final String headersJson,
            final String body
        ) {
            networkPool.execute(new Runnable() {
                @Override
                public void run() {
                    final String responseJson = performNativeHttp(
                        requestId,
                        method,
                        urlString,
                        headersJson,
                        body,
                        new StreamProgressCallback() {
                            @Override
                            public void onChunk(final int totalChars) {
                                runOnUiThread(new Runnable() {
                                    @Override
                                    public void run() {
                                        if (webView != null) {
                                            webView.evaluateJavascript(
                                                "window.__veditHttpProgress && window.__veditHttpProgress("
                                                    + JSONObject.quote(requestId) + "," + totalChars + ");",
                                                null
                                            );
                                        }
                                    }
                                });
                            }
                        }
                    );
                    final String b64 = Base64.encodeToString(
                        responseJson.getBytes(StandardCharsets.UTF_8),
                        Base64.NO_WRAP
                    );
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (webView != null) {
                                String js = "window.__veditResolveHttp && window.__veditResolveHttp("
                                    + JSONObject.quote(requestId) + ","
                                    + JSONObject.quote(b64) + ");";
                                webView.evaluateJavascript(js, null);
                            }
                        }
                    });
                }
            });
        }

        @JavascriptInterface
        public boolean toggleFullscreen(String mode) {
            boolean next;
            if ("state".equalsIgnoreCase(mode)) {
                return immersiveFullscreen;
            } else if ("on".equalsIgnoreCase(mode)) {
                next = true;
            } else if ("off".equalsIgnoreCase(mode)) {
                next = false;
            } else {
                next = !immersiveFullscreen;
            }
            applyImmersiveMode(next);
            return next;
        }

        @JavascriptInterface
        public void openExternalUrl(final String url) {
            if (url == null || url.isEmpty()) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                        startActivity(intent);
                    } catch (Exception ignored) {
                    }
                }
            });
        }

        @JavascriptInterface
        public String saveExportBase64(String fileName, String mimeType, String base64Data) {
            try {
                byte[] raw = Base64.decode(base64Data, Base64.DEFAULT);
                String safeMime = (mimeType == null || mimeType.isEmpty()) ? "video/mp4" : mimeType;
                boolean isVideo = safeMime.startsWith("video/");
                boolean isImage = safeMime.startsWith("image/");

                if (Build.VERSION.SDK_INT >= 29) {
                    ContentResolver resolver = getContentResolver();
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, safeMime);

                    Uri collection;
                    String displayFolder;
                    if (isVideo) {
                        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/Vedit");
                        collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                        displayFolder = "Gallery (Movies/Vedit/" + fileName + ")";
                    } else if (isImage) {
                        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Vedit");
                        collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                        displayFolder = "Gallery (Pictures/Vedit/" + fileName + ")";
                    } else {
                        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Vedit");
                        collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                        displayFolder = "Downloads/Vedit/" + fileName;
                    }

                    Uri target = resolver.insert(collection, values);
                    if (target != null) {
                        OutputStream out = resolver.openOutputStream(target);
                        if (out != null) {
                            out.write(raw);
                            out.flush();
                            out.close();
                        }
                        lastExportedUri = target;
                        lastExportedMime = safeMime;
                        notifyToast("Saved to " + displayFolder);
                        return displayFolder;
                    }
                }

                File pubDir = new File(
                    Environment.getExternalStoragePublicDirectory(
                        isVideo ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_DOWNLOADS
                    ),
                    "Vedit"
                );
                if (!pubDir.exists()) pubDir.mkdirs();
                File outFile = new File(pubDir, fileName);
                FileOutputStream fos = new FileOutputStream(outFile);
                fos.write(raw);
                fos.flush();
                fos.close();
                lastExportedUri = Uri.fromFile(outFile);
                lastExportedMime = safeMime;
                notifyToast("Saved to " + outFile.getAbsolutePath());
                return outFile.getAbsolutePath();
            } catch (Exception e) {
                return "Save error: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public boolean shareLastExport() {
            if (lastExportedUri == null) return false;
            final Uri target = lastExportedUri;
            final String mime = lastExportedMime;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent share = new Intent(Intent.ACTION_SEND);
                        share.setType(mime);
                        share.putExtra(Intent.EXTRA_STREAM, target);
                        share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(Intent.createChooser(share, "Share video"));
                    } catch (Exception ignored) {
                    }
                }
            });
            return true;
        }

        private void notifyToast(final String message) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show();
                }
            });
        }
    }
}
