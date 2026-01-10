"""Utility helpers shared across the Barry Image Viewer codebase."""

from __future__ import annotations

import os
import re
from collections import Counter
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

SUPPORTED_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".bmp",
    ".tif",
    ".tiff",
    ".webp",
}

IGNORED_DIRECTORIES = {".Trash-1000"}
DATE_TOKEN_PATTERN = re.compile(
    r"(?P<year>(?:19|20)\d{2})(?P<sep>[-_/]?)(?P<month>\d{2})(?P=sep)?(?P<day>\d{2})"
)
_SEARCH_SANITIZE_PATTERN = re.compile(r"[^0-9a-z]+")
_MONTH_NAMES = (
    "",
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
)
_MONTH_ABBREVIATIONS = (
    "",
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
)


def is_ignored_name(name: str) -> bool:
    return name in IGNORED_DIRECTORIES or name.startswith(".")


def resolve_relative_path(root: Path, relative: str) -> Path:
    relative_path = Path(relative)
    if relative_path.is_absolute():
        raise ValueError("Absolute paths are not permitted")
    full_path = (root / relative_path).resolve()
    if root == full_path:
        return full_path
    if root not in full_path.parents:
        raise ValueError("Requested path escapes the image root")
    return full_path


def iter_directories(path: Path) -> Iterator[Path]:
    for entry in sorted(path.iterdir(), key=lambda p: p.name.lower()):
        if entry.is_dir() and not is_ignored_name(entry.name):
            yield entry


def iter_images(path: Path) -> Iterator[Path]:
    lowered_exts = {ext.lower() for ext in SUPPORTED_EXTENSIONS}
    for entry in sorted(path.iterdir(), key=lambda p: p.name.lower()):
        if entry.is_file() and entry.suffix.lower() in lowered_exts:
            yield entry


def iter_images_recursive(path: Path, limit: Optional[int] = None) -> Iterator[Path]:
    lowered_exts = {ext.lower() for ext in SUPPORTED_EXTENSIONS}
    count = 0
    for current_root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if not is_ignored_name(d)]
        dirs.sort(key=str.lower)
        for name in sorted(files, key=str.lower):
            if Path(name).suffix.lower() in lowered_exts:
                yield Path(current_root) / name
                count += 1
                if limit is not None and count >= limit:
                    return


def guess_date_hint(relative_path: Path) -> Optional[str]:
    for part in relative_path.parts[::-1]:
        normalized = part.replace("-", "_")
        if len(normalized) == 4 and normalized.isdigit():
            return normalized
        if len(normalized) >= 8 and normalized[:4].isdigit():
            cleaned = normalized.replace("_", "-")
            if cleaned.count("-") >= 2:
                return cleaned
    return None


def relative_path_from_id(value: object) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = value.replace("\\", "/").lstrip("/").strip()
    return normalized or None


def extract_date_value(rel_path: Path) -> tuple[bool, int]:
    text = str(rel_path)
    tokens = [tok for tok in re.split(r"\D+", text) if tok]
    for idx, token in enumerate(tokens):
        if len(token) == 4 and token.startswith(("19", "20")):
            year = token
            month = "00"
            day = "00"
            if idx + 1 < len(tokens) and len(tokens[idx + 1]) == 2:
                candidate_month = int(tokens[idx + 1])
                if 1 <= candidate_month <= 12:
                    month = f"{candidate_month:02d}"
                    if idx + 2 < len(tokens) and len(tokens[idx + 2]) == 2:
                        candidate_day = int(tokens[idx + 2])
                        if 1 <= candidate_day <= 31:
                            day = f"{candidate_day:02d}"
            return True, int(f"{year}{month}{day}")
    return False, 0


def parse_date_label(text: str) -> Optional[datetime]:
    normalized = (text or "").strip()
    if not normalized:
        return None

    def build_date(year: int, month: int, day: int) -> Optional[datetime]:
        try:
            return datetime(year, month, day)
        except ValueError:
            return None

    cleaned = normalized.replace("_", "-").replace("/", "-").replace(".", "-")
    match = re.fullmatch(r"(?P<year>\d{4})-(?P<month>\d{1,2})-(?P<day>\d{1,2})", cleaned)
    if match:
        return build_date(int(match.group("year")), int(match.group("month")), int(match.group("day")))

    digits = re.sub(r"\D", "", normalized)
    if len(digits) >= 8:
        year = int(digits[:4])
        month = int(digits[4:6])
        day = int(digits[6:8])
        parsed = build_date(year, month, day)
        if parsed:
            return parsed

    match = DATE_TOKEN_PATTERN.search(normalized)
    if match:
        year = int(match.group("year"))
        month = int(match.group("month"))
        day = int(match.group("day"))
        parsed = build_date(year, month, day)
        if parsed:
            return parsed

    for fmt in ("%B %d %Y", "%b %d %Y", "%B %d, %Y", "%b %d, %Y", "%d %B %Y", "%d %b %Y"):
        try:
            return datetime.strptime(normalized, fmt)
        except ValueError:
            continue

    return None


def format_display_date(label: str) -> Optional[str]:
    parsed = parse_date_label(label)
    if parsed:
        return parsed.strftime("%B %d, %Y").replace(" 0", " ")
    return None


def format_date_value(value: int) -> Optional[str]:
    if not value:
        return None
    year = value // 10000
    month = (value % 10000) // 100
    day = value % 100
    try:
        parsed = datetime(year, month, day)
    except ValueError:
        return None
    return parsed.strftime("%B %d, %Y").replace(" 0", " ")


def normalize_search_text(value: object) -> str:
    text = _SEARCH_SANITIZE_PATTERN.sub(" ", str(value or "").lower())
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def date_tokens_from_value(date_value: int) -> List[str]:
    if not isinstance(date_value, int) or date_value <= 0:
        return []
    year = date_value // 10000
    month = (date_value % 10000) // 100
    day = date_value % 100
    if not (1 <= month <= 12 and 1 <= day <= 31 and year > 0):
        return []
    padded_month = f"{month:02d}"
    padded_day = f"{day:02d}"
    tokens = [
        f"{year:04d}{padded_month}{padded_day}",
        f"{year:04d} {padded_month} {padded_day}",
        f"{padded_month} {padded_day} {year:04d}",
        f"{padded_day} {padded_month} {year:04d}",
    ]
    month_name = _MONTH_NAMES[month]
    month_abbr = _MONTH_ABBREVIATIONS[month]
    if month_name:
        tokens.append(f"{month_name} {day} {year}")
        tokens.append(f"{day} {month_name} {year}")
    if month_abbr:
        tokens.append(f"{month_abbr} {day} {year}")
        tokens.append(f"{day} {month_abbr} {year}")
    return tokens


def build_search_haystack(parts: Iterable[object], date_value: Optional[int] = None) -> str:
    tokens: List[str] = []
    for part in parts:
        normalized = normalize_search_text(part)
        if normalized:
            tokens.append(normalized)

    extras: List[str] = []
    if isinstance(date_value, int) and date_value > 0:
        extras = date_tokens_from_value(date_value)

    if not extras:
        for part in parts:
            parsed = parse_date_label(str(part))
            if parsed:
                fallback_value = parsed.year * 10000 + parsed.month * 100 + parsed.day
                extras = date_tokens_from_value(fallback_value)
                if extras:
                    break

    for extra in extras:
        normalized_extra = normalize_search_text(extra)
        if normalized_extra:
            tokens.append(normalized_extra)

    if not tokens:
        return ""

    deduped = list(dict.fromkeys(tokens))
    return " ".join(deduped)


def date_value_from_datetime(value: object) -> Optional[int]:
    if isinstance(value, datetime):
        target = value.date()
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        text = text.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        target = parsed.date()
    else:
        return None
    return target.year * 10000 + target.month * 100 + target.day


def date_value_from_iso(value: object) -> Optional[int]:
    if isinstance(value, datetime):
        dt_obj = value
    elif isinstance(value, str):
        try:
            dt_obj = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    return dt_obj.year * 10000 + dt_obj.month * 100 + dt_obj.day


def format_date_iso(value: int) -> Optional[str]:
    if not isinstance(value, int) or value <= 0:
        return None
    year = value // 10000
    month = (value % 10000) // 100
    day = value % 100
    try:
        return f"{year:04d}-{month:02d}-{day:02d}"
    except ValueError:
        return None


def format_location_label(location: object) -> Optional[str]:
    if not isinstance(location, dict):
        return None

    address = location.get("address")
    if not isinstance(address, dict):
        address = {}

    components: List[str] = []
    primary_keys = ("city", "town", "village", "hamlet", "suburb", "municipality")
    for key in primary_keys:
        value = address.get(key)
        if value:
            components.append(str(value))
            break

    if not components:
        for key in ("neighbourhood", "county", "state_district"):
            value = address.get(key)
            if value:
                components.append(str(value))
                break

    road = address.get("road")
    if road and not components:
        components.append(str(road))

    state = address.get("state") or address.get("region") or address.get("province")
    if state:
        components.append(str(state))

    country = address.get("country")
    if country:
        components.append(str(country))

    poi = location.get("poi")
    if isinstance(poi, dict):
        name = poi.get("name")
        if name:
            components.insert(0, str(name))

    deduped: List[str] = []
    seen = set()
    for part in components:
        normalized = part.strip()
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(normalized)

    if deduped:
        return ", ".join(deduped)

    raw = location.get("raw")
    if isinstance(raw, dict):
        display = raw.get("display_name")
        if display:
            return str(display)

    return None


def clean_exif_string(value: str) -> str:
    cleaned = value.replace("\x00", " ")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def normalize_exif_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        for encoding in ("utf-8", "latin-1"):
            try:
                decoded = value.decode(encoding, errors="ignore")
                if decoded:
                    return clean_exif_string(decoded)
            except Exception:
                continue
        return value.hex()
    if isinstance(value, (list, tuple, set)):
        parts = [normalize_exif_value(part) for part in value]
        filtered = [part for part in parts if part]
        return ", ".join(filtered)
    if isinstance(value, dict):
        pieces = []
        for key, sub_value in value.items():
            normalized = normalize_exif_value(sub_value)
            if normalized:
                pieces.append(f"{key}: {normalized}")
        return "; ".join(pieces)
    return clean_exif_string(str(value))


def sanitize_zip_component(component: str, fallback: str = "item") -> str:
    cleaned = re.sub(r"[^\w\-.]+", "_", component or "")
    cleaned = cleaned.strip("._")
    return cleaned or fallback


def is_year_label(text: object) -> bool:
    if not isinstance(text, str):
        return False
    stripped = text.strip()
    return len(stripped) == 4 and stripped.isdigit()


def to_pure_posix(path: str) -> PurePosixPath:
    return PurePosixPath(path.replace("\\", "/"))


def summarize_locations(location_counts: Dict[str, Counter], key: str) -> Optional[str]:
    counter = location_counts.get(key)
    if not counter:
        return None
    return counter.most_common(1)[0][0]
