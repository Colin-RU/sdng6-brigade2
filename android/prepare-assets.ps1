param([string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath($ProjectRoot)
$androidRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$source = Join-Path $project 'docs'
$target = [IO.Path]::GetFullPath((Join-Path $androidRoot 'app\src\main\assets\www'))
if (!$target.StartsWith($androidRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected Android assets path' }
foreach ($required in @('index.html','app.js','offline.js','data.json','gps-points.json','geo-network.json')) {
    if (!(Test-Path -LiteralPath (Join-Path $source $required))) { throw "Missing app asset: $required" }
}
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
New-Item -ItemType Directory -Path $target -Force | Out-Null
Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $target -Recurse -Force
Copy-Item -LiteralPath (Join-Path $androidRoot 'native-gps.js') -Destination $target
$utf8 = [Text.UTF8Encoding]::new($false)
$indexPath = Join-Path $target 'index.html'
$html = [IO.File]::ReadAllText($indexPath)
$html = $html.Replace('<script src="preferences.js"></script>', '<script src="native-gps.js"></script>' + "`n  " + '<script src="preferences.js"></script>')
if (!$html.Contains('src="native-gps.js"')) { throw 'Could not install native GPS adapter' }
[IO.File]::WriteAllText($indexPath, $html, $utf8)
$appPath = Join-Path $target 'app.js'
$app = [IO.File]::ReadAllText($appPath)
$patches = @{
    'async function setupOffline(){' = "async function setupOffline(){if(window.isNativeAtlas){document.querySelector('#offline-state').textContent='Доступен без сети';return;}"
    'function downloadJSON(object,name){' = 'function downloadJSON(object,name){if(window.isNativeAtlas){SdngGps.saveExport(name,JSON.stringify(object,null,2));return;}'
    'async function install(){' = "async function install(){if(window.isNativeAtlas){toast('Приложение уже установлено и готово к работе без интернета');return;}"
}
foreach ($needle in $patches.Keys) {
    if (!$app.Contains($needle)) { throw "Android assets patch no longer matches: $needle" }
    $app = $app.Replace($needle, $patches[$needle])
}
[IO.File]::WriteAllText($appPath, $app, $utf8)
$offlinePath = Join-Path $target 'offline.js'
$offline = [IO.File]::ReadAllText($offlinePath)
$needle = 'async function offlineRequest(type){'
if (!$offline.Contains($needle)) { throw 'Android offline patch no longer matches' }
$offline = $offline.Replace($needle, $needle + 'if(window.isNativeAtlas)return {ready:true};')
[IO.File]::WriteAllText($offlinePath, $offline, $utf8)
$icons = Join-Path $androidRoot 'app\src\main\res\mipmap-xxxhdpi'
New-Item -ItemType Directory -Path $icons -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'icon-512.png') -Destination (Join-Path $icons 'ic_launcher.png') -Force
$hashes = Get-ChildItem -LiteralPath $target -Recurse -File | ForEach-Object {
    @{path=$_.FullName.Substring($target.Length + 1).Replace('\','/'); sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$manifest = @{createdAt=[DateTime]::UtcNow.ToString('o'); files=@($hashes)} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $androidRoot 'app\build-assets.json'), $manifest, $utf8)
Write-Output "Prepared $($hashes.Count) bundled app files."
