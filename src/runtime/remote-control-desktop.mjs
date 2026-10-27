// 反向控制·二期：真·桌面控制（截真屏 + 真鼠标键盘），跑在被控客户端里；本机 Agent（localPc）也走这一份。
//
// 一期是工作区级（shell/文件/无头浏览器）；二期让远程 agent 看真实屏幕、点真实界面、
// 敲真实键盘——能操作任何桌面应用，不再局限于工作区。这是比一期大一个量级的暴露面
// （截屏=看到整个屏幕含其它应用/通知/别处输入的内容），所以另有一道**独立开关**
// BRIDGE_ALLOW_DESKTOP_CONTROL（客户端 control.allowDesktop，默认关；且需先开 allowRemote）。
//
// 实现：零原生依赖，用 Windows 自带 PowerShell + .NET——CopyFromScreen/PrintWindow 截屏、
// SendInput 鼠标键盘、UI Automation 读控件。起一个**常驻 PS 宿主**：Add-Type 只编译一次，
// 之后按行 JSON 协议收发命令，摊薄冷启动开销。截图写临时文件回传路径（避免大块 base64 挤爆
// stdout 行协议），node 侧现读现删再转 base64。
//
// 坐标体系（2026-10-20 照官方 Claude Desktop computer use 重做）：
//   · 截图在宿主里就缩到模型的图片预算内（官方同参：28px/token、最长边 ≤1568、≤1568 token），
//     模型看到的图＝坐标帧，客户端不会再二次缩放；
//   · 每张截图记一个「帧」（物理区域 + 图片尺寸 + 是否某个窗口），之后的点击/移动/滚动收的是
//     「这张图里读到的像素」，这里换算回屏幕；超出帧直接报错、没截过图也报错——不再静默点歪；
//   · 帧是某个窗口时按窗口**当前**位置换算（窗口挪了照样点准），尺寸变了就要求重新截图；
//   · 点之前做命中测试：落点属于哪个窗口/控件随结果回报；落在急停横幅上、或窗口截图的目标被
//     别的程序挡住时拒绝点击并说明。

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 图片预算：与官方 Windows executor 相同（index.chunk-BKirSAUO 的 qz）。
export const IMAGE_BUDGET = Object.freeze({ pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 });

// 常驻 PS 宿主脚本（落盘带 BOM，见 ensureScript）；stdin/stdout 设 UTF-8 以正确收发中文。
// 协议：node 每行一条 {id,op,...}；宿主每行回一条 {id,ok,...}。
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public class RcDesk {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }

  public static IntPtr[] Windows() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  public static void Dpi() {
    // per-monitor v2：多屏不同缩放时窗口矩形/截图/光标也都是物理像素；老系统退回 system-aware
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}
    SetProcessDPIAware();
  }
  // 官方 Jz：在 token 预算内取最大的等比尺寸
  static int Tok(int w, int h, int px) { return ((w - 1) / px + 1) * ((h - 1) / px + 1); }
  public static int[] Fit(int w, int h, int px, int maxPx, int maxTok) {
    if (w <= maxPx && h <= maxPx && Tok(w, h, px) <= maxTok) return new int[] { w, h };
    bool swap = h > w; if (swap) { int t = w; w = h; h = t; }
    double r = (double)w / h; int lo = 1, hi = w;
    while (lo + 1 < hi) { int m = (lo + hi) / 2; int mh = Math.Max((int)Math.Round(m / r), 1); if (m <= maxPx && Tok(m, mh, px) <= maxTok) lo = m; else hi = m; }
    int rw = lo, rh = Math.Max((int)Math.Round(lo / r), 1);
    return swap ? new int[] { rh, rw } : new int[] { rw, rh };
  }

  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags; return i; }
  static INPUT Mouse(uint flags, int data) { var i = new INPUT(); i.type = 0; i.U.mi.dwFlags = flags; i.U.mi.mouseData = (uint)data; return i; }
  static void Send(List<INPUT> list) {
    if (list.Count == 0) return;
    uint n = SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    if (n != list.Count) throw new Exception("SendInput was blocked (" + n + "/" + list.Count + "); the target may be elevated or the desktop is locked");
  }
  static bool Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x6F || vk == 0x90 || vk == 0xA3 || vk == 0xA5; }

  // Unicode 直输（KEYEVENTF_UNICODE）：不经过输入法、不碰剪贴板，中文/emoji 都行；换行/Tab 走真按键。
  public static int TypeText(string s) {
    var batch = new List<INPUT>(); int sent = 0;
    for (int i = 0; i < s.Length; i++) {
      char c = s[i];
      if (c == '\r') { if (i + 1 < s.Length && s[i + 1] == '\n') continue; c = '\n'; }
      if (c == '\n' || c == '\t') { ushort vk = (ushort)(c == '\n' ? 0x0D : 0x09); batch.Add(Key(vk, 0, 0)); batch.Add(Key(vk, 0, 2)); }
      else { batch.Add(Key(0, c, 4)); batch.Add(Key(0, c, 4 | 2)); }
      sent++;
      if (batch.Count >= 64) { Send(batch); batch.Clear(); Thread.Sleep(8); }
    }
    Send(batch);
    return sent;
  }
  // 组合键：mods 依次按下、主键按下抬起、mods 逆序抬起
  public static void Chord(ushort[] mods, ushort key) {
    var l = new List<INPUT>();
    foreach (var m in mods) l.Add(Key(m, 0, Extended(m) ? 1u : 0u));
    if (key != 0) { uint f = Extended(key) ? 1u : 0u; l.Add(Key(key, 0, f)); l.Add(Key(key, 0, f | 2)); }
    for (int i = mods.Length - 1; i >= 0; i--) l.Add(Key(mods[i], 0, (Extended(mods[i]) ? 1u : 0u) | 2));
    Send(l);
  }
  public static void Click(string button, int count) {
    uint down = 0x0002, up = 0x0004;
    if (button == "right") { down = 0x0008; up = 0x0010; } else if (button == "middle") { down = 0x0020; up = 0x0040; }
    for (int i = 0; i < Math.Max(1, count); i++) { var l = new List<INPUT>(); l.Add(Mouse(down, 0)); l.Add(Mouse(up, 0)); Send(l); Thread.Sleep(35); }
  }
  public static void Wheel(int notches) { var l = new List<INPUT>(); l.Add(Mouse(0x0800, notches * 120)); Send(l); }

  // —— 结果确认用的画面指纹 ——
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr dc, int mode);
  [DllImport("gdi32.dll")] static extern bool SetBrushOrgEx(IntPtr dc, int x, int y, IntPtr p);
  [DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr d, int dx, int dy, int dw, int dh, IntPtr s, int sx, int sy, int sw, int sh, uint rop);
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr bmp, uint start, uint lines, byte[] bits, ref BMIH bi, uint usage);
  [StructLayout(LayoutKind.Sequential)] public struct BMIH { public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount; public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter; public uint biClrUsed; public uint biClrImportant; }
  // 屏幕上一块区域 HALFTONE 缩成 sw x sh 的灰度图（按面积平均：光标闪烁这种细线基本被抹平，勾选框、弹窗这种块状变化留得住）
  public static byte[] Sig(int x, int y, int w, int h, int sw, int sh) {
    if (w < 1 || h < 1 || sw < 1 || sh < 1) return null;
    IntPtr scr = GetDC(IntPtr.Zero); IntPtr mem = CreateCompatibleDC(scr); IntPtr bmp = CreateCompatibleBitmap(scr, sw, sh);
    IntPtr old = SelectObject(mem, bmp);
    SetStretchBltMode(mem, 4); SetBrushOrgEx(mem, 0, 0, IntPtr.Zero);
    StretchBlt(mem, 0, 0, sw, sh, scr, x, y, w, h, 0x00CC0020);
    SelectObject(mem, old);
    var bi = new BMIH(); bi.biSize = (uint)Marshal.SizeOf(typeof(BMIH)); bi.biWidth = sw; bi.biHeight = -sh; bi.biPlanes = 1; bi.biBitCount = 32;
    var buf = new byte[sw * sh * 4];
    GetDIBits(scr, bmp, 0, (uint)sh, buf, ref bi, 0);
    DeleteObject(bmp); DeleteDC(mem); ReleaseDC(IntPtr.Zero, scr);
    var g = new byte[sw * sh];
    for (int i = 0; i < g.Length; i++) g[i] = (byte)((buf[i * 4] + buf[i * 4 + 1] * 6 + buf[i * 4 + 2] * 3) / 10);
    return g;
  }
  public static int DiffCells(byte[] a, byte[] b, int thr) {
    if (a == null || b == null || a.Length != b.Length) return 0;
    int n = 0; for (int i = 0; i < a.Length; i++) if (Math.Abs(a[i] - b[i]) > thr) n++;
    return n;
  }
  // 同上，但跳过与 masks（屏幕坐标矩形 x,y,w,h,…）重叠的格子：输入光标一闪一灭不算画面变化
  public static int DiffMasked(byte[] a, byte[] b, int thr, int rx, int ry, int rw, int rh, int sw, int sh, int[] masks) {
    if (a == null || b == null || a.Length != b.Length || sw < 1 || sh < 1) return 0;
    if (masks == null || masks.Length < 4) return DiffCells(a, b, thr);
    double cw = (double)rw / sw, ch = (double)rh / sh;
    int n = 0;
    for (int yy = 0; yy < sh; yy++) for (int xx = 0; xx < sw; xx++) {
      int i = yy * sw + xx;
      if (Math.Abs(a[i] - b[i]) <= thr) continue;
      double x0 = rx + xx * cw, y0 = ry + yy * ch, x1 = x0 + cw, y1 = y0 + ch;
      bool masked = false;
      for (int m = 0; m + 3 < masks.Length && !masked; m += 4) {
        if (masks[m + 2] <= 0) continue;
        if (x0 < masks[m] + masks[m + 2] && x1 > masks[m] && y0 < masks[m + 1] + masks[m + 3] && y1 > masks[m + 1]) masked = true;
      }
      if (!masked) n++;
    }
    return n;
  }
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize; public int flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  // 前台线程的系统输入光标（屏幕坐标，四周放宽 3px）；没有回空数组
  public static int[] Caret() {
    uint pid; uint tid = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    if (tid == 0) return new int[0];
    var gi = new GUITHREADINFO(); gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(tid, ref gi) || gi.hwndCaret == IntPtr.Zero) return new int[0];
    var p = new POINT(); p.X = gi.rcCaret.Left; p.Y = gi.rcCaret.Top;
    if (!ClientToScreen(gi.hwndCaret, ref p)) return new int[0];
    int w = Math.Max(1, gi.rcCaret.Right - gi.rcCaret.Left), h = Math.Max(1, gi.rcCaret.Bottom - gi.rcCaret.Top);
    return new int[] { p.X - 3, p.Y - 3, w + 6, h + 6 };
  }
  public static int[] Join(int[] a, int[] b) { var r = new int[(a == null ? 0 : a.Length) + (b == null ? 0 : b.Length)]; if (a != null) a.CopyTo(r, 0); if (b != null) b.CopyTo(r, a == null ? 0 : a.Length); return r; }
  // 有标题的可见顶层窗口句柄，排好序拼成一串：前后两串一比就知道有没有开/关窗口
  // 桌面壳自己的指示器（顶部状态条、全屏覆盖层）：不算进窗口表，它们的出现/消失不是操作的结果
  public static bool Ours(IntPtr h) { return Title(h).StartsWith("bridge-local-pc-"); }
  public static string TopKey() {
    var l = new List<long>();
    EnumWindows((h, p) => { if (IsWindowVisible(h) && GetWindowTextLength(h) > 0 && !Ours(h)) l.Add(h.ToInt64()); return true; }, IntPtr.Zero);
    l.Sort();
    return string.Join(",", l);
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  // 真鼠标按 easeOutCubic 滑到目标（官方 computer use 的 mouseAnimation 同一做法）：用户看得出指针往哪去了；
  // 时长按距离 140~300ms，覆盖层的 Claude 指针用同一条曲线、同一个时长画在上面
  public static int GlideMs(int x1, int y1) {
    POINT c; GetCursorPos(out c);
    double d = Math.Sqrt((double)(x1 - c.X) * (x1 - c.X) + (double)(y1 - c.Y) * (y1 - c.Y));
    return d < 6 ? 0 : (int)Math.Max(140, Math.Min(300, 110 + d * 0.09));
  }
  public static void Glide(int x1, int y1, int ms) {
    POINT c; GetCursorPos(out c);
    if (ms <= 0) { SetCursorPos(x1, y1); return; }
    var sw = System.Diagnostics.Stopwatch.StartNew();
    while (true) {
      double t = Math.Min(1.0, sw.ElapsedMilliseconds / (double)ms);
      double e = 1 - Math.Pow(1 - t, 3);
      SetCursorPos((int)Math.Round(c.X + (x1 - c.X) * e), (int)Math.Round(c.Y + (y1 - c.Y) * e));
      if (t >= 1.0) break;
      Thread.Sleep(7);
    }
  }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);

  public static IntPtr RootAt(int x, int y) {
    var p = new POINT(); p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    return h == IntPtr.Zero ? h : GetAncestor(h, 2);
  }
  // 前台锁：后台进程默认抢不到前台。先注入一个「零位移」鼠标事件让本进程成为最近输入来源（不会有任何按键副作用），
  // 不行再挂到前台线程的输入队列上借道
  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    if (GetForegroundWindow() == h) return true;
    var l = new List<INPUT>(); l.Add(Mouse(0x0001, 0)); try { Send(l); } catch {}
    SetForegroundWindow(h); BringWindowToTop(h);
    for (int i = 0; i < 10 && GetForegroundWindow() != h; i++) Thread.Sleep(15);
    if (GetForegroundWindow() == h) return true;
    uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid); uint me = GetCurrentThreadId();
    if (fg != 0 && fg != me) { AttachThreadInput(me, fg, true); SetForegroundWindow(h); BringWindowToTop(h); AttachThreadInput(me, fg, false); }
    for (int i = 0; i < 10 && GetForegroundWindow() != h; i++) Thread.Sleep(15);
    return GetForegroundWindow() == h;
  }
  public static ushort Vk(char c) { return (ushort)(VkKeyScan(c) & 0xFF); }
  public static bool NeedsShift(char c) { return ((VkKeyScan(c) >> 8) & 1) == 1; }
}

// —— 原生 COM UI Automation ——
// .NET 自带的 System.Windows.Automation 在这里装不上 Win32 控件代理：经典程序（Win32 对话框、WinForms）的按钮、
// 输入框、勾选框全都只显示成没有任何 pattern 的 Pane，按名字点不了、勾选状态和输入框内容也读不到、认不出密码框。
// 原生 COM 版（UIAutomationCore，Inspect.exe 用的就是它）自带这些代理，所以整层换成 COM。vtable 顺序照 UIAutomationClient.h。
[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUia {
  void CompareElements(); void CompareRuntimeIds(); void GetRootElement();
  [PreserveSig] int ElementFromHandle(IntPtr hwnd, out IUiaEl el);
  [PreserveSig] int ElementFromPoint(RcDesk.POINT pt, out IUiaEl el);
  [PreserveSig] int GetFocusedElement(out IUiaEl el);
  void GetRootElementBuildCache(); void ElementFromHandleBuildCache(); void ElementFromPointBuildCache(); void GetFocusedElementBuildCache(); void CreateTreeWalker();
  [PreserveSig] int get_ControlViewWalker(out IUiaWalker w);
}
[ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUiaEl {
  [PreserveSig] int SetFocus();
  void GetRuntimeId(); void FindFirst(); void FindAll(); void FindFirstBuildCache(); void FindAllBuildCache(); void BuildUpdatedCache();
  [PreserveSig] int GetCurrentPropertyValue(int id, out object v);
  void GetCurrentPropertyValueEx(); void GetCachedPropertyValue(); void GetCachedPropertyValueEx(); void GetCurrentPatternAs(); void GetCachedPatternAs();
  [PreserveSig] int GetCurrentPattern(int id, [MarshalAs(UnmanagedType.IUnknown)] out object p);
}
[ComImport, Guid("4042c624-389c-4afc-a630-9df854a541fc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUiaWalker {
  void GetParentElement();
  [PreserveSig] int GetFirstChildElement(IUiaEl el, out IUiaEl child);
  void GetLastChildElement();
  [PreserveSig] int GetNextSiblingElement(IUiaEl el, out IUiaEl next);
}
[ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUiaInvoke { [PreserveSig] int Invoke(); }
[ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUiaValue { [PreserveSig] int SetValue([MarshalAs(UnmanagedType.BStr)] string v); }
[ComImport, Guid("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUiaToggle { [PreserveSig] int Toggle(); }
[ComImport, Guid("619be086-1f4e-4ee4-bafa-210128738730"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUiaExpand { [PreserveSig] int Expand(); [PreserveSig] int Collapse(); }
[ComImport, Guid("a8efa66a-0fda-421a-9194-38021f3578ea"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUiaSelItem { [PreserveSig] int Select(); }
[ComImport, Guid("b488300f-d015-4f19-9c29-bb595e3645ef"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUiaScrollItem { [PreserveSig] int ScrollIntoView(); }
[ComImport, Guid("32eba289-3583-42c9-9c59-3b6d9a1e9b6a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUiaText { void RangeFromPoint(); void RangeFromChild(); void GetSelection(); void GetVisibleRanges(); [PreserveSig] int get_DocumentRange(out IUiaRange r); }
[ComImport, Guid("a543cc6a-f4ae-494b-8239-c814481187a8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUiaRange {
  void Clone(); void Compare(); void CompareEndpoints(); void ExpandToEnclosingUnit(); void FindAttribute(); void FindText(); void GetAttributeValue(); void GetBoundingRectangles(); void GetEnclosingElement();
  [PreserveSig] int GetText(int max, [MarshalAs(UnmanagedType.BStr)] out string text);
}

public class UiaInfo {
  public int @ref, parent, level;
  public string controlType, name, automationId, className;
  public bool enabled, offscreen, password;
  public int x, y, w, h, pid; public long hwnd;
}
public class UiaState {
  public string type, name, automationId, toggle, expand, value;
  public bool enabled, password, gone, hasSelected, selected;
}

// PowerShell 会把 COM 对象包成 __ComObject、再传回 C# 时转不成接口：元素一律留在这里，PowerShell 只拿编号与普通数据。
public static class RcUia {
  static IUia uia;
  static IUia U() {
    if (uia == null) {
      // CUIAutomation8（Win8+）跨进程超时更稳，没有就退回 CUIAutomation
      try { uia = (IUia)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9"))); }
      catch { uia = (IUia)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e"))); }
    }
    return uia;
  }
  static IUiaWalker walker;
  static IUiaWalker W() { if (walker == null) U().get_ControlViewWalker(out walker); return walker; }
  static IUiaEl FromHandle(IntPtr h) { IUiaEl e; return U().ElementFromHandle(h, out e) == 0 ? e : null; }
  static IUiaEl FromPoint(int x, int y) { var p = new RcDesk.POINT(); p.X = x; p.Y = y; IUiaEl e; return U().ElementFromPoint(p, out e) == 0 ? e : null; }
  static IUiaEl Focused() { IUiaEl e; try { return U().GetFocusedElement(out e) == 0 ? e : null; } catch { return null; } }
  static IUiaEl FirstChild(IUiaEl e) { IUiaEl c; try { return W().GetFirstChildElement(e, out c) == 0 ? c : null; } catch { return null; } }
  static IUiaEl Next(IUiaEl e) { IUiaEl n; try { return W().GetNextSiblingElement(e, out n) == 0 ? n : null; } catch { return null; } }

  static object P(IUiaEl e, int id) { object v = null; try { if (e.GetCurrentPropertyValue(id, out v) != 0) return null; } catch { return null; } return v; }
  static string S(IUiaEl e, int id) { var v = P(e, id); return v as string ?? (v == null ? "" : v.ToString()); }
  static bool B(IUiaEl e, int id) { var v = P(e, id); return v is bool && (bool)v; }
  static int I(IUiaEl e, int id, int dflt) { var v = P(e, id); return v is int ? (int)v : dflt; }
  static readonly Dictionary<int, string> Types = new Dictionary<int, string> {
    {50000,"Button"},{50001,"Calendar"},{50002,"CheckBox"},{50003,"ComboBox"},{50004,"Edit"},{50005,"Hyperlink"},{50006,"Image"},
    {50007,"ListItem"},{50008,"List"},{50009,"Menu"},{50010,"MenuBar"},{50011,"MenuItem"},{50012,"ProgressBar"},{50013,"RadioButton"},
    {50014,"ScrollBar"},{50015,"Slider"},{50016,"Spinner"},{50017,"StatusBar"},{50018,"Tab"},{50019,"TabItem"},{50020,"Text"},
    {50021,"ToolBar"},{50022,"ToolTip"},{50023,"Tree"},{50024,"TreeItem"},{50025,"Custom"},{50026,"Group"},{50027,"Thumb"},
    {50028,"DataGrid"},{50029,"DataItem"},{50030,"Document"},{50031,"SplitButton"},{50032,"Window"},{50033,"Pane"},{50034,"Header"},
    {50035,"HeaderItem"},{50036,"Table"},{50037,"TitleBar"},{50038,"Separator"},{50039,"SemanticZoom"},{50040,"AppBar"}};
  static string TypeName(IUiaEl e) { int t = I(e, 30003, 0); string n; return Types.TryGetValue(t, out n) ? n : (t == 0 ? "Control" : "Control" + t); }
  static UiaInfo Info(IUiaEl e) {
    var i = new UiaInfo();
    i.controlType = TypeName(e); i.name = S(e, 30005); i.automationId = S(e, 30011); i.className = S(e, 30012);
    i.enabled = B(e, 30010); i.offscreen = B(e, 30022); i.password = B(e, 30019);
    i.hwnd = I(e, 30020, 0); i.pid = I(e, 30002, 0);
    var r = P(e, 30001) as double[];
    if (r != null && r.Length == 4 && !double.IsInfinity(r[0])) { i.x = (int)r[0]; i.y = (int)r[1]; i.w = (int)r[2]; i.h = (int)r[3]; }
    return i;
  }
  static int[] Rect(IUiaEl e) {
    if (e == null) return null;
    var r = P(e, 30001) as double[];
    if (r == null || r.Length != 4 || double.IsInfinity(r[0]) || r[2] < 1 || r[3] < 1) return null;
    return new int[] { (int)r[0], (int)r[1], (int)r[2], (int)r[3] };
  }
  static object Pat(IUiaEl e, int id) { object p = null; try { if (e.GetCurrentPattern(id, out p) != 0) return null; } catch { return null; } return p; }
  // 读控件的文字内容：Value 优先，没有再读 Text（富文本、文档）
  static string ReadValue(IUiaEl e) {
    if (B(e, 30043)) { var v = P(e, 30045); if (v is string) return (string)v; }
    if (B(e, 30040)) {
      var tp = Pat(e, 10014) as IUiaText;
      if (tp != null) { IUiaRange r; if (tp.get_DocumentRange(out r) == 0 && r != null) { string s; if (r.GetText(4000, out s) == 0) return s; } }
    }
    return null;
  }
  static readonly string[] ToggleNames = { "Off", "On", "Indeterminate" };
  static readonly string[] ExpandNames = { "Collapsed", "Expanded", "PartiallyExpanded", "LeafNode" };
  // 可观察状态；密码框只标记，绝不读值
  static UiaState State(IUiaEl e) {
    var s = new UiaState();
    if (e == null) { s.gone = true; return s; }
    try {
      object probe; if (e.GetCurrentPropertyValue(30003, out probe) != 0 || probe == null || (probe is int && (int)probe == 0)) { s.gone = true; return s; }
      s.type = TypeName(e); s.name = S(e, 30005); s.automationId = S(e, 30011); s.enabled = B(e, 30010); s.password = B(e, 30019);
      if (B(e, 30041)) { int t = I(e, 30086, -1); if (t >= 0 && t < 3) s.toggle = ToggleNames[t]; }
      if (B(e, 30028)) { int t = I(e, 30070, -1); if (t >= 0 && t < 4) s.expand = ExpandNames[t]; }
      if (B(e, 30036)) { s.hasSelected = true; s.selected = B(e, 30079); }
      if (!s.password) s.value = ReadValue(e);
    } catch { s.gone = true; }
    return s;
  }
  static void Act(IUiaEl e, string action, string value) {
    int hr = -1;
    switch (action) {
      case "focus": hr = e.SetFocus(); break;
      case "invoke": { var p = Pat(e, 10000) as IUiaInvoke; if (p == null) throw new Exception("element has no Invoke pattern; try act click with this ref"); hr = p.Invoke(); break; }
      case "set_value": { var p = Pat(e, 10002) as IUiaValue; if (p == null) throw new Exception("element has no Value pattern; click it with this ref, then type"); hr = p.SetValue(value ?? ""); break; }
      case "select": { var p = Pat(e, 10010) as IUiaSelItem; if (p == null) throw new Exception("element has no SelectionItem pattern"); hr = p.Select(); break; }
      case "toggle": { var p = Pat(e, 10015) as IUiaToggle; if (p == null) throw new Exception("element has no Toggle pattern"); hr = p.Toggle(); break; }
      case "expand": { var p = Pat(e, 10005) as IUiaExpand; if (p == null) throw new Exception("element has no ExpandCollapse pattern"); hr = p.Expand(); break; }
      case "collapse": { var p = Pat(e, 10005) as IUiaExpand; if (p == null) throw new Exception("element has no ExpandCollapse pattern"); hr = p.Collapse(); break; }
      case "scroll_into_view": { var p = Pat(e, 10017) as IUiaScrollItem; if (p == null) throw new Exception("element has no ScrollItem pattern"); hr = p.ScrollIntoView(); break; }
      default: throw new Exception("unknown UIA action: " + action);
    }
    if (hr != 0) throw new Exception("UIA " + action + " failed (0x" + hr.ToString("X8") + "); the element may be disabled or gone - run uia_tree again");
  }

  // —— uia_tree 的 ref 表 ——
  static Dictionary<int, IUiaEl> refs = new Dictionary<int, IUiaEl>();
  public static bool LastTruncated;
  public static UiaInfo[] Tree(IntPtr hwnd, int depth, int max) {
    var root = FromHandle(hwnd);
    if (root == null) throw new Exception("UI Automation cannot attach to this window");
    refs = new Dictionary<int, IUiaEl>();
    var nodes = new List<UiaInfo>();
    var queue = new List<object[]>(); queue.Add(new object[] { root, 0, 0 });
    int qi = 0, next = 1;
    while (qi < queue.Count && nodes.Count < max) {
      var item = queue[qi++]; var el = (IUiaEl)item[0]; int parent = (int)item[1], level = (int)item[2];
      int id = next++;
      UiaInfo info; try { info = Info(el); } catch { continue; }
      refs[id] = el; info.@ref = id; info.parent = parent; info.level = level; nodes.Add(info);
      if (level >= depth) continue;
      var c = FirstChild(el);
      while (c != null && queue.Count + nodes.Count < max * 2) { queue.Add(new object[] { c, id, level + 1 }); c = Next(c); }
    }
    LastTruncated = qi < queue.Count;
    return nodes.ToArray();
  }
  static IUiaEl Ref(int id) { IUiaEl e; if (!refs.TryGetValue(id, out e)) throw new Exception("unknown/stale UIA ref; run uia_tree again"); return e; }
  public static int[] RefRect(int id) { var r = Rect(Ref(id)); if (r == null) throw new Exception("that UIA element has no on-screen rectangle (offscreen/collapsed/gone)"); return r; }
  public static string RefName(int id) { try { return S(Ref(id), 30005); } catch { return ""; } }
  public static bool FocusIsPassword() { var f = Focused(); return f != null && B(f, 30019); }
  public static void ActRef(int id, string action, string value) { Act(Ref(id), action, value); }

  // —— 命中测试与结果确认要盯的控件 ——
  static IUiaEl hit, watch;
  public static UiaInfo HitAt(int x, int y) { hit = null; try { hit = FromPoint(x, y); } catch { } return hit == null ? null : Info(hit); }
  public static void WatchHit() { watch = hit; }
  public static void WatchRef(int id) { watch = Ref(id); }
  public static void WatchNone() { watch = null; }
  public static bool HasWatch() { return watch != null; }
  public static UiaState WatchState() { return State(watch); }
  public static int[] WatchRect() { return Rect(watch); }
  public static UiaState FocusState() { var f = Focused(); return f == null ? null : State(f); }
  public static int[] FocusRect() { return Rect(Focused()); }

  // 前台窗口控件树里按名字（或非密码输入框的内容）找一段文字——预期里的 text
  public static string FindText(IntPtr hwnd, string q, int maxNodes, int maxMs) {
    var root = FromHandle(hwnd); if (root == null) return null;
    q = q.ToLowerInvariant();
    var sw = System.Diagnostics.Stopwatch.StartNew();
    var queue = new Queue<IUiaEl>(); queue.Enqueue(root); int n = 0;
    while (queue.Count > 0 && n < maxNodes && sw.ElapsedMilliseconds < maxMs) {
      var e = queue.Dequeue(); n++;
      string nm = S(e, 30005);
      if (nm.Length > 0 && nm.ToLowerInvariant().Contains(q)) return nm;
      if (B(e, 30043) && !B(e, 30019)) { var v = P(e, 30045) as string; if (v != null && v.ToLowerInvariant().Contains(q)) return v.Length > 120 ? v.Substring(0, 120) : v; }
      var c = FirstChild(e); while (c != null) { queue.Enqueue(c); c = Next(c); }
    }
    return null;
  }
}
'@
[RcDesk]::Dpi()
function Get-Bounds($display, $window) {
  if ($null -ne $window -and [long]$window -ne 0) {
    $r = New-Object RcDesk+RECT
    if ([RcDesk]::GetWindowRect([IntPtr][long]$window, [ref]$r)) { return New-Object System.Drawing.Rectangle $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top) }
    throw 'window not found (closed?)'
  }
  if ($display -eq -1) { return [System.Windows.Forms.SystemInformation]::VirtualScreen }
  $s = [System.Windows.Forms.Screen]::AllScreens
  if ($null -ne $display -and $display -ge 0 -and $display -lt $s.Length) { return $s[$display].Bounds }
  return [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
}
function Do-Displays {
  $arr = @(); $s = [System.Windows.Forms.Screen]::AllScreens
  for ($i = 0; $i -lt $s.Length; $i++) { $b = $s[$i].Bounds; $arr += @{ index = $i; primary = $s[$i].Primary; x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height } }
  return ,$arr
}
function Capture-Raw($b, $window) {
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  # 指定了窗口：先让窗口自己画进位图（PrintWindow + PW_RENDERFULLCONTENT=2），盖在上面的别的窗口不会混进来；
  # 画不出来（老式/受保护窗口返回 false、或整张是黑的）再退回按屏幕区域截。
  $printed = $false
  if ($null -ne $window -and [long]$window -ne 0 -and -not [RcDesk]::IsIconic([IntPtr][long]$window)) {
    $hdc = $g.GetHdc()
    try { $printed = [RcDesk]::PrintWindow([IntPtr][long]$window, $hdc, 2) } finally { $g.ReleaseHdc($hdc) }
    if ($printed) {
      $lit = $false
      foreach ($f in 0.25, 0.5, 0.75) { foreach ($k in 0.25, 0.5, 0.75) { $px = $bmp.GetPixel([int](($b.Width - 1) * $f), [int](($b.Height - 1) * $k)); if (($px.R + $px.G + $px.B) -gt 0) { $lit = $true } } }
      if (-not $lit) { $printed = $false }
    }
  }
  if (-not $printed) { $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size) }
  $g.Dispose()
  return $bmp
}
# 截图/放大共用：在物理区域 $src（相对 $b 左上角）上取图，缩到预算尺寸，按需叠网格，存 JPEG。
function Render-Shot($raw, $sx, $sy, $sw, $sh, $grid) {
  $fit = [RcDesk]::Fit($sw, $sh, 28, [int]$script:maxPx, [int]$script:maxTok)
  $tw = $fit[0]; $th = $fit[1]
  $out = New-Object System.Drawing.Bitmap $tw, $th
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($raw, (New-Object System.Drawing.Rectangle 0, 0, $tw, $th), (New-Object System.Drawing.Rectangle $sx, $sy, $sw, $sh), [System.Drawing.GraphicsUnit]::Pixel)
  if ($grid) {
    # 网格按「图片像素」标注（=点击要传的坐标），每 100 一条细线、每 500 一条粗线
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(130, 255, 40, 40)), 1
    $pen5 = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(210, 255, 40, 40)), 2
    $font = New-Object System.Drawing.Font 'Consolas', 9
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 255, 40, 40))
    for ($x = 100; $x -lt $tw; $x += 100) { $p = $pen; if ($x % 500 -eq 0) { $p = $pen5 }; $g.DrawLine($p, $x, 0, $x, $th); $g.DrawString([string]$x, $font, $brush, ($x + 2), 1) }
    for ($y = 100; $y -lt $th; $y += 100) { $p = $pen; if ($y % 500 -eq 0) { $p = $pen5 }; $g.DrawLine($p, 0, $y, $tw, $y); $g.DrawString([string]$y, $font, $brush, 1, ($y + 1)) }
  }
  $g.Dispose()
  $file = Join-Path $env:TEMP ('rcshot-' + [guid]::NewGuid().ToString('N') + '.jpg')
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([int64]75)
  $out.Save($file, $enc, $ep)
  $out.Dispose()
  return @{ file = $file; fw = $tw; fh = $th }
}
# 实时事件：桌面壳的覆盖层据此画 Claude 的指针、点击涟漪、输入气泡等。只在调用方要（fx）时发，与命令回包同一条 stdout、不带 id
function Emit($o) { if ($script:fx) { $o.evt = $o.type; [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)) } }
function Caret-Or-Focus {
  $c = [RcDesk]::Caret(); if ($c.Length -eq 4) { return @{ x = $c[0] + 3; y = $c[1] + 3; w = [Math]::Max(1, $c[2] - 6); h = [Math]::Max(1, $c[3] - 6) } }
  if (Fg-Ok) { try { $f = [RcUia]::FocusRect(); if ($null -ne $f) { return @{ x = $f[0]; y = $f[1]; w = $f[2]; h = $f[3] } } } catch {} }
  return $null
}
function Do-Shot($display, $grid, $window) {
  $b = Get-Bounds $display $window
  if ($b.Width -lt 1 -or $b.Height -lt 1) { throw 'window/display has no capturable bounds' }
  Emit @{ type = 'shot'; rect = @{ x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height } }
  $raw = Capture-Raw $b $window
  try { $r = Render-Shot $raw 0 0 $b.Width $b.Height $grid } finally { $raw.Dispose() }
  return @{ ok = $true; file = $r.file; w = $b.Width; h = $b.Height; ox = $b.X; oy = $b.Y; fw = $r.fw; fh = $r.fh }
}
# 放大：区域给的是物理偏移（相对帧左上角）；帧是窗口时按窗口当前位置取
function Do-Zoom($display, $window, $ox, $oy, $rx, $ry, $rw, $rh) {
  if ($null -ne $window -and [long]$window -ne 0) { $b = Get-Bounds $null $window } else { $b = New-Object System.Drawing.Rectangle ([int]$ox), ([int]$oy), ([int]$rx + [int]$rw), ([int]$ry + [int]$rh) }
  $raw = Capture-Raw $b $window
  try {
    $sx = [Math]::Max(0, [Math]::Min([int]$rx, $raw.Width - 1)); $sy = [Math]::Max(0, [Math]::Min([int]$ry, $raw.Height - 1))
    $sw = [Math]::Max(1, [Math]::Min([int]$rw, $raw.Width - $sx)); $sh = [Math]::Max(1, [Math]::Min([int]$rh, $raw.Height - $sy))
    $r = Render-Shot $raw $sx $sy $sw $sh $false
  } finally { $raw.Dispose() }
  Emit @{ type = 'shot'; rect = @{ x = $b.X + $sx; y = $b.Y + $sy; w = $sw; h = $sh } }
  return @{ ok = $true; file = $r.file; fw = $r.fw; fh = $r.fh }
}
function Window-Info($h) {
  if ($null -eq $h -or [long]$h -eq 0) { return $null }
  $titleBuf = New-Object System.Text.StringBuilder 1024; [void][RcDesk]::GetWindowText($h, $titleBuf, $titleBuf.Capacity)
  $classBuf = New-Object System.Text.StringBuilder 256; [void][RcDesk]::GetClassName($h, $classBuf, $classBuf.Capacity)
  [uint32]$procId = 0; [void][RcDesk]::GetWindowThreadProcessId($h, [ref]$procId)
  $r = New-Object RcDesk+RECT; [void][RcDesk]::GetWindowRect($h, [ref]$r)
  $procName = ''; $procPath = ''; try { $pr = Get-Process -Id $procId -ErrorAction Stop; $procName = $pr.ProcessName; try { $procPath = $pr.Path } catch {} } catch {}
  return @{ hwnd = [long]$h; title = $titleBuf.ToString(); className = $classBuf.ToString(); pid = [int]$procId; process = $procName; path = $procPath; x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) }
}
# 落点命中测试：顶层窗口 + （窗口没挂死时）UIA 控件
function Hit-Info($ax, $ay) {
  $root = [RcDesk]::RootAt([int]$ax, [int]$ay)
  $w = Window-Info $root
  $ctl = $null
  [RcUia]::WatchNone()
  if ($root -ne [IntPtr]::Zero -and -not [RcDesk]::IsHungAppWindow($root)) {
    try {
      $i = [RcUia]::HitAt([int]$ax, [int]$ay)
      if ($null -ne $i) { $ctl = @{ type = $i.controlType; name = $i.name; automationId = $i.automationId } }
    } catch {}
  }
  return @{ window = $w; control = $ctl }
}
# —— 结果确认：动作前拍一份「现场」，动作后等界面稳定再拍一份，比出发生了什么 ——
function Thumb-Size($w, $h, $max) {
  if ($w -ge $h) { $sw = $max; $sh = [Math]::Max(4, [int][Math]::Round($max * $h / [Math]::Max(1, $w))) }
  else { $sh = $max; $sw = [Math]::Max(4, [int][Math]::Round($max * $w / [Math]::Max(1, $h))) }
  return ,@($sw, $sh)
}
function Take-Sigs($reg, $loc) {
  $g = $null; $l = $null; $gs = $null; $ls = $null
  if ($null -ne $reg) { $gs = Thumb-Size $reg.w $reg.h 128; $g = [RcDesk]::Sig([int]$reg.x, [int]$reg.y, [int]$reg.w, [int]$reg.h, $gs[0], $gs[1]) }
  if ($null -ne $loc) { $ls = Thumb-Size $loc.w $loc.h 64; $l = [RcDesk]::Sig([int]$loc.x, [int]$loc.y, [int]$loc.w, [int]$loc.h, $ls[0], $ls[1]) }
  return @{ g = $g; l = $l; gs = $gs; ls = $ls }
}
# 两份指纹比出变化格数（整窗口, 局部）；masks＝要跳过的屏幕矩形（输入光标）
function Diff-Sigs($p, $a, $b, $masks) {
  $dg = 0; $dl = 0
  if ($null -ne $a.g) { $dg = [RcDesk]::DiffMasked($a.g, $b.g, 16, [int]$p.reg.x, [int]$p.reg.y, [int]$p.reg.w, [int]$p.reg.h, $a.gs[0], $a.gs[1], $masks) }
  if ($null -ne $a.l) { $dl = [RcDesk]::DiffMasked($a.l, $b.l, 24, [int]$p.loc.x, [int]$p.loc.y, [int]$p.loc.w, [int]$p.loc.h, $a.ls[0], $a.ls[1], $masks) }
  return ,@($dg, $dl)
}
function Rect-Of($hwnd) {
  if ($null -eq $hwnd -or $hwnd -eq [IntPtr]::Zero) { return $null }
  $r = New-Object RcDesk+RECT
  if (-not [RcDesk]::GetWindowRect($hwnd, [ref]$r)) { return $null }
  $rw = $r.Right - $r.Left; $rh = $r.Bottom - $r.Top
  if ($rw -lt 2 -or $rh -lt 2) { return $null }
  return @{ x = $r.Left; y = $r.Top; w = $rw; h = $rh }
}
function Rect-Hash($b) {
  if ($null -eq $b -or $b[2] -lt 3 -or $b[3] -lt 3) { return $null }
  return @{ x = $b[0]; y = $b[1]; w = [Math]::Min(800, $b[2]); h = [Math]::Min(400, $b[3]) }
}
function Fg-Ok { $fg = [RcDesk]::GetForegroundWindow(); return ($fg -ne [IntPtr]::Zero -and -not [RcDesk]::IsHungAppWindow($fg)) }
# 控件状态（C# 里读，密码框只标记、绝不读值）转成 hashtable 交给 JSON
function State-Hash($s) {
  if ($null -eq $s) { return $null }
  if ($s.gone) { return @{ gone = $true } }
  $h = @{ type = $s.type; name = $s.name; automationId = $s.automationId; enabled = $s.enabled; password = $s.password }
  if ($null -ne $s.toggle) { $h.toggle = $s.toggle }
  if ($null -ne $s.expand) { $h.expand = $s.expand }
  if ($s.hasSelected) { $h.selected = $s.selected }
  if ($null -ne $s.value) { $h.value = $s.value }
  return $h
}
function Focus-State { if (-not (Fg-Ok)) { return $null }; try { return State-Hash ([RcUia]::FocusState()) } catch { return $null } }
function Watch-State { if (-not [RcUia]::HasWatch()) { return $null }; try { return State-Hash ([RcUia]::WatchState()) } catch { return @{ gone = $true } } }
# 鼠标刚移过来时悬停高亮还在淡入：等落点附近静下来再拍「动作前」，免得把悬停效果算成点击的结果
function Settle-Local($ax, $ay, $maxMs) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew(); $prev = $null
  while ($sw.ElapsedMilliseconds -lt $maxMs) {
    Start-Sleep -Milliseconds 40
    $cur = [RcDesk]::Sig([int]$ax - 64, [int]$ay - 64, 128, 128, 32, 32)
    if ($null -ne $prev -and [RcDesk]::DiffCells($prev, $cur, 10) -eq 0) { return }
    $prev = $cur
  }
}
# 动作前：比对区域＝落点所在的顶层窗口（没有落点就用前台窗口），局部区域＝落点周围 256 像素 / 目标控件 / 焦点控件
function Obs-Pre($ax, $ay) {
  $fg = [RcDesk]::GetForegroundWindow()
  $regWin = $fg
  if ($null -ne $ax) { $root = [RcDesk]::RootAt([int]$ax, [int]$ay); if ($root -ne [IntPtr]::Zero) { $regWin = $root } }
  $reg = Rect-Of $regWin
  if ($null -eq $reg) { $sb = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $reg = @{ x = $sb.X; y = $sb.Y; w = $sb.Width; h = $sb.Height } }
  $loc = $null
  if ($null -ne $ax) { $loc = @{ x = [int]$ax - 128; y = [int]$ay - 128; w = 256; h = 256 } }
  elseif ([RcUia]::HasWatch()) { $loc = Rect-Hash ([RcUia]::WatchRect()) }
  elseif (Fg-Ok) { $loc = Rect-Hash ([RcUia]::FocusRect()) }
  $key = [RcDesk]::TopKey()
  $titles = @{}; foreach ($k in $key.Split(',')) { if ($k) { $titles[$k] = [RcDesk]::Title([IntPtr][long]$k) } }
  $script:pre = @{ reg = $reg; loc = $loc; sig = (Take-Sigs $reg $loc); caret = [RcDesk]::Caret(); fg = $fg; key = $key; titles = $titles; focusState = (Focus-State); hasEl = [RcUia]::HasWatch(); elState = (Watch-State) }
}
function Find-Text($q) {
  if (-not (Fg-Ok)) { return $null }
  try { return [RcUia]::FindText([RcDesk]::GetForegroundWindow(), [string]$q, 1500, 1200) } catch { return $null }
}
function Check-Expect($exp) {
  $checks = New-Object System.Collections.ArrayList; $all = $true
  $titles = @(); foreach ($k in ([RcDesk]::TopKey()).Split(',')) { if ($k) { $titles += [RcDesk]::Title([IntPtr][long]$k) } }
  if ($null -ne $exp.window) {
    $q = ([string]$exp.window).ToLower(); $hit = @($titles | Where-Object { $_.ToLower().Contains($q) }); $ok = $hit.Count -gt 0
    if (-not $ok) { $all = $false }
    $got = ''; if ($ok) { $got = [string]$hit[0] }
    [void]$checks.Add(@{ key = 'window'; want = [string]$exp.window; ok = $ok; got = $got })
  }
  if ($null -ne $exp.gone) {
    $q = ([string]$exp.gone).ToLower(); $hit = @($titles | Where-Object { $_.ToLower().Contains($q) }); $ok = $hit.Count -eq 0
    if (-not $ok) { $all = $false }
    $got = ''; if (-not $ok) { $got = [string]$hit[0] }
    [void]$checks.Add(@{ key = 'gone'; want = [string]$exp.gone; ok = $ok; got = $got })
  }
  if ($null -ne $exp.focus -or $null -ne $exp.value) {
    $fs = Focus-State
    if ($null -ne $exp.focus) {
      $got = ''; if ($null -ne $fs) { $got = (([string]$fs.type) + ' ' + ([string]$fs.name) + ' ' + ([string]$fs.automationId)).Trim() }
      $ok = $got.ToLower().Contains(([string]$exp.focus).ToLower())
      if (-not $ok) { $all = $false }
      [void]$checks.Add(@{ key = 'focus'; want = [string]$exp.focus; ok = $ok; got = $got })
    }
    if ($null -ne $exp.value) {
      $want = ([string]$exp.value).Replace([string][char]13, '')
      $got = $null; if ($null -ne $fs -and -not $fs.password -and $null -ne $fs.value) { $got = ([string]$fs.value).Replace([string][char]13, '') }
      $ok = ($null -ne $got) -and $got.Contains($want)
      if (-not $ok) { $all = $false }
      $show = ''; if ($null -ne $got) { $show = $got.Substring(0, [Math]::Min(120, $got.Length)) }
      [void]$checks.Add(@{ key = 'value'; want = [string]$exp.value; ok = $ok; got = $show; unreadable = ($null -eq $got) })
    }
  }
  if ($null -ne $exp.text) {
    $q = [string]$exp.text
    $f = Find-Text $q
    if ($null -eq $f) { $t = @($titles | Where-Object { $_.ToLower().Contains($q.ToLower()) }); if ($t.Count -gt 0) { $f = [string]$t[0] } }
    $ok = $null -ne $f
    if (-not $ok) { $all = $false }
    [void]$checks.Add(@{ key = 'text'; want = $q; ok = $ok; got = [string]$f })
  }
  return @{ ok = $all; checks = @($checks) }
}
# 动作后：每 ~100ms 比一次画面。有变化 → 连续两次不再变才算稳定；一直没变化 → 等满 noChangeMs 收手；
# 给了 expect → 一直等到预期全部满足（且画面稳定）或超时。界面一直在动（动画/视频）就等满 maxMs。
function Obs-Post($o) {
  $p = $script:pre
  if ($null -eq $p) { return $null }
  $max = [Math]::Max(200, [Math]::Min(15000, [int]$o.maxMs))
  $noChange = [Math]::Max(150, [Math]::Min($max, [int]$o.noChangeMs))
  $exp = $o.expect
  $hasExp = $null -ne $exp
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Start-Sleep -Milliseconds 100
  $last = $null; $lastCaret = $null; $quiet = 0; $ever = $false; $checks = $null; $expOk = $false; $nextExp = 0; $dg = 0; $dl = 0
  while ($true) {
    $cur = Take-Sigs $p.reg $p.loc
    $caret = [RcDesk]::Caret()
    $d = Diff-Sigs $p $p.sig $cur ([RcDesk]::Join($p.caret, $caret))
    $dg = $d[0]; $dl = $d[1]
    if ($dg -gt 0 -or $dl -ge 2 -or ([RcDesk]::TopKey() -ne $p.key) -or ([RcDesk]::GetForegroundWindow() -ne $p.fg)) { $ever = $true }
    if ($null -ne $last) { $q = Diff-Sigs $p $last $cur ([RcDesk]::Join($lastCaret, $caret)); if ($q[0] -eq 0 -and $q[1] -eq 0) { $quiet++ } else { $quiet = 0 } }
    $last = $cur; $lastCaret = $caret
    $t = $sw.ElapsedMilliseconds
    if ($hasExp) {
      if ($t -ge $nextExp) { $r = Check-Expect $exp; $checks = $r.checks; $expOk = [bool]$r.ok; $nextExp = $t + 250 }
      if ($expOk -and $quiet -ge 1) { break }
    } elseif (($ever -and $quiet -ge 2) -or (-not $ever -and $quiet -ge 1 -and $t -ge $noChange)) { break }
    if ($t -ge $max) { break }
    Start-Sleep -Milliseconds 80
  }
  if ($hasExp -and -not $expOk) { $r = Check-Expect $exp; $checks = $r.checks; $expOk = [bool]$r.ok }
  $nowKey = [RcDesk]::TopKey()
  $now = @{}; foreach ($k in $nowKey.Split(',')) { if ($k) { $now[$k] = 1 } }
  $opened = New-Object System.Collections.ArrayList
  foreach ($k in $now.Keys) { if (-not $p.titles.ContainsKey($k) -and $opened.Count -lt 6) { $wi = Window-Info ([IntPtr][long]$k); if ($null -ne $wi) { [void]$opened.Add(@{ hwnd = $wi.hwnd; title = $wi.title; process = $wi.process }) } } }
  $closed = New-Object System.Collections.ArrayList
  foreach ($k in $p.titles.Keys) { if (-not $now.ContainsKey($k) -and $closed.Count -lt 6) { [void]$closed.Add([string]$p.titles[$k]) } }
  $fgNow = [RcDesk]::GetForegroundWindow()
  $res = @{
    settledMs = [int]$sw.ElapsedMilliseconds; stable = ($quiet -ge 1); pixels = ($dg -gt 0 -or $dl -ge 2); cells = $dg; localCells = $dl
    opened = @($opened); closed = @($closed); fgChanged = ($fgNow -ne $p.fg); foreground = (Window-Info $fgNow)
    focusBefore = $p.focusState; focusAfter = (Focus-State)
    hasControl = [bool]$p.hasEl; controlBefore = $p.elState; controlAfter = (Watch-State)
  }
  if ($hasExp) { $res.expect = @{ ok = $expOk; checks = @($checks) } }
  $script:pre = $null
  return $res
}
# 帧内物理偏移 -> 屏幕绝对坐标。帧是窗口：按窗口【当前】矩形换算，尺寸变了就拒绝。
function Resolve-Point($c) {
  if ($null -ne $c.ref) {
    $bb = [RcUia]::RefRect([int]$c.ref)
    return @{ x = [int]($bb[0] + $bb[2] / 2); y = [int]($bb[1] + $bb[3] / 2) }
  }
  $ox = [int]$c.ox; $oy = [int]$c.oy
  if ($null -ne $c.win -and [long]$c.win -ne 0) {
    $h = [IntPtr][long]$c.win
    if (-not [RcDesk]::IsWindow($h)) { throw 'FRAME_GONE' }
    $r = New-Object RcDesk+RECT; [void][RcDesk]::GetWindowRect($h, [ref]$r)
    if ([Math]::Abs(($r.Right - $r.Left) - [int]$c.ew) -gt 2 -or [Math]::Abs(($r.Bottom - $r.Top) - [int]$c.eh) -gt 2) { throw 'FRAME_RESIZED' }
    $ox = $r.Left; $oy = $r.Top
  }
  return @{ x = $ox + [int]$c.fx; y = $oy + [int]$c.fy }
}
function Do-Pointer($c) {
  $p = Resolve-Point $c
  $hit = Hit-Info $p.x $p.y
  if ($c.guard) {
    $root = $hit.window
    if ($null -ne $root -and $null -ne $c.banner -and [long]$c.banner -ne 0 -and [long]$root.hwnd -eq [long]$c.banner) { return @{ ok = $false; code = 'BANNER'; screen = $p; target = $hit } }
    # 顶部状态条整块（含透明边距）：它常驻最前、停止键就在里面
    $br = $c.bannerRect
    if ($null -ne $br -and @($br).Count -eq 4 -and $p.x -ge $br[0] -and $p.x -lt ($br[0] + $br[2]) -and $p.y -ge $br[1] -and $p.y -lt ($br[1] + $br[3])) { return @{ ok = $false; code = 'BANNER'; screen = $p; target = $hit } }
    if ($null -ne $c.win -and [long]$c.win -ne 0 -and $null -ne $root) {
      [uint32]$wantPid = 0; [void][RcDesk]::GetWindowThreadProcessId([IntPtr][long]$c.win, [ref]$wantPid)
      if ([int]$root.pid -ne [int]$wantPid) { return @{ ok = $false; code = 'COVERED'; screen = $p; target = $hit } }
    }
  }
  $obsOn = ($null -ne $c.obs) -and [bool]$c.obs.on -and ([string]$c.kind -ne 'move')
  $was = [System.Windows.Forms.Cursor]::Position
  if ($script:fx) {
    $ms = [RcDesk]::GlideMs($p.x, $p.y)
    $label = ''; if ($null -ne $hit.control) { $label = [string]$hit.control.name }
    Emit @{ type = 'move'; from = @{ x = $was.X; y = $was.Y }; to = @{ x = $p.x; y = $p.y }; ms = $ms; kind = [string]$c.kind; button = [string]$c.button; target = $label }
    [RcDesk]::Glide($p.x, $p.y, $ms)
  } else { [void][RcDesk]::SetCursorPos($p.x, $p.y) }
  if ($obsOn) {
    if (([Math]::Abs($was.X - $p.x) + [Math]::Abs($was.Y - $p.y)) -gt 2) { Settle-Local $p.x $p.y 320 } else { Start-Sleep -Milliseconds 20 }
    [RcUia]::WatchHit(); Obs-Pre $p.x $p.y
  } else { Start-Sleep -Milliseconds 20 }
  switch ([string]$c.kind) {
    'click'  { Emit @{ type = 'click'; x = $p.x; y = $p.y; button = [string]$c.button; count = [int]$c.count }; [RcDesk]::Click([string]$c.button, [int]$c.count) }
    'scroll' { Emit @{ type = 'scroll'; x = $p.x; y = $p.y; amount = [int]$c.amount }; [RcDesk]::Wheel([int]$c.amount) }
    default  { }
  }
  $obs = $null; if ($obsOn) { $obs = Obs-Post $c.obs }
  return @{ ok = $true; screen = $p; target = $hit; obs = $obs }
}
function Do-Cursor { $q = [System.Windows.Forms.Cursor]::Position; return @{ ok = $true; absX = $q.X; absY = $q.Y } }
function Do-Windows {
  $arr = @(); foreach ($h in [RcDesk]::Windows()) { if ([RcDesk]::Ours($h)) { continue }; $i = Window-Info $h; if ($null -ne $i -and $i.title) { $arr += $i } }
  return ,$arr
}
function Do-Active { return Window-Info ([RcDesk]::GetForegroundWindow()) }
function Do-Processes {
  $arr = @(); foreach ($p in (Get-Process | Sort-Object ProcessName, Id | Select-Object -First 500)) {
    $pp = ''; try { $pp = $p.Path } catch {}
    $arr += @{ pid = $p.Id; name = $p.ProcessName; title = $p.MainWindowTitle; path = $pp; cpu = $p.CPU; workingSet = [long]$p.WorkingSet64 }
  }; return ,$arr
}
function Do-Launch($file, $args, $cwd) {
  if (-not $file) { throw 'launch requires file' }
  $sp = @{ FilePath = [string]$file; PassThru = $true }
  if ($null -ne $args -and @($args).Count -gt 0) { $sp.ArgumentList = [string[]]@($args) }
  if ($cwd) { $sp.WorkingDirectory = [string]$cwd }
  $p = Start-Process @sp; return @{ ok = $true; pid = $p.Id; file = [string]$file }
}
function Do-FocusWindow($window) {
  $h = [IntPtr][long]$window
  if (-not [RcDesk]::IsWindow($h)) { throw 'window not found (closed?)' }
  $ok = [RcDesk]::Focus($h)
  return @{ ok = $true; focused = [bool]$ok; window = (Window-Info $h); foreground = (Window-Info ([RcDesk]::GetForegroundWindow())) }
}
function Do-SetWindow($window, $x, $y, $w, $h) {
  $hwnd = [IntPtr][long]$window; $cur = Window-Info $hwnd
  if ($null -eq $cur) { throw 'window not found' }
  $nx = if ($null -eq $x) { $cur.x } else { [int]$x }; $ny = if ($null -eq $y) { $cur.y } else { [int]$y }
  $nw = if ($null -eq $w) { $cur.w } else { [int]$w }; $nh = if ($null -eq $h) { $cur.h } else { [int]$h }
  if ($nw -lt 80 -or $nh -lt 40) { throw 'window size is too small' }
  $ok = [RcDesk]::MoveWindow($hwnd, $nx, $ny, $nw, $nh, $true); return @{ ok = [bool]$ok; window = (Window-Info $hwnd) }
}
function Do-CloseWindow($window) { $ok = [RcDesk]::PostMessage([IntPtr][long]$window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); return @{ ok = [bool]$ok } }
function Obs-On($obs) { return ($null -ne $obs) -and [bool]$obs.on }
function Do-Type($text, $obs) {
  $on = Obs-On $obs
  if ($on) { [RcUia]::WatchNone(); Obs-Pre $null $null }
  if ($script:fx) {
    # 密码框只报长度，绝不把明文推到屏幕上
    $pw = $false; if (Fg-Ok) { try { $pw = [RcUia]::FocusIsPassword() } catch {} }
    $shown = ''; if (-not $pw) { $shown = ([string]$text); if ($shown.Length -gt 200) { $shown = $shown.Substring(0, 200) } }
    Emit @{ type = 'type'; text = $shown; password = $pw; length = ([string]$text).Length; rect = (Caret-Or-Focus) }
  }
  $n = [RcDesk]::TypeText([string]$text)
  $res = $null; if ($on) { $res = Obs-Post $obs }
  return @{ ok = $true; chars = $n; foreground = (Window-Info ([RcDesk]::GetForegroundWindow())); obs = $res }
}
function Do-Chord($mods, $key, $char, $obs, $label) {
  $on = Obs-On $obs
  if ($on) { [RcUia]::WatchNone(); Obs-Pre $null $null }
  if ($script:fx -and $null -ne $label) { Emit @{ type = 'key'; keys = @($label); rect = (Caret-Or-Focus) } }
  $m = New-Object System.Collections.Generic.List[uint16]
  foreach ($v in @($mods)) { if ($null -ne $v) { $m.Add([uint16]$v) } }
  $k = [uint16]0
  if ($char) { $ch = ([string]$char)[0]; $k = [RcDesk]::Vk($ch); if ([RcDesk]::NeedsShift($ch) -and -not $m.Contains(0x10)) { $m.Add(0x10) } }
  elseif ($null -ne $key) { $k = [uint16]$key }
  [RcDesk]::Chord($m.ToArray(), $k)
  $res = $null; if ($on) { $res = Obs-Post $obs }
  return @{ ok = $true; foreground = (Window-Info ([RcDesk]::GetForegroundWindow())); obs = $res }
}
function Do-UiaTree($window, $depth, $max) {
  $hwnd = if ($null -ne $window -and [long]$window -ne 0) { [IntPtr][long]$window } else { [RcDesk]::GetForegroundWindow() }
  if ($hwnd -eq [IntPtr]::Zero) { throw 'no foreground window' }
  if ([RcDesk]::IsHungAppWindow($hwnd)) { throw 'that window is not responding (hung); UI Automation would block - try again later' }
  $depth = [Math]::Max(0, [Math]::Min(12, [int]$depth)); $max = [Math]::Max(1, [Math]::Min(1000, [int]$max))
  $nodes = @(foreach ($i in [RcUia]::Tree($hwnd, $depth, $max)) {
    @{ ref = $i.ref; parent = $i.parent; level = $i.level; name = $i.name; controlType = $i.controlType; automationId = $i.automationId; className = $i.className; enabled = $i.enabled; offscreen = $i.offscreen; password = $i.password; x = $i.x; y = $i.y; w = $i.w; h = $i.h; hwnd = $i.hwnd; pid = $i.pid }
  })
  return @{ ok = $true; window = (Window-Info $hwnd); nodes = $nodes; truncated = [RcUia]::LastTruncated }
}
function Do-UiaAction($ref, $action, $value, $obs) {
  $key = [int]$ref
  $on = Obs-On $obs
  if ($on) { [RcUia]::WatchRef($key); Obs-Pre $null $null }
  if ($script:fx) {
    $rr = $null; try { $q = [RcUia]::RefRect($key); $rr = @{ x = $q[0]; y = $q[1]; w = $q[2]; h = $q[3] } } catch {}
    Emit @{ type = 'target'; rect = $rr; action = [string]$action; name = [RcUia]::RefName($key) }
  }
  [RcUia]::ActRef($key, [string]$action, [string]$value)
  $res = $null; if ($on) { $res = Obs-Post $obs }
  return @{ ok = $true; ref = $key; action = [string]$action; obs = $res }
}
$script:maxPx = 1568; $script:maxTok = 1568; $script:fx = $false
[Console]::Out.WriteLine('{"ready":true}')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $c = $null
  try { $c = $line | ConvertFrom-Json } catch { [Console]::Out.WriteLine('{"id":0,"ok":false,"error":"bad json"}'); continue }
  $id = $c.id; $r = $null
  try {
    if ($null -ne $c.maxPx) { $script:maxPx = [int]$c.maxPx; $script:maxTok = [int]$c.maxTok }
    $script:fx = [bool]$c.emitEvents
    switch ($c.op) {
      'shot'     { $r = Do-Shot $c.display $c.grid $c.window }
      'zoom'     { $r = Do-Zoom $c.display $c.window $c.ox $c.oy $c.rx $c.ry $c.rw $c.rh }
      'pointer'  { $r = Do-Pointer $c }
      'type'     { $r = Do-Type $c.text $c.obs }
      'chord'    { $r = Do-Chord $c.mods $c.key $c.char $c.obs $c.label }
      'displays' { $r = @{ ok = $true; displays = (Do-Displays) } }
      'cursor'   { $r = Do-Cursor }
      'windows'  { $r = @{ ok = $true; windows = (Do-Windows) } }
      'active'   { $r = @{ ok = $true; window = (Do-Active) } }
      'processes'{ $r = @{ ok = $true; processes = (Do-Processes) } }
      'launch'   { $r = Do-Launch $c.file $c.args $c.cwd }
      'focus_window' { $r = Do-FocusWindow $c.window }
      'set_window' { $r = Do-SetWindow $c.window $c.x $c.y $c.w $c.h }
      'close_window' { $r = Do-CloseWindow $c.window }
      'uia_tree' { $r = Do-UiaTree $c.window $c.depth $c.max }
      'uia_action' { $r = Do-UiaAction $c.ref $c.action $c.value $c.obs }
      default    { $r = @{ ok = $false; error = ('unknown op: ' + [string]$c.op) } }
    }
  } catch { $r = @{ ok = $false; error = $_.Exception.Message } }
  $r["id"] = $id
  [Console]::Out.WriteLine(($r | ConvertTo-Json -Compress -Depth 6))
}
`;

let host = null;       // { child, ready, pending:Map, seq, buf }
// 事件观察者：桌面壳（本机 broker）注册后，宿主在动作进行中实时推 move/click/scroll/type/key/target/shot，
// 用来画覆盖层上的 Claude 指针与动效；没注册（远程客户端）就不发、也不做平滑移动。坐标都是物理像素。
let observer = null;
export function setDesktopObserver(fn) { observer = typeof fn === 'function' ? fn : null; }
let starting = null;   // 正在起宿主的 promise
let generation = 0;    // 急停/关宿主时 +1：正在跑的 batch 看到变化就停，不会把宿主又拉起来接着点
const HOST_SCRIPT = path.join(os.tmpdir(), `bridge-desktop-host-${process.pid}.ps1`);

function ensureScript() {
  // 带 BOM：脚本里有中文注释，Windows PowerShell 5.1 读无 BOM 文件按 ANSI 码页解，会把引号吃乱导致整篇解析失败
  writeFileSync(HOST_SCRIPT, '﻿' + PS_SCRIPT, 'utf8');
  return HOST_SCRIPT;
}

function startHost() {
  if (host && host.child && !host.child.killed) return Promise.resolve(host);
  if (starting) return starting;
  const p = new Promise((resolve, reject) => {
    let child;
    try { child = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ensureScript()], { windowsHide: true }); }
    catch (e) { reject(new Error('无法启动 PowerShell 桌面宿主：' + e.message)); return; }
    const h = { child, ready: false, pending: new Map(), seq: 0, buf: '' };
    let settled = false;
    let startupTimer = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      h.buf += chunk;
      let i;
      while ((i = h.buf.indexOf('\n')) >= 0) {
        const line = h.buf.slice(0, i).trim(); h.buf = h.buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.evt) { try { observer?.(msg); } catch {} continue; }
        if (msg.ready) {
          h.ready = true;
          host = h;
          if (!settled) {
            settled = true;
            clearTimeout(startupTimer);
            resolve(h);
          }
          continue;
        }
        const pend = h.pending.get(msg.id);
        if (pend) { h.pending.delete(msg.id); pend.settle(msg); }
      }
    });
    child.stderr.on('data', (b) => { const s = b.toString().trim(); if (s) console.error('[remote-desktop] ' + s); });
    // spawn 失败是【异步 'error' 事件】——上面那个同步 try/catch 只挡得住参数非法，
    // 挡不住 ENOENT（PATH 里没有 powershell.exe）/ EACCES。没有监听者时未处理的
    // 'error' 会把整个 bridge 进程打死，而不是让这次调用失败。
    child.on('error', (e) => {
      clearTimeout(startupTimer);
      for (const [, pend] of h.pending) pend.fail(e);
      h.pending.clear();
      if (host === h) host = null;
      if (!settled) { settled = true; reject(new Error('无法启动 PowerShell 桌面宿主：' + (e?.message || e))); }
    });
    child.on('exit', (code) => {
      clearTimeout(startupTimer);
      for (const [, pend] of h.pending) pend.fail(new Error('桌面控制宿主已退出（' + code + '）'));
      h.pending.clear();
      if (host === h) host = null;
      if (!settled) { settled = true; reject(new Error('桌面控制宿主启动失败（退出码 ' + code + '）；确认在交互式桌面会话中运行。')); }
    });
    startupTimer = setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch {} reject(new Error('桌面控制宿主启动超时')); } }, 30_000);
  });
  starting = p;
  // finally 派生的新 promise 也会带着启动失败的原因 reject，没人接就是 unhandled rejection（会打死宿主进程）
  p.finally(() => { if (starting === p) starting = null; }).catch(() => {});
  return p;
}

// raw=true：宿主回 ok:false 时不抛，原样交回（命中测试的拒绝要带上落点信息）
function sendCmd(op, args, timeoutMs = 20_000, { raw = false } = {}) {
  return startHost().then((h) => new Promise((resolve, reject) => {
    const id = ++h.seq;
    const timer = setTimeout(() => { h.pending.delete(id); reject(new Error('桌面操作超时（' + op + '）')); }, timeoutMs);
    h.pending.set(id, {
      settle: (msg) => {
        clearTimeout(timer);
        if (msg.ok === false && !raw) reject(new Error(msg.error || `桌面操作「${op}」失败（宿主没给原因）`));
        else resolve(msg);
      },
      fail: (e) => { clearTimeout(timer); reject(e); },
    });
    // 动效事件开关叫 emitEvents，别叫 fx——fx/fy 是指针指令里的帧内坐标，重名会把横坐标盖成 0
    try { h.child.stdin.write(JSON.stringify({ id, op, ...args, emitEvents: Boolean(observer) }) + '\n', 'utf8'); }
    catch (e) { clearTimeout(timer); h.pending.delete(id); reject(e); }
  }));
}

// —— 键名 → 虚拟键码（SendInput）——
const MOD_VK = { ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5B, meta: 0x5B, cmd: 0x5B, super: 0x5B };
const KEY_VK = {
  enter: 0x0D, return: 0x0D, tab: 0x09, esc: 0x1B, escape: 0x1B,
  backspace: 0x08, bs: 0x08, del: 0x2E, delete: 0x2E, ins: 0x2D, insert: 0x2D,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
  space: 0x20, capslock: 0x14, printscreen: 0x2C, prtsc: 0x2C, menu: 0x5D, apps: 0x5D, pause: 0x13,
  numlock: 0x90, scrolllock: 0x91,
  volumeup: 0xAF, volumedown: 0xAE, volumemute: 0xAD,
  plus: '+',
};
// 覆盖层上显示的键帽文字：「ctrl+shift+s」→ ['Ctrl', 'Shift', 'S']
const KEY_NAMES = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', meta: 'Win', cmd: 'Win', super: 'Win',
  enter: 'Enter', return: 'Enter', esc: 'Esc', escape: 'Esc', tab: 'Tab', backspace: 'Backspace', bs: 'Backspace', del: 'Delete', delete: 'Delete',
  up: '↑', down: '↓', left: '←', right: '→', pageup: 'PgUp', pgup: 'PgUp', pagedown: 'PgDn', pgdn: 'PgDn', space: 'Space', home: 'Home', end: 'End' };
export function keyLabels(spec) {
  const parts = String(spec == null ? '' : spec).split('+').map((x) => x.trim());
  if (parts.length >= 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') parts.splice(-2, 2, '+');
  return parts.filter(Boolean).map((x) => KEY_NAMES[x.toLowerCase()] || (x.length === 1 ? x.toUpperCase() : x[0].toUpperCase() + x.slice(1)));
}

// "Ctrl+Shift+C" / "Enter" / "Alt+F4" / "Win+R" / "Ctrl+Plus" → { mods:[vk], key?:vk, char?:'c' }
export function parseKeys(spec) {
  const parts = String(spec == null ? '' : spec).split('+').map((s) => s.trim());
  // "Ctrl++" 拆出来末尾是两个空串：还原成主键 '+'
  if (parts.length >= 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') { parts.splice(-2, 2, '+'); }
  const mods = []; let key = null; let char = null;
  for (const p of parts.filter(Boolean)) {
    const low = p.toLowerCase();
    if (MOD_VK[low] != null && (key != null || char != null || parts.length > 1)) { if (!mods.includes(MOD_VK[low])) mods.push(MOD_VK[low]); continue; }
    if (key != null || char != null) throw new Error(`组合键「${spec}」里有两个主键`);
    if (MOD_VK[low] != null) { key = MOD_VK[low]; continue; }   // 单按一个修饰键（如「Win」开开始菜单）
    const mapped = KEY_VK[low];
    if (typeof mapped === 'number') key = mapped;
    else if (typeof mapped === 'string') char = mapped;
    else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(p)) key = 0x70 + Number(p.slice(1)) - 1;
    // 字母/数字直接给键码：大写的「S」不能走 VkKeyScan，否则 Ctrl+S 会被补成 Ctrl+Shift+S
    else if (/^[a-z0-9]$/i.test(p)) key = p.toUpperCase().charCodeAt(0);
    else if (p.length === 1) char = p;   // 符号按当前键盘布局查键位（需要 Shift 的自动补上）
    else throw new Error(`不认识的按键「${p}」（可用：Ctrl/Alt/Shift/Win + 字母数字符号、Enter、Tab、Esc、方向键、Home/End、PageUp/PageDown、F1–F24 等）`);
  }
  if (key == null && char == null) throw new Error('key 需要一个主键，例如 "Ctrl+S"、"Enter"');
  return { mods, key, char };
}

// —— 坐标帧 ——
// 每个调用方（frameKey：claude / dimensio / codex / 远程设备…）各记各的最近一张截图，互不覆盖。
const frames = new Map();
export function makeFrame(shot, { window = null } = {}) {
  return { ox: shot.ox, oy: shot.oy, pw: shot.w, ph: shot.h, fw: shot.fw, fh: shot.fh, window: window || null, at: Date.now() };
}
// 截图像素 → 帧内物理偏移（与官方相同：越界报错、结果夹在帧内）
export function toPhysical(frame, x, y, label = '坐标') {
  if (!frame) throw new Error('还没有截图可对照——先 screenshot，再按那张图里读到的像素点。');
  const nx = Number(x), ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error(`${label}需要 x 和 y（截图里的像素）`);
  if (nx < 0 || ny < 0 || nx > frame.fw || ny > frame.fh) {
    throw new Error(`${label} [${nx}, ${ny}] 超出了最近一张截图的范围（${frame.fw}×${frame.fh}）——坐标是那张图里的像素。重新截图后再选点。`);
  }
  const fx = Math.min(Math.max(Math.round(nx * frame.pw / frame.fw), 0), Math.max(frame.pw - 1, 0));
  const fy = Math.min(Math.max(Math.round(ny * frame.ph / frame.fh), 0), Math.max(frame.ph - 1, 0));
  return { fx, fy };
}
// 屏幕绝对坐标 → 截图像素（光标位置、落点回报用；不在帧内回 null）
export function toFramePixels(frame, absX, absY) {
  if (!frame || frame.window) return null;   // 窗口帧的原点会随窗口移动，绝对坐标没法稳定换算
  const x = Math.round((absX - frame.ox) * frame.fw / frame.pw);
  const y = Math.round((absY - frame.oy) * frame.fh / frame.ph);
  return x >= 0 && y >= 0 && x <= frame.fw && y <= frame.fh ? { x, y } : null;
}

const frameKeyOf = (args) => String(args?.frameKey || 'default').slice(0, 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (w) => (w ? { hwnd: w.hwnd, title: w.title, process: w.process } : null);
const describe = (t) => {
  const w = t?.window, c = t?.control;
  const where = w ? `「${w.title || w.className || '无标题窗口'}」(${w.process || '?'})` : '桌面';
  const what = c && (c.name || c.type) ? `的 ${c.type || '控件'}${c.name ? `「${String(c.name).slice(0, 60)}」` : ''}` : '';
  return where + what;
};

async function readShot(r) {
  try { return (await readFile(r.file)).toString('base64'); } finally { unlink(r.file).catch(() => {}); }
}

async function doScreenshot(args, key) {
  const display = typeof args.display === 'number' ? args.display : undefined;
  const window = args.window == null ? undefined : Number(args.window);
  const r = await sendCmd('shot', { display, window, grid: !!args.grid, ...budgetArgs() }, 25_000);
  const image = await readShot(r);
  const frame = makeFrame(r, { window: window || null });
  frame.display = display;
  frames.set(key, frame);
  return { image, mimeType: 'image/jpeg', w: r.w, h: r.h, ox: r.ox, oy: r.oy, fw: r.fw, fh: r.fh, window: window || null };
}
const budgetArgs = () => ({ maxPx: IMAGE_BUDGET.maxTargetPx, maxTok: IMAGE_BUDGET.maxTargetTokens });

async function doZoom(args, frame) {
  if (!frame) throw new Error('还没有截图——zoom 的区域按最近一张截图的像素给，先 screenshot。');
  const reg = Array.isArray(args.region) ? args.region.map(Number) : null;
  if (!reg || reg.length !== 4 || reg.some((v) => !Number.isFinite(v))) throw new Error('zoom 需要 region: [x0, y0, x1, y1]（最近一张截图里的像素）');
  const [x0, y0, x1, y1] = reg;
  if (x1 <= x0 || y1 <= y0) throw new Error('zoom 的 region 要求 x1>x0、y1>y0');
  const a = toPhysical(frame, x0, y0, 'region 左上角'), b = toPhysical(frame, x1, y1, 'region 右下角');
  const r = await sendCmd('zoom', {
    display: frame.display, window: frame.window, ox: frame.ox, oy: frame.oy,
    rx: a.fx, ry: a.fy, rw: Math.max(1, b.fx - a.fx), rh: Math.max(1, b.fy - a.fy), ...budgetArgs(),
  }, 25_000);
  return { image: await readShot(r), mimeType: 'image/jpeg', fw: r.fw, fh: r.fh, region: [x0, y0, x1, y1] };
}

const POINTER = { move: ['move', 1], click: ['click', 1], double_click: ['click', 2], triple_click: ['click', 3], right_click: ['click', 1], scroll: ['scroll', 1] };

// —— 结果确认（动作后自动比对 + 可选预期）——
// 默认开：点击/滚动/输入/按键/uia_action 做完都附一份「发生了什么」。verify:false 关掉（追求速度时）。
const VERIFIED = new Set(['click', 'double_click', 'triple_click', 'right_click', 'scroll', 'type', 'key', 'uia_action']);
const EXPECT_KEYS = ['window', 'gone', 'focus', 'value', 'text'];
// 返回宿主要的 obs 参数（null＝不确认）以及 node 侧自己核对的 changed 预期
export function obsParams(action, args) {
  if (!VERIFIED.has(action) || args.verify === false) return { obs: null, wantChanged: undefined };
  const e = args.expect && typeof args.expect === 'object' ? args.expect : null;
  const hostExpect = {};
  for (const k of EXPECT_KEYS) if (e && e[k] != null && String(e[k]) !== '') hostExpect[k] = String(e[k]).slice(0, 200);
  const hasHost = Object.keys(hostExpect).length > 0;
  const wantChanged = e && typeof e.changed === 'boolean' ? e.changed : undefined;
  const expectMs = Math.max(500, Math.min(15_000, Number(args.expect_timeout_ms) || 3000));
  const maxMs = hasHost || wantChanged === true ? expectMs : 2500;
  // 一直没变化时等多久才下结论：按键（Ctrl+C 这类本就不改画面）短一点；期望「有变化」就等满预期时长
  const noChangeMs = wantChanged === true ? expectMs : action === 'key' ? 400 : 800;
  return { obs: { on: true, maxMs, noChangeMs, ...(hasHost ? { expect: hostExpect } : {}) }, wantChanged };
}

const clip = (s, n = 120) => (s == null ? s : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const elBrief = (s) => (s && !s.gone ? { type: s.type, name: clip(s.name, 60), automationId: s.automationId || undefined } : null);
const elId = (s) => (s && !s.gone ? `${s.type}|${s.name}|${s.automationId}` : '');
const STATE_KEYS = ['toggle', 'expand', 'selected', 'enabled', 'value', 'name'];

function stateChanges(before, after) {
  if (!before || before.gone) return { changes: [], gone: false };
  if (!after || after.gone) return { changes: [], gone: true };
  const changes = [];
  for (const k of STATE_KEYS) {
    if (k === 'value' && (before.password || after.password)) continue;
    const a = before[k], b = after[k];
    if (a === undefined && b === undefined) continue;
    if (String(a ?? '') !== String(b ?? '')) changes.push({ key: k, from: clip(a, 60), to: clip(b, 60) });
  }
  return { changes, gone: false };
}

// 打字后回读：焦点控件现在的内容里有没有刚打的字（取最后一行的最后 40 个字比对，长文本不必整段相等）
function readback(typed, after) {
  const text = String(typed ?? '');
  if (!text.trim()) return null;
  if (after?.password) return { password: true };
  if (!after || after.gone || after.value == null) return { ok: null };
  const norm = (s) => String(s).replace(/\r/g, '');
  const lines = norm(text).split('\n').filter((l) => l.trim());
  const tail = (lines[lines.length - 1] || '').slice(-40);
  const value = norm(after.value);
  return { ok: tail ? value.includes(tail) : null, value: clip(value, 120), enter: /\n/.test(text) };
}

export function buildVerify(action, obs, { typed, wantChanged } = {}) {
  if (!obs) return null;
  const opened = (obs.opened || []).filter((w) => w && w.title !== BANNER_TITLE);
  const closed = (obs.closed || []).filter((t) => t && t !== BANNER_TITLE);
  const focusChanged = elId(obs.focusBefore) !== elId(obs.focusAfter);
  const control = obs.hasControl ? { ...elBrief(obs.controlBefore), ...stateChanges(obs.controlBefore, obs.controlAfter) } : null;
  // 输入框里的值变化本身就是打字的结果：算「有变化」，但不单列成控件变化（回读里说）
  const valueChanged = action === 'type' && String(obs.focusBefore?.value ?? '') !== String(obs.focusAfter?.value ?? '');
  const changed = Boolean(obs.pixels || opened.length || closed.length || obs.fgChanged || focusChanged || valueChanged
    || control?.gone || control?.changes?.length);
  const v = {
    settledMs: obs.settledMs, stable: obs.stable !== false, changed, pixels: !!obs.pixels,
    opened, closed,
    foreground: obs.fgChanged ? brief(obs.foreground) : null,
    focus: focusChanged ? elBrief(obs.focusAfter) : null,
    control: control && (control.gone || control.changes.length) ? control : null,
  };
  if (action === 'type') v.readback = readback(typed, obs.focusAfter);
  if (obs.expect || wantChanged !== undefined) {
    const checks = [...(obs.expect?.checks || [])];
    if (wantChanged !== undefined) checks.push({ key: 'changed', want: wantChanged, ok: changed === wantChanged, got: changed });
    v.expect = { ok: checks.every((c) => c.ok), checks };
  }
  return v;
}
// 急停横幅的标题（main.cjs 里固定），它第一次出现时不算成「打开了窗口」
export const BANNER_TITLE = 'bridge-local-pc-banner';

async function doPointer(action, args, frame, extra) {
  const [kind, count] = POINTER[action];
  const button = action === 'right_click' ? 'right' : (args.button || 'left');
  let point;
  if (args.ref != null) point = { ref: Number(args.ref) };
  else {
    const { fx, fy } = toPhysical(frame, args.x, args.y);
    point = { fx, fy, ox: frame.ox, oy: frame.oy, win: frame.window, ew: frame.pw, eh: frame.ph };
  }
  const { obs, wantChanged } = obsParams(action, args);
  const r = await sendCmd('pointer', {
    ...point, kind, button, count, amount: Number(args.amount) || 0,
    guard: kind !== 'move', banner: extra.bannerHwnd || 0, bannerRect: extra.bannerRect, obs,
  }, obs ? 40_000 : 20_000, { raw: true });
  if (r.ok === false) {
    if (r.code === 'BANNER') throw new Error('这个落点在屏幕顶部的状态条上（「停止」键就在里面，截图里看不到它），点下去可能直接停掉本机 Agent。把目标窗口往下挪（set_window）或滚动后重新截图，或改用 uia_action / 键盘。');
    if (r.code === 'COVERED') throw new Error(`这个位置现在被${describe(r.target)}挡住了（截图是按窗口单独截的，看不到遮挡）。先 focus_window 把目标窗口提到最前，再点。`);
    const msg = String(r.error || '');
    if (msg.includes('FRAME_RESIZED')) throw new Error('截图之后这个窗口的大小变了，原来的坐标已经对不上——重新截图再选点。');
    if (msg.includes('FRAME_GONE')) throw new Error('截图里的那个窗口已经关掉了——重新 windows / 截图。');
    throw new Error(msg || `${action} 失败`);
  }
  const out = { ok: true, action, target: { window: brief(r.target?.window), control: r.target?.control || null }, landed: describe(r.target) };
  if (args.ref == null) out.at = [Number(args.x), Number(args.y)];
  else out.ref = Number(args.ref);
  const verify = buildVerify(action, r.obs, { wantChanged });
  if (verify) out.verify = verify;
  return out;
}

const BATCH_ACTIONS = new Set([
  'move', 'click', 'double_click', 'triple_click', 'right_click', 'scroll', 'type', 'key', 'wait',
  'screenshot', 'zoom', 'uia_action', 'focus_window', 'cursor', 'active_window',
]);

/**
 * 执行一条桌面 op。被控端唯一入口。
 * 观察：screenshot / zoom / windows / active_window / processes / uia_tree / displays / cursor / wait_for_window
 * 操作：move / click / double_click / triple_click / right_click / scroll / type / key / uia_action /
 *       launch / focus_window / set_window / close_window / wait / batch
 * 公共参数：frameKey（坐标帧归属，调用方标识）、screenshot_after（操作后等 settle_ms 再截一张，省一个来回）、
 *          _bannerHwnd（本机 broker 注入：急停横幅窗口，点击不许落在上面）
 */
export async function desktopOp(action, args = {}) {
  if (process.platform !== 'win32') throw new Error('桌面控制目前仅支持 Windows 客户端');
  const a = String(action || '');
  const key = frameKeyOf(args);
  const rect = Array.isArray(args._bannerRect) && args._bannerRect.length === 4 && args._bannerRect.every(Number.isFinite) ? args._bannerRect.map(Math.round) : null;
  const extra = { bannerHwnd: Number(args._bannerHwnd) || 0, bannerRect: rect };
  if (a === 'batch') return runBatch(args, key, extra);
  const result = await runOne(a, args, key, frames.get(key), extra);
  if (args.screenshot_after && a !== 'screenshot' && a !== 'zoom') {
    // 做过结果确认的动作已经等到界面稳定，直接截；没确认的按 settle_ms（默认 400）等
    const settle = args.settle_ms != null ? Number(args.settle_ms) : result.verify ? 0 : 400;
    await sleep(Math.max(0, Math.min(5000, settle || 0)));
    const f = frames.get(key);
    result.screenshot = await doScreenshot({ window: f?.window ?? args.window, display: f?.display }, key);
  }
  return result;
}

async function runOne(a, args, key, frame, extra) {
  switch (a) {
    case 'screenshot': return doScreenshot(args, key);
    case 'zoom': return doZoom(args, frame);
    case 'move': case 'click': case 'double_click': case 'triple_click': case 'right_click': case 'scroll':
      return doPointer(a, args, frame, extra);
    case 'type': {
      const text = String(args.text == null ? '' : args.text);
      const { obs, wantChanged } = obsParams(a, args);
      const r = await sendCmd('type', { text, obs }, 60_000);
      const out = { ok: true, action: a, chars: r.chars, foreground: brief(r.foreground) };
      const verify = buildVerify(a, r.obs, { typed: text, wantChanged });
      if (verify) out.verify = verify;
      return out;
    }
    case 'key': {
      const k = parseKeys(args.keys);
      const { obs, wantChanged } = obsParams(a, args);
      const r = await sendCmd('chord', { mods: k.mods, key: k.key, char: k.char, obs, label: keyLabels(args.keys) }, obs ? 40_000 : 20_000);
      const out = { ok: true, action: a, keys: String(args.keys), foreground: brief(r.foreground) };
      const verify = buildVerify(a, r.obs, { wantChanged });
      if (verify) out.verify = verify;
      return out;
    }
    case 'wait': await sleep(Math.max(0, Math.min(10_000, Number(args.ms ?? args.duration_ms) || 500))); return { ok: true };
    case 'wait_for_window': return waitForWindow(args);
    case 'displays': { const r = await sendCmd('displays'); return { displays: r.displays || [] }; }
    case 'cursor': {
      const r = await sendCmd('cursor');
      const inFrame = toFramePixels(frame, r.absX, r.absY);
      return { absX: r.absX, absY: r.absY, ...(inFrame ? { x: inFrame.x, y: inFrame.y } : {}) };
    }
    case 'windows': { const r = await sendCmd('windows'); return { windows: r.windows || [] }; }
    case 'active_window': { const r = await sendCmd('active'); return { window: r.window || null }; }
    case 'processes': { const r = await sendCmd('processes'); return { processes: r.processes || [] }; }
    case 'launch': {
      const r = await sendCmd('launch', {
        file: String(args.file || ''),
        args: Array.isArray(args.args) ? args.args.map(String) : [],
        cwd: args.cwd ? String(args.cwd) : undefined,
      }, 30_000);
      return { ok: true, pid: r.pid, file: r.file };
    }
    case 'focus_window': {
      const r = await sendCmd('focus_window', { window: Number(args.window) });
      if (!r.focused) {
        const fg = r.foreground;
        throw new Error(`没能把窗口提到前台（Windows 前台锁拦下了；当前前台是「${fg?.title || fg?.process || '未知'}」）。可以直接点一下目标窗口的标题栏来激活它。`);
      }
      return { ok: true, window: r.window || null };
    }
    case 'set_window': {
      const r = await sendCmd('set_window', {
        window: Number(args.window),
        x: args.x == null ? null : Number(args.x),
        y: args.y == null ? null : Number(args.y),
        w: args.w == null ? null : Number(args.w),
        h: args.h == null ? null : Number(args.h),
      });
      return { ok: r.ok !== false, window: r.window || null };
    }
    case 'close_window': {
      const r = await sendCmd('close_window', { window: Number(args.window) });
      return { ok: r.ok !== false };
    }
    case 'uia_tree': {
      const r = await sendCmd('uia_tree', {
        window: args.window == null ? null : Number(args.window),
        depth: Math.max(0, Math.min(12, Number(args.depth) || 4)),
        max: Math.max(1, Math.min(1000, Number(args.max) || 250)),
      }, 30_000);
      return { window: r.window || null, nodes: r.nodes || [], truncated: !!r.truncated };
    }
    case 'uia_action': {
      const { obs, wantChanged } = obsParams('uia_action', args);
      const r = await sendCmd('uia_action', {
        ref: Number(args.ref),
        action: String(args.action || ''),
        value: args.value == null ? '' : String(args.value),
        obs,
      }, obs ? 40_000 : 20_000);
      const out = { ok: r.ok !== false, action: 'uia_action', ref: r.ref, uiaAction: r.action };
      const verify = buildVerify('uia_action', r.obs, { wantChanged });
      if (verify) out.verify = verify;
      return out;
    }
    default: throw new Error('未知桌面动作：' + a);
  }
}

// 等窗口出现（或消失）：按标题/进程名/类名子串匹配，250ms 一轮，最多 60 秒
async function waitForWindow(args) {
  const q = String(args.query || '').toLowerCase().trim();
  if (!q) throw new Error('wait_for_window 需要 query（窗口标题、进程名或类名里的一段字）');
  const gone = !!args.gone;
  const timeout = Math.max(250, Math.min(60_000, Number(args.timeout_ms) || 10_000));
  const start = Date.now();
  const gen = generation;
  for (;;) {
    const r = await sendCmd('windows');
    const hits = (r.windows || []).filter((w) => `${w.title} ${w.process} ${w.className}`.toLowerCase().includes(q));
    if (gone ? hits.length === 0 : hits.length > 0) return { ok: true, waitedMs: Date.now() - start, windows: hits.slice(0, 10) };
    if (Date.now() - start >= timeout) throw new Error(`等了 ${Math.round(timeout / 1000)} 秒，${gone ? '含' : '没有出现含'}「${args.query}」的窗口${gone ? '还在' : ''}。`);
    if (gen !== generation) throw new Error('桌面控制已停止');
    await sleep(250);
  }
}

// 一次调用跑一串动作（官方 computer_batch 同语义）：
//   · 批里所有坐标都按【调用前】最近那张截图；批里中途截的图不改变本批的坐标基准，
//     批跑完后最后一张截图才成为下一次调用的基准；
//   · 顺序执行、遇错即停，回报已完成的每一步和出错那步；急停立即中止。
async function runBatch(args, key, extra) {
  const list = Array.isArray(args.actions) ? args.actions : [];
  if (!list.length) throw new Error('batch 需要 actions: [{action:"click",x,y}, {action:"type",text}, …]');
  if (list.length > 30) throw new Error('batch 一次最多 30 步');
  const startFrame = frames.get(key);
  const gen = generation;
  const steps = [];
  const images = [];
  let lastShotFrame = null;
  let waited = 0;
  const started = Date.now();
  for (let i = 0; i < list.length; i++) {
    if (gen !== generation) { steps.push({ step: i + 1, error: '桌面控制已停止（急停/关闭），批处理中止' }); break; }
    // 每步都可能等界面稳定、等预期：整批封顶 100 秒（调用方的请求超时是 120 秒）
    if (Date.now() - started > 100_000) { steps.push({ step: i + 1, error: 'batch 已跑满 100 秒，后面的步骤没执行' }); break; }
    const item = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const act = String(item.action || '');
    if (!BATCH_ACTIONS.has(act)) { steps.push({ step: i + 1, action: act, error: `batch 里不支持「${act}」` }); break; }
    const sub = act === 'uia_action' ? { ...item, action: String(item.uiaAction || '') } : item;
    if (act === 'wait') {
      waited += Math.max(0, Math.min(10_000, Number(item.ms ?? item.duration_ms) || 500));
      if (waited > 30_000) { steps.push({ step: i + 1, action: act, error: 'batch 里的等待合计超过 30 秒' }); break; }
    }
    try {
      const shotKey = key + '#batch';
      const r = await runOne(act, sub, shotKey, startFrame, extra);
      if (act === 'screenshot') {
        lastShotFrame = frames.get(shotKey);
        images.push({ step: i + 1, kind: 'screenshot', image: r.image, mimeType: r.mimeType, fw: r.fw, fh: r.fh });
        steps.push({ step: i + 1, action: act, ok: true, size: `${r.fw}×${r.fh}` });
      } else if (act === 'zoom') {
        images.push({ step: i + 1, kind: 'zoom', image: r.image, mimeType: r.mimeType, fw: r.fw, fh: r.fh, region: r.region });
        steps.push({ step: i + 1, action: act, ok: true, region: r.region });
      } else {
        steps.push({ step: i + 1, ...r, action: act });
        // 预期不符＝这一步没达到目的：后面的步骤是照着「它成功了」写的，不能接着做
        if (r.verify?.expect && !r.verify.expect.ok) {
          steps[steps.length - 1].error = '预期不符，批处理在这一步停下';
          break;
        }
      }
    } catch (e) {
      steps.push({ step: i + 1, action: act, error: String(e?.message || e) });
      break;
    }
  }
  frames.delete(key + '#batch');
  if (lastShotFrame) frames.set(key, lastShotFrame);
  const failed = steps.find((s) => s.error);
  return { ok: !failed, completed: steps.filter((s) => !s.error).length, total: list.length, steps, images };
}

/** 关掉常驻宿主（急停/停止被控时调，确保截屏与输入真正停止）。 */
export function shutdownDesktop() {
  generation++;
  frames.clear();
  const h = host; host = null;
  if (h && h.child) { try { h.child.stdin.end(); } catch {} try { h.child.kill(); } catch {} }
  unlink(HOST_SCRIPT).catch(() => {});
}
