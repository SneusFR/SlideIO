# ASCII colour map of a screenshot region (one char per `Step` px):
#   K ink · C cream/white · Y cyan · P pink · L lime · W yellow · O orange
#   D dark panel · ' ' anything else. Lets the HUD shapes of the reference be
#   read as text and compared with the preview render.
#   powershell -File tools/hud-preview/ascii.ps1 -Src ref.png -X 0 -Y 470 -W 120 -H 140 -Step 1
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [int]$X, [int]$Y, [int]$W, [int]$H,
  [int]$Step = 1
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
  return " "
}
$sb = New-Object System.Text.StringBuilder
for ($yy = $Y; $yy -lt [Math]::Min($bmp.Height, $Y + $H); $yy += $Step) {
  [void]$sb.Append(("{0,4} " -f $yy))
  for ($xx = $X; $xx -lt [Math]::Min($bmp.Width, $X + $W); $xx += $Step) {
    [void]$sb.Append((Classify $bmp.GetPixel($xx, $yy)))
  }
  [void]$sb.AppendLine()
}
$bmp.Dispose()
$sb.ToString()
