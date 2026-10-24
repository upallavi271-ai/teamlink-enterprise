# Instant two-way sync between this folder and GitHub.
#
#   powershell -ExecutionPolicy Bypass -File .\watch-sync.ps1
#
# How it works:
#   - One file watcher per main folder of the project (plus one for the top-level files only) reads your saves. After the
#     last real change it waits QuietSeconds of quiet, then commits and pushes to GitHub by itself.
#   - Every PullSeconds it also pulls from GitHub, so changes made elsewhere arrive here.
#   - It never pushes a secret: anything staged that looks like one (.env, .env.local, .env.production ..., *.pem, *.key,
#     *.p12, *.pfx; the *.env.example / .env.*.example templates are fine) cancels the commit and is printed in red.
#   - It syncs the branch you are on (git branch --show-current), not a hard-coded "main".
#   - Only one copy runs at a time. Close the window to stop it.
#
# Switches:
#   -QuietSeconds 8     wait this long after the last change before syncing
#   -PullSeconds  120   how often to pull changes DOWN from GitHub
#   -MaxFiles     500   a single sync bigger than this is held back (it is probably a first sync or a mistake):
#                       run once with -AllowBig after you have looked at `git status`
#   -Remote       origin

param(
  [int]$QuietSeconds = 8,
  [int]$PullSeconds  = 120,
  [int]$MaxFiles     = 500,
  [switch]$AllowBig,
  [string]$Remote    = 'origin'
)

Set-Location $PSScriptRoot
$Root = $PSScriptRoot
$Project = Split-Path $Root -Leaf
$Host.UI.RawUI.WindowTitle = "$Project - WATCH-SYNC"
$env:GIT_TERMINAL_PROMPT = '0'   # never sit waiting for a password prompt; a failed login is just a failed push

# Only one copy at a time: two of them racing over one repo make a mess.
$mutexName = 'WatchSync-' + (($Root.ToLower() -replace '[^a-z0-9]', '-').Trim('-'))
if ($mutexName.Length -gt 120) { $mutexName = $mutexName.Substring(0, 120) }
$script:syncMutex = New-Object System.Threading.Mutex($false, $mutexName)
if (-not $script:syncMutex.WaitOne(0)) {
  Write-Host "Another WATCH-SYNC window is already running for this project - this one will close." -ForegroundColor Yellow
  Start-Sleep -Seconds 5
  exit
}

function Say([string]$text, [string]$color = 'Gray') {
  Write-Host ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $text) -ForegroundColor $color
}

# ---- sanity: a git repo with the remote, on a real branch ---------------------------------------------------------------
$inside = (git rev-parse --is-inside-work-tree 2>$null)
if ($inside -ne 'true') { Write-Host "This folder is not a git repository." -ForegroundColor Red; $script:syncMutex.ReleaseMutex(); exit 1 }
$remoteUrl = (git remote get-url $Remote 2>$null)
if (-not $remoteUrl) { Write-Host "There is no git remote called '$Remote'." -ForegroundColor Red; $script:syncMutex.ReleaseMutex(); exit 1 }

function Get-Branch { return (git branch --show-current 2>$null) }

# ---- noise a watcher must ignore (never a reason to sync) ---------------------------------------------------------------
$excludeRe = '\\(node_modules|\.git|dist|dist-ssr|build|coverage|\.vite|\.uploads|uploads|logs|\.vscode|\.idea|\.teamlink-[a-z]+|backups|test-results)(\\|$)' +
  '|\.(log|tmp|swp|swo|tsbuildinfo|crdownload|db|db-wal|db-shm|db-journal|sqlite|sqlite3)$' +
  '|\\(Thumbs\.db|desktop\.ini|\.DS_Store|4913)$|~\$|\\\.#|~$'

# ---- one watcher per main folder + one for the top-level files -----------------------------------------------------------
$skipFolders = @('node_modules', '.git', 'dist', 'dist-ssr', 'build', 'coverage', '.vite', 'logs', 'uploads', 'backups', '.vscode', '.idea')
$areas = @()
Get-ChildItem -LiteralPath $Root -Directory -Force | Where-Object { $skipFolders -notcontains $_.Name -and $_.Name -notlike '.teamlink-*' } | ForEach-Object {
  $areas += @{ Name = $_.Name; Path = $_.FullName; Recurse = $true }
}
$areas += @{ Name = 'root-files'; Path = $Root; Recurse = $false }   # top-level files only

$watchers = @()
foreach ($a in $areas) {
  $w = New-Object System.IO.FileSystemWatcher
  $w.Path = $a.Path
  $w.IncludeSubdirectories = $a.Recurse
  $w.NotifyFilter = [IO.NotifyFilters]'FileName, DirectoryName, LastWrite'
  foreach ($ev in 'Changed', 'Created', 'Deleted', 'Renamed') {
    Register-ObjectEvent -InputObject $w -EventName $ev -SourceIdentifier ("ws-{0}-{1}" -f $a.Name, $ev) | Out-Null
  }
  $w.EnableRaisingEvents = $true
  $watchers += $w
  Write-Host ("  [{0}] reading {1}" -f $a.Name, $a.Path) -ForegroundColor DarkCyan
}
Write-Host ""
$branch0 = Get-Branch
Write-Host "$($watchers.Count) watchers running for '$Project'." -ForegroundColor Green
Write-Host "Syncing branch '$branch0' with $Remote ($remoteUrl)." -ForegroundColor Green
Write-Host "Saves are pushed after ${QuietSeconds}s of quiet. GitHub is pulled every ${PullSeconds}s. Close this window to stop." -ForegroundColor Green
Write-Host ""

# ---- does a staged file name look like a secret? (templates *.example are allowed) --------------------------------------------
function Test-Secret([string]$name) {
  $n = $name -replace '\\', '/'
  if ($n -match '(^|/)\.env($|\.)' -and $n -notmatch '(^|/)\.env(\.[^/]+)?\.example$') { return $true }
  if ($n -match '\.(pem|key|p12|pfx)$') { return $true }
  return $false
}

function Sync-Up {
  $branch = Get-Branch
  if (-not $branch) { Say "Not syncing: git is not on a branch (detached HEAD)." 'Red'; return }

  $changes = git status --porcelain 2>$null
  if ($changes) {
    git add -A 2>$null
    $staged = @(git -c core.quotepath=false diff --cached --name-only 2>$null | Where-Object { $_ })
    if ($staged.Count -gt 0) {
      # 1. never commit a secret
      $secrets = @($staged | Where-Object { Test-Secret $_ })
      if ($secrets.Count -gt 0) {
        git reset -q 2>$null
        Say "NOT syncing - these files look like secrets:" 'Red'
        $secrets | ForEach-Object { Write-Host "      $_" -ForegroundColor Red }
        Write-Host "      Add them to .gitignore (or delete them). Nothing was committed." -ForegroundColor Yellow
        return
      }
      # 2. a huge batch is held back (first sync of a long-open folder, or something copied in by mistake)
      if ($staged.Count -gt $MaxFiles -and -not $AllowBig) {
        git reset -q 2>$null
        Say "HELD BACK: $($staged.Count) files would go in one commit (limit $MaxFiles). Look at 'git status', then start once with -AllowBig." 'Yellow'
        return
      }
      # 3. commit
      $names = @($staged | ForEach-Object { Split-Path $_ -Leaf })
      $summary = ($names | Select-Object -First 3) -join ', '
      if ($names.Count -gt 3) { $summary += ", +$($names.Count - 3) more" }
      git commit -q -m "Auto-sync: $summary" 2>$null
      if ($LASTEXITCODE -ne 0) { Say "Commit failed (is a git hook or identity missing?). Nothing was pushed." 'Red'; return }
      Say "Committed $($names.Count) file(s): $summary" 'Cyan'
    }
  }

  # 4. bring in what others pushed, on top of ours (only when the branch exists on the remote)
  git fetch -q $Remote $branch 2>$null
  $remoteHas = ($LASTEXITCODE -eq 0)
  if ($remoteHas) {
    git pull -q --rebase $Remote $branch 2>$null
    if ($LASTEXITCODE -ne 0) {
      git rebase --abort 2>$null
      Say "CONFLICT with GitHub on '$branch'. Your commit is safe locally; nothing was pushed. Resolve it by hand (git pull --rebase), then save a file." 'Red'
      return
    }
  }

  # 5. push (nothing to push = quiet)
  $ahead = 1
  if ($remoteHas) { $ahead = [int](git rev-list --count "$Remote/$branch..HEAD" 2>$null) }
  if ($ahead -le 0) { return }
  if ($remoteHas) { git push -q $Remote $branch 2>$null } else { git push -q -u $Remote $branch 2>$null }
  if ($LASTEXITCODE -eq 0) { Say "Pushed $ahead commit(s) to $Remote/$branch." 'Green'; $script:pushPending = $false }
  else { Say "Push failed (offline?). It will be retried on the next change." 'Yellow'; $script:pushPending = $true }
}

function Sync-Down {
  $branch = Get-Branch
  if (-not $branch) { return }
  git fetch -q $Remote $branch 2>$null
  if ($LASTEXITCODE -ne 0) { return }
  $behind = [int](git rev-list --count "HEAD..$Remote/$branch" 2>$null)
  if ($behind -gt 0) {
    git pull -q --rebase --autostash $Remote $branch 2>$null
    if ($LASTEXITCODE -eq 0) { Say "Pulled $behind commit(s) from GitHub ($branch)." 'Magenta' }
    else {
      git rebase --abort 2>$null
      Say "Could not pull from GitHub (conflict). Nothing was changed here. Resolve it by hand." 'Red'
    }
  } elseif ($script:pushPending) {
    $script:pushPending = $false
    Sync-Up
  }
}

# ---- main loop: debounce the watcher events, sync up on quiet, pull down on a timer ------------------------------------------
$script:pushPending = $false
$lastChange = $null
$lastPull = Get-Date

try {
  while ($true) {
    $events = @(Get-Event -ErrorAction SilentlyContinue | Where-Object { $_.SourceIdentifier -like 'ws-*' })
    foreach ($e in $events) {
      $p = $e.SourceEventArgs.FullPath
      Remove-Event -EventIdentifier $e.EventIdentifier -ErrorAction SilentlyContinue
      if ($p -and ($p -notmatch $excludeRe)) {
        if (-not $lastChange) { Say ("change: {0}  (syncing after {1}s of quiet)" -f (Split-Path $p -Leaf), $QuietSeconds) 'DarkGray' }
        $lastChange = Get-Date
      }
    }
    if ($lastChange -and ((Get-Date) - $lastChange).TotalSeconds -ge $QuietSeconds) {
      $lastChange = $null
      Sync-Up
    }
    if (((Get-Date) - $lastPull).TotalSeconds -ge $PullSeconds) {
      $lastPull = Get-Date
      Sync-Down
    }
    Start-Sleep -Milliseconds 1000
  }
}
finally {
  foreach ($w in $watchers) { $w.EnableRaisingEvents = $false; $w.Dispose() }
  Get-EventSubscriber | Where-Object { $_.SourceIdentifier -like 'ws-*' } | Unregister-Event -ErrorAction SilentlyContinue
  try { $script:syncMutex.ReleaseMutex() } catch { }
}
