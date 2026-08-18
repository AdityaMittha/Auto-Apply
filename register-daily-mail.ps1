# Registers the daily 8:00 PM email report task in Windows Task Scheduler
$repo = $PSScriptRoot
$nodePath = (Get-Command node.exe).Source

Write-Host "Registering DailyApplicationReport Task..." -ForegroundColor Cyan
Write-Host "Repo Directory: $repo"
Write-Host "Node Executable: $nodePath"

$action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$repo\mailer.js`"" -WorkingDirectory $repo
# Trigger daily at 8:00 PM
$trigger = New-ScheduledTaskTrigger -Daily -At "8:00PM"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName "DailyApplicationReport" -Action $action -Trigger $trigger -Settings $settings -Force

Write-Host "Daily mailer task successfully registered! Status:" -ForegroundColor Green
Get-ScheduledTask -TaskName "DailyApplicationReport"
