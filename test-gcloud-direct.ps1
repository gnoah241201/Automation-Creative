$gcloudPath = "C:\Users\admin\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$gcloudArgs = @("config", "set", "project", "central-cinema-327608")
$output = & $gcloudPath @gcloudArgs 2>&1
$exitCode = $LASTEXITCODE
Write-Host "EXIT: $exitCode"
Write-Host "OUTPUT:"
$output | ForEach-Object { Write-Host $_ }
