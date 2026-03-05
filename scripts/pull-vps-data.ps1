param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$SshHost = "46.225.80.0",
  [string]$User = "deploy",
  [string]$RemotePath = "/opt/sol-trader/data/",
  [string]$SshKeyPath = "$HOME/.ssh/id_ed25519",
  [switch]$AcceptNewHostKey
)

$ErrorActionPreference = "Stop"

function Write-Info([string]$Message) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Host "[$ts] $Message"
}

if (-not (Test-Path -Path $ProjectRoot)) {
  throw "ProjectRoot does not exist: $ProjectRoot"
}

if (-not (Test-Path -Path $SshKeyPath)) {
  throw "SSH key not found: $SshKeyPath"
}

$scp = Get-Command scp -ErrorAction Stop

$logDir = Join-Path $ProjectRoot "logs"
if (-not (Test-Path -Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$logFile = Join-Path $logDir "data-pull-$stamp.log"

$scpArgs = @("-r", "-i", $SshKeyPath)
if ($AcceptNewHostKey) {
  $scpArgs += @("-o", "StrictHostKeyChecking=accept-new")
}
$scpArgs += @("$User@$SshHost`:$RemotePath", ".")

Write-Info "Starting VPS data pull..."
Write-Info "ProjectRoot: $ProjectRoot"
Write-Info "Remote: $User@$SshHost`:$RemotePath"
Write-Info "Log: $logFile"

Push-Location $ProjectRoot
try {
  & $scp.Source @scpArgs 2>&1 | Tee-Object -FilePath $logFile -Append
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed with exit code $LASTEXITCODE"
  }
  Write-Info "Data pull completed successfully."
}
finally {
  Pop-Location
}
