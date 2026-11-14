#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文件预览样张生成器（只进库脚本，产物不进库）。

用法：
  python web/scripts/preview-qa/make-samples.py                         # 生成整套样张到共用样张目录（%TEMP%/bridge-preview-qa/vault/预览样张，已存在的文件跳过）
  python web/scripts/preview-qa/make-samples.py --out <目录>            # 生成到别处
  python web/scripts/preview-qa/make-samples.py --out <目录> --force    # 全部重新生成
  python web/scripts/preview-qa/make-samples.py --out <目录> --only 图片,视频   # 只生成某几组
  可选：--seq 60（序列图张数） --long-min 6（长视频分钟数） --audio-min 40（长音频分钟数） --no-soffice（不转 doc/rtf/odt 等旧格式）

依赖：Pillow、python-docx、openpyxl、python-pptx、reportlab、PyMuPDF（fitz）、numpy；ffmpeg 在 PATH；LibreOffice（soffice）可选。
产物目录结构见文件末尾 GROUPS；结束时在 <目录>/manifest.json 写清单（相对路径、字节数、说明），控制台打印总大小。
设计要点：
  - 每张图 / 每段视频都画上醒目的序号、尺寸、时间码，截图里一眼认得出是哪张、播到哪；
  - 只用合成内容，绝不拷维护者的真实素材（uploads/、media/ 里有发票等隐私）；
  - soffice 用独立的临时 profile，带超时，结束后按 PID 收进程树并删 profile（不留 lo-prof-*，不留 soffice.bin）。
"""
import argparse
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

FONT_DIR = os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts')
FONT_CN = next((p for p in [os.path.join(FONT_DIR, n) for n in ('simhei.ttf', 'msyh.ttc', 'Deng.ttf', 'NotoSansSC-VF.ttf')] if os.path.exists(p)), None)
FONT_CN_TTF = next((p for p in [os.path.join(FONT_DIR, n) for n in ('simhei.ttf', 'Deng.ttf')] if os.path.exists(p)), None)  # reportlab 只吃 .ttf
FONT_MONO = next((p for p in [os.path.join(FONT_DIR, n) for n in ('consola.ttf', 'cour.ttf')] if os.path.exists(p)), FONT_CN)

MANIFEST = {}   # rel -> 说明


def note(rel, desc):
    MANIFEST[rel.replace('\\', '/')] = desc


def need(path, force):
    """文件已存在且非空就跳过（返回 False）"""
    if force or not os.path.exists(path) or os.path.getsize(path) == 0:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        return True
    return False


def run(cmd, timeout=900, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError('命令失败（%s）：%s' % (cmd[0], r.stderr.decode('utf-8', 'replace')[-800:]))
    return r


# —— 画图小工具 ——————————————————————————————————————————————————————————————
def pil():
    from PIL import Image, ImageDraw, ImageFont
    return Image, ImageDraw, ImageFont


def font(size, mono=False):
    _, _, ImageFont = pil()
    p = FONT_MONO if mono else FONT_CN
    try:
        return ImageFont.truetype(p, size)
    except Exception:
        return ImageFont.load_default()


def hsv(h, s=0.65, v=0.9):
    import colorsys
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, s, v)
    return (int(r * 255), int(g * 255), int(b * 255))


def base_canvas(w, h, hue=0.6, noise=0.0, seed=0):
    """渐变底 + 网格 + 可选噪声纹理（噪声让 JPEG 体积接近真照片）"""
    import numpy as np
    Image, ImageDraw, _ = pil()
    sw, sh = max(2, min(w, 1600)), max(2, min(h, 1200))
    yy, xx = np.mgrid[0:sh, 0:sw].astype(np.float32)
    fx, fy = xx / max(1, sw - 1), yy / max(1, sh - 1)
    c1, c2, c3 = np.array(hsv(hue), np.float32), np.array(hsv(hue + 0.33, 0.5, 0.8), np.float32), np.array(hsv(hue + 0.66, 0.6, 0.6), np.float32)
    img = (c1 * (1 - fx)[..., None] * (1 - fy)[..., None] + c2 * fx[..., None] + c3 * fy[..., None] * (1 - fx)[..., None])
    img = np.clip(img, 0, 255).astype(np.uint8)
    im = Image.fromarray(img, 'RGB')
    if (sw, sh) != (w, h):
        im = im.resize((w, h), Image.BICUBIC)
    if noise > 0:
        rng = np.random.default_rng(seed)
        arr = np.asarray(im).astype(np.int16)
        n = rng.normal(0, noise, (h, w, 1)).astype(np.int16)
        im = Image.fromarray(np.clip(arr + n, 0, 255).astype(np.uint8), 'RGB')
    d = ImageDraw.Draw(im)
    step = max(40, min(w, h) // 12)
    for x in range(0, w, step):
        d.line([(x, 0), (x, h)], fill=(255, 255, 255), width=max(1, step // 60))
    for y in range(0, h, step):
        d.line([(0, y), (w, y)], fill=(255, 255, 255), width=max(1, step // 60))
    return im


def big_label(im, text, sub=None, frac=0.32, color=(255, 255, 255)):
    _, ImageDraw, _ = pil()
    d = ImageDraw.Draw(im)
    w, h = im.size
    f = font(max(10, int(min(w, h) * frac)))
    bb = d.textbbox((0, 0), text, font=f)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    x, y = (w - tw) // 2 - bb[0], (h - th) // 2 - bb[1]
    sw = max(1, int(min(w, h) * frac / 18))
    d.text((x, y), text, font=f, fill=color, stroke_width=sw, stroke_fill=(0, 0, 0))
    if sub:
        fs = font(max(10, int(min(w, h) * 0.045)))
        d.text((max(4, int(w * 0.03)), max(4, int(h * 0.03))), sub, font=fs, fill=(255, 255, 255), stroke_width=max(1, sw // 3), stroke_fill=(0, 0, 0))
    return im


def corner_marks(im):
    """四角标记：看裁切、看越界"""
    _, ImageDraw, _ = pil()
    d = ImageDraw.Draw(im)
    w, h = im.size
    s = max(8, min(w, h) // 10)
    f = font(max(8, s // 2))
    for (x, y, t) in [(0, 0, '左上'), (w - s, 0, '右上'), (0, h - s, '左下'), (w - s, h - s, '右下')]:
        d.rectangle([x, y, x + s - 1, y + s - 1], fill=(220, 30, 60))
        d.text((x + s // 10, y + s // 5), t, font=f, fill=(255, 255, 255))
    return im


# —— 图片 ——————————————————————————————————————————————————————————————————
def gen_images(out, a):
    Image, ImageDraw, _ = pil()
    dd = os.path.join(out, '图片')
    p = os.path.join(dd, '大图-8000x6000.jpg')
    if need(p, a.force):
        im = corner_marks(big_label(base_canvas(8000, 6000, 0.05, noise=6, seed=1), '8000×6000', '大图 48MP · 放大看网格是否清楚'))
        im.save(p, 'JPEG', quality=90)
    note('图片/大图-8000x6000.jpg', '48MP 大 JPEG：缩放升级原图、内存、平移边界')

    p = os.path.join(dd, 'EXIF方向6-竖拍.jpg')
    if need(p, a.force):
        up = base_canvas(3000, 4000, 0.3, noise=4, seed=2)
        d = ImageDraw.Draw(up)
        # 正确显示时：箭头朝上、文字正立
        d.polygon([(1500, 300), (900, 1300), (2100, 1300)], fill=(255, 255, 255), outline=(0, 0, 0), width=12)
        d.rectangle([1300, 1300, 1700, 2300], fill=(255, 255, 255), outline=(0, 0, 0), width=12)
        big_label(up, '↑ 正', 'EXIF Orientation=6：箭头朝上才对', frac=0.18)
        corner_marks(up)
        raw = up.transpose(Image.ROTATE_90)   # 原始像素逆时针转 90°，Orientation=6 让查看器顺时针转回来
        ex = Image.Exif()
        ex[0x0112] = 6
        ex[0x010F] = 'QA-Camera'
        ex[0x0110] = 'Preview-QA 1'
        raw.save(p, 'JPEG', quality=90, exif=ex.tobytes())
    note('图片/EXIF方向6-竖拍.jpg', 'EXIF 方向 6：原始像素是横的，正确显示箭头朝上')

    p = os.path.join(dd, '全景-12000x800.jpg')
    if need(p, a.force):
        im = base_canvas(12000, 800, 0.55, noise=4, seed=3)
        d = ImageDraw.Draw(im)
        f = font(300)
        for i in range(10):
            d.text((i * 1200 + 380, 220), str(i + 1), font=f, fill=(255, 255, 255), stroke_width=10, stroke_fill=(0, 0, 0))
        corner_marks(im)
        im.save(p, 'JPEG', quality=88)
    note('图片/全景-12000x800.jpg', '15:1 全景：适配、平移、缩略图裁切')

    p = os.path.join(dd, '透明.png')
    if need(p, a.force):
        im = Image.new('RGBA', (1200, 900), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.ellipse([100, 100, 700, 700], fill=(255, 80, 80, 255))
        d.rectangle([500, 300, 1100, 800], fill=(60, 140, 255, 140))
        d.text((140, 760), '透明 PNG：底色应是棋盘格或查看器底', font=font(48), fill=(20, 20, 20, 255))
        im.save(p, 'PNG')
    note('图片/透明.png', '带 alpha 的 PNG：暗底/亮底下是否可见')

    p = os.path.join(dd, '动图.gif')
    if need(p, a.force):
        frames = []
        for i in range(24):
            fr = Image.new('RGB', (480, 360), hsv(i / 24))
            d = ImageDraw.Draw(fr)
            d.text((150, 100), '%02d' % (i + 1), font=font(160, True), fill=(255, 255, 255), stroke_width=4, stroke_fill=(0, 0, 0))
            a0 = i / 24 * 2 * math.pi
            d.ellipse([240 + 140 * math.cos(a0) - 18, 180 + 140 * math.sin(a0) - 18, 240 + 140 * math.cos(a0) + 18, 180 + 140 * math.sin(a0) + 18], fill=(0, 0, 0))
            frames.append(fr.convert('P', palette=Image.ADAPTIVE))
        frames[0].save(p, save_all=True, append_images=frames[1:], duration=80, loop=0)
    note('图片/动图.gif', '24 帧动图：衍生图不能丢动画')

    p = os.path.join(dd, '图.webp')
    if need(p, a.force):
        big_label(base_canvas(2400, 1600, 0.8, noise=3, seed=4), 'WEBP', '2400×1600 webp').save(p, 'WEBP', quality=85)
    note('图片/图.webp', 'webp')

    p = os.path.join(dd, '矢量.svg')
    if need(p, a.force):
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">\n'
                    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs>\n'
                    '<rect width="800" height="600" fill="url(#g)"/>\n'
                    '<circle cx="400" cy="300" r="180" fill="none" stroke="#fff" stroke-width="16"/>\n'
                    '<path d="M300 300 l70 70 l140 -150" fill="none" stroke="#fff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>\n'
                    '<text x="400" y="560" font-size="40" text-anchor="middle" fill="#fff" font-family="sans-serif">SVG 800x600 矢量放大应锐利</text>\n'
                    '</svg>\n')
    note('图片/矢量.svg', 'SVG（带 width/height）：放大锐利、缩略图 density')

    p = os.path.join(dd, '极小-1x1.png')
    if need(p, a.force):
        Image.new('RGB', (1, 1), (255, 0, 0)).save(p, 'PNG')
    note('图片/极小-1x1.png', '1×1：不能被放大到糊满屏、不能除零')

    p = os.path.join(dd, '小图-64x48.png')
    if need(p, a.force):
        big_label(base_canvas(64, 48, 0.15), '64', frac=0.6).save(p, 'PNG')
    note('图片/小图-64x48.png', '小图：适配时是否放大（fitSize 基准）')

    p = os.path.join(dd, '超高-1080x8000.jpg')
    if need(p, a.force):
        im = base_canvas(1080, 8000, 0.42, noise=3, seed=5)
        d = ImageDraw.Draw(im)
        for i in range(10):
            d.text((380, i * 800 + 280), str(i + 1), font=font(240), fill=(255, 255, 255), stroke_width=8, stroke_fill=(0, 0, 0))
        corner_marks(im).save(p, 'JPEG', quality=88)
    note('图片/超高-1080x8000.jpg', '长截图：竖向适配与滚动')

    # —— 图片查看器改版补的三张（feat/pv-img）：文件信息里的 EXIF 行、webp / png 动图不能被预览档压成静帧 ——
    p = os.path.join(dd, '相机EXIF.jpg')
    if need(p, a.force):
        im = big_label(base_canvas(2400, 1600, 0.62, noise=4, seed=6), 'EXIF', '拍摄时间 / 相机 / 镜头 / 曝光参数')
        ex = Image.Exif()
        ex[0x010F] = 'Canon'
        ex[0x0110] = 'Canon EOS R5'
        ex[0x0132] = '2024:05:01 12:34:56'
        from PIL.TiffImagePlugin import IFDRational   # 元组会被存成两个整数，要 RATIONAL 得显式包一层
        sub = ex.get_ifd(0x8769)
        sub[0x9003] = '2024:05:01 12:34:56'
        sub[0x829A] = IFDRational(1, 125)
        sub[0x829D] = IFDRational(28, 10)
        sub[0x8827] = 400
        sub[0x920A] = IFDRational(50, 1)
        sub[0xA434] = 'RF24-70mm F2.8 L IS USM'
        im.save(p, 'JPEG', quality=88, exif=ex.tobytes())
    note('图片/相机EXIF.jpg', '带完整 EXIF：文件信息里的拍摄时间、相机、镜头、参数')

    def anim_frames(w, h, n):
        fr = []
        for i in range(n):
            f = Image.new('RGB', (w, h), hsv(i / n))
            d = ImageDraw.Draw(f)
            d.text((w * 0.3, h * 0.28), '%02d' % (i + 1), font=font(int(h * 0.44), True), fill=(255, 255, 255), stroke_width=4, stroke_fill=(0, 0, 0))
            fr.append(f)
        return fr

    p = os.path.join(dd, '动图.webp')
    if need(p, a.force):
        fr = anim_frames(480, 360, 16)
        fr[0].save(p, 'WEBP', save_all=True, append_images=fr[1:], duration=90, loop=0, quality=80)
    note('图片/动图.webp', '16 帧动画 webp：预览档会压成静帧，查看器要认出来直接上原图')

    p = os.path.join(dd, '动图-APNG.png')
    if need(p, a.force):
        fr = anim_frames(480, 360, 16)
        fr[0].save(p, 'PNG', save_all=True, append_images=fr[1:], duration=90, loop=0)
    note('图片/动图-APNG.png', '16 帧 APNG：同上')


def gen_sequence(out, a):
    Image, ImageDraw, _ = pil()
    dd = os.path.join(out, '序列')
    n = a.seq
    for i in range(1, n + 1):
        p = os.path.join(dd, '序列-%03d.jpg' % i)
        if need(p, a.force):
            portrait = (i % 7 == 0)
            w, h = (3024, 4032) if portrait else (4032, 3024)
            im = base_canvas(w, h, (i * 0.137) % 1, noise=7, seed=100 + i)
            big_label(im, '%d' % i, '序列 %d / %d  %d×%d' % (i, n, w, h), frac=0.45)
            corner_marks(im).save(p, 'JPEG', quality=90)
    note('序列/', '%d 张 12MP 序列图（每 7 张一张竖图），侧滑卡顿/空白帧基准；每张画巨大序号' % n)

    # 混排：图片 + 视频 + PDF，给之后「画廊混排、文档上一个/下一个」用
    md = os.path.join(out, '混排')
    for i in range(1, 7):
        p = os.path.join(md, '混排-%02d.jpg' % (i * 2 - 1))
        if need(p, a.force):
            big_label(base_canvas(2400, 1800, i * 0.15, noise=4, seed=200 + i), '%02d' % (i * 2 - 1), '混排 图片').save(p, 'JPEG', quality=88)
    note('混排/', '图片与视频、PDF 交替排列（之后画廊混排、文档上一个/下一个）')


# —— 视频 / 音频（ffmpeg） ——————————————————————————————————————————————————
def ff_font():
    # drawtext 的 fontfile：Windows 盘符冒号要转义
    return (FONT_MONO or '').replace('\\', '/').replace(':', '\\:')


def tc_filter(w, h, label):
    fs = max(18, h // 12)
    ff = ff_font()
    lab = label.replace(':', '\\:').replace("'", '')
    return ("drawtext=fontfile='{ff}':text='%{{pts\\:hms}}  F%{{n}}':x=(w-tw)/2:y=h*0.42:fontsize={fs}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw={b},"
            "drawtext=fontfile='{ff}':text='{lab}':x=24:y=24:fontsize={fs2}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=8").format(ff=ff, fs=fs, b=fs // 4, lab=lab, fs2=max(14, fs // 2))


def ffmpeg_video(path, w, h, secs, vcodec_args, label, audio=True, rate=30, extra_in=None, aud_args=None, fmt_args=None):
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
           '-f', 'lavfi', '-i', 'testsrc2=size=%dx%d:rate=%d:duration=%d' % (w, h, rate, secs)]
    if audio:
        cmd += ['-f', 'lavfi', '-i', 'sine=frequency=440:beep_factor=4:sample_rate=48000:duration=%d' % secs]
    if extra_in:
        cmd += extra_in
    cmd += ['-vf', tc_filter(w, h, label)] + vcodec_args
    if audio:
        cmd += aud_args or ['-c:a', 'aac', '-b:a', '128k']
    cmd += (fmt_args or []) + ['-shortest', path]
    run(cmd, timeout=1800)


def gen_video(out, a):
    dd = os.path.join(out, '视频')
    x264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-g', '60', '-movflags', '+faststart']

    p = os.path.join(dd, '1080p-h264-带声.mp4')
    if need(p, a.force):
        meta = os.path.join(tempfile.gettempdir(), 'pvqa-chapters.txt')
        with open(meta, 'w', encoding='utf-8', newline='\n') as f:
            f.write(';FFMETADATA1\ntitle=预览样张 1080p\n')
            for k, (s, e, t) in enumerate([(0, 10, '第一章 开场'), (10, 20, '第二章 中段'), (20, 30, '第三章 结尾')]):
                f.write('[CHAPTER]\nTIMEBASE=1/1000\nSTART=%d\nEND=%d\ntitle=%s\n' % (s * 1000, e * 1000, t))
        ffmpeg_video(p, 1920, 1080, 30, x264, '1080p H.264 AAC', extra_in=['-i', meta], fmt_args=['-map', '0:v', '-map', '1:a', '-map_metadata', '2', '-map_chapters', '2'])
        os.remove(meta)
    note('视频/1080p-h264-带声.mp4', '30s 1080p H.264+AAC，带三个章节，画面烧时间码与帧号')
    p = os.path.join(dd, '1080p-h264-带声.vtt')
    if need(p, a.force):
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write('WEBVTT\n\n')
            for s in range(0, 30, 3):
                f.write('00:00:%02d.000 --> 00:00:%02d.500\n第 %d 句字幕（%d 秒）\n\n' % (s, s + 2, s // 3 + 1, s))
    note('视频/1080p-h264-带声.vtt', '同名 WebVTT 字幕')

    p = os.path.join(dd, 'hevc.mp4')
    if need(p, a.force):
        ffmpeg_video(p, 1920, 1080, 20, ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-x265-params', 'log-level=error', '-movflags', '+faststart'], 'HEVC hvc1')
    note('视频/hevc.mp4', '20s HEVC（hvc1）：Edge 无头多半解不了，走转码兜底/错误态')

    p = os.path.join(dd, '竖拍-1080x1920.mp4')
    if need(p, a.force):
        ffmpeg_video(p, 1080, 1920, 15, x264, 'Portrait 1080x1920')
    note('视频/竖拍-1080x1920.mp4', '15s 竖拍：全屏不该强制横屏')

    p = os.path.join(dd, 'vp9.webm')
    if need(p, a.force):
        ffmpeg_video(p, 1280, 720, 15, ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-row-mt', '1'], 'VP9 Opus', aud_args=['-c:a', 'libopus', '-b:a', '96k'])
    note('视频/vp9.webm', '15s VP9+Opus webm')

    p = os.path.join(dd, '片段.mov')
    if need(p, a.force):
        ffmpeg_video(p, 1280, 720, 10, ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p'], 'MOV H.264')
    note('视频/片段.mov', '10s mov 容器')

    p = os.path.join(dd, '长片-%d分钟.mp4' % a.long_min)
    if need(p, a.force):
        ffmpeg_video(p, 1280, 720, a.long_min * 60, ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p', '-g', '60', '-movflags', '+faststart'], 'Long %d min' % a.long_min, rate=25)
    note('视频/长片-%d分钟.mp4' % a.long_min, '%d 分钟 720p，拖进度条、seek 出帧耗时（画面烧时间码）' % a.long_min)

    p = os.path.join(dd, '无声-短.mp4')
    if need(p, a.force):
        ffmpeg_video(p, 640, 360, 5, x264, 'No audio 5s', audio=False)
    note('视频/无声-短.mp4', '5s 无音轨：音量控件应禁用/隐藏')

    # 混排里的两段视频
    md = os.path.join(out, '混排')
    for k in (4, 8):
        p = os.path.join(md, '混排-%02d.mp4' % k)
        if need(p, a.force):
            ffmpeg_video(p, 1280, 720, 6, x264, 'Mix %02d' % k)


def gen_audio(out, a):
    Image, _, _ = pil()
    dd = os.path.join(out, '音频')
    p = os.path.join(dd, '带封面.mp3')
    if need(p, a.force):
        cover = os.path.join(tempfile.gettempdir(), 'pvqa-cover.jpg')
        big_label(base_canvas(800, 800, 0.9, noise=3, seed=9), '封面', 'ID3 APIC 800×800', frac=0.3).save(cover, 'JPEG', quality=88)
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=523:beep_factor=2:duration=95', '-i', cover,
             '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-b:a', '160k', '-c:v', 'mjpeg', '-id3v2_version', '3',
             '-metadata', 'title=预览样张之歌', '-metadata', 'artist=QA 合成器', '-metadata', 'album=bridge 预览样张', '-metadata', 'track=1',
             '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)', '-disposition:v', 'attached_pic', p])
        os.remove(cover)
    note('音频/带封面.mp3', '95s mp3，ID3 标题/艺人/专辑 + 封面图')

    p = os.path.join(dd, '长音频-%d分钟.mp3' % a.audio_min)
    if need(p, a.force):
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:beep_factor=8:duration=%d' % (a.audio_min * 60),
             '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '48k', '-metadata', 'title=长音频 %d 分钟' % a.audio_min, p], timeout=1800)
    note('音频/长音频-%d分钟.mp3' % a.audio_min, '%d 分钟单声道 mp3：不能整段读进内存才播、波形抽样' % a.audio_min)

    p = os.path.join(dd, '提示音.wav')
    if need(p, a.force):
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:beep_factor=3:duration=10', '-c:a', 'pcm_s16le', p])
    note('音频/提示音.wav', '10s PCM wav')


# —— PDF ——————————————————————————————————————————————————————————————————
def gen_pdf(out, a):
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4, landscape, letter
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    dd = os.path.join(out, '文档')
    cn = 'Helvetica'
    if FONT_CN_TTF:
        try:
            pdfmetrics.registerFont(TTFont('QACN', FONT_CN_TTF))
            cn = 'QACN'
        except Exception:
            pass

    p = os.path.join(dd, '300页-书签-文本层.pdf')
    if need(p, a.force):
        c = canvas.Canvas(p, pagesize=A4)
        c.setTitle('预览样张 300 页')
        W, H = A4
        for i in range(1, 301):
            ch = (i - 1) // 30 + 1
            key = 'p%d' % i
            c.bookmarkPage(key)
            if (i - 1) % 30 == 0:
                c.addOutlineEntry('第 %d 章（第 %d-%d 页）' % (ch, i, i + 29), key, level=0)
            if (i - 1) % 10 == 0:
                c.addOutlineEntry('第 %d 节' % ((i - 1) // 10 + 1), key, level=1)
            c.setFillColorRGB(*[x / 255 for x in hsv(i / 300, 0.25, 0.97)])
            c.rect(0, H - 90, W, 90, fill=1, stroke=0)
            c.setFillColorRGB(0, 0, 0)
            c.setFont(cn, 28)
            c.drawString(50, H - 60, '第 %d 页 / 共 300 页　第 %d 章' % (i, ch))
            c.setFont(cn, 160)
            c.drawCentredString(W / 2, H / 2 - 40, str(i))
            c.setFont(cn, 11)
            y = H - 130
            for ln in range(18):
                c.drawString(50, y, '可选中的文本层 第%d页第%d行：The quick brown fox 敏捷的棕色狐狸跳过懒狗 %d-%d 关键词「样张%03d」' % (i, ln + 1, i, ln + 1, i))
                y -= 16
            if i < 300:   # 页内链接：跳到下一章首页
                nxt = min(300, ch * 30 + 1)
                c.setFont(cn, 12)
                c.setFillColorRGB(0.1, 0.3, 0.9)
                c.drawString(50, 60, '→ 跳到第 %d 页（PDF 内链接）' % nxt)
                c.linkRect('', 'p%d' % nxt, (45, 55, 300, 75), relative=0)
                c.setFillColorRGB(0, 0, 0)
            c.showPage()
        c.save()
    note('文档/300页-书签-文本层.pdf', '300 页 A4：两级书签、每页文本层、页内链接；测首开、内存回收、页码、搜索「样张123」')

    p = os.path.join(dd, '横竖混排.pdf')
    if need(p, a.force):
        sizes = [A4, landscape(A4), letter, (600, 600), landscape(letter), (300, 900), A4]
        c = canvas.Canvas(p)
        for i, sz in enumerate(sizes, 1):
            c.setPageSize(sz)
            W, H = sz
            c.setFillColorRGB(*[x / 255 for x in hsv(i / 7, 0.3, 0.95)])
            c.rect(10, 10, W - 20, H - 20, fill=1, stroke=1)
            c.setFillColorRGB(0, 0, 0)
            c.setFont(cn, 36)
            c.drawCentredString(W / 2, H / 2, '第 %d 页  %d×%d pt' % (i, W, H))
            c.showPage()
        c.save()
    note('文档/横竖混排.pdf', '7 页：A4 竖、A4 横、Letter、方形、超窄长；页宽适配与缩放')

    p = os.path.join(dd, '中文字体.pdf')
    if need(p, a.force):
        c = canvas.Canvas(p, pagesize=A4)
        W, H = A4
        c.setFont(cn, 22)
        c.drawString(50, H - 80, '第 1 页：内嵌 TrueType 中文（黑体）')
        c.setFont(cn, 14)
        c.drawString(50, H - 120, '天地玄黄 宇宙洪荒 日月盈昃 辰宿列张 — 内嵌字体，任何查看器都应显示')
        c.showPage()
        try:
            pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
            c.setFont('STSong-Light', 22)
            c.drawString(50, H - 80, '第 2 页：未内嵌 CID 字体 STSong-Light')
            c.setFont('STSong-Light', 14)
            c.drawString(50, H - 120, '寒来暑往 秋收冬藏 — 依赖 cMap 与标准字体数据，缺配置会成方块或空白')
            c.drawString(50, H - 150, '（pdf.js 需 cMapUrl / standardFontDataUrl）')
        except Exception as e:
            c.setFont(cn, 14)
            c.drawString(50, H - 80, 'CID 字体不可用：%s' % e)
        c.showPage()
        c.save()
    note('文档/中文字体.pdf', '两页：内嵌黑体 + 未内嵌 CID 字体 STSong-Light（验 cMapUrl）')

    p = os.path.join(dd, '扫描图.pdf')
    if need(p, a.force):
        import fitz
        Image, ImageDraw, _ = pil()
        doc = fitz.open()
        for i in range(1, 6):
            im = Image.new('RGB', (1654, 2339), (246, 244, 236))
            d = ImageDraw.Draw(im)
            d.text((120, 120), '扫描件 第 %d 页（只有图像，没有文本层）' % i, font=font(56), fill=(30, 30, 30))
            for ln in range(40):
                d.text((120, 260 + ln * 48), '这是一行被拍成图片的文字，第 %d 行，无法选中复制。' % (ln + 1), font=font(32), fill=(50, 50, 50))
            im = im.rotate(0.8 * (1 if i % 2 else -1), expand=False, fillcolor=(246, 244, 236))
            buf = os.path.join(tempfile.gettempdir(), 'pvqa-scan-%d.jpg' % i)
            im.save(buf, 'JPEG', quality=70)
            pg = doc.new_page(width=595, height=842)
            pg.insert_image(pg.rect, filename=buf)
            os.remove(buf)
        doc.save(p, deflate=True)
        doc.close()
    note('文档/扫描图.pdf', '5 页纯图像 PDF：无文本层，搜索应提示无文字')

    p = os.path.join(dd, '加密-密码1234.pdf')
    if need(p, a.force):
        import fitz
        doc = fitz.open()
        pg = doc.new_page()
        pg.insert_text((72, 100), 'Encrypted sample. user password = 1234', fontsize=18)
        doc.save(p, encryption=fitz.PDF_ENCRYPT_AES_256, user_pw='1234', owner_pw='owner-qa', permissions=int(fitz.PDF_PERM_PRINT | fitz.PDF_PERM_COPY))
        doc.close()
    note('文档/加密-密码1234.pdf', 'AES-256 加密，打开密码 1234：应弹密码输入而不是通用错误')

    # 混排目录里放一份 PDF（之后「文档上一个/下一个」用）
    mp = os.path.join(out, '混排', '混排-12.pdf')
    src = os.path.join(dd, '横竖混排.pdf')
    if os.path.exists(src) and need(mp, a.force):
        shutil.copyfile(src, mp)


# —— Office ——————————————————————————————————————————————————————————————
def gen_office(out, a):
    Image, _, _ = pil()
    dd = os.path.join(out, '文档')
    os.makedirs(dd, exist_ok=True)
    img = os.path.join(tempfile.gettempdir(), 'pvqa-office.png')
    big_label(base_canvas(1200, 700, 0.6), '插图', '文档里的图片', frac=0.25).save(img, 'PNG')

    p = os.path.join(dd, '报告.docx')
    if need(p, a.force):
        from docx import Document
        from docx.shared import Inches, Pt
        from docx.oxml.ns import qn
        from docx.oxml import OxmlElement
        doc = Document()
        st = doc.styles['Normal']
        st.font.name = '微软雅黑'
        st.element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
        st.font.size = Pt(11)
        doc.add_heading('预览样张：季度报告', 0)
        # 目录域（Word 打开会提示更新域；LibreOffice 转 PDF 时会按标题生成）
        par = doc.add_paragraph()
        r = par.add_run()
        for tag, txt in (('begin', None), (None, 'TOC \\o "1-3" \\h \\z \\u'), ('separate', None), (None, None), ('end', None)):
            if tag:
                fc = OxmlElement('w:fldChar'); fc.set(qn('w:fldCharType'), tag); r._r.append(fc)
            elif txt:
                it = OxmlElement('w:instrText'); it.set(qn('xml:space'), 'preserve'); it.text = txt; r._r.append(it)
            else:
                tt = OxmlElement('w:t'); tt.text = '（目录：在 Word 里右键「更新域」）'; r._r.append(tt)
        for s in range(1, 6):
            doc.add_heading('第 %d 章 章节标题' % s, 1)
            pp = doc.add_paragraph('这是第 %d 章的正文。' % s + '段落文字用来测排版与换行，中英文混排 Mixed English text 也要对齐。' * 6)
            if s == 1:
                try:
                    doc.add_comment(pp.runs[0], text='这里是一条批注（QA）', author='QA', initials='QA')
                except Exception:
                    pass
            doc.add_heading('%d.1 小节' % s, 2)
            doc.add_paragraph('要点一', style='List Bullet')
            doc.add_paragraph('要点二', style='List Bullet')
            doc.add_paragraph('步骤一', style='List Number')
            if s == 2:
                t = doc.add_table(rows=6, cols=4)
                t.style = 'Light Grid Accent 1'
                for ci, h in enumerate(['项目', '一季度', '二季度', '合计']):
                    t.cell(0, ci).text = h
                for ri in range(1, 6):
                    q1, q2 = ri * 120, ri * 95
                    for ci, v in enumerate(['项目 %d' % ri, str(q1), str(q2), str(q1 + q2)]):
                        t.cell(ri, ci).text = v
            if s == 3:
                doc.add_picture(img, width=Inches(5.5))
                doc.add_paragraph('图 1：文档里的插图', style='Caption')
            doc.add_page_break()
        doc.save(p)
    note('文档/报告.docx', '标题（含 0-2 级）、目录域、表格、图片、列表、批注、分页')

    p = os.path.join(dd, '数据表.xlsx')
    if need(p, a.force):
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment
        from openpyxl.chart import BarChart, Reference
        wb = Workbook()
        ws = wb.active
        ws.title = '汇总'
        ws.merge_cells('A1:F1')
        ws['A1'] = '预览样张 · 年度汇总（合并单元格）'
        ws['A1'].font = Font(size=16, bold=True)
        ws['A1'].alignment = Alignment(horizontal='center')
        hdr = ['月份', '收入', '成本', '利润', '利润率', '备注']
        ws.append(hdr)
        for c in ws[2]:
            c.font = Font(bold=True, color='FFFFFF'); c.fill = PatternFill('solid', fgColor='4472C4')
        for m in range(1, 13):
            r = m + 2
            ws.append(['%d 月' % m, 10000 + m * 1234, 6000 + m * 700, '=B%d-C%d' % (r, r), '=D%d/B%d' % (r, r), '第 %d 月备注，文字较长用来测列宽与截断' % m])
            ws['E%d' % r].number_format = '0.0%'
        ws.append(['合计', '=SUM(B3:B14)', '=SUM(C3:C14)', '=SUM(D3:D14)', '=D15/B15', ''])
        ws.merge_cells('A17:B18')
        ws['A17'] = '纵向合并'
        ws.column_dimensions['A'].width = 10
        ws.column_dimensions['F'].width = 42
        ws.freeze_panes = 'B3'
        ch = BarChart(); ch.title = '每月收入'
        ch.add_data(Reference(ws, min_col=2, min_row=2, max_row=14), titles_from_data=True)
        ch.set_categories(Reference(ws, min_col=1, min_row=3, max_row=14))
        ws.add_chart(ch, 'H3')
        big = wb.create_sheet('明细-2万行')
        big.append(['序号', '日期', '客户', '品类', '数量', '单价', '金额', '说明'])
        rnd = random.Random(7)
        for i in range(1, 20001):
            q, pr = rnd.randint(1, 50), round(rnd.uniform(5, 500), 2)
            big.append([i, '2026-%02d-%02d' % (i % 12 + 1, i % 28 + 1), '客户%04d' % (i % 977), ['硬件', '软件', '服务', '耗材'][i % 4], q, pr, '=E%d*F%d' % (i + 1, i + 1), '第 %d 行' % i])
        big.freeze_panes = 'A2'
        wide = wb.create_sheet('宽表')
        wide.append(['列%d' % c for c in range(1, 61)])
        for r in range(2, 40):
            wide.append([r * c for c in range(1, 61)])
        wb.save(p)
    note('文档/数据表.xlsx', '三张表：合并单元格、公式、冻结窗格、柱状图；明细 2 万行；60 列宽表')

    p = os.path.join(dd, '演示.pptx')
    if need(p, a.force):
        from pptx import Presentation
        from pptx.util import Inches, Pt
        from pptx.chart.data import CategoryChartData
        from pptx.enum.chart import XL_CHART_TYPE
        prs = Presentation()
        prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
        s = prs.slides.add_slide(prs.slide_layouts[0])
        s.shapes.title.text = '预览样张 演示文稿'
        s.placeholders[1].text = '第 1 页 · 封面'
        for i in range(2, 9):
            s = prs.slides.add_slide(prs.slide_layouts[5])
            s.shapes.title.text = '第 %d 页' % i
            if i == 3:
                cd = CategoryChartData(); cd.categories = ['一季度', '二季度', '三季度', '四季度']
                cd.add_series('收入', (12, 18, 15, 22)); cd.add_series('成本', (8, 9, 11, 12))
                s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(1.6), Inches(11), Inches(5.4), cd)
            elif i == 4:
                cd = CategoryChartData(); cd.categories = ['甲', '乙', '丙']; cd.add_series('占比', (0.5, 0.3, 0.2))
                s.shapes.add_chart(XL_CHART_TYPE.PIE, Inches(3), Inches(1.6), Inches(7), Inches(5.4), cd)
            elif i == 5:
                s.shapes.add_picture(img, Inches(1.5), Inches(1.6), width=Inches(10))
            elif i == 6:
                tb = s.shapes.add_table(5, 4, Inches(1), Inches(1.8), Inches(11), Inches(3)).table
                for r in range(5):
                    for c in range(4):
                        tb.cell(r, c).text = ('表头%d' % (c + 1)) if r == 0 else '%d-%d' % (r, c)
            else:
                tx = s.shapes.add_textbox(Inches(1), Inches(1.8), Inches(11), Inches(4)).text_frame
                tx.text = '要点 A：第 %d 页的正文' % i
                for k in range(4):
                    para = tx.add_paragraph(); para.text = '· 子要点 %d' % (k + 1); para.font.size = Pt(24)
            s.notes_slide.notes_text_frame.text = '第 %d 页的演讲者备注' % i
        prs.save(p)
    note('文档/演示.pptx', '8 页 16:9：柱状图、饼图、图片、表格、备注')

    # 旧格式与开放格式：LibreOffice 转出来（客户端回落、doc/ppt/odt/rtf 打不开的痛点）
    if not a.no_soffice:
        conv = [('报告.docx', 'doc'), ('报告.docx', 'odt'), ('报告.docx', 'rtf'), ('数据表.xlsx', 'xls'), ('数据表.xlsx', 'ods'), ('演示.pptx', 'ppt'), ('演示.pptx', 'odp')]
        todo = [(s, e) for s, e in conv if need(os.path.join(dd, os.path.splitext(s)[0] + '.' + e), a.force)]
        if todo:
            soffice_convert(dd, todo)
        for s, e in conv:
            note('文档/%s.%s' % (os.path.splitext(s)[0], e), 'LibreOffice 由 %s 转出的 %s（客户端回落/旧格式）' % (s, e))
    try:
        os.remove(img)
    except Exception:
        pass


def find_soffice():
    for c in [shutil.which('soffice'), r'C:\Program Files\LibreOffice\program\soffice.exe', r'C:\Program Files (x86)\LibreOffice\program\soffice.exe']:
        if c and os.path.exists(c):
            return c
    return None


def kill_tree(pid):
    if sys.platform == 'win32':
        subprocess.run(['taskkill', '/T', '/F', '/PID', str(pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        try:
            os.kill(pid, 9)
        except Exception:
            pass


def soffice_convert(dd, todo):
    exe = find_soffice()
    if not exe:
        print('  （没找到 soffice，跳过旧格式）')
        return
    prof = tempfile.mkdtemp(prefix='pvqa-lo-prof-')
    try:
        for src, ext in todo:
            uri = 'file:///' + prof.replace('\\', '/')
            pr = subprocess.Popen([exe, '-env:UserInstallation=' + uri, '--headless', '--norestore', '--nologo', '--convert-to', ext, '--outdir', dd, os.path.join(dd, src)],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                pr.wait(timeout=180)
            except subprocess.TimeoutExpired:
                print('  soffice 转 %s 超时，按 PID %d 收掉' % (ext, pr.pid))
            finally:
                if pr.poll() is None:
                    kill_tree(pr.pid)
    finally:
        # profile 里还挂着 soffice.bin 的话，按命令行里的 profile 目录精确找出来收掉（不按名字通配）
        if sys.platform == 'win32':
            ps = "Get-CimInstance Win32_Process -Filter \"Name='soffice.bin' or Name='soffice.exe'\" | Where-Object { $_.CommandLine -like '*%s*' } | ForEach-Object { $_.ProcessId }" % os.path.basename(prof)
            try:
                o = subprocess.run(['powershell.exe', '-NoProfile', '-Command', ps], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30).stdout.decode()
                for pid in o.split():
                    kill_tree(int(pid))
            except Exception:
                pass
        time.sleep(0.5)
        shutil.rmtree(prof, ignore_errors=True)


# —— md / 代码 / 文本 / zip / html ————————————————————————————————————————————
def gen_text(out, a):
    Image, _, _ = pil()
    nd = os.path.join(out, '笔记')
    p = os.path.join(nd, 'img', '示意图.png')
    if need(p, a.force):
        big_label(base_canvas(900, 500, 0.2), '相对路径图', 'img/示意图.png', frac=0.16).save(p, 'PNG')
    p = os.path.join(nd, '笔记.md')
    if need(p, a.force):
        md = '''---
title: 预览样张笔记
tags: [qa, 预览]
---

# 预览样张笔记

这是一篇用来测 **md 查看器** 的笔记：相对路径图片、公式、代码块、表格、任务列表、引用、脚注。

## 相对路径图片

![同目录 img 下的图](img/示意图.png)

![上一级目录的透明图](../图片/透明.png)

![[img/示意图.png]]

## 公式

行内公式 $E = mc^2$，以及 $\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$。

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

## 代码块

```js
// 一段 JavaScript
export function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
console.log([...Array(10).keys()].map(fib));
```

```python
def hello(name: str) -> str:
    """中文注释也要正常显示"""
    return f"你好，{name}"
```

## 表格

| 类型 | 对标 | 状态 |
|---|---|---|
| 图片 | Windows 照片 | 进行中 |
| 视频 | YouTube | 进行中 |
| PDF | Acrobat | 待定 |

## 任务列表

- [x] 生成样张
- [ ] 跑基线
- [ ] 改版后对比

> 引用：好的查看器让人忘了它的存在。

链接到 [同目录的另一篇](另一篇.md)、[[另一篇]]、[PDF 附件](../文档/横竖混排.pdf)。

脚注示例[^1]。

[^1]: 这是脚注内容。
'''
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write(md)
        with open(os.path.join(nd, '另一篇.md'), 'w', encoding='utf-8', newline='\n') as f:
            f.write('# 另一篇\n\n回到 [[笔记]]。\n\n' + '\n\n'.join('第 %d 段：长文用来测滚动与目录。' % i for i in range(1, 200)) + '\n')
    note('笔记/笔记.md', 'md：frontmatter、相对路径图（同级/上级/双链嵌入）、KaTeX、代码块、表格、任务、脚注、双链')
    note('笔记/另一篇.md', '长 md（200 段）+ 双链回跳')
    note('笔记/img/', 'md 引用的相对路径图')

    cd = os.path.join(out, '代码')
    rnd = random.Random(11)
    p = os.path.join(cd, '大文件.js')
    if need(p, a.force):
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write('// 约 2MB 的 JavaScript：语法高亮、行号、查找、跳行的性能\n')
            i = 0
            while f.tell() < 2 * 1024 * 1024:
                i += 1
                f.write('export function handler%d(req, res) {\n  const items = [%s];\n  // 第 %d 个函数：中文注释\n  return res.json({ id: %d, ok: true, items, name: "item-%d" });\n}\n\n' % (i, ', '.join(str(rnd.randint(0, 999)) for _ in range(12)), i, i, i))
    note('代码/大文件.js', '约 2MB js')
    p = os.path.join(cd, '脚本.py')
    if need(p, a.force):
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write('#!/usr/bin/env python3\n"""示例 Python（约 300KB）"""\nimport json\n\n')
            i = 0
            while f.tell() < 300 * 1024:
                i += 1
                f.write('class Model%d:\n    def __init__(self, x: int = %d) -> None:\n        self.x = x  # 注释 %d\n\n    def run(self):\n        return {"id": %d, "values": [n * self.x for n in range(10)]}\n\n\n' % (i, i, i, i))
    note('代码/脚本.py', '约 300KB python')
    p = os.path.join(cd, '数据.json')
    if need(p, a.force):
        data = {'title': '样张 JSON', 'items': [{'id': i, 'name': '条目%d' % i, 'tags': ['a', 'b', 'c'][: i % 3 + 1], 'score': rnd.random(), 'nested': {'k': i, 'v': [i, i * 2]}} for i in range(40000)]}
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    note('代码/数据.json', '约 6MB 缩进 JSON（4 万条）')
    p = os.path.join(cd, '表格.csv')
    if need(p, a.force):
        with open(p, 'w', encoding='utf-8-sig', newline='') as f:
            f.write('序号,日期,城市,金额,备注\r\n')
            for i in range(1, 50001):
                f.write('%d,2026-%02d-%02d,%s,%.2f,"含逗号, 的备注 %d"\r\n' % (i, i % 12 + 1, i % 28 + 1, ['北京', '上海', '深圳', '杭州'][i % 4], rnd.uniform(1, 9999), i))
    note('代码/表格.csv', '5 万行 CSV（UTF-8 BOM、CRLF、带引号逗号）')
    p = os.path.join(cd, '表格.tsv')
    if need(p, a.force):
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write('名称\t数量\t说明\n')
            for i in range(1, 501):
                f.write('物品%d\t%d\t制表符分隔第 %d 行\n' % (i, i * 3, i))
    note('代码/表格.tsv', 'TSV（有渲染器但缺入口）')
    p = os.path.join(cd, '运行.log')
    if need(p, a.force):
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            i = 0
            while f.tell() < 12 * 1024 * 1024:
                i += 1
                lv = ['INFO', 'WARN', 'ERROR', 'DEBUG'][i % 4]
                f.write('2026-11-09T10:%02d:%02d.%03dZ [%s] worker-%d 处理请求 /api/file?path=%d 耗时 %dms\n' % (i // 3600 % 60, i // 60 % 60, i % 1000, lv, i % 8, i, rnd.randint(1, 900)))
    note('代码/运行.log', '约 12MB 日志：超过 2MB 截断与只读提示')
    p = os.path.join(cd, 'GBK编码.txt')
    if need(p, a.force):
        with open(p, 'w', encoding='gbk', newline='\r\n') as f:
            f.write('这是 GBK 编码的中文文本文件。\n用 UTF-8 打开会乱码，正确的查看器应自动识别编码。\n' + '\n'.join('第 %d 行：床前明月光，疑是地上霜。' % i for i in range(1, 60)) + '\n')
    note('代码/GBK编码.txt', 'GBK 编码中文（CRLF）')
    p = os.path.join(cd, 'Makefile')
    if need(p, a.force):
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write('# 无扩展名文件（内容是文本，应嗅探成文本）\nall:\n\techo "hello"\n\nclean:\n\trm -rf build\n')
    note('代码/Makefile', '无扩展名文本')
    p = os.path.join(cd, 'LICENSE')
    if need(p, a.force):
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write('MIT License\n\nCopyright (c) 2026 Preview QA\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software...\n')
    note('代码/LICENSE', '无扩展名文本')
    p = os.path.join(cd, '二进制无扩展名')
    if need(p, a.force):
        with open(p, 'wb') as f:
            f.write(bytes(rnd.randint(0, 255) for _ in range(4096)))
    note('代码/二进制无扩展名', '无扩展名二进制：嗅探后应判「无法预览」而不是乱码')
    p = os.path.join(cd, '.env.example')
    if need(p, a.force):
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write('# 点文件\nPORT=8787\nDEBUG=false\n')
    note('代码/.env.example', '点文件')

    hd = os.path.join(out, '网页')
    p = os.path.join(hd, 'index.html')
    if need(p, a.force):
        os.makedirs(os.path.join(hd, 'assets'), exist_ok=True)
        with open(os.path.join(hd, 'assets', 'style.css'), 'w', encoding='utf-8', newline='\n') as f:
            f.write('body{font-family:sans-serif;margin:2rem;background:#f6f7fb}h1{color:#3b5bdb}img{max-width:100%;border-radius:12px}\n')
        big_label(base_canvas(800, 400, 0.65), 'HTML 相对资源', frac=0.12).save(os.path.join(hd, 'assets', 'pic.png'), 'PNG')
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>样张网页</title><link rel="stylesheet" href="assets/style.css"></head>'
                    '<body><h1>样张网页</h1><p>相对路径的 CSS 与图片要能加载；按 Esc 应能关掉查看器。</p><img src="assets/pic.png" alt="pic"><p><input placeholder="焦点抢夺测试"></p>'
                    '<script>document.querySelector("input").focus()</script></body></html>\n')
    note('网页/index.html', 'HTML：相对 css/图片、抢焦点的 input')
    note('网页/assets/', 'index.html 引用的相对资源')

    zp = os.path.join(out, '压缩包.zip')
    if need(zp, a.force):
        with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('说明.txt', '压缩包里的中文文件名\n')
            z.writestr('子目录/数据.json', json.dumps({'a': 1}, ensure_ascii=False))
            nb = os.path.join(out, '图片', '图.webp')
            if os.path.exists(nb):
                z.write(nb, '子目录/图.webp')
    note('压缩包.zip', 'zip（中文文件名、子目录）')


GROUPS = {
    '图片': gen_images,
    '序列': gen_sequence,
    '视频': gen_video,
    '音频': gen_audio,
    'PDF': gen_pdf,
    'Office': gen_office,
    '文本': gen_text,
}


def human(n):
    for u in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or u == 'GB':
            return '%.1f %s' % (n, u) if u != 'B' else '%d B' % n
        n /= 1024


def main():
    ap = argparse.ArgumentParser(description='生成文件预览样张')
    # 缺省输出到 dev.mjs / run.mjs 认的共用样张目录：<PREVIEW_QA_ROOT 或 %TEMP%/bridge-preview-qa>/vault/预览样张
    dflt = os.path.join(os.environ.get('PREVIEW_QA_ROOT') or os.path.join(tempfile.gettempdir(), 'bridge-preview-qa'), 'vault', '预览样张')
    ap.add_argument('--out', default=dflt, help='输出目录（会建出来；缺省 %s）' % dflt.replace('%', '%%'))
    ap.add_argument('--force', action='store_true', help='已存在也重新生成')
    ap.add_argument('--only', default='', help='只生成这些组，逗号分隔：' + ','.join(GROUPS))
    ap.add_argument('--seq', type=int, default=60, help='序列图张数（默认 60）')
    ap.add_argument('--long-min', type=int, default=6, help='长视频分钟数（默认 6）')
    ap.add_argument('--audio-min', type=int, default=40, help='长音频分钟数（默认 40）')
    ap.add_argument('--no-soffice', action='store_true', help='不用 LibreOffice 转旧格式')
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    only = [x.strip() for x in a.only.split(',') if x.strip()]
    bad = [x for x in only if x not in GROUPS]
    if bad:
        sys.exit('未知分组：%s（可选：%s）' % (','.join(bad), ','.join(GROUPS)))
    fails = []
    t0 = time.time()
    for name, fn in GROUPS.items():
        if only and name not in only:
            continue
        t1 = time.time()
        try:
            fn(out, a)
            print('[%s] 完成 %.1fs' % (name, time.time() - t1), flush=True)
        except Exception as e:
            fails.append((name, str(e)))
            print('[%s] 失败：%s' % (name, e), flush=True)
    # --only 只跑了部分分组时，其余分组的说明沿用上一份清单（不然 desc 全空）
    old_desc = {}
    try:
        with open(os.path.join(out, 'manifest.json'), encoding='utf-8') as f:
            old_desc = {x['rel']: x.get('desc', '') for x in json.load(f).get('files', [])}
    except Exception:
        pass
    files, total = [], 0
    for root, _, fs in os.walk(out):
        for f in fs:
            if f == 'manifest.json':
                continue
            full = os.path.join(root, f)
            rel = os.path.relpath(full, out).replace('\\', '/')
            sz = os.path.getsize(full)
            total += sz
            desc = MANIFEST.get(rel) or next((v for k, v in MANIFEST.items() if k.endswith('/') and rel.startswith(k)), '') or old_desc.get(rel, '')
            files.append({'rel': rel, 'bytes': sz, 'desc': desc})
    files.sort(key=lambda x: x['rel'])
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'at': time.strftime('%Y-%m-%d %H:%M:%S'), 'out': out, 'total': total, 'count': len(files), 'files': files, 'fails': fails}, f, ensure_ascii=False, indent=1)
    print('共 %d 个文件，%s，用时 %.0fs → %s' % (len(files), human(total), time.time() - t0, os.path.join(out, 'manifest.json')))
    if fails:
        print('失败分组：' + '；'.join('%s：%s' % x for x in fails))
        sys.exit(1)


if __name__ == '__main__':
    main()
