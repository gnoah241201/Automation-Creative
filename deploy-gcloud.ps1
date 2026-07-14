[CmdletBinding()]
param(
    [string]$ProjectId = "",
    [string]$Region = "asia-southeast1",
    [string]$Zone = "asia-southeast1-b",
    [string]$InstanceName = "resize-video",
    [string]$MachineType = "e2-standard-2",
    [int]$BootDiskSizeGb = 50,
    [string]$BootDiskType = "pd-balanced",
    [string]$ImageFamily = "ubuntu-2204-lts",
    [string]$ImageProject = "ubuntu-os-cloud",
    [string]$Network = "default",
    [string]$Subnet = "default",
    [string]$AddressName = "resize-video-ip",
    [string]$FirewallRuleName = "allow-http-resize-video",
    [string]$TargetTag = "http-server",
    [string]$SourceRanges = "0.0.0.0/0",
    [string]$StartupScriptPath = "",
    [string]$AppName = "resize-video",
    [string]$AppDir = "/opt/resize-video",
    [string]$AppUser = "resizevideo",
    [string]$RepoUrl = "https://github.com/gnoah241201/ResizeVideo.git",
    [string]$RepoRef = "main",
    [string]$NodeMajor = "20",
    [string]$AppPort = "3001",
    [string]$MaxConcurrentJobs = "5",
    [string]$FfmpegBinaryPath = "/usr/bin/ffmpeg",
    [string]$FfmpegEncoder = "libx264",
    [string]$AppUrl = "",
    [switch]$EnableOsLogin,
    [switch]$AllowHttps,
    [switch]$Recreate,
    [switch]$SkipApiEnable
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Get-GcloudCommand {
    $gcloudCmd = Get-Command gcloud -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gcloudCmd) {
        $altPath = "C:\Users\admin\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
        if (Test-Path $altPath) {
            return $altPath
        }
    }
    return $gcloudCmd.Source
}

function Assert-Command {
    param([string]$Name)
    $gcloudPath = Get-GcloudCommand
    if ([string]::IsNullOrWhiteSpace($gcloudPath)) {
        throw "Required command not found: $Name. Please ensure Google Cloud SDK is installed and in your PATH."
    }
}

function Invoke-Gcloud {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$CaptureOutput,
        [switch]$IgnoreErrors
    )

    $gcloudExe = Get-GcloudCommand
    Write-Host (("gcloud " + ($Arguments -join " "))) -ForegroundColor DarkGray

    # Temporarily set ErrorAction to Continue so gcloud's [environment: untagged] stderr
    # does not become a PowerShell terminating error.
    $prevErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & $gcloudExe @Arguments 2>&1
    }
    finally {
        $ErrorActionPreference = $prevErrorAction
    }
    $exitCode = $LASTEXITCODE
    $exitCode = $LASTEXITCODE

    # Split into stdout and stderr lines. Lines with [environment: untagged] are stderr.
    $stdoutLines = @()
    $stderrLines = @()
    foreach ($line in $output) {
        if ($line -is [System.Management.Automation.ErrorRecord]) {
            $stderrLines += $line.ToString()
        } elseif ($line -match '\[environment: untagged\]') {
            $stderrLines += $line
        } else {
            $stdoutLines += $line
        }
    }

    $stdoutText = $stdoutLines -join "`n"
    $stderrText = $stderrLines -join "`n"

    if (-not $IgnoreErrors -and $exitCode -ne 0) {
        if ($stdoutText) { Write-Host ("STDOUT:`n" + $stdoutText) -ForegroundColor Red }
        if ($stderrText) { Write-Host ("STDERR:`n" + $stderrText) -ForegroundColor Red }
        throw "gcloud command failed with exit code $exitCode"
    }

    if ($CaptureOutput) {
        return $stdoutText
    }

    if ($stdoutText) {
        Write-Host $stdoutText
    }
}

function Test-GcloudResource {
    param([string[]]$Arguments)
    $gcloudExe = Get-GcloudCommand
    $prevErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "SilentlyContinue"
        $null = & $gcloudExe @Arguments 2>$null
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            $output = & $gcloudExe @Arguments 2>&1
            $hasBenignWarning = $output | Where-Object { $_ -match '\[environment: untagged\]' }
            if ($hasBenignWarning) {
                $exitCode = 0
            }
        }
        return $exitCode -eq 0
    }
    finally {
        $ErrorActionPreference = $prevErrorAction
    }
}

function New-MetadataArgument {
    param(
        [string]$ReservedIp,
        [string]$ExplicitAppUrl
    )

    $resolvedAppUrl = $ExplicitAppUrl
    if ([string]::IsNullOrWhiteSpace($resolvedAppUrl)) {
        $resolvedAppUrl = "http://$ReservedIp"
    }

    $items = [ordered]@{
        "app-name" = $AppName
        "app-dir" = $AppDir
        "app-user" = $AppUser
        "repo-url" = $RepoUrl
        "repo-ref" = $RepoRef
        "node-major" = $NodeMajor
        "app-port" = $AppPort
        "max-concurrent-jobs" = $MaxConcurrentJobs
        "ffmpeg-binary-path" = $FfmpegBinaryPath
        "ffmpeg-encoder" = $FfmpegEncoder
        "app-url" = $resolvedAppUrl
    }

    return (($items.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ",")
}

$resolvedGcloud = Get-GcloudCommand
if ([string]::IsNullOrWhiteSpace($resolvedGcloud)) {
    throw "gcloud not found. Please install Google Cloud SDK: https://cloud.google.com/sdk/docs/install"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($StartupScriptPath)) {
    $StartupScriptPath = Join-Path $scriptDir "vm-startup.sh"
}

if (-not (Test-Path -LiteralPath $StartupScriptPath)) {
    throw "Startup script not found: $StartupScriptPath"
}

$StartupScriptPath = (Resolve-Path -LiteralPath $StartupScriptPath).Path

if (-not [string]::IsNullOrWhiteSpace($ProjectId)) {
    Write-Step "Setting active gcloud project"
    Invoke-Gcloud -Arguments @("config", "set", "project", $ProjectId)
}

$activeProject = Invoke-Gcloud -Arguments @("config", "get-value", "project") -CaptureOutput
if ([string]::IsNullOrWhiteSpace($activeProject) -or $activeProject -eq "(unset)") {
    throw "No active gcloud project. Pass -ProjectId or run: gcloud config set project YOUR_PROJECT_ID"
}

Write-Host "Project: $activeProject"
Write-Host "Region : $Region"
Write-Host "Zone   : $Zone"
Write-Host "HTTP ingress source ranges: $SourceRanges"

if (-not $SkipApiEnable) {
    Write-Step "Enabling required Google Cloud APIs"
    Invoke-Gcloud -Arguments @(
        "services", "enable",
        "compute.googleapis.com",
        "iam.googleapis.com"
    )
}

Write-Step "Ensuring reserved static external IP exists"
$addressExists = Test-GcloudResource -Arguments @(
    "compute", "addresses", "describe", $AddressName,
    "--region=$Region"
)

if (-not $addressExists) {
    Invoke-Gcloud -Arguments @(
        "compute", "addresses", "create", $AddressName,
        "--region=$Region"
    )
}

$reservedIp = Invoke-Gcloud -Arguments @(
    "compute", "addresses", "describe", $AddressName,
    "--region=$Region",
    "--format=get(address)"
) -CaptureOutput

if ([string]::IsNullOrWhiteSpace($reservedIp)) {
    throw "Could not resolve static IP for address: $AddressName"
}

Write-Host "Reserved IP: $reservedIp" -ForegroundColor Green

$metadataArg = New-MetadataArgument -ReservedIp $reservedIp -ExplicitAppUrl $AppUrl
Write-Host "App repo     : $RepoUrl#$RepoRef"
Write-Host "App URL      : $(if ([string]::IsNullOrWhiteSpace($AppUrl)) { "http://$reservedIp" } else { $AppUrl })"
Write-Host "Node major   : $NodeMajor"
Write-Host "App port     : $AppPort"
Write-Host "Max jobs     : $MaxConcurrentJobs"

Write-Step "Ensuring HTTP firewall rule exists"
$firewallExists = Test-GcloudResource -Arguments @(
    "compute", "firewall-rules", "describe", $FirewallRuleName
)

if (-not $firewallExists) {
    Invoke-Gcloud -Arguments @(
        "compute", "firewall-rules", "create", $FirewallRuleName,
        "--direction=INGRESS",
        "--priority=1000",
        "--network=$Network",
        "--action=ALLOW",
        "--rules=tcp:80",
        "--source-ranges=$SourceRanges",
        "--target-tags=$TargetTag"
    )
}
else {
    Write-Host "Firewall rule already exists: $FirewallRuleName"
    Write-Host "If you need to restrict access to company CIDRs only, update the rule manually or rerun with a different rule name + -SourceRanges." -ForegroundColor Yellow
}

if ($AllowHttps) {
    $httpsRuleName = "$FirewallRuleName-https"
    Write-Step "Ensuring optional HTTPS firewall rule exists"
    $httpsRuleExists = Test-GcloudResource -Arguments @(
        "compute", "firewall-rules", "describe", $httpsRuleName
    )

    if (-not $httpsRuleExists) {
        Invoke-Gcloud -Arguments @(
            "compute", "firewall-rules", "create", $httpsRuleName,
            "--direction=INGRESS",
            "--priority=1000",
            "--network=$Network",
            "--action=ALLOW",
            "--rules=tcp:443",
            "--source-ranges=$SourceRanges",
            "--target-tags=$TargetTag"
        )
    }
}

Write-Step "Checking instance state"
$instanceExists = Test-GcloudResource -Arguments @(
    "compute", "instances", "describe", $InstanceName,
    "--zone=$Zone"
)

if ($instanceExists -and $Recreate) {
    Write-Step "Deleting existing instance because -Recreate was specified"
    Invoke-Gcloud -Arguments @(
        "compute", "instances", "delete", $InstanceName,
        "--zone=$Zone",
        "--quiet"
    )
    $instanceExists = $false
}

if (-not $instanceExists) {
    Write-Step "Creating Compute Engine VM"
    $createArgs = @(
        "compute", "instances", "create", $InstanceName,
        "--zone=$Zone",
        "--machine-type=$MachineType",
        "--network=$Network",
        "--subnet=$Subnet",
        "--address=$reservedIp",
        "--tags=$TargetTag",
        "--image-family=$ImageFamily",
        "--image-project=$ImageProject",
        "--boot-disk-size=$($BootDiskSizeGb)GB",
        "--boot-disk-type=$BootDiskType",
        "--metadata=$metadataArg",
        "--metadata-from-file=startup-script=`"$StartupScriptPath`""
    )

    if ($EnableOsLogin) {
        $createArgs += "--metadata=enable-oslogin=TRUE"
    }

    Invoke-Gcloud -Arguments $createArgs
}
else {
    Write-Host "Instance already exists: $InstanceName" -ForegroundColor Yellow
    Write-Host "Skipping create. Use -Recreate to replace it." -ForegroundColor Yellow
}

Write-Step "Fetching instance details"
$instanceIp = Invoke-Gcloud -Arguments @(
    "compute", "instances", "describe", $InstanceName,
    "--zone=$Zone",
    "--format=get(networkInterfaces[0].accessConfigs[0].natIP)"
) -CaptureOutput

if ([string]::IsNullOrWhiteSpace($instanceIp)) {
    $instanceIp = $reservedIp
}

$sshCommand = "gcloud compute ssh $InstanceName --zone=$Zone"
$healthUrl = "http://$instanceIp/api/health"
$siteUrl = "http://$instanceIp"

Write-Step "Done"
Write-Host "VM Name      : $InstanceName" -ForegroundColor Green
Write-Host "External IP  : $instanceIp" -ForegroundColor Green
Write-Host "Website URL  : $siteUrl" -ForegroundColor Green
Write-Host "Health URL   : $healthUrl" -ForegroundColor Green
Write-Host "SSH          : $sshCommand" -ForegroundColor Green

Write-Host "`nNext checks:" -ForegroundColor Cyan
Write-Host "1. SSH in and tail setup log: sudo tail -f /var/log/resize-video-setup.log"
Write-Host "2. Verify backend: curl http://localhost:3001/api/health"
Write-Host "3. Verify PM2: pm2 status"
Write-Host "4. Verify nginx: sudo nginx -t && sudo systemctl status nginx --no-pager"

Write-Host "`nHTTP/non-HTTPS note:" -ForegroundColor Cyan
Write-Host "- This script opens port 80 so the app is reachable from the public internet, including your company network in normal conditions."
Write-Host "- If your company proxy/firewall blocks plain HTTP sites, Cloud CLI setup cannot override that policy. In that case you will need HTTPS, VPN, or company allowlisting."
Write-Host "- If you want only company-network access, rerun with -SourceRanges using your company public CIDR(s)."
