param(
    [string]$ToolsRoot = 'D:\sites\android-build-tools',
    [string]$SigningRoot = 'D:\sites\sdng6-brigade2-signing',
    [string]$OutputApk = 'D:\sites\releases\brigade2-android.apk'
)
$ErrorActionPreference = 'Stop'
$tools = [IO.Path]::GetFullPath($ToolsRoot)
$signing = [IO.Path]::GetFullPath($SigningRoot)
$project = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if ($signing.StartsWith($project + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $signing -eq $project) {
    throw 'Keep signing keys outside the application repository.'
}
$jdk = Get-ChildItem -LiteralPath (Join-Path $tools 'jdk17') -Directory | Select-Object -First 1
if (!$jdk) { throw 'Install a verified JDK 17 under ToolsRoot\jdk17 first.' }
$gradle = Join-Path $tools 'gradle-8.11.1\bin\gradle.bat'
$sdk = Join-Path $tools 'sdk'
foreach ($required in @($gradle, (Join-Path $sdk 'platforms\android-35\android.jar'), (Join-Path $sdk 'build-tools\35.0.0\apksigner.bat'))) {
    if (!(Test-Path -LiteralPath $required)) { throw "Missing build dependency: $required" }
}
& (Join-Path $PSScriptRoot 'prepare-assets.ps1')
New-Item -ItemType Directory -Path $signing -Force | Out-Null
$keyFile = Join-Path $signing 'brigade2-release.jks'
$passwordFile = Join-Path $signing 'release-password.dpapi.xml'
if ((Test-Path -LiteralPath $keyFile) -ne (Test-Path -LiteralPath $passwordFile)) { throw 'Signing key/password pair is incomplete. Restore both private files before building.' }
if (!(Test-Path -LiteralPath $passwordFile)) {
    $random = [byte[]]::new(32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($random)
    $newSecret = [Convert]::ToHexString($random).ToLowerInvariant()
    ConvertTo-SecureString $newSecret -AsPlainText -Force | Export-Clixml -LiteralPath $passwordFile
    $newSecret = $null
    [Array]::Clear($random, 0, $random.Length)
}
$oldEnvironment = @{}
foreach ($name in @('JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT','GRADLE_USER_HOME','Path','BRIGADE_KEYSTORE','BRIGADE_STORE_PASSWORD','BRIGADE_KEY_PASSWORD')) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:JAVA_HOME = $jdk.FullName
    $env:ANDROID_HOME = $sdk
    $env:ANDROID_SDK_ROOT = $sdk
    $env:GRADLE_USER_HOME = Join-Path $tools 'gradle-cache'
    $env:Path = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:Path
    $secure = Import-Clixml -LiteralPath $passwordFile
    $credential = [PSCredential]::new('brigade2', $secure)
    $env:BRIGADE_STORE_PASSWORD = $credential.GetNetworkCredential().Password
    $env:BRIGADE_KEY_PASSWORD = $env:BRIGADE_STORE_PASSWORD
    $env:BRIGADE_KEYSTORE = $keyFile
    if (!(Test-Path -LiteralPath $keyFile)) {
        & (Join-Path $env:JAVA_HOME 'bin\keytool.exe') -genkeypair -noprompt -keystore $keyFile -storetype JKS -alias brigade2 -keyalg RSA -keysize 3072 -sigalg SHA256withRSA -validity 36500 -dname 'CN=Brigade 2 Atlas' -storepass:env BRIGADE_STORE_PASSWORD -keypass:env BRIGADE_KEY_PASSWORD
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the permanent release key.' }
    }
    & $gradle --no-daemon --console=plain -p $PSScriptRoot :app:assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'Android release build failed.' }
    $built = Join-Path $PSScriptRoot 'app\build\outputs\apk\release\app-release.apk'
    if (!(Test-Path -LiteralPath $built)) { throw 'Signed APK was not produced.' }
    & (Join-Path $sdk 'build-tools\35.0.0\apksigner.bat') verify --verbose --print-certs $built
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    $absoluteOutput = [IO.Path]::GetFullPath($OutputApk)
    New-Item -ItemType Directory -Path (Split-Path $absoluteOutput -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $built -Destination $absoluteOutput -Force
    $hash = (Get-FileHash -LiteralPath $absoluteOutput -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($absoluteOutput + '.sha256', $hash + '  ' + [IO.Path]::GetFileName($absoluteOutput) + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output "Signed APK: $absoluteOutput"
    Write-Output "SHA256: $hash"
} finally {
    foreach ($name in $oldEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process') }
    $credential = $null
    $secure = $null
}
