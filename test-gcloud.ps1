$gcloudExe = "C:\Users\admin\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
Write-Host "Testing path: $gcloudExe"
Write-Host "Exists: $(Test-Path $gcloudExe)"

$tempOut = [System.IO.Path]::GetTempFileName()
$tempErr = [System.IO.Path]::GetTempFileName()

$cmdLine = "`"$gcloudExe`" --version"
Write-Host "CMD line: $cmdLine"

$process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmdLine -NoNewWindow `
    -RedirectStandardOutput $tempOut -RedirectStandardError $tempErr -Wait -PassThru

if ($process) {
    Write-Host "Exit code: $($process.ExitCode)"
    $stdout = Get-Content $tempOut -Raw -Encoding UTF8
    Write-Host "STDOUT: $stdout"
} else {
    Write-Host "Process was null!"
}

Remove-Item $tempOut -Force -EA SilentlyContinue
Remove-Item $tempErr -Force -EA SilentlyContinue
