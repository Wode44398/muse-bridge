# Harness 安卓壳打包：build 前端 -> 拷进 android assets -> 用 bridge 的自带工具链出 apk。
# 前端改动后重跑本脚本再装 apk 即更新内置 UI；数据仍打到 PC 的 harness。
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
# 复用 bridge 工具链（jdk17 + gradle8.7 + sdk34）——harness 是 bridge 仓库的子目录，取上一级。
$tc   = Join-Path (Split-Path $PSScriptRoot -Parent) 'android\.toolchain'

Write-Host '[1/4] building frontend...' -ForegroundColor Cyan
Push-Location "$root\web"
try { npm run build } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "frontend build failed (exit $LASTEXITCODE)" }

Write-Host '[2/4] copying frontend into android assets/www...' -ForegroundColor Cyan
$dst = "$root\android\app\src\main\assets\www"
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$root\web\dist\*" $dst -Recurse -Force

Write-Host '[3/4] building apk with bundled toolchain...' -ForegroundColor Cyan
$env:JAVA_HOME        = "$tc\jdk17\jdk-17.0.19+10"
$env:GRADLE_USER_HOME = "$tc\ghome"
$env:ANDROID_HOME     = "$tc\sdk"
# clean 必做：增量构建会把 asset 打包判 UP-TO-DATE，出一个不带前端的壳（bridge 实测坑）。
# 输出经重定向到日志文件：gradle daemon 继承 stdout 管道会让外层读 EOF 的消费者永久挂死。
# 注意路径带空格 → cmd /c 的引号剥离会肢解命令行，必须落一个 .cmd 批处理再执行。
$batch = "$root\_gradle-build.cmd"
@"
@echo off
call "$tc\gradle\gradle-8.7\bin\gradle.bat" -p "$root\android" clean assembleDebug --console=plain > "$root\gradle-build.log" 2>&1
exit /b %ERRORLEVEL%
"@ | Out-File -FilePath $batch -Encoding ascii
& cmd /c "`"$batch`""
$gradleExit = $LASTEXITCODE
Remove-Item $batch -Force -ErrorAction SilentlyContinue
if ($gradleExit -ne 0) { Get-Content "$root\gradle-build.log" -Tail 25; throw "gradle build failed (exit $gradleExit)，完整日志见 gradle-build.log" }

Write-Host '[4/4] verifying + writing apk to project root...' -ForegroundColor Cyan
$apk = "$root\android\app\build\outputs\apk\debug\app-debug.apk"
$aapt = "$tc\sdk\build-tools\34.0.0\aapt.exe"
$code = ''
if (Test-Path $aapt) {
  $badging = (cmd /c "`"$aapt`" dump badging `"$apk`" 2>nul") | Select-Object -First 1
  if ($badging -match "versionCode='(\d+)'") { $code = $Matches[1] }
}
$out = "$root\Harness.apk"
Copy-Item $apk $out -Force
if ($code) { Copy-Item $apk "$root\Harness-$code.apk" -Force }
$kb = [math]::Round((Get-Item $out).Length / 1KB)
Write-Host "[OK] done: $out (versionCode=$code, $kb KB)" -ForegroundColor Green
