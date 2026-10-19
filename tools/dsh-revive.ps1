#Requires -Version 5.1
<#
.SYNOPSIS
  一次性重启执行体：关掉 DSH → 拉起桌面端 → 等就位 → 推一条「已重启」→ 注销自己。

.DESCRIPTION
  本脚本由一次性计划任务 DSH-ReviveOnce 拉起（不是从 DSH 内部起），因为实测
  DSH 的子进程树同在一个 Windows Job Object 内且 CREATE_BREAKAWAY_FROM_JOB 被
  静默收编 —— 从 DSH 里 spawn 的东西会跟着宿主一起死，拉不起任何东西。
  Task Scheduler 的服务进程在 Job 之外，是唯一可靠的「外人」。

  「杀宿主」也放在这里做：发起方（dsh-restart-now.ps1）是 DSH 的子孙，
  由它动手会把自己一起带走。

  跑完自己注销；日志留在 %TEMP%\dsh-restart.log。
#>
[CmdletBinding()]
param(
  [switch]$SkipPush,
  [switch]$Rehearse,
  [int]$GraceWaitSec = 5,
  [int]$KillWaitSec = 40,
  [int]$UpWaitSec = 180,
  # 可选钩子：在「关掉 DSH 之后、拉起之前」执行。用来做只能趁宿主停止时干的活
  # （例如改 C:\Users\toast\.dsh\storages\workspace.json 的工作区路径 —— 运行中改
  # 会被宿主内存态回写还原，2026-10-19 18:02 实测）。不给就走原行为，一行不变。
  [string]$PostKillScript
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$exePath     = 'D:\DSH\DeepSeek Harness.exe'
$guiPort     = 19387
$bridgePorts = @(43127, 43128)
$taskName    = 'DSH-ReviveOnce'
# 推送脚本住在消费方那一侧（pocket\tools\），因为它整条行为都来自 pocket\lib\ ——
# 放在本目录会变成「脚本在这儿、lib 写死在别处」，一搬家就断。2026-10-11 搬迁。
$selfDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$pushScript  = Join-Path $selfDir 'dsh-push-notice.mjs'
$logPath     = Join-Path $env:TEMP 'dsh-restart.log'

function Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  # 显式 UTF8：本脚本由计划任务用 powershell.exe(5.1) 跑，Add-Content 默认按系统
  # ANSI(GBK) 落盘，事后按 UTF8 读就是乱码。而这份日志是唯一证据（任务里没有终端
  # 可回显），乱码等于没证据。
  try { Add-Content -LiteralPath $logPath -Value $line -Encoding utf8 } catch { }
  Write-Host $line
}

function Test-PortOpen {
  param([string]$Address, [int]$Port)
  # 参数名不能叫 $Host —— 那是 PowerShell 的自动变量。
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync($Address, $Port)
    if (-not $task.Wait(1200)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-DshPids {
  # 必须 `return ,@(...)`：PowerShell 会把函数输出**枚举摊平**，`@(42)` 到调用侧变成标量
  # Int32、`@()` 变成 $null —— 在 Set-StrictMode -Version Latest 下取 .Count 直接抛
  # 「在此对象上找不到属性"Count"」。2026-10-09 11:30:28 那次「关掉没拉起」就是这个抛：
  # 抛出点在杀进程之后、拉起之前，机器被留在已死且无人拉的状态。逗号包一层可保住数组。
  return ,@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
}

function Remove-OwnTask {
  # 用完即走：成败都要走到，否则机器上留一个待命条目。
  try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  } catch { }
}

try {
  Log '── revive 开始 ──'

  # 1) 关掉当前进程
  #    整段自兜异常：11:30:28 那次就是这里抛（`.Count` 摊平）⇒ 直接跳到最外层 catch
  #    ⇒ 第 2 步的拉起没执行 ⇒ 机器停在「已死且无人拉」。关与拉之间不允许任何异常穿透。
  try {
    $pids = Get-DshPids
  if ($Rehearse) {
    Log "[rehearse] 跳过关闭（当前 $($pids.Count) 个 DSH 进程一个不动）。"
  } elseif ($pids.Count -eq 0) {
    Log 'DSH 没在跑，跳过关闭。'
  } else {
    Log "关闭 DSH：$($pids -join ', ')"
    # 两段式（P2，2026-10-12 段一验证成立后改入）：先试优雅通道、只短等 $GraceWaitSec，
    # 没退再强杀。依据：
    # - WM_CLOSE 实测（2026-10-09 09:43:52）被 DSH 拦成「收到后台」，不是退出通道——
    #   这段大概率等满 5s 就过；留着它是因为真正能退的托盘通道只能人在 UI 里点，
    #   脚本够不着，而未来版本若把 WM_CLOSE 修成真退出，这里自动受益，代价仅 5 秒。
    # - 托盘退出实测（2026-10-12 12:34 那次重启）：logs/ 零新增 crash 文件、进程清零——
    #   「正常退出被记成 crash」只是窗口 X／强杀路径的记账缺陷，优雅退出不受影响。
    # - 会话数据是 append-only 的 session.v4.jsonl.zstd，实测强杀后重启仍完整续写。
    foreach ($procId in $pids) {
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($p -and $p.MainWindowHandle -ne 0) { $null = $p.CloseMainWindow() }
    }
    $graceDeadline = (Get-Date).AddSeconds($GraceWaitSec)
    while ((Get-Date) -lt $graceDeadline) {
      if ((Get-DshPids).Count -eq 0) { break }
      Start-Sleep -Seconds 1
    }
    $left = Get-DshPids
    if ($left.Count -eq 0) {
      Log '优雅通道退出成功。'
    } else {
      Log "优雅通道 ${GraceWaitSec}s 没退干净（预期内：WM_CLOSE 被 DSH 拦成收到后台），转强杀。"
      foreach ($procId in $left) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      }
      $deadline = (Get-Date).AddSeconds($KillWaitSec)
      while ((Get-Date) -lt $deadline) {
        if ((Get-DshPids).Count -eq 0) { break }
        Start-Sleep -Seconds 2
      }
      $left = Get-DshPids
      if ($left.Count -gt 0) {
        Log "[warn] 强杀后仍有残留：$($left -join ', ')"
      }
    }
    Log 'DSH 已关闭。'

    # 钩子：宿主已停、还没拉起。整段自兜异常，绝不让它穿透到下面的「拉起」——
    # 2026-10-09 11:30:28 的教训就是杀与拉之间抛了个错，机器停在「已死且无人拉」。
    if ($PostKillScript) {
      Log "执行 PostKill 钩子：$PostKillScript"
      try {
        if (-not (Test-Path -LiteralPath $PostKillScript)) {
          throw "钩子脚本不存在: $PostKillScript"
        }
        $prevPref = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $hookOut = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PostKillScript 2>&1) -join ' | '
        $hookExit = $LASTEXITCODE
        $ErrorActionPreference = $prevPref
        Log "PostKill 结果：$hookOut (exit=$hookExit)"
      } catch {
        Log "[warn] PostKill 钩子抛错，仍继续拉起：$($_.Exception.Message)"
      }
    }
  }
  } catch {
    # 关闭阶段无论出什么错，都必须往下走到第 2 步的拉起。
    Log "[warn] 关闭阶段抛错，仍继续拉起：$($_.Exception.Message)"
  }

  # 2) 拉起桌面端
  if ($Rehearse) {
    Log '[rehearse] 跳过杀进程与拉起，只验触发/等待/推送/自删这条链。'
  } else {
    if (-not (Test-Path -LiteralPath $exePath)) {
      Log "[fail] 找不到 $exePath，终止。"
      Remove-OwnTask
      exit 3
    }
    # 经 explorer 代发，而不是直接 Start-Process：
    # 实测裸调时新进程的父进程是发起者（一个控制台进程），于是 DSH 继承了那个
    # 控制台；等计划任务的 powershell 退场后，conhost 成了「父死子活」的僵尸窗口
    # ——不再输出，也不会自己关（2026-10-09 实测：屏幕上留着一个乱码的 powershell 窗口）。
    # explorer 本身无控制台，经它 exec 出来的进程 ppid=explorer，与本次控制台彻底无关。
    Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$exePath`"" | Out-Null
    Log '已发起桌面端（经 explorer，不继承控制台）。'
  }

  # 3) 等就位
  $state = $null
  $deadline = (Get-Date).AddSeconds($UpWaitSec)
  $gui = $false; $bridge = $false
  while ((Get-Date) -lt $deadline) {
    $currentPids = Get-DshPids
    if ($currentPids.Count -gt 0) {
      $listenConns = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -in $currentPids }

      if (-not $bridge) {
        $foundBridge = $listenConns | Where-Object { $_.LocalPort -in $bridgePorts } | Select-Object -First 1
        if ($foundBridge) {
          $bridge = $true
          Log "Pocket 桥就位：$($foundBridge.LocalPort)"
        } elseif (Test-PortOpen -Address '127.0.0.1' -Port $bridgePorts[0]) {
          $bridge = $true
          Log "Pocket 桥就位：$($bridgePorts[0])"
        }
      }

      if (-not $gui) {
        # GUI 端口动态分配（如 9800、13969 等，非固定 19387）：
        # 排除 Pocket 桥端口后，探测 DSH 进程在 127.0.0.1 上监听的端口
        $candidateGui = $listenConns | Where-Object {
          $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -notin $bridgePorts
        } | Select-Object -First 1
        if ($candidateGui -and (Test-PortOpen -Address '127.0.0.1' -Port $candidateGui.LocalPort)) {
          $gui = $true
          Log "桌面端就位：$($candidateGui.LocalPort)"
        } elseif (Test-PortOpen -Address '127.0.0.1' -Port $guiPort) {
          $gui = $true
          Log "桌面端就位：$guiPort"
        }
      }
    }
    if ($gui -and $bridge) { break }
    Start-Sleep -Seconds 3
  }

  $ok = $gui -and $bridge
  if (-not $ok) {
    Log "[timeout] 没等到全部就位：gui=$gui bridge=$bridge（仍然会推一条，写明实况）"
  } else {
    Log '桌面端与 Pocket 桥都在。'
  }

  # 4) 推「已重启」
  if ($SkipPush) {
    Log '跳过推送。'
  } elseif (-not (Test-Path -LiteralPath $pushScript)) {
    Log "[warn] 找不到 $pushScript，跳过推送。"
  } else {
    # 语气规则（用户 2026-10-18 定：页面文案归页面，微信推送归推送）。
    # 微信推送恢复直白功能通知，横幅扫一眼即知。文艺台词落在手机加载页面与重连页。
    $title = if ($ok) { 'DSH 已重启' } else { 'DSH 已重启（未完全就位）' }
    # 正文说明原因并指路后续动作。
    $body  = if ($ok) {
      '已就绪。回任意一句话拿新地址。'
    } else {
      "gui=$gui bridge=$bridge，请回电脑看一眼。"
    }
    Log "推送：$title"
    # 把退出码写进日志并说明语义：dsh-push-notice.mjs 的 exit=2 是「渠道未配置、
    # 正常跳过」，不是故障。不标注的话，日后看日志会把一次成功的重启误读成推送坏了。
    # 2026-10-11 修正：原注释说「原生命令非零退出默认不抛」在 PS 5.1 下不成立——
    # $ErrorActionPreference='Stop' 时，2>&1 合并进来的 stderr 行会变成 ErrorRecord
    # 并在第一行就抛 NativeCommandError（推送脚本的日志行走 stderr），于是推送明明
    # 成功（message_id 已回），脚本却被甩进 catch、日志写成 [error]、任务结果恒为 1。
    # 这里局部降为 Continue，收完输出再恢复 Stop。
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = (& node $pushScript $title $body 2>&1) -join ' | '
    $pushExit = $LASTEXITCODE
    $ErrorActionPreference = $prevPref
    $pushMeaning = switch ($pushExit) {
      0 { '已送达' }
      2 { '渠道未配置，正常跳过' }
      default { '未送达' }
    }
    Log "推送结果：$out (exit=$pushExit = $pushMeaning)"
  }

  # 5) 注销自己
  Remove-OwnTask
  Log '── revive 结束，任务已注销 ──'
  exit $(if ($ok) { 0 } else { 4 })
}
catch {
  Log "[error] $($_.Exception.Message)"
  Remove-OwnTask
  exit 1
}
