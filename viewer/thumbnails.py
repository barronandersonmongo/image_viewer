"""Thumbnail generation helpers."""

from __future__ import annotations

import hashlib
import io
from pathlib import Path
from typing import Optional, Tuple

from PIL import Image, ImageOps

from config import THUMBNAIL_CACHE_DIR


def extract_exif_thumbnail(image_path: Path) -> Optional[bytes]:
    try:
        with Image.open(image_path) as img:
            exif = img.getexif()
            thumb = exif.thumbnail if exif else None
            if thumb:
                return thumb
    except Exception:
        return None
    return None


def thumbnail_cache_key(image_path: Path, max_size: int) -> str:
    stat = image_path.stat()
    fingerprint = f"{image_path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}|{max_size}"
    return hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()


def thumbnail_cache_path(image_path: Path, max_size: int) -> Path:
    key = thumbnail_cache_key(image_path, max_size)
    return THUMBNAIL_CACHE_DIR / f"{key}.jpg"


def generate_thumbnail(image_path: Path, max_size: int) -> Optional[Tuple[bytes, str]]:
    exif_thumb = extract_exif_thumbnail(image_path)
    if exif_thumb:
        return exif_thumb, "image/jpeg"

    cache_file = thumbnail_cache_path(image_path, max_size)
    if cache_file.exists():
        return cache_file.read_bytes(), "image/jpeg"

    try:
        with Image.open(image_path) as img:
            img = ImageOps.exif_transpose(img)
            thumb = img.copy()
            thumb.thumbnail((max_size, max_size), Image.LANCZOS)
            if thumb.mode == "RGBA":
                background = Image.new("RGB", thumb.size, (16, 16, 16))
                background.paste(thumb, mask=thumb.split()[3])
                thumb = background
            elif thumb.mode != "RGB":
                thumb = thumb.convert("RGB")
            buffer = io.BytesIO()
            save_kwargs = {"optimize": True, "quality": 82}
            thumb.save(buffer, "JPEG", **save_kwargs)
    except Exception:
        return None

    data = buffer.getvalue()
    THUMBNAIL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_bytes(data)
    return data, "image/jpeg"
