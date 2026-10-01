# Prints the colour of named pixels of a screenshot (3x3 average) so the HUD
# palette can be matched exactly against the reference.
#   powershell -File tools/hud-preview/sample.ps1 -Src ref.png -Points "bg:10,10;ink:20,30"
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Points
)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap (Resolve-Path $Src).Path
foreach ($p in $Points.Split(";")) {
  $name, $xy = $p.Split(":")
  $x, $y = $xy.Split(",") | ForEach-Object { [int]$_ }
  $r = 0; $g = 0; $b = 0; $n = 0
  for ($dx = -1; $dx -le 1; $dx++) {
    for ($dy = -1; $dy -le 1; $dy++) {
      $c = $bmp.GetPixel([Math]::Min($bmp.Width - 1, [Math]::Max(0, $x + $dx)), [Math]::Min($bmp.Height - 1, [Math]::Max(0, $y + $dy)))
      $r += $c.R; $g += $c.G; $b += $c.B; $n++
    }
  }
  "{0,-10} ({1},{2})  #{3:x2}{4:x2}{5:x2}" -f $name, $x, $y, [int]($r / $n), [int]($g / $n), [int]($b / $n)
}
$bmp.Dispose()
