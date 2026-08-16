# AMO へアップロードする zip を作る。
# manifest.json が zip の直下に来ている必要があるため、
# フォルダごと固めるのではなくファイルを個別に追加する。
#
# 使い方: powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot

# Windows PowerShell 5.1 の既定は ANSI 読みなので UTF8 を明示する。
# 指定しないと日本語が化けて JSON が壊れる。
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version

$distDir = Join-Path $root 'dist'
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }

$zipPath = Join-Path $distDir "CertainlyYoutubeShorts-$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# 配布に必要なファイルだけを入れる。README や build.ps1 は含めない。
$files = @('manifest.json', 'cys.js', 'icon.svg')

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
    foreach ($file in $files) {
        $path = Join-Path $root $file
        if (-not (Test-Path $path)) { throw "見つかりません: $file" }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $path, $file) | Out-Null
    }
}
finally {
    $zip.Dispose()
}

Write-Output "作成しました: $zipPath"
[System.IO.Compression.ZipFile]::OpenRead($zipPath).Entries | ForEach-Object { Write-Output ("  " + $_.FullName) }
