package com.musebridge.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLDecoder;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Muse Bridge 安卓端：一个全屏 WebView，打开用户自己那台 Muse 上的 Muse Bridge 网址。
 *
 * 界面全部由服务器提供（跟浏览器里打开一模一样，服务器一更新这里就是新版），本 app 只补浏览器做不到 /
 * 做不好的几件事：记住服务器地址、临时地址变了时原生的「连不上 → 换地址」面板、文件选择 / 下载 /
 * 相机（扫码登录）、系统栏颜色跟着页面走。没有任何第三方依赖。
 *
 * 地址怎么进来：① 首次打开填（可一键粘贴，从一整句话里也能抠出网址）；② 网页「设置 → 安卓 app」里
 * 点「在 app 里打开」，经 musebridge://open?server=… 带进来（会先给用户看一眼地址再连）。
 */
public class MainActivity extends Activity {
    private static final String PREFS = "musebridge";
    private static final String K_SERVER = "server";
    private static final int REQ_FILE = 1, REQ_CAMERA = 2, REQ_STORAGE = 3;

    // 从一段文字里抠网址（用户常把 Muse 回复的整句话粘过来）；中英文标点都当结尾
    private static final Pattern URL_IN_TEXT = Pattern.compile("(?i)https?://[^\\s<>\"'()（）\\[\\]【】「」，。；、,;]+");
    private static final Pattern BARE_HOST = Pattern.compile("(?i)^[a-z0-9-]+(\\.[a-z0-9-]+)+(:\\d+)?(/\\S*)?$");

    // 系统栏颜色跟着页面走：取页面最上沿 / 最下沿那一点的背景色（往父元素找到第一个不透明的）
    private static final String BARS_JS = "(function(){if(window.__mbBars)return;window.__mbBars=1;var lt='',lb='';"
        + "function bg(y){var el=document.elementFromPoint(innerWidth/2,y);while(el&&el.nodeType===1){"
        + "var c=getComputedStyle(el).backgroundColor;if(c&&c!=='transparent'&&!/,\\s*0\\)$/.test(c))return c;el=el.parentElement;}"
        + "var m=document.querySelector('meta[name=theme-color]');return m?m.content:'';}"
        + "function f(){try{var t=bg(1),b=bg(innerHeight-2);if(t!==lt||b!==lb){lt=t;lb=b;MuseBridgeApp.setBarColors(t,b);}}catch(e){}}"
        + "window.__mbBarsKick=function(){lt=lb=null;f();};f();setInterval(f,1000);})();";

    private enum Panel { NONE, SETUP, OFFLINE }

    private FrameLayout root;
    private WebView web;
    private View panelView;
    private Panel panel = Panel.NONE;
    private String server;          // 当前服务器的 origin，如 https://xxxx.trycloudflare.com；null = 还没配
    private boolean pageFailed;     // 这一次主文档加载失败（onPageFinished 里别把「连不上」面板收掉）
    private boolean pageOk;         // 页面至少成功加载过一次（「填地址」面板此时可以取消）
    private ValueCallback<Uri[]> fileCb;
    private PermissionRequest pendingPerm;
    private String[] pendingDownload;   // 等存储权限的下载：url, ua, contentDisposition, mime

    // ───────────────────────── 生命周期 ─────────────────────────

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        applyBars(getColor(R.color.bg), getColor(R.color.bg));
        setupWebView();

        server = getSharedPreferences(PREFS, MODE_PRIVATE).getString(K_SERVER, null);
        if (server != null) load();
        if (!handleDeepLink(getIntent()) && server == null) showSetup(null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeepLink(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        // 回到前台时还停在「连不上」：服务器可能已经恢复了（VM 重启完 / 网络回来），自动再试一次
        if (panel == Panel.OFFLINE && server != null) load();
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        web.onPause();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (panel == Panel.SETUP && server != null && pageOk) { hidePanel(); return; }
        if (panel == Panel.NONE && web.canGoBack()) { web.goBack(); return; }   // 网页自己用 history 逐级关层
        moveTaskToBack(true);
    }

    // ───────────────────────── WebView ─────────────────────────

    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setSupportMultipleWindows(false);
        s.setTextZoom(100);   // 系统字体放大交给网页自己的排版；整页按比例放大会把布局挤坏
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // 网页据此认出自己跑在 app 里（设置页显示 app 版本、换地址按钮）
        s.setUserAgentString(s.getUserAgentString() + " MuseBridgeApp/" + versionName() + " (" + versionCode() + ")");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);

        web.setBackgroundColor(getColor(R.color.bg));
        web.addJavascriptInterface(new JsApi(), "MuseBridgeApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return route(r.getUrl()); }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap favicon) { pageFailed = false; }

            @Override
            public void onPageFinished(WebView v, String url) {
                CookieManager.getInstance().flush();
                if (pageFailed || !isOurs(Uri.parse(url))) return;
                pageOk = true;
                if (panel == Panel.OFFLINE) hidePanel();
                v.evaluateJavascript(BARS_JS, null);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (!r.isForMainFrame()) return;
                pageFailed = true;
                showOffline(String.valueOf(e.getDescription()));
            }

            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse resp) {
                // 隧道断了 / 临时地址失效时 Cloudflare 回 502 / 530 之类的错误页
                if (!r.isForMainFrame() || resp.getStatusCode() < 500) return;
                pageFailed = true;
                showOffline("HTTP " + resp.getStatusCode());
            }

            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                recreate();   // 渲染进程崩了 / 被系统回收：整个重建，比留一块白屏强
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                List<String> mimes = new ArrayList<>();
                for (String a : p.getAcceptTypes()) if (a != null && a.contains("/")) mimes.add(a.trim());
                if (!mimes.isEmpty()) i.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
                if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, null), REQ_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCb = null;
                    return false;
                }
            }

            // 只放行相机（登录页「扫码登录」），而且只给自己的服务器
            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(() -> {
                    boolean video = false;
                    for (String r : req.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) video = true;
                    if (!video || !isOurs(req.getOrigin())) { req.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        req.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                        return;
                    }
                    if (pendingPerm != null) pendingPerm.deny();
                    pendingPerm = req;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest req) { if (pendingPerm == req) pendingPerm = null; }
        });

        web.setDownloadListener((url, ua, cd, mime, len) -> {
            if (url.startsWith("blob:") || url.startsWith("data:")) { toast(getString(R.string.download_blob)); return; }
            if (Build.VERSION.SDK_INT < 29 && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                pendingDownload = new String[]{url, ua, cd, mime};
                requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
                return;
            }
            download(url, ua, cd, mime);
        });
    }

    private void load() {
        pageFailed = false;
        web.loadUrl(server + "/");
    }

    /** 自己服务器上的地址留在 app 里，别的一律交给系统（浏览器 / 对应的 app）。 */
    private boolean route(Uri u) {
        String sc = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        if ((sc.equals("http") || sc.equals("https")) && isOurs(u)) return false;
        if (sc.equals("musebridge")) { handleDeepLink(new Intent(Intent.ACTION_VIEW, u)); return true; }
        try {
            Intent i = sc.equals("intent") ? Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME) : new Intent(Intent.ACTION_VIEW, u);
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            i.setComponent(null);
            i.setSelector(null);
            startActivity(i);
        } catch (Exception e) {
            toast(getString(R.string.no_app));
        }
        return true;
    }

    private boolean isOurs(Uri u) {
        if (server == null || u == null || u.getHost() == null) return false;
        Uri s = Uri.parse(server);
        return u.getHost().equalsIgnoreCase(s.getHost()) && u.getPort() == s.getPort();
    }

    // ───────────────────────── 地址 ─────────────────────────

    /** musebridge://open?server=https://… ：先把地址填进面板给用户看一眼，确认了再连（别让任意网页一跳就把 app 指走）。 */
    private boolean handleDeepLink(Intent it) {
        Uri u = it == null ? null : it.getData();
        if (u == null || !"musebridge".equals(u.getScheme())) return false;
        String target = normalize(u.getQueryParameter("server"));
        if (target == null) return false;
        if (target.equals(server)) {
            if (panel != Panel.NONE) load();
            return true;
        }
        showSetup(target);
        return true;
    }

    /** 从用户输入（或一整句话）里取出服务器的 origin：scheme://host[:port]，没写 scheme 就当 https。 */
    static String normalize(String s) {
        if (s == null) return null;
        s = s.trim();
        if (s.isEmpty()) return null;
        String u;
        Matcher m = URL_IN_TEXT.matcher(s);
        if (m.find()) u = m.group();
        else if (BARE_HOST.matcher(s).matches()) u = "https://" + s;
        else return null;
        Uri p = Uri.parse(u);
        if (p.getHost() == null || p.getHost().isEmpty() || p.getScheme() == null) return null;
        return p.getScheme().toLowerCase() + "://" + p.getHost().toLowerCase() + (p.getPort() > 0 ? ":" + p.getPort() : "");
    }

    private void use(String target) {
        boolean changed = !target.equals(server);
        server = target;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(K_SERVER, target).apply();
        hidePanel();
        if (changed) pageOk = false;
        load();
        if (changed) web.clearHistory();
    }

    /** 连接前先探一下 /healthz：null = 通；否则是给人看的原因。 */
    private String probe(String origin) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(origin + "/healthz").openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            int code = c.getResponseCode();
            return code == 200 ? null : "HTTP " + code;
        } catch (UnknownHostException e) {
            return getString(R.string.err_dns);
        } catch (SocketTimeoutException e) {
            return getString(R.string.err_timeout);
        } catch (Exception e) {
            return e.getClass().getSimpleName();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ───────────────────────── 原生面板 ─────────────────────────

    /** 填地址面板。prefill = 深链带进来的地址（直接填好，用户点「连接」）。 */
    private void showSetup(String prefill) {
        LinearLayout box = newPanel(Panel.SETUP);
        box.addView(title(getString(R.string.setup_title)));
        box.addView(body(getString(R.string.setup_body)), gap(10));

        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        input.setHint(R.string.setup_hint);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        input.setTextColor(getColor(R.color.text));
        input.setHintTextColor(getColor(R.color.muted));
        input.setPadding(dp(14), 0, dp(14), 0);
        input.setBackground(shape(getColor(R.color.field), getColor(R.color.line)));
        if (prefill != null) input.setText(prefill);
        else if (server != null) input.setText(server);
        box.addView(input, sized(ViewGroup.LayoutParams.MATCH_PARENT, dp(48), 22));

        final TextView err = body("");
        err.setTextColor(getColor(R.color.err));
        err.setVisibility(View.GONE);
        box.addView(err, gap(10));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        final TextView paste = button(getString(R.string.paste), false);
        final TextView go = button(getString(R.string.connect), true);
        row.addView(paste, weighted(0));
        row.addView(go, weighted(dp(10)));
        box.addView(row, gap(16));

        final TextView anyway = button(getString(R.string.use_anyway), false);
        anyway.setVisibility(View.GONE);
        box.addView(anyway, sized(ViewGroup.LayoutParams.MATCH_PARENT, dp(44), 10));

        if (server != null && pageOk) {
            TextView cancel = button(getString(R.string.cancel), false);
            cancel.setOnClickListener(v -> hidePanel());
            box.addView(cancel, sized(ViewGroup.LayoutParams.MATCH_PARENT, dp(44), 10));
        }

        paste.setOnClickListener(v -> {
            String clip = clipboardText();
            String u = normalize(clip);
            if (u == null) { toast(getString(R.string.no_url_in_clipboard)); return; }
            input.setText(u);
            input.setSelection(u.length());
        });
        final Runnable connect = () -> {
            final String target = normalize(input.getText().toString());
            anyway.setVisibility(View.GONE);
            if (target == null) { err.setText(R.string.bad_url); err.setVisibility(View.VISIBLE); return; }
            err.setVisibility(View.GONE);
            go.setEnabled(false);
            go.setText(R.string.connecting);
            new Thread(() -> {
                final String problem = probe(target);
                runOnUiThread(() -> {
                    if (isFinishing() || panel != Panel.SETUP) return;
                    go.setEnabled(true);
                    go.setText(R.string.connect);
                    if (problem == null) { use(target); return; }
                    String host = Uri.parse(target).getHost();
                    String msg = getString(R.string.probe_failed, host, problem);
                    if (host != null && host.endsWith("trycloudflare.com")) msg += "\n" + getString(R.string.temp_hint);
                    err.setText(msg);
                    err.setVisibility(View.VISIBLE);
                    anyway.setVisibility(View.VISIBLE);
                    anyway.setOnClickListener(x -> use(target));
                });
            }).start();
        };
        go.setOnClickListener(v -> connect.run());
        input.setOnEditorActionListener((v, action, ev) -> { connect.run(); return true; });
    }

    /** 主文档加载失败：多半是临时地址换了，或者 VM 正在重启。 */
    private void showOffline(String detail) {
        LinearLayout box = newPanel(Panel.OFFLINE);
        box.addView(title(getString(R.string.offline_title)));
        String host = server == null ? "" : Uri.parse(server).getHost();
        String msg = getString(R.string.probe_failed, host, detail);
        if (host != null && host.endsWith("trycloudflare.com")) msg += "\n\n" + getString(R.string.temp_hint);
        box.addView(body(msg), gap(10));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        TextView change = button(getString(R.string.change_server), false);
        final TextView retry = button(getString(R.string.retry), true);
        row.addView(change, weighted(0));
        row.addView(retry, weighted(dp(10)));
        box.addView(row, gap(24));
        change.setOnClickListener(v -> showSetup(null));
        retry.setOnClickListener(v -> { retry.setEnabled(false); retry.setText(R.string.connecting); load(); });
    }

    private LinearLayout newPanel(Panel kind) {
        hidePanel();
        panel = kind;
        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        sv.setBackgroundColor(getColor(R.color.bg));
        sv.setClickable(true);   // 挡住下面的 WebView

        FrameLayout center = new FrameLayout(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(28), dp(40), dp(28), dp(40));
        int w = Math.min(dp(480), getResources().getDisplayMetrics().widthPixels);
        center.addView(box, new FrameLayout.LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        sv.addView(center, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.mipmap.ic_launcher);
        box.addView(logo, sized(dp(56), dp(56), 0));

        root.addView(sv, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        panelView = sv;
        applyBars(getColor(R.color.bg), getColor(R.color.bg));
        return box;
    }

    private void hidePanel() {
        if (panelView != null) root.removeView(panelView);
        panelView = null;
        panel = Panel.NONE;
        web.evaluateJavascript("window.__mbBarsKick&&__mbBarsKick()", null);   // 面板盖着时系统栏是面板色，收起后换回页面色
    }

    private TextView title(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        t.setTypeface(Typeface.SERIF);
        t.setTextColor(getColor(R.color.text));
        t.setPadding(0, dp(20), 0, 0);
        return t;
    }

    private TextView body(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        t.setLineSpacing(0, 1.25f);
        t.setTextColor(getColor(R.color.muted));
        return t;
    }

    private TextView button(String s, boolean primary) {
        TextView b = new TextView(this);
        b.setText(s);
        b.setGravity(Gravity.CENTER);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setClickable(true);
        b.setFocusable(true);
        b.setTextColor(getColor(primary ? R.color.primary_ink : R.color.text));
        b.setBackground(shape(primary ? getColor(R.color.primary) : Color.TRANSPARENT, primary ? 0 : getColor(R.color.line)));
        return b;
    }

    private GradientDrawable shape(int fill, int stroke) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(10));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    private LinearLayout.LayoutParams gap(int top) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(top);
        return lp;
    }

    private LinearLayout.LayoutParams sized(int w, int h, int top) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(w, h);
        lp.topMargin = dp(top);
        return lp;
    }

    private LinearLayout.LayoutParams weighted(int left) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(44), 1f);
        lp.leftMargin = left;
        return lp;
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    // ───────────────────────── 系统栏 ─────────────────────────

    private void applyBars(int top, int bottom) {
        Window w = getWindow();
        w.setStatusBarColor(top);
        w.setNavigationBarColor(bottom);
        View d = w.getDecorView();
        int f = d.getSystemUiVisibility();
        f = isLight(top) ? (f | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) : (f & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        if (Build.VERSION.SDK_INT >= 26) {
            f = isLight(bottom) ? (f | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR) : (f & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
        d.setSystemUiVisibility(f);
    }

    private static boolean isLight(int c) {
        return (0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c)) > 150;
    }

    /** CSS 颜色（rgb() / rgba() / #hex）→ 不透明的 int；认不出返回 null。 */
    static Integer parseCss(String s) {
        if (s == null) return null;
        s = s.trim();
        try {
            if (s.startsWith("#")) {
                String h = s.substring(1);
                if (h.length() == 3) h = "" + h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
                if (h.length() >= 6) return 0xff000000 | Integer.parseInt(h.substring(0, 6), 16);
                return null;
            }
            Matcher m = Pattern.compile("rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)").matcher(s);
            if (m.find()) {
                return Color.rgb(Math.round(Float.parseFloat(m.group(1))), Math.round(Float.parseFloat(m.group(2))), Math.round(Float.parseFloat(m.group(3))));
            }
        } catch (Exception ignored) {}
        return null;
    }

    // ───────────────────────── 下载 / 文件 / 权限 ─────────────────────────

    private void download(String url, String ua, String cd, String mime) {
        try {
            String name = fileName(url, cd, mime);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            String cookie = CookieManager.getInstance().getCookie(url);   // 下载要带上登录态
            if (cookie != null) r.addRequestHeader("Cookie", cookie);
            if (ua != null && !ua.isEmpty()) r.addRequestHeader("User-Agent", ua);
            if (mime != null && !mime.isEmpty()) r.setMimeType(mime);
            r.setTitle(name);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
            toast(getString(R.string.download_started, name));
        } catch (Exception e) {
            toast(getString(R.string.download_failed));
        }
    }

    /** 文件名：先认 filename*=UTF-8''…（中文名都走这个），再认 filename="…"，最后交给系统猜。 */
    static String fileName(String url, String cd, String mime) {
        if (cd != null) {
            Matcher m = Pattern.compile("(?i)filename\\*\\s*=\\s*UTF-8''([^;]+)").matcher(cd);
            try { if (m.find()) return clean(URLDecoder.decode(m.group(1).trim(), "UTF-8")); } catch (Exception ignored) {}
            m = Pattern.compile("(?i)filename\\s*=\\s*\"([^\"]+)\"").matcher(cd);
            if (m.find()) return clean(m.group(1));
        }
        return clean(URLUtil.guessFileName(url, cd, mime));
    }

    private static String clean(String n) {
        n = n.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        return n.isEmpty() ? "download" : n;
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != REQ_FILE) { super.onActivityResult(req, res, data); return; }
        if (fileCb == null) return;
        Uri[] out = null;
        if (res == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                out = new Uri[clip.getItemCount()];
                for (int i = 0; i < out.length; i++) out[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                out = new Uri[]{data.getData()};
            }
        }
        fileCb.onReceiveValue(out);
        fileCb = null;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (code == REQ_CAMERA && pendingPerm != null) {
            if (ok) pendingPerm.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            else pendingPerm.deny();
            pendingPerm = null;
        } else if (code == REQ_STORAGE && pendingDownload != null) {
            String[] d = pendingDownload;
            pendingDownload = null;
            if (ok) download(d[0], d[1], d[2], d[3]);
            else toast(getString(R.string.download_failed));
        }
    }

    // ───────────────────────── 杂项 ─────────────────────────

    private String clipboardText() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            ClipData c = cm.getPrimaryClip();
            if (c == null || c.getItemCount() == 0) return null;
            CharSequence t = c.getItemAt(0).coerceToText(this);
            return t == null ? null : t.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show(); }

    private String versionName() {
        try { return pkg().versionName; } catch (Exception e) { return "dev"; }
    }

    @SuppressWarnings("deprecation")
    private long versionCode() {
        try {
            PackageInfo p = pkg();
            return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private PackageInfo pkg() throws PackageManager.NameNotFoundException {
        return getPackageManager().getPackageInfo(getPackageName(), 0);
    }

    /** 给网页用的接口（window.MuseBridgeApp）。只有自己服务器的页面会留在这个 WebView 里。 */
    private class JsApi {
        @JavascriptInterface public String server() { return server == null ? "" : server; }
        @JavascriptInterface public String versionName() { return MainActivity.this.versionName(); }
        @JavascriptInterface public long versionCode() { return MainActivity.this.versionCode(); }
        @JavascriptInterface public void changeServer() { runOnUiThread(() -> showSetup(null)); }
        @JavascriptInterface public void setBarColors(String top, String bottom) {
            final Integer t = parseCss(top), b = parseCss(bottom);
            if (t == null && b == null) return;
            runOnUiThread(() -> {
                if (panel != Panel.NONE) return;
                int bg = getColor(R.color.bg);
                applyBars(t != null ? t : bg, b != null ? b : bg);
            });
        }
    }
}
