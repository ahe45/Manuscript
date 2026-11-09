param(
    [string]$RuntimeCache,
    [string]$CompilerPath,
    [switch]$SkipInstaller,
    [switch]$KeepStage
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$cache = Join-Path $PSScriptRoot 'cache'
if (-not $RuntimeCache) { $RuntimeCache = $cache }
$build = Join-Path $PSScriptRoot ('.build/' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $build 'stage'
$release = Join-Path $PSScriptRoot 'output'
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') -Raw | ConvertFrom-Json
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'package.json version must be major.minor.patch.' }
New-Item -ItemType Directory -Path $cache,$stage,$release,(Join-Path $stage 'runtime'),(Join-Path $stage 'installer') -Force | Out-Null

function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed ($LASTEXITCODE)" }
}

function Expand-Runtime($Spec, [string]$ArchiveName) {
    $archive = Join-Path $RuntimeCache $ArchiveName
    if (-not (Test-Path -LiteralPath $archive)) {
        $archive = Join-Path $cache $ArchiveName
        if (-not (Test-Path -LiteralPath $archive)) {
            $temporary = "$archive.download"
            Invoke-WebRequest -Uri $Spec.url -UseBasicParsing -OutFile $temporary
            if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $Spec.sha256) {
                throw "SHA-256 mismatch for $ArchiveName"
            }
            Move-Item -LiteralPath $temporary -Destination $archive -Force
        }
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $Spec.sha256) {
        throw "SHA-256 mismatch for $ArchiveName"
    }
    $destination = Join-Path $build ([IO.Path]::GetFileNameWithoutExtension($ArchiveName))
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $destination)
    return Join-Path $destination $Spec.directory
}

$appFiles = @('package.json','package-lock.json','server.mjs','database.mjs','access.mjs','fonts.mjs','pdf.mjs','pdf-queue.mjs')
foreach ($file in $appFiles) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage }
Copy-Item -LiteralPath (Join-Path $root 'dist'),(Join-Path $root 'db') -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime.mjs'),(Join-Path $PSScriptRoot 'data-permissions.ps1') -Destination (Join-Path $stage 'installer')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'USER-GUIDE.txt') -Destination $stage

Push-Location $stage
try { Invoke-Checked 'npm.cmd' @('ci','--omit=dev','--no-audit','--no-fund') }
finally { Pop-Location }

# Keep only the WOFF2 weights used by the app.
$fontFiles = Join-Path $stage 'node_modules/@fontsource/noto-sans-kr/files'
Get-ChildItem -LiteralPath $fontFiles -File | Where-Object { $_.Name -notmatch '-(400|700)-normal\.woff2$' } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName }

$node = Expand-Runtime $lock.node 'node.zip'
$mariadb = Expand-Runtime $lock.mariadb 'mariadb.zip'
$nodeDestination = Join-Path $stage 'runtime/node'
New-Item -ItemType Directory -Path $nodeDestination -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $node 'node.exe'),(Join-Path $node 'LICENSE') -Destination $nodeDestination
Move-Item -LiteralPath $mariadb -Destination (Join-Path $stage 'runtime/mariadb')

@{ version = $version; mariadb = $lock.mariadb.version } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'release.json') -Encoding ascii
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$icon = Join-Path $stage 'Manuscript.ico'
Copy-Item -LiteralPath (Join-Path $root 'Manuscript.ico') -Destination $icon
Invoke-Checked $csc @('/nologo','/codepage:65001','/target:winexe','/platform:x64','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',
    ('/win32icon:' + $icon), ('/out:' + (Join-Path $stage 'Manuscript.exe')), (Join-Path $PSScriptRoot 'Launcher.cs'))

if (-not $SkipInstaller) {
    if (-not $CompilerPath) {
        $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
        if ($command) { $CompilerPath = $command.Source }
        else { $CompilerPath = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6/ISCC.exe' }
    }
    if (-not (Test-Path -LiteralPath $CompilerPath)) { throw 'Set -CompilerPath to Inno Setup ISCC.exe.' }
    $script = Join-Path $build 'Manuscript.iss'
    [IO.File]::WriteAllText($script, [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Manuscript.iss')), [Text.UTF8Encoding]::new($true))
    Invoke-Checked $CompilerPath @('/Qp',("/DAppVersion=$version"),("/DStageDir=$stage"),("/DReleaseDir=$release"),$script)
    $filename = "Manuscript-$version-Setup.exe"
    $hash = Get-FileHash -LiteralPath (Join-Path $release $filename) -Algorithm SHA256
    ($hash.Hash.ToLowerInvariant() + '  ' + $filename) |
        Set-Content -LiteralPath (Join-Path $release "$filename.sha256") -Encoding ascii
    $hash
}
if ($SkipInstaller -or $KeepStage) {
    Write-Output "Stage: $stage"
} else {
    $resolvedBuild = (Resolve-Path -LiteralPath $build).Path
    $resolvedParent = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '.build')).Path
    if ((Split-Path -Parent $resolvedBuild) -ne $resolvedParent -or (Split-Path -Leaf $resolvedBuild) -notmatch '^[0-9a-f]{32}$') {
        throw 'Unexpected installer build path.'
    }
    Remove-Item -LiteralPath $resolvedBuild -Recurse -Force
}
