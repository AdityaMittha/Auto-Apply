$repo = $PSScriptRoot
Set-Location $repo

$EC2_IP = "13.234.182.177"
$KEY_FILE = "$repo\auto-apply-key.pem"
$EC2_USER = "ec2-user"
$REMOTE_DIR = "/home/ec2-user/Auto-Apply"

if (Test-Path "$repo\.deploy-info") {
    Get-Content "$repo\.deploy-info" | ForEach-Object {
        if ($_ -match "DEPLOY_IP=(.*)") { $global:EC2_IP = $matches[1].Trim() }
    }
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Auto-Apply Data Transfer to EC2: $EC2_IP" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Code & Config & Dashboard UI
Write-Host "`n[1/5] Uploading code (*.js, package.json, .env, public/)..." -ForegroundColor Yellow
scp -o StrictHostKeyChecking=no -i $KEY_FILE *.js package.json .env applied-jobs.json "${EC2_USER}@${EC2_IP}:${REMOTE_DIR}/"
if (Test-Path "$repo\public") {
    scp -o StrictHostKeyChecking=no -r -i $KEY_FILE "$repo\public" "${EC2_USER}@${EC2_IP}:${REMOTE_DIR}/"
}

# 2. Resumes
Write-Host "`n[2/5] Uploading resumes..." -ForegroundColor Yellow
if (Test-Path "$repo\resume") {
    scp -o StrictHostKeyChecking=no -r -i $KEY_FILE "$repo\resume" "${EC2_USER}@${EC2_IP}:${REMOTE_DIR}/"
}

# 3. Chrome Profiles
Write-Host "`n[3/5] Uploading all 6 Chrome Profiles..." -ForegroundColor Yellow
$profiles = @(
    ".naukri-chrome-profile",
    ".internshala-chrome-profile",
    ".linkedin-chrome-profile",
    ".indeed-chrome-profile",
    ".wellfound-chrome-profile",
    ".foundit-chrome-profile"
)

foreach ($p in $profiles) {
    $dirPath = Join-Path $repo $p
    if (Test-Path $dirPath) {
        Write-Host "   Compressing $p..." -ForegroundColor Green
        $tarFile = Join-Path $repo "$p.tar.gz"
        tar.exe -czf $tarFile --exclude="*Cache*" --exclude="*Crashpad*" --exclude="*.pma" --exclude="*BrowserMetrics*" -C $repo $p
        scp -o StrictHostKeyChecking=no -i $KEY_FILE $tarFile "${EC2_USER}@${EC2_IP}:/tmp/"
        ssh -o StrictHostKeyChecking=no -i $KEY_FILE "${EC2_USER}@${EC2_IP}" "cd ${REMOTE_DIR} && tar -xzf /tmp/$p.tar.gz && rm -f /tmp/$p.tar.gz"
        Remove-Item $tarFile -Force -ErrorAction SilentlyContinue
        Write-Host "   Uploaded $p" -ForegroundColor Green
    }
}

# 4. Server scripts
Write-Host "`n[4/5] Uploading shell scripts..." -ForegroundColor Yellow
scp -o StrictHostKeyChecking=no -i $KEY_FILE *.sh "${EC2_USER}@${EC2_IP}:${REMOTE_DIR}/"
ssh -o StrictHostKeyChecking=no -i $KEY_FILE "${EC2_USER}@${EC2_IP}" "cd ${REMOTE_DIR} && chmod +x *.sh"

Write-Host "`n==========================================" -ForegroundColor Green
Write-Host "Transfer Complete! All profiles and code synced to EC2." -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
