$path = "C:\Program Files\test file.txt"
Write-Host "Path: $path"
Write-Host "Exists: $(Test-Path $path)"

$tempBat = [System.IO.Path]::GetTempFileName() + ".bat"
$batContent = "echo hello from batch" 
Set-Content -Path $tempBat -Value $batContent -Encoding ASCII
Write-Host "Bat file: $tempBat"
Write-Host "Bat exists: $(Test-Path $tempBat)"

$tempOut = [System.IO.Path]::GetTempFileName()
$cmdLine = "`"$tempBat`""
Write-Host "CMD: $cmdLine"

$process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmdLine -NoNewWindow `
    -RedirectStandardOutput $tempOut -Wait -PassThru
if ($process) {
    Write-Host "Exit code: $($process.ExitCode)"
    $stdout = Get-Content $tempOut -Raw -Encoding UTF8
    Write-Host "STDOUT: $stdout"
}
Remove-Item $tempBat -Force -EA SilentlyContinue
Remove-Item $tempOut -Force -EA SilentlyContinue
