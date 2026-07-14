[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VmHost,

    [Parameter(Mandatory = $true)]
    [string]$VmUser,

    [string]$VmPort = "22",
    [string]$RemoteDir = "",
    [switch]$RunRemoteExtract
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

function Assert-LastExitCode {
    param([string]$Step)
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE"
    }
}

Assert-Command -Name "ssh"
Assert-Command -Name "scp"
Assert-Command -Name "tar"

if ([string]::IsNullOrWhiteSpace($RemoteDir)) {
    $RemoteDir = "/home/$VmUser/resize-video"
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectName = Split-Path -Leaf $projectRoot
$archiveName = "$projectName-$(Get-Date -Format 'yyyyMMdd-HHmmss').tar.gz"
$archivePath = Join-Path $env:TEMP $archiveName

Write-Step "Creating project archive (excluding heavy/unnecessary paths)"
Push-Location $projectRoot
try {
    if (Test-Path $archivePath) {
        Remove-Item -Force $archivePath
    }

    $tarArgs = @(
        "-czf", $archivePath,
        "--exclude", ".git",
        "--exclude", "node_modules",
        "--exclude", "dist",
        "--exclude", "ResizeVideo-1.1.5",
        "--exclude", "*.log",
        "."
    )
    & tar @tarArgs
}
finally {
    Pop-Location
}

Write-Step "Ensuring remote directory exists"
ssh -p $VmPort "$VmUser@$VmHost" "mkdir -p '$RemoteDir'"
Assert-LastExitCode -Step "Ensure remote directory"

Write-Step "Uploading archive to VM"
$remoteArchive = "$RemoteDir/$archiveName"
scp -P $VmPort $archivePath "${VmUser}@${VmHost}:$remoteArchive"
Assert-LastExitCode -Step "Upload archive"

if ($RunRemoteExtract) {
    Write-Step "Extracting archive on VM"
    ssh -p $VmPort "$VmUser@$VmHost" "cd '$RemoteDir' && tar -xzf '$remoteArchive' && rm -f '$remoteArchive'"
    Assert-LastExitCode -Step "Extract archive"

    Write-Step "Done"
    Write-Host "Project extracted at: $RemoteDir"
    Write-Host "Next: ssh $VmUser@$VmHost -p $VmPort"
    Write-Host "Then run: cd $RemoteDir; sudo docker compose up --build -d"
}
else {
    Write-Step "Upload completed"
    Write-Host "Archive uploaded to: $remoteArchive"
    Write-Host "Next: ssh $VmUser@$VmHost -p $VmPort"
    Write-Host "Then run: cd $RemoteDir; tar -xzf $archiveName; rm -f $archiveName"
}
