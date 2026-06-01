# RSN - local DB backup script
# Dumps the live Neon Postgres DB to a sibling folder OUTSIDE the repo.
# Output is plaintext SQL. Stored outside project tree so git cannot reach it.
#
# Manual run:   powershell -ExecutionPolicy Bypass -File scripts/backup-db.ps1
# Scheduled:    registered in Windows Task Scheduler as "RSN-DB-Backup"
#               (every 10 days at 03:00)
#
# Retention: keeps newest 10 backups, deletes older.

$ErrorActionPreference = 'Stop'

# Paths
$repoRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$envFile   = Join-Path $repoRoot 'server\.env'
$backupDir = Join-Path (Split-Path $repoRoot -Parent) 'RSN-backups'
$pgDump    = 'C:\Program Files\PostgreSQL\17\bin\pg_dump.exe'
$keepCount = 10
$logFile   = Join-Path $backupDir 'backup.log'

function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Write-Host $line
    if (Test-Path $backupDir) { Add-Content -Path $logFile -Value $line }
}

# Pre-flight
if (-not (Test-Path $envFile))   { throw "server/.env not found at $envFile" }
if (-not (Test-Path $pgDump))    { throw "pg_dump not found at $pgDump" }
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }

# Pull DATABASE_URL from server/.env
$dbLine = (Get-Content $envFile) | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
if (-not $dbLine) { throw "DATABASE_URL not found in $envFile" }
$dbUrl = $dbLine -replace '^\s*DATABASE_URL\s*=\s*"?', '' -replace '"?\s*$', ''

# Neon requires SSL - ensure it's in the URL
if ($dbUrl -notmatch 'sslmode=') {
    if ($dbUrl -match '\?') {
        $dbUrl = $dbUrl + '&sslmode=require'
    } else {
        $dbUrl = $dbUrl + '?sslmode=require'
    }
}

# Output filename
$stamp   = Get-Date -Format 'yyyy-MM-dd_HHmm'
$outFile = Join-Path $backupDir "rsn_dump_$stamp.sql"

Write-Log "BEGIN backup -> $outFile"

# Run pg_dump
$pgArgs = @(
    $dbUrl,
    '--no-owner',
    '--no-acl',
    '--format=plain',
    '--encoding=UTF8',
    '--file', $outFile
)

& $pgDump @pgArgs
if ($LASTEXITCODE -ne 0) {
    Write-Log "FAILED - pg_dump exit $LASTEXITCODE"
    exit $LASTEXITCODE
}

$sizeMB = '{0:N2}' -f ((Get-Item $outFile).Length / 1MB)
Write-Log "OK - wrote $outFile ($sizeMB MB)"

# Rotation: keep newest $keepCount backups, delete older
$old = Get-ChildItem $backupDir -Filter 'rsn_dump_*.sql' |
       Sort-Object LastWriteTime -Descending |
       Select-Object -Skip $keepCount

foreach ($f in $old) {
    Remove-Item $f.FullName -Force
    Write-Log "ROTATED OUT - $($f.Name)"
}

$total = (Get-ChildItem $backupDir -Filter 'rsn_dump_*.sql').Count
Write-Log "DONE - $total backup(s) on disk"
