# Registers the hourly NaukriProfileRefresh scheduled task in Windows
$repo = $PSScriptRoot
$nodePath = (Get-Command node.exe).Source

Write-Host "Registering NaukriProfileRefresh Task..." -ForegroundColor Cyan
Write-Host "Repo Directory: $repo"
Write-Host "Node Executable: $nodePath"

$action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$repo\naukri-profile-refresh.js`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName "NaukriProfileRefresh" -Action $action -Trigger $trigger -Settings $settings -Force

Write-Host "Task successfully registered! Status:" -ForegroundColor Green
Get-ScheduledTask -TaskName "NaukriProfileRefresh"
