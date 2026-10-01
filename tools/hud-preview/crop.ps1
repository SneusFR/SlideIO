# Crops zones out of a screenshot and upscales them (bicubic) so HUD details
# can be compared with the reference, e.g.:
#   powershell -File tools/hud-preview/crop.ps1 -Src ref.png -Out crops -Tag ref `
#     -Zones "buddy:0,470,340,150" -Scale 1.5
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Tag = "img",
  [string]$Zones = "mode:540,0,220,50;buddyL:0,470,170,150;buddyR:110,470,230,150;lb:1080,20,215,175;weapon:1035,490,260,130;ks:1150,375,145,125",
  [double]$Scale = 1.5,
  [int]$Quality = 70
)
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$img = [System.Drawing.Image]::FromFile((Resolve-Path $Src))
foreach ($zone in $Zones.Split(";")) {
  $name, $rect = $zone.Split(":")
  $z = $rect.Split(",") | ForEach-Object { [int]$_ }
  $w = [int]($z[2] * $Scale); $h = [int]($z[3] * $Scale)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $dst = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $g.DrawImage($img, $dst, $z[0], $z[1], $z[2], $z[3], [System.Drawing.GraphicsUnit]::Pixel)
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
  $bmp.Save((Join-Path $Out "$Tag-$name.jpg"), $codec, $ep)
  $g.Dispose(); $bmp.Dispose()
}
$img.Dispose()
Write-Output "cropped $Tag"
