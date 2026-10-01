# Prints the colour runs along horizontal (h:y:x0-x1) or vertical (v:x:y0-y1)
# scanlines, each pixel classified as K ink / C cream / Y cyan / P pink /
# L lime / O orange / W yellow / D dark panel / . other — used to measure
# the reference HUD geometry without eyeballing.
#   powershell -File tools/hud-preview/scan.ps1 -Src ref.png -Lines "h:25:540-760"
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Lines
)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap (Resolve-Path $Src).Path
function Classify($c) {
  $r = $c.R; $g = $c.G; $b = $c.B
  $mx = [Math]::Max($r, [Math]::Max($g, $b)); $mn = [Math]::Min($r, [Math]::Min($g, $b))
  if ($mx -lt 45) { return "K" }
  if ($r -gt 225 -and $g -gt 215 -and $b -gt 180 -and ($mx - $mn) -lt 60) { return "C" }
  if ($b -gt 170 -and $g -gt 170 -and $r -lt 90) { return "Y" }
  if ($r -gt 200 -and $b -gt 110 -and $g -lt 130) { return "P" }
  if ($g -gt 200 -and $r -gt 150 -and $b -lt 110) { return "L" }
  if ($r -gt 220 -and $g -gt 180 -and $b -lt 90) { return "W" }
  if ($r -gt 200 -and $g -gt 70 -and $g -lt 160 -and $b -lt 80) { return "O" }
  if ($mx -lt 80 -and ($mx - $mn) -lt 40) { return "D" }
  return "."
}
foreach ($line in $Lines.Split(";")) {
  $dir, $at, $range = $line.Split(":")
  $a, $z = $range.Split("-") | ForEach-Object { [int]$_ }
  $at = [int]$at
  $runs = @(); $prev = ""; $start = $a
  for ($i = $a; $i -le $z; $i++) {
    $c = if ($dir -eq "h") { $bmp.GetPixel($i, $at) } else { $bmp.GetPixel($at, $i) }
    $k = Classify $c
    if ($k -ne $prev) {
      if ($prev -ne "") { $runs += "$prev$start" + "+" + ($i - $start) }
      $prev = $k; $start = $i
    }
  }
  $runs += "$prev$start" + "+" + ($z + 1 - $start)
  "$line => " + ($runs -join " ")
}
$bmp.Dispose()
