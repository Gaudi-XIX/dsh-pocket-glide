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
    3. 19387 与 43127 在监听
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
$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 19387, 43127 } | Select-Object -ExpandProperty LocalPort -Unique)
Write-Host "  listening: $(if ($ports.Count) { $ports -join ',' } else { 'none' })"

Write-Host ''
Write-Host '=== 4) 任务是否已自删 ==='
if (Get-ScheduledTask -TaskName 'DSH-ReviveOnce' -ErrorAction SilentlyContinue) {
  Write-Host '  仍存在 —— 任务没跑完（自删没执行），留意残留'
} else { Write-Host '  已注销' }

$logText = if (Test-Path $logPath) { Get-Content $logPath -Encoding UTF8 -Raw } else { '' }
$launched = $logText -match '已发起桌面端'
$portsOk = ($ports -contains 19387) -and ($ports -contains 43127)
$fresh = ($survivors.Count -eq 0) -and ($now.Count -gt 0) -and ($before.Count -gt 0)

Write-Host ''
Write-Host '=== 判定 ==='
Write-Host "  日志有「已发起桌面端」: $launched"
Write-Host "  进程指纹全新(没一个活下来): $fresh"
Write-Host "  两个端口都在: $portsOk"
if ($launched -and $fresh -and $portsOk) { Write-Host '  >>> 重启成功' }
elseif ($now.Count -eq 0) { Write-Host '  >>> 失败：DSH 没起来（机器现在没有桌面端）' }
else { Write-Host '  >>> 未成功或证据不足，看上面三项哪条不成立' }
