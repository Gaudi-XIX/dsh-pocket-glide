#Requires -Version 5.1
<#
.SYNOPSIS
  重启后验证：读日志 + 比对进程指纹，判定 dsh-restart 到底成没成。

.DESCRIPTION
  为什么需要这个脚本：发起重启的 agent 自己跑在 DSH 的 Job Object 里，宿主一死
  它一起死，所以「重启成功」这句话不可能由它自己作证——它当时已经不存在了。
  唯一可信的证据是磁盘上的两样东西：任务自己写的日志，以及重启前后不同的进程指纹。

  判定标准（三条同时成立才算成功）：
    1. 日志里有「已发起桌面端」
    2. 当前 DSH 进程的 pid/启动时间与 dsh-before-restart.txt 记录的**全不一样**
    3. DSH 进程在监听：Pocket 桥端口有其一，且另有一个 127.0.0.1 的 GUI 端口
       （GUI 端口是动态分配的，**不写死** —— 2026-10-19 运行态实测为 5065，
        同日的 19387 是旧口径。写死会让每次成功重启都被判成「未成功」。）
#>
Set-StrictMode -Version 2.0

$logPath = Join-Path $env:TEMP 'dsh-restart.log'
$beforePath = Join-Path $env:TEMP 'dsh-before-restart.txt'

Write-Host '=== 1) 任务日志 ==='
if (Test-Path $logPath) { Get-Content $logPath -Encoding UTF8 | ForEach-Object { Write-Host "  $_" } }
else { Write-Host '  (无日志 —— 任务没跑过，或没写成)' }

Write-Host ''
Write-Host '=== 2) 进程指纹比对 ==='
$before = @{}
if (Test-Path $beforePath) {
  Get-Content $beforePath -Encoding UTF8 | ForEach-Object {
    if ($_ -match '^pid=(\d+)\s+start=(.+)$') { $before[$matches[1]] = $matches[2] }
  }
  Write-Host "  重启前记录了 $($before.Count) 个 pid（$(Get-Content $beforePath -Encoding UTF8 -TotalCount 1)）"
} else { Write-Host '  (无 before 快照，无法比对)' }

$now = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
Write-Host "  现在 $($now.Count) 个："
foreach ($p in $now) {
  $st = try { $p.StartTime.ToString('HH:mm:ss') } catch { '?' }
  $mark = if ($before.ContainsKey([string]$p.Id)) { '!! 同一个 pid 还活着 = 没重启' } else { 'new' }
  Write-Host ("    pid={0} start={1}  {2}" -f $p.Id, $st, $mark)
}

$survivors = @($now | Where-Object { $before.ContainsKey([string]$_.Id) })

Write-Host ''
Write-Host '=== 3) 端口 ==='
# 端口不从常量判：GUI 端口动态分配，只认「DSH 进程自己在监听什么」。
# 桥端口在候选表里（43127/43128），其余 127.0.0.1 上的监听即 GUI。
$bridgePorts = @(43127, 43128)
$dshPids = @($now | ForEach-Object { $_.Id })
$listenConns = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.OwningProcess -in $dshPids })
$bridgeFound = @($listenConns | Where-Object { $_.LocalPort -in $bridgePorts } |
  Select-Object -ExpandProperty LocalPort -Unique)
$guiFound = @($listenConns | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -notin $bridgePorts } |
  Select-Object -ExpandProperty LocalPort -Unique)
Write-Host "  Pocket 桥监听: $(if ($bridgeFound.Count) { $bridgeFound -join ',' } else { 'none' })"
Write-Host "  GUI 监听(动态): $(if ($guiFound.Count) { $guiFound -join ',' } else { 'none' })"

Write-Host ''
Write-Host '=== 4) 任务是否已自删 ==='
if (Get-ScheduledTask -TaskName 'DSH-ReviveOnce' -ErrorAction SilentlyContinue) {
  Write-Host '  仍存在 —— 任务没跑完（自删没执行），留意残留'
} else { Write-Host '  已注销' }

Write-Host ''
Write-Host '=== 5) 手机壳摘要：运行桥 V= 与磁盘实算比对 ==='
# 生效判据（2026-10-21 定）：重启后运行桥 /sw.js 的 V= 等于按盘上 lib/pages.js
# 实算的 zh 壳摘要（sha256(css \0 js).slice(0,12)）。桥只回 V，不回壳本体。
$pocketDir = 'F:\defws\dsh-pocket'
$digestJs = @'
import { createHash } from 'node:crypto';
import { mobilePageAssets } from './lib/pages.js';
const a = await mobilePageAssets({ locale: 'zh' });
console.log('pocket-' + createHash('sha256').update(a.css).update('\u0000').update(a.js).digest('hex').slice(0, 12));
'@
$disk = $null
if (Test-Path (Join-Path $pocketDir 'lib\pages.js')) {
  Push-Location $pocketDir
  $disk = (& node --input-type=module -e $digestJs 2>$null | Select-Object -Last 1).Trim()
  Pop-Location
}
$running = $null
try {
  $sw = (Invoke-WebRequest -Uri 'http://127.0.0.1:43127/sw.js' -UseBasicParsing -TimeoutSec 5).Content
  if ($sw -match "const V='([^']+)'") { $running = $Matches[1] }
} catch { }
Write-Host "  磁盘实算(zh): $disk"
Write-Host "  运行桥 V=     : $running"
if ($disk -and $running -and $disk -eq $running) {
  Write-Host '  >>> 壳一致：手机完全关闭重开后即为新壳'
} elseif ($disk -and $running) {
  Write-Host '  >>> 壳不一致：宿主未装载最新工作树（或并行线又改了盘），先查盘上 HEAD/工作树'
} else {
  Write-Host '  >>> 证据不足（磁盘脚本或运行桥不可用），按 TODO/SNAPSHOT 的手工判据复核'
}

$logText = if (Test-Path $logPath) { Get-Content $logPath -Encoding UTF8 -Raw } else { '' }
$launched = $logText -match '已发起桌面端'
$portsOk = ($bridgeFound.Count -gt 0) -and ($guiFound.Count -gt 0)
$fresh = ($survivors.Count -eq 0) -and ($now.Count -gt 0) -and ($before.Count -gt 0)

Write-Host ''
Write-Host '=== 判定 ==='
Write-Host "  日志有「已发起桌面端」: $launched"
Write-Host "  进程指纹全新(没一个活下来): $fresh"
Write-Host "  桥与 GUI 都在监听: $portsOk"
if ($launched -and $fresh -and $portsOk) { Write-Host '  >>> 重启成功' }
elseif ($now.Count -eq 0) { Write-Host '  >>> 失败：DSH 没起来（机器现在没有桌面端）' }
else { Write-Host '  >>> 未成功或证据不足，看上面三项哪条不成立' }

# 退出码必须显式给：本脚本自身没有失败退出路径（判定结果打在 stdout 上给人读），
# 不写则该进程的 $LASTEXITCODE 会「借」同进程内上一条原生命令的码 —— 被转发垫片
# 的 `exit $LASTEXITCODE` 带出去就是假失败（2026-10-19 Verifier 实测：先跑
# `cmd /c exit 7` 再跑本脚本，会得到 exit=7 而验证其实全过）。
exit 0
