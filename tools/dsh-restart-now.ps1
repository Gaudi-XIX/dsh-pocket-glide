#Requires -Version 5.1
<#
.SYNOPSIS
  DSH 一次性自重启：注册一个几秒后触发的一次性计划任务，然后立即退出。

.DESCRIPTION
  为什么是计划任务，而不是自己拉一个后台进程：
    实测 DSH 把整棵子进程树放在同一个 Windows Job Object 里，且
    CREATE_BREAKAWAY_FROM_JOB 被静默收编（子进程仍 inJob=True）。所以任何
    从 DSH 内部 spawn 出来的「看门狗」都会在宿主死的时候一起死 —— 拉不起东西。
    Task Scheduler 的服务进程在 DSH 的 Job 之外，是这台机器上唯一可靠的「外人」。

  用完即走：任务是一次性的，执行完自己 schtasks /Delete 注销。机器上不留常驻
  进程、不留待命的定时任务。

  杀宿主这一步也放在任务里做，不放本脚本：本脚本是 DSH 的子孙，动手杀祖先会
  把自己一起带走。

.PARAMETER DelaySec
  多少秒后执行（默认 8）。留出时间让本脚本先注册完并返回。

.PARAMETER DryRun
  只打印将要注册的任务，不真的注册、不真的杀任何东西。

.EXAMPLE
  powershell -File .\dsh-restart-now.ps1 -DryRun
  powershell -File .\dsh-restart-now.ps1
#>
[CmdletBinding()]
param(
  [int]$DelaySec = 8,
  [switch]$DryRun,
  # 演练：注册真任务、走真 Task Scheduler 触发，但执行体不杀不拉，只验链路。
  [switch]$Rehearse
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName  = 'DSH-ReviveOnce'
$selfDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$revivePs1 = Join-Path $selfDir 'dsh-revive.ps1'

if (-not (Test-Path -LiteralPath $revivePs1)) {
  Write-Host "[fail] 找不到 $revivePs1 —— 两个脚本必须放在一起。"
  exit 3
}

# -WindowStyle Hidden 必须有：计划任务直接跑 powershell.exe 会开一个可见控制台，
# 而 dsh-revive.ps1 又把 DSH 起在同一个控制台里 → powershell 退场后 conhost 变成
# 「父进程已死、DSH 仍持有句柄」的僵尸窗口：既不再输出，也不会自己关（2026-10-09 实测踩过）。
$argLine = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$revivePs1`""
if ($Rehearse) { $argLine += ' -Rehearse' }
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds($DelaySec)
# 不带 -DeleteExpiredTaskAfter：它要求 trigger 必须有 EndBoundary，否则注册时
# Task Scheduler 直接报「The task XML is missing a required element: (40,4):EndBoundary:」。
# 注销改由 dsh-revive.ps1 里的 `schtasks /Delete` 负责（成功失败两条路都走到）。
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::FromMinutes(10))

if ($DryRun) {
  Write-Host "[dry-run] 将注册一次性任务 $taskName，$DelaySec 秒后执行："
  Write-Host "          powershell $argLine"
  Write-Host '          执行完由任务自己注销；本脚本不杀任何东西。'
  exit 0
}

# 先清掉同名旧任务（上一次跑挂了没自删的情况），再注册。
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings | Out-Null

Write-Host "[armed] 一次性任务 $taskName 已注册，$DelaySec 秒后执行。"
Write-Host '        它负责：关掉 DSH → 拉起桌面端 → 等就位 → 推一条「已重启」→ 自己注销。'
Write-Host '        注意：这个对话会随宿主一起断，重启后需要你自己说一声「继续」。'
exit 0
