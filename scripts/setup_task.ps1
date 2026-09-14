# setup_task.ps1
# Registers a Windows Task Scheduler job to run the NSE OI daily update
# every weekday at 6:45 PM (local time — set your PC timezone to IST).
# Run once with:  npm run setup:task

$TaskName   = 'OI-Lens-Daily-NSE-Update'
$ProjectDir = Split-Path -Parent $PSScriptRoot

# Remove previous registration if it exists
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$NpmPath = (Get-Command npm -ErrorAction Stop).Source

$Action = New-ScheduledTaskAction `
    -Execute $NpmPath `
    -Argument 'run daily:update' `
    -WorkingDirectory $ProjectDir

# Mon–Fri at 6:45 PM, after official EOD publication
$Trigger = New-ScheduledTaskTrigger `
    -Weekly `
    -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday `
    -At '6:45PM'

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description 'Imports official NSE EOD data into remote Cloudflare D1 and updates the prospective research ledger.' `
    -Force | Out-Null

Write-Host "Task '$TaskName' registered. Runs Monday-Friday at 6:45 PM." -ForegroundColor Green
Write-Host 'Verify in Task Scheduler > Task Scheduler Library.' -ForegroundColor Cyan
