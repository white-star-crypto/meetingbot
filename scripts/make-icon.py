from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parents[1]
p = root / "public" / "heyi.png"
im = Image.open(p).convert("RGBA")
ico = root / "public" / "heyi.ico"
im.save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
im2 = Image.open(ico)
print(im2.format, im2.size, getattr(im2, "n_frames", 1))
