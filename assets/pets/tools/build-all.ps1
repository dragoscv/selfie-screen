param(
    [string[]]$Pets = @('parrot', 'cat', 'dragon', 'drone', 'fox', 'owl', 'redpanda'),
    [switch]$Proxy,
    [switch]$Procedural,
    [switch]$Qa
)
# Builds each pet with Blender headless (rig, mouth, clips), then optionally
# renders QA sheets, then optimises (meshopt geometry/animation; KTX2 UASTC
# textures for raw meshes, KTX-Software 4.4 on PATH) into assets/pets/dist/<pet>.glb.
#   -Procedural : stylised models from blender/models.py (vertex colours, no
#                 textures), copied to apps/desktop/public/pets; -Qa renders
#                 .copilot-tmp/pets/<pet>/qa/sheet.png + sheet_900.jpg.
#   default     : raw meshes assets/pets/raw/<pet>.glb (TRELLIS.2 output).
#   -Proxy      : primitive stand-ins (pipeline test only).
$ErrorActionPreference = 'Stop'
$Pets = $Pets | ForEach-Object { $_ -split ',' } | Where-Object { $_ }
$root = Resolve-Path "$PSScriptRoot\..\..\.."
$blender = 'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe'
$build = Join-Path $root 'assets\pets\blender\build.py'
$qaScript = Join-Path $root 'assets\pets\blender\qa_sheet.py'
$work = Join-Path $root '.copilot-tmp\pets'
$dist = Join-Path $root 'assets\pets\dist'
$public = Join-Path $root 'apps\desktop\public\pets'
$gltf = Join-Path $root 'node_modules\.bin\gltf-transform.cmd'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
foreach ($pet in $Pets) {
    $out = Join-Path $work $pet
    $raw = Join-Path $root "assets\pets\raw\$pet.glb"
    $extra = @()
    if ($Procedural) {
        $extra = @('--procedural')
    } elseif (-not $Proxy) {
        if (-not (Test-Path $raw)) { throw "missing raw mesh $raw (use -Proxy)" }
        $extra = @('--input', $raw)
    }
    $log = & $blender -b --factory-startup -P $build -- --pet $pet --out $out @extra 2>&1
    $line = $log | Select-String 'TIKSEE_BUILD'
    if (-not $line) { $log | Select-Object -Last 30; throw "build failed: $pet" }
    Write-Output $line.Line
    if ($Procedural -and $line.Line -notmatch '"unweighted": 0[,}]') { throw "unweighted vertices: $pet" }
    if ($Qa) {
        $qaDir = Join-Path $out 'qa'
        if (Test-Path $qaDir) { Remove-Item -Recurse -Force $qaDir }
        $qaLog = & $blender -b (Join-Path $out "$pet.blend") -P $qaScript -- --out $qaDir 2>&1
        if (-not ($qaLog | Select-String 'TIKSEE_QA')) { $qaLog | Select-Object -Last 30; throw "qa failed: $pet" }
    }
    $rawGlb = Join-Path $out "$pet.raw.glb"
    $final = Join-Path $dist "$pet.glb"
    # No simplify/join/flatten: they would break the skin, the mouth morphs and bone names.
    $tex = if ($Procedural) { @('--texture-compress', 'false') } else { @('--texture-compress', 'ktx2', '--texture-size', '1024') }
    $opt = & $gltf optimize $rawGlb $final --compress meshopt @tex `
        --simplify false --join false --flatten false --instance false --palette false 2>&1
    if ($LASTEXITCODE -ne 0) { $opt | Select-Object -Last 20; throw "optimize failed: $pet" }
    $kb = [math]::Round((Get-Item $final).Length / 1KB)
    if ($Procedural) {
        if ($kb -gt 250) { throw "$pet.glb is $kb KB (> 250 KB budget)" }
        Copy-Item $final (Join-Path $public "$pet.glb") -Force
    }
    Write-Output "TIKSEE_DIST $pet $kb KB"
}
