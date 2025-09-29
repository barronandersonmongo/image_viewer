#!/usr/bin/env python3
"""Populate MongoDB with image metadata from a photo directory (insert-only)."""

import argparse
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, Iterator, Optional, Tuple

import requests
from pymongo import MongoClient
from pymongo.collection import Collection
from pymongo.errors import ServerSelectionTimeoutError
from PIL import Image, ExifTags, UnidentifiedImageError
from PIL.TiffImagePlugin import IFDRational

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".gif", ".bmp", ".heic", ".webp"}
DATE_SEGMENT_PATTERNS = [
    re.compile(r"^(?P<year>19\d{2}|20\d{2})[_-](?P<month>0[1-9]|1[0-2])[_-](?P<day>0[1-9]|[12]\d|3[01])$"),
    re.compile(r"^(?P<year>19\d{2}|20\d{2})(?P<month>0[1-9]|1[0-2])(?P<day>0[1-9]|[12]\d|3[01])$"),
    re.compile(r"^(?P<year>19\d{2}|20\d{2})-(?P<month>0[1-9]|1[0-2])-(?P<day>0[1-9]|[12]\d|3[01])$"),
]
YEAR_SEGMENT_PATTERN = re.compile(r"^(?P<year>19\d{2}|20\d{2})$")
MONTH_SEGMENT_PATTERN = re.compile(r"^(0[1-9]|1[0-2])$")
DAY_SEGMENT_PATTERN = re.compile(r"^(0[1-9]|[12]\d|3[01])$")

logger = logging.getLogger(__name__)


def parse_args(argv: Optional[Iterable[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path("/home/barry/bobby/pictures"),
        help="Root directory that contains the images.",
    )
    parser.add_argument(
        "--mongo-uri",
        default="mongodb://192.168.1.8",
        help="MongoDB connection URI.",
    )
    parser.add_argument(
        "--db", default="barrydb", help="MongoDB database name (default: barrydb)."
    )
    parser.add_argument(
        "--collection",
        default="images",
        help="MongoDB collection name (default: images).",
    )
    parser.add_argument(
        "--extensions",
        nargs="*",
        default=sorted(IMAGE_EXTENSIONS),
        help="Image extensions to include (default: common image formats).",
    )
    parser.add_argument(
        "--include-hidden",
        action="store_true",
        help="Process files and directories that start with a dot.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging output.",
    )
    return parser.parse_args(argv)


@dataclass
class PathDateInfo:
    is_date_specific: bool
    date_value: Optional[datetime]


def iter_image_files(root: Path, extensions: Iterable[str], include_hidden: bool) -> Iterator[Path]:
    root = root.resolve()
    normalized_exts = {ext.lower() if ext.startswith(".") else f".{ext.lower()}" for ext in extensions}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if not include_hidden and any(part.startswith(".") for part in path.relative_to(root).parts):
            continue
        if path.suffix.lower() not in normalized_exts:
            continue
        yield path


def detect_path_date(relative_path: Path) -> PathDateInfo:
    parts = relative_path.parts

    for part in parts:
        for pattern in DATE_SEGMENT_PATTERNS:
            match = pattern.match(part)
            if match:
                try:
                    date_value = datetime(
                        int(match.group("year")),
                        int(match.group("month")),
                        int(match.group("day")),
                        tzinfo=timezone.utc,
                    )
                    return PathDateInfo(True, date_value)
                except ValueError:
                    continue

    for idx in range(len(parts) - 2):
        if YEAR_SEGMENT_PATTERN.match(parts[idx]) and \
           MONTH_SEGMENT_PATTERN.match(parts[idx + 1]) and \
           DAY_SEGMENT_PATTERN.match(parts[idx + 2]):
            try:
                date_value = datetime(
                    int(parts[idx]),
                    int(parts[idx + 1]),
                    int(parts[idx + 2]),
                    tzinfo=timezone.utc,
                )
                return PathDateInfo(True, date_value)
            except ValueError:
                continue

    return PathDateInfo(False, None)


def _normalize_exif_value(value):
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", errors="replace")
        except Exception:
            return value.hex()
    if isinstance(value, IFDRational):
        return float(value) if value.denominator != 0 else None
    if isinstance(value, (tuple, list)):
        return [_normalize_exif_value(v) for v in value]
    return value


def extract_exif(path: Path) -> Dict[str, object]:
    try:
        with Image.open(path) as img:
            exif_raw = img._getexif() or {}
    except (FileNotFoundError, UnidentifiedImageError):
        return {}
    except Exception:
        logger.exception("Unexpected error while reading EXIF from %s", path)
        return {}

    translated: Dict[str, object] = {}
    for tag_id, value in exif_raw.items():
        tag_name = ExifTags.TAGS.get(tag_id, str(tag_id))
        if tag_name == "GPSInfo" and isinstance(value, dict):
            gps_data = {str(k): _normalize_exif_value(v) for k, v in value.items()}
            translated[tag_name] = gps_data
        else:
            translated[tag_name] = _normalize_exif_value(value)
    return translated


def convert_exif_datetime_to_iso_utc(exif: Dict[str, object]) -> Optional[str]:
    raw_datetime = None
    for key in ("DateTimeOriginal", "DateTime", "DateTimeDigitized"):
        if key in exif:
            raw_datetime = str(exif[key])
            break
    if not raw_datetime:
        return None

    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            parsed = datetime.strptime(raw_datetime, fmt)
            break
        except ValueError:
            parsed = None
    if parsed is None:
        return None

    offset_str = exif.get("OffsetTimeOriginal") or exif.get("OffsetTime")
    if isinstance(offset_str, str):
        m = re.match(r"([+-])([01]\d|2[0-3]):?([0-5]\d)$", offset_str)
        if m:
            sign, hours, minutes = m.groups()
            delta = timedelta(hours=int(hours), minutes=int(minutes))
            if sign == "-":
                delta = -delta
            parsed = parsed.replace(tzinfo=timezone(delta))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)

    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _extract_gps_coords(exif: Dict[str, object]) -> Optional[Tuple[float, float, Optional[float]]]:
    gps = exif.get("GPSInfo")
    if not isinstance(gps, dict):
        return None
    try:
        lat_ref, lat_vals = gps.get("1"), gps.get("2")
        lon_ref, lon_vals = gps.get("3"), gps.get("4")
        alt_val = gps.get("6")

        def to_deg(values):
            d, m, s = values
            return float(d) + float(m) / 60 + float(s) / 3600

        lat = to_deg(lat_vals) * (-1 if lat_ref == "S" else 1)
        lon = to_deg(lon_vals) * (-1 if lon_ref == "W" else 1)
        return lat, lon, float(alt_val) if alt_val is not None else None
    except Exception:
        return None


def reverse_geocode(lat: float, lon: float) -> Tuple[Optional[Dict], Optional[str]]:
    url = "https://nominatim.openstreetmap.org/reverse"
    try:
        r = requests.get(url, params={
            "lat": lat,
            "lon": lon,
            "format": "json",
            "addressdetails": 1,
            "namedetails": 1,
            "extratags": 1,
        }, headers={"User-Agent": "BarryImageLoader/1.0"}, timeout=10)
        if r.status_code == 429:
            time.sleep(1)
            return None, "rate_limited"
        if r.ok:
            return r.json(), None
        return None, f"HTTP {r.status_code}"
    except Exception as e:
        return None, str(e)


def connect_collection(uri: str, db_name: str, collection_name: str) -> Collection:
    client = MongoClient(uri, tz_aware=True, serverSelectionTimeoutMS=5000)
    client.admin.command("ping")
    return client[db_name][collection_name]


def build_document(file_path: Path, root: Path, exif: Dict[str, object]) -> Dict[str, object]:
    pseudo_path = f"/{file_path.relative_to(root).as_posix()}"
    file_stat = file_path.stat()

    doc = {
        "_id": pseudo_path,
        "file_size_bytes": file_stat.st_size,
        "exif": exif,
    }

    image_datetime = convert_exif_datetime_to_iso_utc(exif)
    if image_datetime:
        doc["image_datetime"] = image_datetime
        doc["date_specific"] = True
    else:
        path_info = detect_path_date(file_path.relative_to(root))
        doc["image_datetime"] = path_info.date_value.isoformat().replace("+00:00", "Z") if path_info.date_value else None
        doc["date_specific"] = path_info.is_date_specific

    coords = _extract_gps_coords(exif)
    if coords:
        lat, lon, alt = coords
        osm, err = reverse_geocode(lat, lon)
        if osm:
            loc = {
                "type": "Point",
                "coordinates": [lon, lat, alt],
                "raw": osm,
                "address": osm.get("address"),
                "types": [osm.get("type")] if "type" in osm else [],
            }
            if osm.get("namedetails"):
                loc["poi"] = {"name": osm["namedetails"].get("name")}
            doc["location"] = loc
        elif err:
            doc["location_status"] = f"error: {err}"

    return doc


def format_eta(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, sec = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    if hours > 0:
        return f"{hours}h {minutes}m {sec}s"
    return f"{minutes}m {sec}s"


def process_images(args: argparse.Namespace) -> None:
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")

    root = args.root.expanduser().resolve()
    if not root.exists():
        raise FileNotFoundError(f"Root directory does not exist: {root}")

    collection = connect_collection(args.mongo_uri, args.db, args.collection)
    files = list(iter_image_files(root, args.extensions, args.include_hidden))
    total = len(files)
    logger.info("Found %d image files to process.", total)

    start_time = time.time()
    processed = inserted = skipped = 0

    for file_path in files:
        processed += 1
        pseudo_path = f"/{file_path.relative_to(root).as_posix()}"

        if collection.count_documents({"_id": pseudo_path}, limit=1):
            skipped += 1
        else:
            exif = extract_exif(file_path)
            doc = build_document(file_path, root, exif)
            collection.insert_one(doc)
            inserted += 1

        elapsed = time.time() - start_time
        rate = processed / elapsed if elapsed > 0 else 0
        eta_seconds = (total - processed) / rate if rate > 0 else 0
        percent = (processed / total) * 100
        logger.info("Processed %d/%d (%.1f%%). ETA ~ %s", processed, total, percent, format_eta(eta_seconds))

    logger.info("Done. Processed=%d, Inserted=%d, Skipped=%d", processed, inserted, skipped)


def main(argv: Optional[Iterable[str]] = None) -> None:
    args = parse_args(argv)
    process_images(args)


if __name__ == "__main__":
    main()
