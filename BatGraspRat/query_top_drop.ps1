$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$snapshotUrl = 'https://grasp-rat-game.h-e.top/snapshot'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$snapshotFile = Join-Path $scriptDir 'snapshot'
$resultFile = Join-Path $scriptDir 'top_drop_result.txt'

Write-Host 'Downloading latest snapshot...'
& curl.exe -L -o $snapshotFile $snapshotUrl
if ($LASTEXITCODE -ne 0) {
    throw 'Download failed. Please check network or curl.exe.'
}

$json = Get-Content -LiteralPath $snapshotFile -Raw -Encoding UTF8 | ConvertFrom-Json
$rank = 0
$rows = $json.entities |
    Sort-Object -Property death_drop_coins -Descending |
    Select-Object -First 10 |
    ForEach-Object {
        $rank++
        [pscustomobject]@{
            Rank     = $rank
            Name     = $_.name
            Drop     = $_.death_drop_coins
            X        = $_.x
            Y        = $_.y
            Cell     = '[' + ($_.cell -join ', ') + ']'
            Active   = $_.current_join_mode
            EntityId = $_.entity_id
            UserId   = $_.user_id
        }
    }

$output = @()
$output += 'Top 10 by death_drop_coins:'
$output += ''
$output += ($rows | Format-Table -AutoSize | Out-String).TrimEnd()

$output -join [Environment]::NewLine | Set-Content -LiteralPath $resultFile -Encoding UTF8

Write-Host ''
Write-Host ($output -join [Environment]::NewLine)
Write-Host ''
Write-Host "Saved to: $resultFile"
