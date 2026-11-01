#!/usr/bin/env python3
"""Seed a Clipboard Indicator cache dir with large PNG screenshots.

Usage: seed.py <cache_dir> <n_images> [n_texts]

File names follow the extension's convention: the decimal value of
g_bytes_hash() over the file contents (djb2 over *signed* chars).
"""
import io, json, os, random, sys
from PIL import Image, ImageDraw

def g_bytes_hash(data: bytes) -> int:
    h = 5381
    for b in data:
        sb = b - 256 if b > 127 else b
        h = (h * 33 + sb) & 0xFFFFFFFF
    return h

def make_png(seed: int) -> bytes:
    rnd = random.Random(seed)
    w, h = 3840, 2160
    img = Image.effect_noise((w, h), 2).convert('RGB')
    d = ImageDraw.Draw(img)
    for _ in range(60):
        x, y = rnd.randrange(w), rnd.randrange(h)
        d.rectangle([x, y, x + rnd.randrange(50, 900), y + rnd.randrange(30, 500)],
                    fill=(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)))
    buf = io.BytesIO()
    img.save(buf, 'PNG', compress_level=6)
    return buf.getvalue()

def main():
    cache_dir, n_img = sys.argv[1], int(sys.argv[2])
    n_txt = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    os.makedirs(cache_dir, exist_ok=True)
    reg = []
    for i in range(n_txt):
        reg.append({'favorite': i == 0, 'mimetype': 'text/plain;charset=utf-8',
                    'contents': f'seed text entry {i} ' + 'lorem ipsum ' * (i % 7)})
    for i in range(n_img):
        data = make_png(i)
        name = str(g_bytes_hash(data))
        path = os.path.join(cache_dir, name)
        with open(path, 'wb') as f:
            f.write(data)
        reg.append({'favorite': i == 1, 'mimetype': 'image/png', 'contents': path})
    with open(os.path.join(cache_dir, 'registry.txt'), 'w') as f:
        json.dump(reg, f)

main()
