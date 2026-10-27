package com.harness.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
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

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Harness 安卓壳（模式沿自 bridge 离线壳，裁掉一切与本 app 无关的能力）。
 *
 * 前端（web/dist）打包在 assets/www/，shouldInterceptRequest 以本地 https 源
 * https://appassets.androidplatform.net/ 提供 → 界面本地秒开；只有 /api/* 走网络
 * 打到 PC 上的 harness（地址由前端管理，存 localStorage，首跑有连接引导页）。
 */
public class MainActivity extends Activity {

    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String INDEX_URL = "https://" + APP_HOST + "/index.html";
    private static final int FILE_CHOOSER = 1001;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private int cssInsetTop = 0;
    private int cssInsetBottom = 0;

    // 注入系统栏安全边距（CSS px）。WebView 的 env(safe-area-inset-*) 在安卓上不可靠，
    // 前端 --sat/--sab 有 env() 兜底、被这里的真值覆盖。
    private void injectInsets() {
        if (web == null) return;
        web.evaluateJavascript(
                "document.documentElement.style.setProperty('--sat','" + cssInsetTop + "px');" +
                "document.documentElement.style.setProperty('--sab','" + cssInsetBottom + "px');" +
                "try{window.dispatchEvent(new Event('harness-insets'))}catch(e){}", null);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);      // localStorage：服务器地址 / 外观 / 皮肤记忆
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // 本地页是 https 源（appassets），要能 fetch 局域网 http://<ip>:8799 —— 属混合内容，放开。
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebViewClient(new WebViewClient() {
            // 本地源 → assets/www/；其余（/api 到 PC、外链）返回 null 照常走网络。
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                Uri uri = req.getUrl();
                if (uri == null || !APP_HOST.equals(uri.getHost())) return null;
                String path = uri.getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                // SPA 兜底：无扩展名的路径回 index.html
                if (!path.contains(".")) path = "/index.html";
                String assetPath = "www" + path;
                try {
                    InputStream is = getAssets().open(assetPath);
                    return new WebResourceResponse(mimeOf(path), null, is);
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8",
                            new ByteArrayInputStream(("asset not found: " + assetPath).getBytes()));
                }
            }

            // 站内导航留在 WebView；外链交给系统浏览器（预览"新标签打开"走这里）。
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                if (APP_HOST.equals(req.getUrl().getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl())); } catch (Exception ignored) {}
                return true;
            }

            // insets 回调可能早于文档就绪，页面加载完补注一次。
            @Override
            public void onPageFinished(WebView v, String url) { injectInsets(); }
        });

        // 附件上传的 <input type="file">（含 webkitdirectory）→ 系统选择器。
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent intent;
                try { intent = params.createIntent(); }
                catch (Exception e) { intent = new Intent(Intent.ACTION_GET_CONTENT).setType("*/*"); }
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), FILE_CHOOSER);
                } catch (Exception e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "打不开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        // 原生桥：主题同步系统栏图标明暗 + 触感反馈。前端 theme.ts / touch.ts 探测调用。
        web.addJavascriptInterface(new Shell(), "HarnessShell");

        // —— edge-to-edge：内容延伸到系统栏下，安全边距注入 CSS 变量 ——
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarContrastEnforced(false);
            web.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets sys = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                int ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
                float d = getResources().getDisplayMetrics().density;
                cssInsetTop = Math.round(sys.top / d);
                // 键盘：bottomMargin 收缩 WebView（30+ 下 adjustResize 不再自动生效；
                // 不能用 setPadding —— WebView 网页布局忽略自身 padding，实机踩过）。
                FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) v.getLayoutParams();
                int want = ime > 0 ? ime : 0;
                if (lp.bottomMargin != want) { lp.bottomMargin = want; v.setLayoutParams(lp); }
                cssInsetBottom = ime > 0 ? 0 : Math.round(sys.bottom / d);
                injectInsets();
                return insets;
            });
        }

        web.loadUrl(INDEX_URL);
    }

    /** JS 桥。方法在 WebView 线程池被调，UI 操作回主线程。 */
    private class Shell {
        // 状态栏/导航栏图标明暗跟随皮肤（light=true → 深色图标配浅背景）。
        @JavascriptInterface
        public void setBars(final boolean light, final String bg) {
            runOnUiThread(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= 30) {
                        WindowInsetsController c = getWindow().getInsetsController();
                        if (c != null) {
                            int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                            c.setSystemBarsAppearance(light ? mask : 0, mask);
                        }
                    } else {
                        View dv = getWindow().getDecorView();
                        int f = dv.getSystemUiVisibility();
                        if (Build.VERSION.SDK_INT >= 23) {
                            f = light ? (f | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR)
                                      : (f & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
                        }
                        dv.setSystemUiVisibility(f);
                    }
                } catch (Exception ignored) {}
            });
        }

        // 触感：light = 轻点；medium = 确认级。优先系统语义反馈，退振动器。
        @JavascriptInterface
        public void haptic(final String kind) {
            runOnUiThread(() -> {
                try {
                    if ("medium".equals(kind)) {
                        if (Build.VERSION.SDK_INT >= 26) {
                            Vibrator vb = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                            if (vb != null) vb.vibrate(VibrationEffect.createOneShot(18, 160));
                        } else {
                            web.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
                        }
                    } else {
                        web.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
                    }
                } catch (Exception ignored) {}
            });
        }
    }

    // assets 的 MIME —— .js/.woff2 给错会直接加载失败。
    private static String mimeOf(String p) {
        p = p.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".gif")) return "image/gif";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    // 返回键：先给前端关层级（抽屉/sheet/灯箱/预览），全关完退后台（不杀进程，回来秒续）。
    @Override
    public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript("(window.__harnessBack&&window.__harnessBack())?'1':'0'", v -> {
            if (!"\"1\"".equals(v) && !"1".equals(v)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER) {
            if (fileCallback == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{ data.getData() };
                }
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
