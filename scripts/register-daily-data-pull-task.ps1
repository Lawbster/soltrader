param(
  [string]$TaskName = "sol-trader-daily-data-pull",
  [string]$RunAt = "00:00",
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$SshKeyPath = "$HOME/.ssh/id_ed25519",
  [string]$SshHost = "46.225.80.0",
  [string]$User = "deploy",
  [string]$RemotePath = "/opt/sol-trader/data/",
  [switch]$AcceptNewHostKey
)

$ErrorActionPreference = "Stop"

$pullScript = Join-Path $ProjectRoot "scripts\pull-vps-data.ps1"
if (-not (Test-Path -Path $pullScript)) {
  throw "Pull script not found: $pullScript"
}

$taskArgs = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$pullScript`"",
  "-ProjectRoot", "`"$ProjectRoot`"",
  "-SshKeyPath", "`"$SshKeyPath`"",
  "-SshHost", "`"$SshHost`"",
  "-User", "`"$User`"",
  "-RemotePath", "`"$RemotePath`""
)

if ($AcceptNewHostKey) {
  $taskArgs += "-AcceptNewHostKey"
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument ($taskArgs -join " ") `
  -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -Daily -At $RunAt

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

# Re-register if it already exists.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Daily pull of /opt/sol-trader/data from VPS into local sol-trader workspace."

Write-Host "Scheduled task registered: $TaskName"
Write-Host "Runs daily at: $RunAt"
Write-Host "To run immediately:"
Write-Host "  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Host "To inspect:"
Write-Host "  Get-ScheduledTask -TaskName `"$TaskName`" | Get-ScheduledTaskInfo"
