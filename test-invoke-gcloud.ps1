function Get-GcloudCommand {
    $gcloudCmd = Get-Command gcloud -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gcloudCmd) {
        $altPath = "C:\Users\admin\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
        if (Test-Path $altPath) {
            return $altPath
        }
    }
    if ($gcloudCmd) {
        return $gcloudCmd.Source
    }
    return $null
}

function Invoke-Gcloud {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$CaptureOutput,
        [switch]$IgnoreErrors
    )

    $gcloudExe = Get-GcloudCommand
    if ([string]::IsNullOrWhiteSpace($gcloudExe)) {
        throw "gcloud executable not found. Please install Google Cloud SDK."
    }

    Write-Host (("gcloud " + ($Arguments -join " "))) -ForegroundColor DarkGray

    $argString = $Arguments -join " "
    $cmdLine = """$gcloudExe"" $argString"

    $tempOut = [System.IO.Path]::GetTempFileName()
    $tempErr = [System.IO.Path]::GetTempFileName()

    try {
        $process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmdLine -NoNewWindow `
            -RedirectStandardOutput $tempOut -RedirectStandardError $tempErr -Wait -PassThru

        if (-not $process) {
            throw "Failed to start gcloud process"
        }

        $exitCode = $process.ExitCode

        if (Test-Path $tempOut) { $stdoutContent = Get-Content $tempOut -Raw -Encoding UTF8 } else { $stdoutContent = "" }
        if (Test-Path $tempErr) { $stderrContent = Get-Content $tempErr -Raw -Encoding UTF8 } else { $stderrContent = "" }

        $realStderr = $stderrContent -split "`n" | Where-Object {
            $_ -notmatch '\[environment: untagged\]' -and
            $_ -notmatch 'Read more to tag' -and
            $_.Trim() -ne ""
        }

        if (-not $IgnoreErrors -and $exitCode -ne 0) {
            Write-Host ("STDOUT:`n" + $stdoutContent) -ForegroundColor Red
            Write-Host ("STDERR:`n" + $stderrContent) -ForegroundColor Red
            throw "gcloud command failed with exit code $exitCode"
        }

        if ($CaptureOutput) {
            return $stdoutContent.Trim()
        }

        $realOutput = $stdoutContent.Trim()
        if ($realStderr -and ($realStderr | Measure-Object).Count -gt 0) {
            $realOutput = $realOutput + "`n" + ($realStderr -join "`n")
        }
        if ($realOutput) {
            Write-Host $realOutput
        }
    }
    finally {
        Remove-Item $tempOut -Force -EA SilentlyContinue
        Remove-Item $tempErr -Force -EA SilentlyContinue
    }
}

$resolvedGcloud = Get-GcloudCommand
Write-Host "Resolved gcloud: $resolvedGcloud"
Write-Host "Exists: $(Test-Path $resolvedGcloud)"

Write-Step "Setting active gcloud project"
Invoke-Gcloud -Arguments @("config", "set", "project", "central-cinema-327608")

$activeProject = Invoke-Gcloud -Arguments @("config", "get-value", "project") -CaptureOutput
Write-Host "Active project: $activeProject"
