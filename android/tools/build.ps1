param(
    [switch]$Minimal,
    [switch]$Clean,
    [switch]$Release,
    [switch]$Install
)

$ErrorActionPreference = "Continue"
$root = "C:\Users\ms999\Documents\Default Project\whatsapp-poster"
Push-Location $root
try {
    Write-Output "=== 1. bundle ==="
    $bundleArgs = @("android\tools\bundle.mjs")
    if ($Minimal) { $bundleArgs += "--minimal" }
    if ($Clean) { $bundleArgs += "--clean" }
    node @bundleArgs
    if ($LASTEXITCODE -ne 0) { throw "bundle failed" }

    Write-Output "=== 2. zip ==="
    $staging = Join-Path $root "android\build\app-staging"
    $zip = Join-Path $root "android\app\src\main\assets\app.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
    Write-Output ("  app.zip: " + [math]::Round((Get-Item $zip).Length / 1MB, 2) + " MB")

    Write-Output "=== 3. gradle ==="
    $env:JAVA_HOME = "C:\Program Files\Java\jdk-17"
    $gradle = "C:\Users\ms999\.gradle\wrapper\dists\gradle-8.13-all\54h0s9kvb6g2sinako7ub77ku\gradle-8.13\bin\gradle.bat"
    $task = if ($Release) { "assembleRelease" } else { "assembleDebug" }
    & $gradle -p android $task --console=plain --no-daemon 2>&1 |
        Select-String -Pattern "BUILD |error:|FAILED|warning:" |
        ForEach-Object { Write-Output ("  " + $_.Line) }

    $variant = if ($Release) { "release" } else { "debug" }
    $apks = Get-ChildItem "android\app\build\outputs\apk\$variant" -Filter *.apk
    foreach ($a in $apks) { Write-Output ("  " + $a.Name + "  " + [math]::Round($a.Length / 1MB, 1) + " MB") }

    if ($Install) {
        Write-Output "=== 4. install (emulator) ==="
        $adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
        $apk = ($apks | Where-Object { $_.Name -like "*x86_64*" } | Select-Object -First 1).FullName
        & $adb shell am force-stop com.hssc.poster | Out-Null
        & $adb install -r $apk 2>&1 | ForEach-Object { Write-Output ("  " + $_) }
        & $adb shell monkey -p com.hssc.poster -c android.intent.category.LAUNCHER 1 2>&1 | Out-Null
    }
} finally {
    Pop-Location
}
