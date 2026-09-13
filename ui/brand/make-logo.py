#!/usr/bin/env python3
"""Wingman brand assets, generated from the console's design tokens (ui/src/app/globals.css):
product blue #4472C4 -> #2B5797, navy ink #182849, pale blue #DFE7F5, white. The mark is the NavBar's
diamond (◆) drawn as a rounded square rotated 45°, with a smaller white diamond cut in — a lens seen
straight on. Writes: ui/public/brand/{wingman-mark.svg, wingman-logo.svg, wingman-icon-1024.png},
ui/src/app/icon.png (Next favicon) and the iOS AppIcon 1024. Run: python3 ui/brand/make-logo.py"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "ui/public/brand"
OUT.mkdir(parents=True, exist_ok=True)

BLUE, BLUE_DEEP, NAVY, PALE, WHITE = "#4472C4", "#2B5797", "#182849", "#DFE7F5", "#FFFFFF"

# --- vector ---------------------------------------------------------------
MARK = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{BLUE}"/><stop offset="1" stop-color="{BLUE_DEEP}"/>
    </linearGradient>
  </defs>
  <rect x="17" y="17" width="66" height="66" rx="14" transform="rotate(45 50 50)" fill="url(#g)"/>
  <rect x="35" y="35" width="30" height="30" rx="6" transform="rotate(45 50 50)" fill="{WHITE}"/>
  <rect x="44" y="44" width="12" height="12" rx="2.5" transform="rotate(45 50 50)" fill="{BLUE}"/>
</svg>'''
(OUT / "wingman-mark.svg").write_text(MARK + "\n")

LOGO = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 100" width="420" height="100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{BLUE}"/><stop offset="1" stop-color="{BLUE_DEEP}"/>
    </linearGradient>
  </defs>
  <g transform="translate(0 0)">
    <rect x="17" y="17" width="66" height="66" rx="14" transform="rotate(45 50 50)" fill="url(#g)"/>
    <rect x="35" y="35" width="30" height="30" rx="6" transform="rotate(45 50 50)" fill="{WHITE}"/>
    <rect x="44" y="44" width="12" height="12" rx="2.5" transform="rotate(45 50 50)" fill="{BLUE}"/>
  </g>
  <text x="112" y="68" font-family="Roboto, system-ui, sans-serif" font-weight="700" font-size="52" fill="{NAVY}" letter-spacing="-1">Wingman</text>
</svg>'''
(OUT / "wingman-logo.svg").write_text(LOGO + "\n")

# --- raster (app icon) -------------------------------------------------------
S = 1024
def rounded_diamond(size, half, radius, fill):
    """A rounded square rotated 45°, centred, on a transparent canvas of `size`."""
    layer = Image.new("RGBA", (size * 2, size * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    c = size  # centre of the 2x canvas
    d.rounded_rectangle([c - half, c - half, c + half, c + half], radius=radius, fill=fill)
    layer = layer.rotate(45, resample=Image.BICUBIC, center=(c, c))
    return layer.crop((c - size // 2, c - size // 2, c + size // 2, c + size // 2))

def hexrgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))

# ground: white -> pale blue vertical wash (the console's page + pale-blue selected state)
icon = Image.new("RGB", (S, S), WHITE)
px = icon.load()
w, p = hexrgb(WHITE), hexrgb(PALE)
for y in range(S):
    t = y / (S - 1)
    col = tuple(round(w[i] + (p[i] - w[i]) * t) for i in range(3))
    for x in range(S):
        px[x, y] = col
icon = icon.convert("RGBA")

# soft shadow under the mark
shadow = rounded_diamond(S, 310, 66, (24, 40, 73, 90)).filter(ImageFilter.GaussianBlur(28))
icon.alpha_composite(shadow, (0, 26))
# blue gradient mark: paint the gradient through the diamond mask
grad = Image.new("RGBA", (S, S))
gp = grad.load(); a, b = hexrgb(BLUE), hexrgb(BLUE_DEEP)
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * (S - 1))
        gp[x, y] = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
mask = rounded_diamond(S, 310, 66, (255, 255, 255, 255)).split()[3]
icon.paste(grad, (0, 0), mask)
icon.alpha_composite(rounded_diamond(S, 142, 30, (255, 255, 255, 255)))
icon.alpha_composite(rounded_diamond(S, 58, 12, hexrgb(BLUE) + (255,)))

icon = icon.convert("RGB")
icon.save(OUT / "wingman-icon-1024.png", optimize=True)
icon.resize((512, 512), Image.LANCZOS).save(ROOT / "ui/src/app/icon.png", optimize=True)
icon.save(ROOT / "glassbridge/Wingman/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png", optimize=True)
print("wrote", sorted(p.name for p in OUT.iterdir()), "+ ui/src/app/icon.png + iOS AppIcon-1024.png")
