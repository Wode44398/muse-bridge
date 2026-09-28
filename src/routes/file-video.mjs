import path from 'node:path';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { requireReadCtx } from '../runtime/identity.mjs';
import { safeJoin } from '../runtime/http-file.mjs';
import { bad, scopeCtx } from './file-core.mjs';

const STREAM_VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp']);
const STREAM_MAX_CONC = 2;
const REMUX_MAX_CONC = 4;
let streamCount = 0;
let remuxCount = 0;

const H264_PROFILE_HEX = {
  'Constrained Baseline': '4240',
  Baseline: '4200',
  Main: '4D40',
  High: '6400',
  'High 10': '6E10',
};
const HEVC_PROFILE = {
  Main: { p: 1, c: 6 },
  'Main 10': { p: 2, c: 4 },
};

function mseCodecString(video) {
  const level = video.level > 0 ? video.level : 0;
  if (video.codec_name === 'h264') {
    const profile = H264_PROFILE_HEX[video.profile];
    if (!profile || !level) return null;
    return 'avc1.' + profile + level.toString(16).padStart(2, '0');
  }
  if (video.codec_name === 'hevc') {
    const profile = HEVC_PROFILE[video.profile];
    if (!profile || !level) return null;
    return `hvc1.${profile.p}.${profile.c}.L${level}.B0`;
  }
  return null;
}

let nvencProbe;
function nvencAvailable() {
  if (nvencProbe) return nvencProbe;
  nvencProbe = new Promise((resolve) => {
    const child = spawn(
      'ffmpeg',
      ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.1', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'],
      { windowsHide: true },
    );
    child.on('error', () => resolve(false));
    child.stderr.on('data', () => {});
    child.on('close', (code) => resolve(code === 0));
  });
  return nvencProbe;
}

const probeCache = new Map();
function ffprobeMeta(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,profile,level,width,height:format=duration,bit_rate',
      '-of', 'json',
      file,
    ], { windowsHide: true });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { if (errorOutput.length < 2000) errorOutput += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code} ${errorOutput.slice(0, 120)}`));
      try {
        const parsed = JSON.parse(output);
        const streams = parsed.streams || [];
        const video = streams.find((stream) => stream.codec_type === 'video') || {};
        resolve({
          duration: parseFloat(parsed.format?.duration) || 0,
          width: video.width || 0,
          height: video.height || 0,
          vcodec: video.codec_name || '',
          bitrate: parseInt(parsed.format?.bit_rate, 10) || 0,
          hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
          mseCodecs: mseCodecString(video),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function handleStream(req, res, url, identify) {
  let ctx = requireReadCtx(identify, req, res);
  if (!ctx) return;
  ctx = scopeCtx(ctx, url.searchParams.get('ws'), res);
  if (!ctx) return;
  const file = safeJoin(ctx.cwd, url.searchParams.get('path') || '');
  if (!file) return bad(res, 403, 'forbidden');
  let stat;
  try { stat = statSync(file); } catch { return bad(res, 404, 'not found'); }
  if (stat.isDirectory()) return bad(res, 400, 'is a directory');
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!STREAM_VIDEO_EXT.has(ext)) return bad(res, 415, 'not a video');

  if (url.searchParams.get('probe') === '1') {
    const key = `${file}|${stat.mtimeMs}|${stat.size}`;
    try {
      let metadata = probeCache.get(key);
      if (!metadata) {
        metadata = await ffprobeMeta(file);
        if (probeCache.size > 200) probeCache.clear();
        probeCache.set(key, metadata);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=3600' });
      res.end(JSON.stringify(metadata));
    } catch (error) {
      bad(res, 500, 'probe failed: ' + String(error?.message || error).slice(0, 120));
    }
    return;
  }

  const remux = url.searchParams.get('remux') === '1';
  if (remux ? remuxCount >= REMUX_MAX_CONC : streamCount >= STREAM_MAX_CONC) {
    return bad(res, 503, 'transcoder busy');
  }
  let time = parseFloat(url.searchParams.get('t') || '0');
  if (!Number.isFinite(time) || time < 0) time = 0;

  let args;
  if (remux) {
    args = [
      '-hide_banner', '-loglevel', 'error',
      ...(time > 0.1 ? ['-ss', String(time)] : []),
      '-i', file,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1',
    ];
  } else {
    const nvenc = await nvencAvailable();
    const videoEncoder = nvenc
      ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '26', '-maxrate', '6M', '-bufsize', '12M']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '6M', '-bufsize', '12M'];
    args = [
      '-hide_banner', '-loglevel', 'error',
      '-hwaccel', 'auto',
      ...(time > 0.1 ? ['-ss', String(time)] : []),
      '-i', file,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn',
      '-vf', "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-pix_fmt', 'yuv420p',
      ...videoEncoder,
      '-profile:v', 'high', '-level', '4.2', '-g', '120',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1',
    ];
  }

  const child = spawn('ffmpeg', args, { windowsHide: true });
  if (remux) remuxCount += 1;
  else streamCount += 1;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (remux) remuxCount -= 1;
    else streamCount -= 1;
    try { child.kill(); } catch {}
  };
  let errorOutput = '';
  let started = false;
  child.stderr.on('data', (data) => { if (errorOutput.length < 2000) errorOutput += data; });
  child.stdout.on('data', (chunk) => {
    if (done) return;
    if (!started) {
      started = true;
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    }
    if (!res.write(chunk)) {
      child.stdout.pause();
      res.once('drain', () => { try { child.stdout.resume(); } catch {} });
    }
  });
  child.stdout.on('end', () => {
    if (started && !done) { try { res.end(); } catch {} }
  });
  const fail = () => {
    if (!started && !res.headersSent) bad(res, 500, 'transcode failed: ' + errorOutput.trim().slice(0, 160));
    finish();
  };
  child.on('error', fail);
  child.on('close', (code) => {
    if (code !== 0 || !started) fail();
    else finish();
  });
  res.on('close', finish);
}
