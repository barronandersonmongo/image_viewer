"""EXIF metadata helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional

from PIL import ExifTags, Image

from .cache import EXIF_CACHE
from .utils import normalize_exif_value, resolve_relative_path

EXIF_TAGS = {tag_id: tag_name for tag_id, tag_name in ExifTags.TAGS.items()}
GPS_TAGS = {
    tag_id: tag_name for tag_id, tag_name in getattr(ExifTags, "GPSTAGS", {}).items()
}
EXIF_IGNORED_TAGS = {
    "MakerNote",
    "UserComment",
    "XPKeywords",
    "XPComment",
    "XPSubject",
    "XPTitle",
    "XPAuthor",
}


def read_exif_fields(image_path: Path) -> List[Dict[str, str]]:
    try:
        with Image.open(image_path) as img:
            exif_data = img.getexif()
    except Exception:  # noqa: BLE001 - return empty on parse errors
        return []

    if not exif_data:
        return []

    merged: Dict[str, List[str]] = {}

    def process_ifd(mapping, tag_lookup: Dict[int, str], prefix: Optional[str] = None) -> None:
        if not mapping:
            return
        for tag_id, raw_value in mapping.items():
            tag_name = tag_lookup.get(tag_id) or EXIF_TAGS.get(tag_id) or f"Tag {tag_id}"
            if tag_name in EXIF_IGNORED_TAGS:
                continue
            normalized = normalize_exif_value(raw_value)
            if not normalized:
                continue
            if len(normalized) > 500:
                normalized = normalized[:497] + "…"
            label = f"{prefix}{tag_name}" if prefix else tag_name
            entries = merged.setdefault(label, [])
            if normalized not in entries:
                entries.append(normalized)

    process_ifd(exif_data, EXIF_TAGS)

    if hasattr(exif_data, "get_ifd"):
        ifd_namespace = getattr(ExifTags, "IFD", None)
        if ifd_namespace is not None:
            ifd_candidates = [
                ("Exif", getattr(ifd_namespace, "Exif", None), EXIF_TAGS, None),
                ("GPSInfo", getattr(ifd_namespace, "GPSInfo", None), GPS_TAGS or EXIF_TAGS, None),
                ("Interoperability", getattr(ifd_namespace, "Interoperability", None), EXIF_TAGS, None),
                (
                    "1st",
                    getattr(ifd_namespace, "IFD1", None)
                    if hasattr(ifd_namespace, "IFD1")
                    else getattr(ifd_namespace, "First", None),
                    EXIF_TAGS,
                    None,
                ),
            ]
            for _name, ifd_id, lookup, prefix in ifd_candidates:
                if not ifd_id:
                    continue
                try:
                    ifd_mapping = exif_data.get_ifd(ifd_id)
                except Exception:  # noqa: BLE001 - ignore missing IFDs
                    continue
                process_ifd(ifd_mapping, lookup, prefix)

    gps_block = None
    if hasattr(ExifTags, "IFD"):
        gps_block = exif_data.get(ExifTags.IFD.GPSInfo)
    if gps_block and isinstance(gps_block, dict):
        process_ifd(gps_block, GPS_TAGS or EXIF_TAGS)

    fields = [
        {"label": label, "value": "; ".join(values)}
        for label, values in merged.items()
    ]
    fields.sort(key=lambda entry: entry["label"].lower())
    return fields


def get_exif_metadata(root: Path, relative: str) -> List[Dict[str, str]]:
    normalized_relative = relative.replace("\\", "/").lstrip("/")
    cache_key = f"{root}:{normalized_relative}"
    cached = EXIF_CACHE.get(cache_key)
    if cached is not None:
        return cached

    target = resolve_relative_path(root, normalized_relative)
    if not target.is_file():
        raise FileNotFoundError

    fields = read_exif_fields(target)
    EXIF_CACHE.set(cache_key, fields)
    return fields
