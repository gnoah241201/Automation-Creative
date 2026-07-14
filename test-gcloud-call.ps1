$gcloudExe = "C:\Users\admin\AppData\Local\Google Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
Write-Host "Testing call approach"
$tempOut = [System.IO.Path]::GetTempFileName()
$tempErr = [System.IO.Path]::GetTempFileName()
$cmdLine = "call `"$gcloudExe`" config set project central-cinema-327608"
Write-Host "CMD: $cmdLine"
$process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmdLine -NoNewWindow `
    -RedirectStandardOutput $tempOut -RedirectStandardError $tempErr -Wait -PassThru
if ($process) {
    Write-Host "Exit code: $($process.ExitCode)"
    $stdout = Get-Content $tempOut -Raw -Encoding UTF8
    $stderr = Get-Content $tempErr -Raw -Encoding UTF8
    Write-Host "STDOUT: $stdout"
    Write-Host "STDERR: $stderr"
} else {
    Write-Host "Process was null!"
}
Remove-Item $tempOut -Force -EA SilentlyContinue
Remove-Item $tempErr -Force -EA SilentlyContinue
