param(
    [string[]]$Pets = @('parrot', 'cat', 'dragon', 'drone', 'fox', 'owl', 'redpanda'),
    [switch]$Proxy,
    [switch]$Qa
)
# Builds each pet with Blender headless (rig, mouth, shared clips), then optionally
# renders QA sheets, then optimises (meshopt geometry/animation + KTX2 UASTC
# textures, KTX-Software 4.4 on PATH) into assets/pets/dist/<pet>.glb.
# Raw meshes: assets/pets/raw/<pet>.glb (TRELLIS.2 output).
$ErrorActionPreference = 'Stop'
$Pets = $Pets | ForEach-Object { $_ -split ',' } | Where-Object { $_ }
$root = Resolve-Path "$PSScriptRoot\..\..\.."
$blender = 'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe'
$build = Join-Path $root 'assets\pets\blender\build.py'
$qaScript = Join-Path $root 'assets\pets\blender\render_qa.py'
$work = Join-Path $root '.copilot-tmp\pets'
$dist = Join-Path $root 'assets\pets\dist'
$gltf = Join-Path $root 'node_modules\.bin\gltf-transform.cmd'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
foreach ($pet in $Pets) {
    $out = Join-Path $work $pet
    $raw = Join-Path $root "assets\pets\raw\$pet.glb"
    $extra = @()
    if (-not $Proxy) {
        if (-not (Test-Path $raw)) { throw "missing raw mesh $raw (use -Proxy)" }
        $extra = @('--input', $raw)
    }
    $log = & $blender -b --factory-startup -P $build -- --pet $pet --out $out @extra 2>&1
    $line = $log | Select-String 'TIKSEE_BUILD'
    if (-not $line) { $log | Select-Object -Last 30; throw "build failed: $pet" }
    Write-Output $line.Line
    if ($Qa) {
        $qaLog = & $blender -b (Join-Path $out "$pet.blend") -P $qaScript -- --out (Join-Path $out 'qa') 2>&1
        if (-not ($qaLog | Select-String 'TIKSEE_QA')) { $qaLog | Select-Object -Last 30; throw "qa failed: $pet" }
    }
    $rawGlb = Join-Path $out "$pet.raw.glb"
    $final = Join-Path $dist "$pet.glb"
    # No simplify/join/flatten: they would break the skin, the mouth morphs and bone names.
    $opt = & $gltf optimize $rawGlb $final --compress meshopt --texture-compress ktx2 --texture-size 1024 `
        --simplify false --join false --flatten false --instance false 2>&1
    if ($LASTEXITCODE -ne 0) { $opt | Select-Object -Last 20; throw "optimize failed: $pet" }
    $kb = [math]::Round((Get-Item $final).Length / 1KB)
    Write-Output "TIKSEE_DIST $pet $kb KB"
}
