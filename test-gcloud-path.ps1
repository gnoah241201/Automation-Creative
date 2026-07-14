$path = "C:\Users\admin\AppData\Local\Google Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
Write-Host "Testing: cmd /c call"
$tempOut = [System.IO.Path]::GetTempFileName()
$cmdLine = "call `"$path`" --version"
Write-Host "CMD: $cmdLine"
$process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmdLine -NoNewWindow `
    -RedirectStandardOutput $tempOut -Wait -PassThru
if ($process) {
    Write-Host "Exit code: $($process.ExitCode)"
    $stdout = Get-Content $tempOut -Raw -Encoding UTF8
    Write-Host "STDOUT: $stdout"
} else {
    Write-Host "Process was null!"
}
Remove-Item $tempOut -Force -EA SilentlyContinue

Write-Host "---"

# Test: cmd /c without call
Write-Host "Testing: cmd /c direct"
$tempOut2 = [System.IO.Path]::GetTempFileName()
$cmdLine2 = "`"$path`" --version"
Write-Host "CMD: $cmdLine2"
$process2 = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmdLine2 -NoNewWindow `
    -RedirectStandardOutput $tempOut2 -Wait -PassThru
if ($process2) {
    Write-Host "Exit code: $($process2.ExitCode)"
    $stdout2 = Get-Content $tempOut2 -Raw -Encoding UTF8
    Write-Host "STDOUT: $stdout2"
} else {
    Write-Host "Process was null!"
}
Remove-Item $tempOut2 -Force -EA SilentlyContinue
