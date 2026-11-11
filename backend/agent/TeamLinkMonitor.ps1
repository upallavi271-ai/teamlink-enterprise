<#
  TEAMLINK MONITOR - the office-PC agent of HRMS -> Employee Monitoring (2026-11-04).

  What it records, and nothing else:
    * the name of the app in front (chrome, excel ...) and its window title,
    * whether the PC is in use or idle (no mouse / keyboard for the idle minutes HR set),
    * (2.5) how much the keyboard and mouse are used, as counts per minute - and ONLY when one single key or button makes up
      nearly all of a minute (a key held down, an auto-clicker, a mouse mover), that one key's name. Only the flagged minutes
      leave the PC.
    * (2.6) how many times each kind of key and mouse button was pressed in work hours: Space, Enter, Backspace, Ctrl, each
      arrow, left click ... one by one, but ALL letter keys as one count and all number keys as one count - so what was typed
      can never be rebuilt. Sent as totals every two minutes.
  and only during work hours (HR sets them; the server throws away anything outside).
  It NEVER records what is typed, passwords, the clipboard, files or screenshots. Chat apps are recorded by name only.

  No hidden mode: the first run shows the company notice, and nothing is recorded until the employee accepts it and signs
  in with their own TeamLink email and password. While it runs, a TeamLink icon sits next to the clock ("Recording PC use
  in work hours"); its menu shows what is recorded and lets the employee stop it.

  Run: double-click TeamLinkMonitorSetup.cmd, downloaded from TeamLink (it holds this script and runs it).
  After set-up it starts with Windows by itself (the icon menu has "Do not start with Windows").
  Settings: %APPDATA%\TeamLinkMonitor\config.json (the device token is encrypted for this Windows user, DPAPI).
#>
param(
  [string]$Server = 'https://teamlink.teamlinks.in',
  [string]$SetupCode = '',   # the installer's /code=: fills the box, the notice is still shown
  [switch]$AfterUpdate,      # started by its own older copy, which is closing
  [switch]$Keeper            # started by the keeper task (the PC woke or was unlocked): takes over only from a dead or stuck copy
)
$ErrorActionPreference = 'Stop'
$AgentVersion = '2.6'
# older Windows would otherwise try an old, refused kind of secure connection
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Security

# ---------------------------------------------------------------- the agent's own short diary, on this PC only
# Only when it starts, updates, wakes, loses or finds the connection, is stopped and closes - never an app, a title or any activity.
# When a PC shows Offline while the person is working, %APPDATA%\TeamLinkMonitor\agent.log says why (founder 2026-11-09).
$LogFile = Join-Path $env:APPDATA 'TeamLinkMonitor\agent.log'
function Write-Log($text) {
  try {
    [void][IO.Directory]::CreateDirectory((Split-Path $LogFile))
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 256KB) { Move-Item -Path $LogFile -Destination ($LogFile -replace '\.log$', '.old.log') -Force }
    Add-Content -Path $LogFile -Value ('{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $text) -Encoding UTF8
  } catch {}
}
# an error nobody caught is written down, and a click that goes wrong does not close the agent
try { [Windows.Forms.Application]::SetUnhandledExceptionMode([Windows.Forms.UnhandledExceptionMode]::CatchException) } catch {}
[Windows.Forms.Application]::add_ThreadException({ param($s, $e) Write-Log "error, kept running: $($e.Exception.Message)" })
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TLWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static uint IdleSeconds() {
    LASTINPUTINFO l = new LASTINPUTINFO(); l.cbSize = (uint)Marshal.SizeOf(l);
    if (!GetLastInputInfo(ref l)) return 0;
    return ((uint)Environment.TickCount - l.dwTime) / 1000;
  }
}
'@

# ---------------------------------------------------------------- KEYS AND CLICKS, COUNTED (agent 2.5, founder 2026-11-11: "ekkuva sepu ey
# button use chesthunnaro kuda teliyali... constant ga"). Windows' raw input (the way games read the keyboard), on a hidden window of
# this agent: per minute, how many key presses, clicks, wheel turns and mouse moves, which single key was pressed most, and how much
# came from a program instead of a real keyboard / mouse (auto-clickers, mouse-mover apps, remote control). No order of keys is kept.
# a PC where this cannot be built still records apps and idle time as before: only the counting is off (written in the agent's diary)
try {
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class TLInput : NativeWindow {
  [StructLayout(LayoutKind.Sequential)] struct RAWINPUTDEVICE { public ushort UsagePage; public ushort Usage; public uint Flags; public IntPtr Target; }
  [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] d, uint n, uint size);
  [DllImport("user32.dll")] static extern uint GetRawInputData(IntPtr h, uint cmd, byte[] data, ref uint size, uint headerSize);
  static TLInput me;
  static readonly object gate = new object();
  static int[] keys = new int[256];
  // agent 2.6: the presses of each key since the last TakeTotals (a key held down counts once: down[] is cleared on key-up)
  static int[] dayKeys = new int[256];
  static bool[] down = new bool[256];
  static int dayLeft, dayRight, dayMiddle, dayWheel;
  static int keyTotal, clicks, left, right, middle, wheel, moves, injected;
  static long px, py, minX, maxX, minY, maxY;
  public static bool Started;
  public static bool Start() {
    if (me != null) return Started;
    me = new TLInput();
    me.CreateHandle(new CreateParams());   // never shown
    var d = new RAWINPUTDEVICE[2];
    d[0].UsagePage = 1; d[0].Usage = 6; d[0].Flags = 0x100; d[0].Target = me.Handle;   // keyboard, also when another app is in front
    d[1].UsagePage = 1; d[1].Usage = 2; d[1].Flags = 0x100; d[1].Target = me.Handle;   // mouse
    Started = RegisterRawInputDevices(d, 2, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
    Reset();
    return Started;
  }
  static void Reset() { Array.Clear(keys, 0, 256); keyTotal = clicks = left = right = middle = wheel = moves = injected = 0; px = py = minX = maxX = minY = maxY = 0; }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x00FF) { try { Read(m.LParam); } catch { } }
    base.WndProc(ref m);
  }
  static void Read(IntPtr h) {
    int hs = 8 + 2 * IntPtr.Size;
    uint size = 0;
    GetRawInputData(h, 0x10000003, null, ref size, (uint)hs);
    if (size == 0 || size > 2048) return;
    var b = new byte[size];
    if (GetRawInputData(h, 0x10000003, b, ref size, (uint)hs) != size) return;
    uint type = BitConverter.ToUInt32(b, 0);
    long dev = IntPtr.Size == 8 ? BitConverter.ToInt64(b, 8) : BitConverter.ToInt32(b, 8);
    lock (gate) {
      if (type == 1 && b.Length >= hs + 12) {
        ushort vk = BitConverter.ToUInt16(b, hs + 6);
        uint msg = BitConverter.ToUInt32(b, hs + 8);
        if ((msg == 0x100 || msg == 0x104) && vk > 0 && vk < 255) { keys[vk]++; keyTotal++; if (dev == 0) injected++; if (!down[vk]) { down[vk] = true; dayKeys[vk]++; } }
        else if ((msg == 0x101 || msg == 0x105) && vk > 0 && vk < 255) { down[vk] = false; }
      } else if (type == 0 && b.Length >= hs + 20) {
        ushort fl = BitConverter.ToUInt16(b, hs);
        ushort bf = BitConverter.ToUInt16(b, hs + 4);
        int dx = BitConverter.ToInt32(b, hs + 12), dy = BitConverter.ToInt32(b, hs + 16);
        int c = 0;
        if ((bf & 0x1) != 0) { left++; c++; dayLeft++; }
        if ((bf & 0x4) != 0) { right++; c++; dayRight++; }
        if ((bf & 0x10) != 0) { middle++; c++; dayMiddle++; }
        clicks += c;
        if ((bf & 0xC00) != 0) { wheel++; dayWheel++; }
        bool moved = (dx != 0 || dy != 0) && (fl & 1) == 0;
        if (moved) { moves++; px += dx; py += dy; if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py; }
        if (dev == 0 && (c > 0 || moved)) injected++;
      }
    }
  }
  // "keys|topKey|topKeyCount|clicks|left|right|middle|wheel|moves|spanX|spanY|fromAProgram" for the minute just ended; a new one starts
  // "vk=count;vk=count;...|left|right|middle|wheel" since the last call (agent 2.6); the counters start again
  public static string TakeTotals() {
    lock (gate) {
      var sb = new System.Text.StringBuilder();
      for (int i = 0; i < 256; i++) if (dayKeys[i] > 0) { sb.Append(i).Append('=').Append(dayKeys[i]).Append(';'); }
      string s = sb.ToString() + "|" + dayLeft + "|" + dayRight + "|" + dayMiddle + "|" + dayWheel;
      Array.Clear(dayKeys, 0, 256); dayLeft = dayRight = dayMiddle = dayWheel = 0;
      return s;
    }
  }
  public static string TakeMinute() {
    lock (gate) {
      int top = 0, topN = 0;
      for (int i = 0; i < 256; i++) if (keys[i] > topN) { topN = keys[i]; top = i; }
      string s = String.Join("|", new long[] { keyTotal, top, topN, clicks, left, right, middle, wheel, moves, maxX - minX, maxY - minY, injected });
      Reset();
      return s;
    }
  }
}
'@
} catch { Write-Log "key and click counting is not available on this PC: $($_.Exception.Message)" }

# THE KEEPER (founder 2026-11-10: "chaala mandhi laptop shutdown cheyyakunda close chesi vellipotharu, next day open chestharu - offline
# ani vasthundhi"). A Windows task of this user starts this script with -Keeper when the PC wakes or is unlocked. It takes over ONLY
# when the running copy is dead or stuck (no sign of life for 3 minutes, after giving a just-woken copy a minute to come back), and
# never after the employee stopped it (Stop recording and close) or switched off starting with Windows.
$FlagDir = Join-Path $env:APPDATA 'TeamLinkMonitor'
$AliveFile = Join-Path $FlagDir 'alive.txt'      # this copy's process id and last sign of life, every 15 seconds
$StoppedFlag = Join-Path $FlagDir 'stopped.flag' # the employee pressed Stop recording and close
$NoStartFlag = Join-Path $FlagDir 'nostart.flag' # the employee chose Do not start with Windows
function Alive-Age {
  try { $t = [datetime]::Parse(((Get-Content $AliveFile -Raw) -split '\|')[1]); return ((Get-Date) - $t).TotalSeconds } catch { return 99999 }
}
if ($Keeper) {
  if ((Test-Path $StoppedFlag) -or (Test-Path $NoStartFlag) -or -not (Test-Path (Join-Path $FlagDir 'config.json'))) { exit 0 }
}

Add-Type -ReferencedAssemblies System -TypeDefinition @'
using System;
using System.Net;
using System.Text;
using System.Threading;
using System.Diagnostics;
using Microsoft.Win32;
public static class TLPower {
  public static string Url; public static string Token; public static string Version;
  public static volatile bool Locked;
  static bool started;
  // THE GUARD (agent 2.4): Windows does not let an ordinary user set a task that restarts the agent (2.3's keeper: "Access is
  // denied" on a real PC), so the agent guards itself. The window side calls Beat() every 4 seconds; this thread checks it. If the
  // PC has been awake and the window side has not beaten for StuckSeconds, it is stuck: a fresh copy is started and this one ends.
  // Right after the PC wakes, the clock starts again - a just-woken agent is given the full time before anything is done.
  public static long LastBeat = DateTime.UtcNow.Ticks;
  public static string RelaunchExe; public static string RelaunchArgs;
  public static bool KillOnRelaunch = true;
  public static volatile bool Relaunched;
  public static void Beat() { Interlocked.Exchange(ref LastBeat, DateTime.UtcNow.Ticks); }
  public static void Guard(int stuckSeconds, int everySeconds) {
    var t = new Thread(() => {
      var prev = DateTime.UtcNow;
      while (true) {
        Thread.Sleep(everySeconds * 1000);
        var now = DateTime.UtcNow;
        bool slept = (now - prev).TotalSeconds > everySeconds * 3; prev = now;
        if (slept) { Beat(); continue; }
        var since = (now - new DateTime(Interlocked.Read(ref LastBeat))).TotalSeconds;
        if (since > stuckSeconds && !String.IsNullOrEmpty(RelaunchExe)) {
          try { Process.Start(new ProcessStartInfo(RelaunchExe, RelaunchArgs) { UseShellExecute = false, CreateNoWindow = true }); } catch { }
          Relaunched = true;
          if (KillOnRelaunch) { try { Process.GetCurrentProcess().Kill(); } catch { } }
          return;
        }
      }
    });
    t.IsBackground = true; t.Start();
  }
  public static void Start() {
    if (started) return; started = true;
    SystemEvents.PowerModeChanged += (s, e) => { if (e.Mode == PowerModes.Suspend) Tell("sleep"); };
    SystemEvents.SessionSwitch += (s, e) => {
      if (e.Reason == SessionSwitchReason.SessionLock) Locked = true;
      else if (e.Reason == SessionSwitchReason.SessionUnlock) Locked = false;
    };
  }
  // one short heartbeat that says the laptop is going to sleep; a few seconds at most, and nothing else
  public static void Tell(string state) {
    try {
      if (String.IsNullOrEmpty(Url) || String.IsNullOrEmpty(Token)) return;
      var req = (HttpWebRequest)WebRequest.Create(Url);
      req.Method = "POST"; req.Timeout = 3000; req.ReadWriteTimeout = 3000; req.ContentType = "application/json; charset=utf-8";
      req.Headers["Authorization"] = "Device " + Token;
      var body = Encoding.UTF8.GetBytes("{\"paused\":\"" + state + "\",\"agentVersion\":\"" + Version + "\",\"currentApp\":\"\",\"title\":\"\",\"idle\":true}");
      req.ContentLength = body.Length;
      using (var st = req.GetRequestStream()) st.Write(body, 0, body.Length);
      using (req.GetResponse()) { }
    } catch { }
  }
}
'@

# one agent per PC login: running the setup file again must not start a second copy (two icons, every minute counted twice)
$script:OneCopy = New-Object Threading.Mutex($false, 'Local\TeamLinkMonitor')
# After an update the older copy closes still holding this - Windows then hands it over with an "abandoned" error, which used to
# stop the NEW copy too and leave the PC with no agent until the next sign-in (founder 2026-11-09: working, but shown Offline).
$got = $false
try { $got = $script:OneCopy.WaitOne($(if ($AfterUpdate) { 30000 } else { 0 })) } catch [Threading.AbandonedMutexException] { $got = $true }
if (-not $got -and $Keeper) {
  # a copy is running: a PC that just woke needs a minute before its timers tick again, so look twice before calling it stuck
  if ((Alive-Age) -gt 180) { Start-Sleep -Seconds 75 }
  if ((Alive-Age) -le 180) { exit 0 }
  try {
    $old = [int]((Get-Content $AliveFile -Raw) -split '\|')[0]
    $pr = Get-Process -Id $old -ErrorAction Stop
    if ($pr.ProcessName -like 'powershell*') { Stop-Process -Id $old -Force -ErrorAction Stop }
  } catch {}
  try { $got = $script:OneCopy.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $got = $true }
  if ($got) { $script:tookOver = $true }
}
if (-not $got) {
  if (-not $Keeper) { [Windows.Forms.MessageBox]::Show('TeamLink Monitor is already running on this PC. Look for its icon next to the clock.', 'TeamLink') | Out-Null }
  exit 0
}
if (-not $Keeper) { Remove-Item -Path $StoppedFlag -ErrorAction SilentlyContinue }   # started again by the employee or Windows

Write-Log "started: version $AgentVersion$(if ($AfterUpdate) { ', after an update' })$(if ($Keeper) { $(if ($script:tookOver) { ', by the keeper: the old copy was stuck' } else { ', by the keeper: no copy was running' }) })"

$Dir = Join-Path $env:APPDATA 'TeamLinkMonitor'
$ConfigFile = Join-Path $Dir 'config.json'
$QueueFile = Join-Path $Dir 'queue.json'
$OpenFile = Join-Path $Dir 'open.json'   # the piece of activity still running: a shutdown or power cut loses none of it
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# ---------------------------------------------------------------- starting with Windows (the employee can switch it off in the icon's menu)
$StartupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'TeamLink Monitor.lnk'
function Add-Startup {
  $copy = Join-Path $Dir 'TeamLinkMonitor.ps1'
  if ($PSCommandPath -and ($PSCommandPath -ne $copy)) { Copy-Item -Path $PSCommandPath -Destination $copy -Force }
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($StartupLink)
  $s.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$copy`""
  $s.Description = 'TeamLink Monitor: records PC use in work hours (app names, window titles, active and idle time)'
  $s.Save()
  Remove-Item -Path $NoStartFlag -ErrorAction SilentlyContinue
}
# The keeper task: this user's own Windows task, run when the PC wakes from sleep or the user unlocks it. Set once per start.
$KeeperTask = 'TeamLink Monitor keeper'
function Set-Keeper {
  if ((Test-Path $NoStartFlag) -or (Test-Path (Join-Path $Dir 'keeper-denied.flag'))) { return }
  $copy = Join-Path $Dir 'TeamLinkMonitor.ps1'
  if (-not (Test-Path $copy)) { return }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $esc = { param($t) [Security.SecurityElement]::Escape([string]$t) }
  $ps = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  $argline = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$copy`" -Keeper"
  $wake = "<QueryList><Query Id=`"0`" Path=`"System`"><Select Path=`"System`">*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]</Select></Query></QueryList>"
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>TeamLink Monitor: starts it again when the PC wakes or is unlocked, only if it stopped working by itself. It never starts it after the employee stopped it.</Description></RegistrationInfo>
  <Triggers>
    <SessionStateChangeTrigger><Enabled>true</Enabled><StateChange>SessionUnlock</StateChange><UserId>$(& $esc $user)</UserId></SessionStateChangeTrigger>
    <EventTrigger><Enabled>true</Enabled><Subscription>$(& $esc $wake)</Subscription></EventTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$(& $esc $user)</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <AllowHardTerminate>true</AllowHardTerminate>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>$(& $esc $ps)</Command><Arguments>$(& $esc $argline)</Arguments></Exec></Actions>
</Task>
"@
  $file = Join-Path $env:TEMP 'teamlink-keeper.xml'
  try {
    [IO.File]::WriteAllText($file, $xml, [Text.Encoding]::Unicode)
    $out = & schtasks.exe /Create /TN $KeeperTask /XML $file /F 2>&1
    if ($LASTEXITCODE -ne 0) { if (-not (Test-Path (Join-Path $Dir 'keeper-denied.flag'))) { Write-Log "keeper task not allowed by Windows (the guard inside the agent does the job): $out"; Set-Content -Path (Join-Path $Dir 'keeper-denied.flag') -Value 1 } } elseif (-not $script:keeperLogged) { $script:keeperLogged = $true; Write-Log 'keeper set (wake / unlock)' }
  } catch { Write-Log "keeper not set: $($_.Exception.Message)" }
  Remove-Item -Path $file -ErrorAction SilentlyContinue
}
function Remove-Keeper { try { & schtasks.exe /Delete /TN $KeeperTask /F 2>&1 | Out-Null } catch {} }

# ---------------------------------------------------------------- config (token encrypted for this Windows user)
function Save-Config($cfg) {
  $plain = [Text.Encoding]::UTF8.GetBytes($cfg.token)
  $enc = [Security.Cryptography.ProtectedData]::Protect($plain, $null, 'CurrentUser')
  @{ server = $cfg.server; token = [Convert]::ToBase64String($enc); employee = $cfg.employee } | ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8
}
function Load-Config {
  if (-not (Test-Path $ConfigFile)) { return $null }
  try {
    $raw = Get-Content $ConfigFile -Raw | ConvertFrom-Json
    $dec = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($raw.token), $null, 'CurrentUser')
    return @{ server = $raw.server; token = [Text.Encoding]::UTF8.GetString($dec); employee = $raw.employee }
  } catch { return $null }
}

# ---------------------------------------------------------------- talking to TeamLink
function Call-Api($method, $path, $body, $token, $wait = 30) {
  $headers = @{}
  if ($token) { $headers['Authorization'] = "Device $token" }
  # bytes, not a string: Windows PowerShell would send a string in the old Latin encoding and spoil Telugu / Hindi window titles
  # (a typed byte[]: an if-expression would unroll it into a list of numbers)
  [byte[]]$json = $null
  if ($body) { $json = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 6 -Compress)) }
  try {
    $r = Invoke-WebRequest -Method $method -Uri ($script:Server.TrimEnd('/') + '/api/monitoring' + $path) -Headers $headers -Body $json -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec $wait
    $text = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
    return @{ status = [int]$r.StatusCode; data = ($text | ConvertFrom-Json) }
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if ($resp) {
      # Windows PowerShell has already read the answer by now: its text is here, not in the response stream
      $data = $null; try { $data = $_.ErrorDetails.Message | ConvertFrom-Json } catch {}
      return @{ status = [int]$resp.StatusCode; data = $data }
    }
    return @{ status = 0; data = $null }
  } catch { return @{ status = 0; data = $null } }
}

# ---------------------------------------------------------------- the notice and the sign-in (shown, never skipped)
function Show-Notice($text, $version) {
  $f = New-Object Windows.Forms.Form
  $f.Text = "TeamLink - monitoring notice (version $version)"; $f.Width = 620; $f.Height = 480; $f.StartPosition = 'CenterScreen'; $f.TopMost = $true
  $t = New-Object Windows.Forms.TextBox
  $t.Multiline = $true; $t.ReadOnly = $true; $t.ScrollBars = 'Vertical'; $t.Text = ($text -replace "`r?`n", "`r`n"); $t.Dock = 'Top'; $t.Height = 360; $t.Font = New-Object Drawing.Font('Segoe UI', 10)
  $ok = New-Object Windows.Forms.Button; $ok.Text = 'I have read it and I accept'; $ok.Width = 220; $ok.Left = 160; $ok.Top = 380; $ok.DialogResult = 'OK'
  $no = New-Object Windows.Forms.Button; $no.Text = 'I do not accept'; $no.Width = 140; $no.Left = 400; $no.Top = 380; $no.DialogResult = 'Cancel'
  $f.Controls.AddRange(@($t, $ok, $no)); $f.AcceptButton = $ok; $f.CancelButton = $no
  return ($f.ShowDialog() -eq 'OK')
}
$script:lastEmail = ''
function Ask-Login {
  $f = New-Object Windows.Forms.Form
  $f.Text = 'TeamLink - set up this PC'; $f.Width = 420; $f.Height = 320; $f.StartPosition = 'CenterScreen'; $f.TopMost = $true
  $l0 = New-Object Windows.Forms.Label; $l0.Text = 'Set-up code from TeamLink (if you have one)'; $l0.Left = 20; $l0.Top = 14; $l0.Width = 360
  $c = New-Object Windows.Forms.TextBox; $c.Left = 20; $c.Top = 34; $c.Width = 360; $c.CharacterCasing = 'Upper'; $c.Text = $SetupCode
  $lo = New-Object Windows.Forms.Label; $lo.Text = 'or sign in with your own TeamLink login:'; $lo.Left = 20; $lo.Top = 68; $lo.Width = 360
  $l1 = New-Object Windows.Forms.Label; $l1.Text = 'Email'; $l1.Left = 20; $l1.Top = 90; $l1.Width = 360
  $e = New-Object Windows.Forms.TextBox; $e.Left = 20; $e.Top = 110; $e.Width = 360; $e.Text = $script:lastEmail
  $l2 = New-Object Windows.Forms.Label; $l2.Text = 'Password'; $l2.Left = 20; $l2.Top = 138; $l2.Width = 360
  $p = New-Object Windows.Forms.TextBox; $p.Left = 20; $p.Top = 158; $p.Width = 360; $p.UseSystemPasswordChar = $true
  $show = New-Object Windows.Forms.CheckBox; $show.Text = 'Show password'; $show.Left = 20; $show.Top = 186; $show.Width = 200
  $show.Add_CheckedChanged({ $p.UseSystemPasswordChar = -not $show.Checked }.GetNewClosure())
  $ok = New-Object Windows.Forms.Button; $ok.Text = 'Set up this PC'; $ok.Left = 20; $ok.Top = 222; $ok.Width = 160; $ok.DialogResult = 'OK'
  $no = New-Object Windows.Forms.Button; $no.Text = 'Cancel'; $no.Left = 200; $no.Top = 222; $no.Width = 100; $no.DialogResult = 'Cancel'
  $f.Controls.AddRange(@($l0, $c, $lo, $l1, $e, $l2, $p, $show, $ok, $no)); $f.AcceptButton = $ok; $f.CancelButton = $no
  if ($f.ShowDialog() -ne 'OK') { return $null }
  $script:lastEmail = $e.Text.Trim()
  return @{ code = $c.Text.Trim(); email = $e.Text.Trim(); password = $p.Text }
}

function Register {
  $os = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption
  $version = $null
  while ($true) {
    $login = Ask-Login
    if (-not $login) { return $null }
    $body = @{ deviceName = $env:COMPUTERNAME; os = $os }
    if ($login.code) { $body.setupCode = $login.code } else { $body.email = $login.email; $body.password = $login.password }
    if ($version) { $body.acceptPolicyVersion = $version }
    $r = Call-Api 'POST' '/devices/register' $body $null
    if ($r.status -eq 412 -and $r.data.consentRequired) {
      if (-not (Show-Notice $r.data.policyText $r.data.policyVersion)) { [Windows.Forms.MessageBox]::Show('Nothing was set up and nothing is recorded.', 'TeamLink') | Out-Null; return $null }
      $version = $r.data.policyVersion
      $body.acceptPolicyVersion = $version
      $r = Call-Api 'POST' '/devices/register' $body $null
    }
    if ($r.status -eq 201) {
      $cfg = @{ server = $script:Server; token = $r.data.deviceToken; employee = $r.data.employee }
      Save-Config $cfg
      try { Add-Startup } catch {}
      [Windows.Forms.MessageBox]::Show("This PC is set up for $($r.data.employee). It starts with Windows, and a TeamLink icon next to the clock shows that work hours are recorded. You can stop it from that icon.", 'TeamLink') | Out-Null
      return $cfg
    }
    $msg = if ($r.data -and $r.data.error) { $r.data.error } elseif ($r.status -eq 0) { 'TeamLink could not be reached. Check the internet connection.' } else { "TeamLink said no ($($r.status))." }
    [Windows.Forms.MessageBox]::Show($msg, 'TeamLink') | Out-Null
  }
}

# ---------------------------------------------------------------- start
$cfg = Load-Config
if ($cfg -and $cfg.server) { $script:Server = $cfg.server } else { $script:Server = $Server }
if (-not $cfg) { $cfg = Register; if (-not $cfg) { exit } }

[TLPower]::Url = $script:Server.TrimEnd('/') + '/api/monitoring/heartbeat'; [TLPower]::Token = $cfg.token; [TLPower]::Version = $AgentVersion
try { [TLPower]::Start() } catch { Write-Log "power watcher not started: $($_.Exception.Message)" }
try { Set-Keeper } catch {}
# the guard: a stuck agent starts a fresh copy of itself (the fresh copy takes over as the keeper would)
try {
  $me = Join-Path $Dir 'TeamLinkMonitor.ps1'; if (-not (Test-Path $me)) { $me = $PSCommandPath }
  [TLPower]::RelaunchExe = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  [TLPower]::RelaunchArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$me`" -Keeper"
  [TLPower]::Guard(180, 20)
} catch { Write-Log "guard not started: $($_.Exception.Message)" }

$settings = @{ workStart = '09:30'; workEnd = '18:30'; idleThresholdMinutes = 5; excluded = $false }
$queue = New-Object System.Collections.ArrayList
# what was not sent last time, and the piece that was running when the PC went off: sent now
function Restore-Saved {
  if (Test-Path $QueueFile) { try { (Get-Content $QueueFile -Raw | ConvertFrom-Json) | ForEach-Object { [void]$script:queue.Add($_) } } catch {} }
  if (Test-Path $OpenFile) {
    try {
      $o = Get-Content $OpenFile -Raw | ConvertFrom-Json
      [void]$script:queue.Add(@{ appName = $o.app; windowTitle = $o.title; start = $o.start; end = $o.last; isIdle = [bool]$o.idle; isBreak = [bool]$o.brk })
    } catch {}
    Remove-Item -Path $OpenFile -ErrorAction SilentlyContinue
  }
}
Restore-Saved
$current = $null      # the open segment: app, title, idle, brk, start
$lastSample = $null   # when the PC last looked: a long gap means it was asleep
$stopping = $false    # the employee pressed Stop recording
$updateTried = ''     # a version already tried: once a run is enough
$updating = $false    # the new version is starting: this one closes
$lastLive = ''        # what TeamLink was last told is in front
$nextLive = [datetime]::MinValue
$paused = $false      # stopped by TeamLink (no consent, PC switched off)
$onBreak = $false     # the employee pressed Pause: only the break itself is timed
$clockedOutDay = ''   # the employee clocked out: nothing until the next day

function In-WorkHours {
  if ($settings.excluded) { return $false }
  $now = (Get-Date).ToUniversalTime().AddMinutes(330).ToString('HH:mm')
  # a night shift ends after midnight
  if ($settings.workStart -gt $settings.workEnd) { return ($now -ge $settings.workStart -or $now -lt $settings.workEnd) }
  return ($now -ge $settings.workStart -and $now -lt $settings.workEnd)
}
function Save-Queue {
  try {
    if ($script:queue.Count) { ConvertTo-Json -InputObject @($script:queue) -Depth 4 | Set-Content -Path $QueueFile -Encoding UTF8 }
    else { Remove-Item -Path $QueueFile -ErrorAction SilentlyContinue }
  } catch {}
}
function Write-Open {
  $c = $script:current
  if (-not $c) { return }
  try { @{ app = $c.app; title = $c.title; idle = $c.idle; brk = $c.brk; start = $c.start.ToString('o'); last = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -Path $OpenFile -Encoding UTF8 } catch {}
}
# ends the open piece, now or at the moment given
function Close-Segment($at = $null) {
  if ($script:current) {
    $end = if ($at) { $at } else { (Get-Date).ToUniversalTime() }
    if (($end - $script:current.start).TotalSeconds -ge 1) {
      [void]$script:queue.Add(@{ appName = $script:current.app; windowTitle = $script:current.title; start = $script:current.start.ToString('o'); end = $end.ToString('o'); isIdle = $script:current.idle; isBreak = $script:current.brk })
      Save-Queue
    }
    $script:current = $null
    Remove-Item -Path $OpenFile -ErrorAction SilentlyContinue
  }
}
function Today-Ist { return (Get-Date).ToUniversalTime().AddMinutes(330).ToString('yyyy-MM-dd') }
# what is in front now
function Get-Front {
  $h = [TLWin]::GetForegroundWindow()
  $app = 'Desktop'; $title = ''
  if ($h -ne [IntPtr]::Zero) {
    $sb = New-Object Text.StringBuilder 512
    [void][TLWin]::GetWindowText($h, $sb, 512); $title = $sb.ToString()
    $procId = 0; [void][TLWin]::GetWindowThreadProcessId($h, [ref]$procId)
    try { $app = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  }
  return @{ app = $app; title = $title }
}
function Sample {
  $now = (Get-Date).ToUniversalTime()
  # the timer stopped for a while: the PC was asleep. That time is nobody's work, so the open piece ends where the PC last looked.
  if ($script:lastSample -and ($now - $script:lastSample).TotalSeconds -gt 90) { Close-Segment $script:lastSample }
  $script:lastSample = $now
  if ($script:clockedOutDay -and $script:clockedOutDay -ne (Today-Ist)) { $script:clockedOutDay = ''; Update-Menu }
  if ($script:paused -or $script:clockedOutDay -or -not (In-WorkHours)) { Close-Segment; return }
  if ($script:onBreak) {
    # a break: only that it is a break and how long; no app, no title
    $c = $script:current
    if ($c -and $c.brk -and ($now - $c.start).TotalMinutes -lt 30) { Write-Open; return }
    Close-Segment
    $script:current = @{ app = 'Break'; title = ''; idle = $false; brk = $true; start = $now }
    Write-Open
    return
  }
  $inputAgo = [double][TLWin]::IdleSeconds()
  $idle = $inputAgo -ge ([int]$settings.idleThresholdMinutes * 60)
  $front = Get-Front
  $app = $front.app; $title = $front.title
  # a locked screen is never work: it is idle from the first moment, whatever the idle minutes
  if ($app -in @('LockApp', 'LogonUI')) { $idle = $true; $app = 'Locked' }
  if ($idle) { $title = '' }
  $c = $script:current
  if ($c -and $c.app -eq $app -and $c.title -eq $title -and $c.idle -eq $idle -and ($now - $c.start).TotalMinutes -lt 30) { Write-Open; return }
  $from = $now
  if ($idle -and $c -and -not $c.idle -and -not $c.brk) {
    # idle began when the mouse and keyboard stopped, not when the idle minutes ran out
    $from = $now.AddSeconds(-$inputAgo)
    if ($from -lt $c.start) { $from = $c.start }
    Close-Segment $from
  } else { Close-Segment }
  $script:current = @{ app = $app; title = $title; idle = $idle; brk = $false; start = $from }
  Write-Open
}
# THE LIVE DASHBOARD, WITHIN SECONDS: looks at what is in front every 2 seconds and tells TeamLink only when it changed. This is the live
# picture alone: the records still come from Sample and Flush, so a page that keeps changing its title cannot fill them up.
function Watch-Front {
  if ($script:paused -or $script:onBreak -or $script:clockedOutDay -or -not (In-WorkHours)) { return }
  $now = Get-Date
  if ($now -lt $script:nextLive) { return }
  $f = Get-Front
  $app = $f.app; $title = $f.title
  $idle = [double][TLWin]::IdleSeconds() -ge ([int]$settings.idleThresholdMinutes * 60)
  if ($app -in @('LockApp', 'LogonUI')) { $idle = $true; $app = 'Locked' }
  if ($idle) { $title = '' }
  $key = "$app|$title|$idle"
  if ($key -eq $script:lastLive) { return }
  $r = Call-Api 'POST' '/live' @{ currentApp = $app; title = $title; idle = [bool]$idle } $script:cfg.token 5
  if ($r.status -eq 200) { $script:lastLive = $key; $script:nextLive = $now.AddSeconds(2) } else { $script:nextLive = $now.AddSeconds(30) }  # no line: try again later, quietly
}
# ONE MINUTE OF INPUT, LOOKED AT (agent 2.5). A minute is kept only when nearly all of it is ONE thing over and over:
#   key       30+ key presses and one key is 85%+ of them (a key held down or tapped again and again)
#   click     20+ clicks, hardly any typing, and one button is 95%+ of them (an auto-clicker)
#   mouse     only small mouse moves inside a 40-pixel spot, no key, no click, no wheel (a mouse mover / jiggler)
#   software  30+ events and 80%+ of the input came from a program, not a real keyboard or mouse
# TeamLink joins the kept minutes into stretches; 10 minutes in a row is shown to HR and the team lead.
$script:inputQueue = New-Object Collections.ArrayList
$script:inputOff = $false
$KeyNames = @{ 8 = 'Backspace'; 9 = 'Tab'; 13 = 'Enter'; 16 = 'Shift'; 17 = 'Ctrl'; 18 = 'Alt'; 27 = 'Esc'; 32 = 'Space'; 33 = 'Page Up'; 34 = 'Page Down'; 35 = 'End'; 36 = 'Home'; 37 = 'Left arrow'; 38 = 'Up arrow'; 39 = 'Right arrow'; 40 = 'Down arrow'; 45 = 'Insert'; 46 = 'Delete'; 160 = 'Shift'; 161 = 'Shift'; 162 = 'Ctrl'; 163 = 'Ctrl'; 164 = 'Alt'; 165 = 'Alt'; 91 = 'Windows key'; 92 = 'Windows key' }
function Key-Name([int]$vk) {
  if ($KeyNames.ContainsKey($vk)) { return $KeyNames[$vk] }
  if ($vk -ge 48 -and $vk -le 57) { return "Key $([char]$vk)" }
  if ($vk -ge 65 -and $vk -le 90) { return "Key $([char]$vk)" }
  if ($vk -ge 96 -and $vk -le 105) { return "Number pad $($vk - 96)" }
  if ($vk -ge 112 -and $vk -le 135) { return "F$($vk - 111)" }
  return "Key code $vk"
}
function Check-Input {
  if (-not [TLInput]::Started) { return }
  $p = @(([TLInput]::TakeMinute()) -split '\|' | ForEach-Object { [double]$_ })
  if ($p.Count -lt 12) { return }
  if ($script:paused -or $script:onBreak -or $script:clockedOutDay -or -not (In-WorkHours)) { return }
  $keys = $p[0]; $top = [int]$p[1]; $topN = $p[2]; $clicks = $p[3]; $l = $p[4]; $r = $p[5]; $m = $p[6]; $wheel = $p[7]; $moves = $p[8]; $sx = $p[9]; $sy = $p[10]; $inj = $p[11]
  $all = $keys + $clicks + $wheel + $moves
  $kind = $null; $name = ''; $count = 0
  if ($inj -ge 30 -and $inj -ge 0.8 * $all) { $kind = 'software'; $name = 'Input sent by a program'; $count = $inj }
  elseif ($keys -ge 30 -and $topN -ge 0.85 * $keys) { $kind = 'key'; $name = Key-Name $top; $count = $topN }
  elseif ($clicks -ge 20 -and $keys -le 3 -and [math]::Max($l, [math]::Max($r, $m)) -ge 0.95 * $clicks) {
    $kind = 'click'; $name = $(if ($l -ge $r -and $l -ge $m) { 'Left click' } elseif ($r -ge $m) { 'Right click' } else { 'Middle click' }); $count = $clicks
  }
  elseif ($keys -eq 0 -and $clicks -eq 0 -and $wheel -eq 0 -and $moves -ge 5 -and $sx -le 40 -and $sy -le 40) { $kind = 'mouse'; $name = 'Mouse moving in one small spot'; $count = $moves }
  if (-not $kind) { return }
  [void]$script:inputQueue.Add(@{ at = (Get-Date).ToUniversalTime().AddSeconds(-60).ToString('o'); kind = $kind; key = $name; count = [int]$count })
  if ($script:inputQueue.Count -gt 2000) { $script:inputQueue.RemoveRange(0, $script:inputQueue.Count - 2000) }
}
# THE KEYS AND BUTTONS OF THE DAY (agent 2.6, founder 2026-11-11: "evaru ey buttons enni times press chesthunnaro teliyali").
# Every key one by one, except that all LETTER keys are one count and all NUMBER keys are one count (so typing can never be rebuilt).
function Key-Group([int]$vk) {
  if ($vk -ge 65 -and $vk -le 90) { return 'Letter keys' }
  if (($vk -ge 48 -and $vk -le 57) -or ($vk -ge 96 -and $vk -le 105)) { return 'Number keys' }
  if ($vk -ge 112 -and $vk -le 135) { return 'F-keys (F1 - F24)' }
  if (($vk -ge 186 -and $vk -le 192) -or ($vk -ge 219 -and $vk -le 223) -or $vk -eq 226 -or ($vk -ge 106 -and $vk -le 111)) { return 'Symbol keys' }
  if ($vk -eq 20) { return 'Caps Lock' }
  if ($vk -eq 44) { return 'Print Screen' }
  if ($vk -in @(1, 2, 4, 5, 6)) { return $null }   # mouse buttons arrive as keys too on some PCs: counted from the mouse instead
  if ($KeyNames.ContainsKey($vk)) { return $KeyNames[$vk] }
  return 'Other keys'
}
$script:dayCounts = @{}   # 'yyyy-mm-dd' -> @{ 'Space' = 12; ... }
function Take-Counts {
  if (-not [TLInput]::Started) { return }
  $raw = [TLInput]::TakeTotals()
  if ($script:paused -or $script:onBreak -or $script:clockedOutDay -or -not (In-WorkHours)) { return }   # outside work hours: thrown away
  $parts = $raw -split '\|'
  if ($parts.Count -lt 5) { return }
  $day = Today-Ist
  if (-not $script:dayCounts.ContainsKey($day)) { $script:dayCounts[$day] = @{} }
  $c = $script:dayCounts[$day]
  foreach ($pair in ($parts[0] -split ';')) {
    if (-not $pair) { continue }
    $kv = $pair -split '='
    $g = Key-Group ([int]$kv[0])
    if (-not $g) { continue }
    $c[$g] = [int]$c[$g] + [int]$kv[1]
  }
  foreach ($m in @(@('Left click', 1), @('Right click', 2), @('Middle click', 3), @('Mouse wheel', 4))) {
    $n = [int]$parts[$m[1]]
    if ($n -gt 0) { $c[$m[0]] = [int]$c[$m[0]] + $n }
  }
}
function Send-Counts {
  if ($script:inputOff -or $script:dayCounts.Count -eq 0) { return }
  foreach ($day in @($script:dayCounts.Keys)) {
    $c = $script:dayCounts[$day]
    if ($c.Count -eq 0) { $script:dayCounts.Remove($day); continue }
    $r = Call-Api 'POST' '/input-counts' @{ day = $day; counts = $c } $script:cfg.token
    if ($r.status -eq 200) { $script:dayCounts.Remove($day) }
    elseif ($r.status -eq 404) { $script:dayCounts.Clear(); return }   # an older TeamLink: it does not take these
  }
}
function Send-Input {
  if ($script:inputOff -or $script:inputQueue.Count -eq 0) { return }
  $batch = @($script:inputQueue | Select-Object -First 300)
  $r = Call-Api 'POST' '/input' @{ minutes = $batch } $script:cfg.token
  if ($r.status -eq 200) { $script:inputQueue.RemoveRange(0, $batch.Count) }
  elseif ($r.status -eq 404) { $script:inputOff = $true; $script:inputQueue.Clear() }   # an older TeamLink: it does not take these
}
function Flush {
  try { Send-Input } catch {}
  try { Take-Counts; Send-Counts } catch {}
  Close-Segment   # send what is done so far
  Sample          # and go straight on: a heartbeat right after this must still say what is in front
  if ($script:queue.Count -eq 0) { return }
  $batch = @($script:queue | Select-Object -First 400)
  $r = Call-Api 'POST' '/activity' @{ records = $batch } $script:cfg.token
  if ($r.status -eq 200) {
    $script:queue.RemoveRange(0, $batch.Count)
  } elseif ($r.status -eq 412) {
    Ask-Consent $r.data
  } elseif ($r.status -eq 401) {
    $script:tray.ShowBalloonTip(8000, 'TeamLink', 'This PC was switched off in TeamLink, or needs to be set up again.', 'Warning')
    $script:paused = $true
  }
  if ($script:queue.Count -gt 5000) { $script:queue.RemoveRange(0, $script:queue.Count - 5000) }
  Save-Queue
}
function Ask-Consent($data) {
  $script:paused = $true
  Close-Segment
  $script:queue.Clear()
  if ($data -and $data.policyText -and (Show-Notice $data.policyText $data.policyVersion)) {
    $r = Call-Api 'POST' '/consent' @{ policyVersion = $data.policyVersion } $script:cfg.token
    if ($r.status -eq 200) { $script:paused = $false }
  }
}
# A NEW AGENT FROM TEAMLINK: taken only if its hash matches what TeamLink announced and the script is whole; any trouble keeps this one running.
function Apply-Update($u) {
  if ($script:updateTried -eq $u.version) { return }
  $script:updateTried = $u.version
  $new = Join-Path $Dir 'update.ps1'
  $copy = Join-Path $Dir 'TeamLinkMonitor.ps1'
  try {
    Invoke-WebRequest -Uri ($script:Server.TrimEnd('/') + '/api/monitoring/agent-script') -Headers @{ Authorization = "Device $($script:cfg.token)" } -OutFile $new -UseBasicParsing -TimeoutSec 60
    if ((Get-FileHash -Path $new -Algorithm SHA256).Hash -ne ([string]$u.sha256).ToUpper()) { throw 'hash' }
    $errs = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($new, [ref]$null, [ref]$errs)
    if ($errs.Count) { throw 'parse' }
    Move-Item -Path $new -Destination $copy -Force
  } catch { Write-Log "update to $($u.version) not taken: $($_.Exception.Message)"; Remove-Item -Path $new -ErrorAction SilentlyContinue; return }
  try { Flush } catch {}
  Write-Log "updating to $($u.version): the new copy takes over"
  Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$copy`"", '-AfterUpdate')
  $script:tray.Visible = $false
  $script:updating = $true
  [Windows.Forms.Application]::Exit()
}
function Heartbeat {
  # what the Live Dashboard shows: the app's name only, never a title
  $c = $script:current
  $state = if ($script:stopping) { 'stopped' } elseif ($script:clockedOutDay) { 'clockout' } elseif ($script:onBreak) { 'break' } elseif ([TLPower]::Locked -or ($c -and $c.app -eq 'Locked')) { 'locked' } else { $null }
  $beat = @{ agentVersion = $AgentVersion; paused = $state; currentApp = $(if ($c -and -not $c.brk) { $c.app } else { '' }); title = $(if ($c -and -not $c.brk) { $c.title } else { '' }); idle = [bool]($c -and $c.idle) }
  $r = Call-Api 'POST' '/heartbeat' $beat $script:cfg.token
  if ($r.status -ne 200 -and -not $script:beatFailing) { $script:beatFailing = $true; Write-Log "cannot reach TeamLink (answer $($r.status))" }
  if ($r.status -eq 200) {
    if ($script:beatFailing) { $script:beatFailing = $false; Write-Log 'reaching TeamLink again' }
    $script:lastBeatOk = Get-Date   # it is reaching the server: the wake handler uses this to know it is back online
    $s = $r.data.settings
    $script:lastLive = ''   # this heartbeat may be up to 15 seconds old: the watcher sets the picture right
    $script:settings = @{ workStart = $s.workStart; workEnd = $s.workEnd; idleThresholdMinutes = $s.idleThresholdMinutes; excluded = [bool]$s.excluded }
    # a new notice: shown at once, and nothing more is recorded until it is accepted
    if ($r.data.consentRequired) { Ask-Consent @{ policyText = $r.data.policyText; policyVersion = $s.policyVersion } }
    elseif ($r.data.update -and -not $script:stopping) { Apply-Update $r.data.update }
  } elseif ($r.status -eq 401) { $script:paused = $true }
}

# ---------------------------------------------------------------- the icon next to the clock (always visible while it runs)
$tray = New-Object Windows.Forms.NotifyIcon
$tray.Icon = [Drawing.SystemIcons]::Information
$tray.Text = 'TeamLink: recording PC use in work hours'
$tray.Visible = $true
$menu = New-Object Windows.Forms.ContextMenuStrip
$who = $menu.Items.Add("Set up for $($cfg.employee)"); $who.Enabled = $false
[void]$menu.Items.Add('What is recorded (open TeamLink)', $null, { Start-Process ($script:Server.TrimEnd('/') + '/monitoring?tab=mine') })
$pauseItem = $menu.Items.Add('Pause (break)', $null, { $script:onBreak = -not $script:onBreak; Close-Segment; Update-Menu; try { Sample; Heartbeat } catch {} })
$clockItem = $menu.Items.Add('Clock out for today', $null, { $script:onBreak = $false; $script:clockedOutDay = (Today-Ist); Close-Segment; Update-Menu; try { Flush; Heartbeat } catch {} })
function Update-Menu {
  $script:pauseItem.Text = if ($script:onBreak) { 'Resume' } else { 'Pause (break)' }
  $script:pauseItem.Enabled = -not $script:clockedOutDay
  $script:clockItem.Enabled = -not $script:clockedOutDay
  $script:tray.Text = if ($script:clockedOutDay) { 'TeamLink: clocked out for today, nothing is recorded' } elseif ($script:onBreak) { 'TeamLink: on a break, nothing is recorded' } else { 'TeamLink: recording PC use in work hours' }
}
# HR sees that it was stopped: stopping is allowed, and never silent
[void]$menu.Items.Add('Stop recording and close', $null, { Write-Log 'stopped by the employee (Stop recording and close)'; try { Set-Content -Path $StoppedFlag -Value (Get-Date).ToString('o') } catch {}; Flush; $script:stopping = $true; try { Heartbeat } catch {}; $script:tray.Visible = $false; [Windows.Forms.Application]::Exit() })
[void]$menu.Items.Add('Do not start with Windows', $null, { Write-Log 'set not to start with Windows'; Remove-Item -Path $StartupLink -ErrorAction SilentlyContinue; try { Set-Content -Path $NoStartFlag -Value (Get-Date).ToString('o') } catch {}; Remove-Keeper; $script:tray.ShowBalloonTip(5000, 'TeamLink', 'It will not start with Windows any more.', 'Info') })
$tray.ContextMenuStrip = $menu
$tray.ShowBalloonTip(6000, 'TeamLink', 'Recording PC use in work hours: app names, window titles, active and idle time, and how much the keyboard and mouse are used. Nothing you type is recorded.', 'Info')
# the icon above is what shows it is running: the black window goes, so closing it by mistake does not stop the agent
try { [void][TLWin]::ShowWindow([TLWin]::GetConsoleWindow(), 0) } catch {}

Sample   # so the very first heartbeat already says what is in front
Heartbeat
# an update on this first heartbeat: the message loop has not started, so Exit above did nothing and the new copy is waiting for this one
if ($updating) { $tray.Dispose(); Write-Log 'closed for the update'; exit 0 }
$sampleTimer = New-Object Windows.Forms.Timer; $sampleTimer.Interval = 15000; $sampleTimer.Add_Tick({ try { Sample } catch {} }); $sampleTimer.Start()
$flushTimer = New-Object Windows.Forms.Timer; $flushTimer.Interval = 120000; $flushTimer.Add_Tick({ try { Flush } catch {} }); $flushTimer.Start()
$liveTimer = New-Object Windows.Forms.Timer; $liveTimer.Interval = 2000; $liveTimer.Add_Tick({ try { Watch-Front } catch {} }); $liveTimer.Start()
try { if (-not [TLInput]::Start()) { Write-Log 'key and click counting could not start on this PC' } } catch { Write-Log "key and click counting could not start: $($_.Exception.Message)" }
$inputTimer = New-Object Windows.Forms.Timer; $inputTimer.Interval = 60000; $inputTimer.Add_Tick({ try { Check-Input } catch {} }); $inputTimer.Start()
$beatTimer = New-Object Windows.Forms.Timer; $beatTimer.Interval = 60000; $beatTimer.Add_Tick({ try { Heartbeat } catch {} }); $beatTimer.Start()
# ---------------------------------------------------------------- WAKE FROM SLEEP
# Closing the laptop and opening it the next day does NOT sign out of Windows, so this same agent keeps running. But while the
# PC sleeps a Windows.Forms.Timer does not tick, and the Wi-Fi takes a few seconds to come back on wake - so the first
# heartbeat after opening the lid can race the network and miss, and the Live Dashboard shows the person Offline until a later
# tick happens to land. This makes the agent report the moment the PC wakes, and keep trying for a short while until a
# heartbeat gets through, so a normal close-and-reopen never shows as Offline.
$script:resumeAt = $null
try {
  [Microsoft.Win32.SystemEvents]::add_PowerModeChanged({
    param($sender, $e)
    if ($e.Mode -eq [Microsoft.Win32.PowerModes]::Resume) { $script:resumeAt = Get-Date }
  })
} catch { }
$wakeTimer = New-Object Windows.Forms.Timer
$wakeTimer.Interval = 4000   # the work runs here, on the UI thread, not inside the power event
$script:lastWakeTick = Get-Date
$wakeTimer.Add_Tick({
  # Windows does not always say "resumed": a lid opened with no key pressed sends a signal .NET leaves out. So a 4-second timer
  # that did not tick for 30 seconds also means the PC slept (tested 2026-11-09: only the keyed resume reached the handler above).
  $now = Get-Date
  [TLPower]::Beat()
  if (-not $script:lastAlive -or ($now - $script:lastAlive).TotalSeconds -ge 15) { $script:lastAlive = $now; try { Set-Content -Path $AliveFile -Value ("{0}|{1}" -f $PID, $now.ToString('o')) } catch {} }
  if (($now - $script:lastWakeTick).TotalSeconds -gt 30 -and -not $script:resumeAt) { $script:resumeAt = $now }
  $script:lastWakeTick = $now
  if ($script:resumeAt -and -not $script:wakeLogged) { $script:wakeLogged = $true; Write-Log 'woke from sleep' }
  if (-not $script:resumeAt) { return }
  $since = (Get-Date) - $script:resumeAt
  # a heartbeat that got through AFTER we woke, or 90 seconds of trying, ends the catch-up
  if (($script:lastBeatOk -and $script:lastBeatOk -gt $script:resumeAt) -or $since.TotalSeconds -gt 90) { $script:resumeAt = $null; $script:wakeLogged = $false; return }
  try { Sample; Watch-Front; Heartbeat; Flush } catch { }
})
$wakeTimer.Start()

[Windows.Forms.Application]::Run()
$tray.Dispose()
Write-Log $(if ($updating) { 'closed for the update' } else { 'closed' })
