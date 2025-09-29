#!/usr/bin/env python3
"""Barry Image Viewer web application."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import mimetypes
import os
import re
import time
import zipfile
from datetime import datetime
from http import HTTPStatus
import http.server
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple
from urllib.parse import parse_qs, unquote, urlparse

from PIL import Image, ImageOps

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
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8765
DEFAULT_ROOT = Path("/home/barry/bobby/pictures")
STATIC_DIR = Path(__file__).with_name("static")
THUMBNAIL_DEFAULT_SIZE = 320
THUMBNAIL_CACHE_DIR = Path(__file__).with_name(".thumbnail_cache")
THUMBNAIL_PLACEHOLDER_PATH = STATIC_DIR / "thumbnail-placeholder.svg"
IMAGE_CACHE_TTL_SECONDS = 30

_IMAGE_CACHE: Dict[str, object] = {
    "root": None,
    "generated": 0.0,
    "paths": [],
    "hierarchy_root": None,
    "hierarchy_generated": 0.0,
    "hierarchy": None,
}

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")


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


def build_breadcrumbs(root: Path, target: Path) -> List[Dict[str, str]]:
    breadcrumbs = [{"name": "Home", "path": ""}]
    if target == root:
        return breadcrumbs
    relative = target.relative_to(root)
    accumulated = Path()
    for segment in relative.parts:
        accumulated = accumulated / segment
        breadcrumbs.append({
            "name": segment,
            "path": str(accumulated).replace(os.sep, "/"),
        })
    return breadcrumbs


def first_image_in_tree(path: Path) -> Optional[Path]:
    for image_path in iter_images_recursive(path, limit=1):
        return image_path
    return None


def next_folder_first_image(root: Path, target: Path) -> Optional[Path]:
    if target == root:
        for candidate in iter_directories(root):
            found = first_image_in_tree(candidate)
            if found:
                return found
        return None

    parent = target.parent
    siblings = [d for d in iter_directories(parent)]
    try:
        current_index = siblings.index(target)
    except ValueError:
        current_index = -1

    for candidate in siblings[current_index + 1 :]:
        found = first_image_in_tree(candidate)
        if found:
            return found

    if parent == root:
        parent_siblings = [d for d in iter_directories(root)]
        try:
            parent_index = parent_siblings.index(parent)
        except ValueError:
            parent_index = -1
        for candidate in parent_siblings[parent_index + 1 :]:
            found = first_image_in_tree(candidate)
            if found:
                return found
        return None

    return next_folder_first_image(root, parent)


def directory_payload(root: Path, target: Path) -> Dict[str, object]:
    relative = (
        ""
        if target == root
        else str(target.relative_to(root)).replace(os.sep, "/")
    )
    directories = []
    for directory in iter_directories(target):
        rel_path = str(directory.relative_to(root)).replace(os.sep, "/")
        has_images = any(iter_images_recursive(directory, limit=1))
        directories.append(
            {
                "name": directory.name,
                "path": rel_path,
                "hasImages": has_images,
            }
        )

    images = []
    for image_path in iter_images(target):
        rel_path = str(image_path.relative_to(root)).replace(os.sep, "/")
        date_hint = guess_date_hint(image_path.relative_to(root))
        images.append(
            {
                "name": image_path.name,
                "path": rel_path,
                "dateHint": date_hint,
                "size": image_path.stat().st_size,
            }
        )

    next_image = next_folder_first_image(root, target)

    return {
        "path": relative,
        "breadcrumbs": build_breadcrumbs(root, target),
        "directories": directories,
        "images": images,
        "totalImages": len(images),
        "nextFolderImage": (
            str(next_image.relative_to(root)).replace(os.sep, "/") if next_image else None
        ),
    }


def search_directories(root: Path, query: str, limit: int = 50) -> List[Dict[str, str]]:
    normalized_query = query.strip()
    if not normalized_query:
        return []

    normalized_query = normalized_query.lower().replace("-", "_")
    results: List[Dict[str, str]] = []
    seen_paths: set[str] = set()

    for current_root, dirs, _files in os.walk(root):
        dirs[:] = [d for d in dirs if not is_ignored_name(d)]
        for directory in sorted(dirs, key=str.lower):
            dir_path = Path(current_root) / directory
            relative = str(dir_path.relative_to(root)).replace(os.sep, "/")
            haystack = relative.lower().replace("-", "_")
            if normalized_query in haystack:
                if relative not in seen_paths:
                    seen_paths.add(relative)
                    results.append(
                        {
                            "name": directory,
                            "path": relative,
                        }
                    )
                if len(results) >= limit:
                    return results

    if len(results) < limit:
        for image_path in iter_images_recursive(root):
            relative = str(image_path.relative_to(root)).replace(os.sep, "/")
            haystack = relative.lower().replace("-", "_")
            if normalized_query in haystack:
                directory_path = str(image_path.parent.relative_to(root)).replace(os.sep, "/")
                if directory_path not in seen_paths:
                    seen_paths.add(directory_path)
                    results.append(
                        {
                            "name": image_path.parent.name,
                            "path": directory_path,
                        }
                    )
                if len(results) >= limit:
                    break
    return results


def _extract_date_value(rel_path: Path) -> tuple[bool, int]:
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


DATE_TOKEN_PATTERN = re.compile(r"(?P<year>(?:19|20)\d{2})(?P<sep>[-_/]?)(?P<month>\d{2})(?P=sep)?(?P<day>\d{2})")

def _parse_date_label(text: str) -> Optional[datetime]:
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

    for fmt in ("%B %d %Y", "%b %d %Y", "%B %d, %Y", "%b %d, %Y", "%d %B %Y", "%d %b %Y"):
        try:
            return datetime.strptime(normalized, fmt)
        except ValueError:
            continue

    return None


def format_display_date(label: str) -> Optional[str]:
    date_obj = _parse_date_label(label)
    if not date_obj:
        return None
    return f"{date_obj:%B} {date_obj.day}, {date_obj.year}"


def format_date_value(value: int) -> Optional[str]:
    if not isinstance(value, int) or value <= 0:
        return None
    year = value // 10000
    month = (value % 10000) // 100
    day = value % 100
    try:
        return datetime(year, month, day).strftime("%B %d, %Y").replace(" 0", " ")
    except ValueError:
        return None
def sanitize_zip_component(component: str, fallback: str = "item") -> str:
    cleaned = re.sub(r"[\\/:*?\"<>|]+", "_", component).strip()
    cleaned = cleaned.replace("\0", "_")
    if not cleaned:
        return fallback
    return cleaned


def sorted_image_paths(root: Path, order: str = "desc") -> List[str]:
    cache_root = _IMAGE_CACHE["root"]
    now = time.time()
    if cache_root == root and now - float(_IMAGE_CACHE["generated"]) < IMAGE_CACHE_TTL_SECONDS:
        cache_paths = list(_IMAGE_CACHE["paths"])
    else:
        dated: List[tuple[int, str]] = []
        undated: List[str] = []
        for image_path in iter_images_recursive(root):
            relative = str(image_path.relative_to(root)).replace(os.sep, "/")
            has_date, value = _extract_date_value(Path(relative))
            if has_date:
                dated.append((value, relative))
            else:
                undated.append(relative)

        dated.sort(key=lambda item: (item[0], item[1].lower()))
        undated.sort(key=lambda path: path.lower())
        cache_paths = [path for _value, path in dated] + undated

        _IMAGE_CACHE["root"] = root
        _IMAGE_CACHE["generated"] = now
        _IMAGE_CACHE["paths"] = cache_paths

    if order == "asc":
        return list(cache_paths)

    dated_paths = []
    undated_paths = []
    for path in cache_paths:
        has_date, _ = _extract_date_value(Path(path))
        if has_date:
            dated_paths.append(path)
        else:
            undated_paths.append(path)
    dated_paths.reverse()
    return dated_paths + undated_paths


def timeline_sections(
    root: Path, cursor: Optional[str], limit: int, order: str = "desc"
) -> Dict[str, object]:
    paths = sorted_image_paths(root, order)
    if not paths:
        return {"sections": [], "nextCursor": None}

    start_index = 0
    if cursor:
        cursor = cursor.replace(os.sep, "/")
        try:
            start_index = paths.index(cursor) + 1
        except ValueError:
            start_index = 0

    slice_paths = paths[start_index : start_index + limit]
    if not slice_paths:
        return {"sections": [], "nextCursor": None}

    sections: List[Dict[str, object]] = []
    current_label: Optional[str] = None
    current_items: List[Dict[str, object]] = []

    for rel_path_str in slice_paths:
        rel_path = Path(rel_path_str)
        hint = guess_date_hint(rel_path)
        label = hint or rel_path.parent.name or "Unknown"
        if label != current_label:
            if current_items:
                sections.append({"label": current_label, "items": current_items})
            current_label = label
            current_items = []
        current_items.append(
            {
                "name": rel_path.name,
                "path": rel_path_str,
                "dateHint": hint or label,
            }
        )

    if current_items:
        sections.append({"label": current_label, "items": current_items})

    next_cursor = None
    if start_index + len(slice_paths) < len(paths):
        next_cursor = slice_paths[-1]

    return {"sections": sections, "nextCursor": next_cursor}


def build_hierarchy(root: Path) -> Dict[str, object]:
    cache_root = _IMAGE_CACHE.get("hierarchy_root")
    now = time.time()
    cached_hierarchy = _IMAGE_CACHE.get("hierarchy")
    if (
        cached_hierarchy
        and cache_root == root
        and now - float(_IMAGE_CACHE.get("hierarchy_generated", 0.0)) < IMAGE_CACHE_TTL_SECONDS
    ):
        return cached_hierarchy

    top_groups: Dict[str, Dict[str, object]] = {}
    images_by_group: Dict[str, List[Dict[str, object]]] = {}

    for image_path in iter_images_recursive(root):
        relative_str = str(image_path.relative_to(root)).replace(os.sep, "/")
        rel_path = Path(relative_str)
        parts = rel_path.parts
        if not parts:
            continue

        top_key = parts[0]
        top_label = top_key
        if len(parts) >= 2:
            subgroup_key = f"{parts[0]}/{parts[1]}"
            subgroup_label = parts[1]
        else:
            subgroup_key = top_key
            subgroup_label = top_label

        has_date, date_value = _extract_date_value(rel_path)
        date_hint = guess_date_hint(rel_path) or subgroup_label

        image_item = {
            "name": rel_path.name,
            "path": relative_str,
            "dateHint": date_hint,
            "dateValue": date_value,
            "hasDate": has_date,
        }

        images_by_group.setdefault(subgroup_key, []).append(image_item)

        top_entry = top_groups.setdefault(
            top_key,
            {
                "key": top_key,
                "label": top_label,
                "count": 0,
                "maxDate": 0,
                "subgroups": {},
            },
        )
        top_entry["count"] += 1
        if has_date:
            top_entry["maxDate"] = max(top_entry["maxDate"], date_value)

        subgroup_entry = top_entry["subgroups"].setdefault(
            subgroup_key,
            {
                "key": subgroup_key,
                "label": subgroup_label,
                "count": 0,
                "maxDate": 0,
            },
        )
        subgroup_entry["count"] += 1
        if has_date:
            subgroup_entry["maxDate"] = max(subgroup_entry["maxDate"], date_value)

    for group_key, image_list in images_by_group.items():
        image_list.sort(
            key=lambda item: (
                1 if item["hasDate"] else 0,
                item["dateValue"],
                item["path"].lower(),
            ),
            reverse=True,
        )

    top_group_list: List[Dict[str, object]] = []
    for top_entry in top_groups.values():
        subgroups_raw = top_entry["subgroups"].values()
        subgroups_list: List[Dict[str, object]] = []
        for sub in subgroups_raw:
            formatted_label = format_date_value(sub.get("maxDate", 0)) or format_display_date(sub["label"]) or sub["label"]
            subgroup_payload: Dict[str, object] = {
                "key": sub["key"],
                "label": sub["label"],
                "formattedLabel": formatted_label,
                "count": sub["count"],
                "dateValue": sub["maxDate"],
            }
            subgroups_list.append(subgroup_payload)
        subgroups_list.sort(
            key=lambda item: (item["dateValue"], item["key"]), reverse=True
        )
        formatted_top_label = format_display_date(top_entry["label"]) or top_entry["label"]
        top_group_list.append(
            {
                "key": top_entry["key"],
                "label": top_entry["label"],
                "formattedLabel": formatted_top_label,
                "count": top_entry["count"],
                "dateValue": top_entry["maxDate"],
                "subgroups": subgroups_list,
            }
        )

    top_group_list.sort(
        key=lambda item: (item["dateValue"], item["key"]), reverse=True
    )

    hierarchy = {
        "top_groups": top_group_list,
        "images_by_group": images_by_group,
    }

    _IMAGE_CACHE["hierarchy_root"] = root
    _IMAGE_CACHE["hierarchy_generated"] = now
    _IMAGE_CACHE["hierarchy"] = hierarchy
    return hierarchy


def hierarchy_payload(root: Path, order: str) -> Dict[str, object]:
    data = build_hierarchy(root)
    top_groups = data["top_groups"]
    images_by_group = data["images_by_group"]
    reverse = order == "desc"

    ordered_groups: List[Dict[str, object]] = []
    for group in sorted(
        top_groups, key=lambda item: (item["dateValue"], item["key"]), reverse=reverse
    ):
        subgroups_ordered = sorted(
            group["subgroups"],
            key=lambda item: (item["dateValue"], item["key"]),
            reverse=reverse,
        )
        ordered_groups.append(
            {
                "key": group["key"],
                "label": group["label"],
                "formattedLabel": group.get("formattedLabel"),
                "count": group["count"],
                "dateValue": group["dateValue"],
                "subgroups": subgroups_ordered,
            }
        )

    images_payload: Dict[str, List[Dict[str, object]]] = {}
    for group_key, image_list in images_by_group.items():
        sequence = image_list if reverse else list(reversed(image_list))
        images_payload[group_key] = [
            {
                "name": item.get("name"),
                "path": item.get("path"),
                "dateHint": item.get("dateHint"),
                "dateValue": item.get("dateValue"),
            }
            for item in sequence
        ]

    return {
        "groups": ordered_groups,
        "imagesByGroup": images_payload,
        "order": order,
    }


def group_images_payload(
    root: Path,
    group_key: str,
    cursor: Optional[str],
    limit: int,
    order: str,
) -> Dict[str, object]:
    data = build_hierarchy(root)
    images = data["images_by_group"].get(group_key)
    if images is None:
        return {"images": [], "nextCursor": None}

    sequence = images if order == "desc" else list(reversed(images))
    start_index = 0
    if cursor:
        cursor = cursor.replace(os.sep, "/")
        for idx, item in enumerate(sequence):
            if item["path"] == cursor:
                start_index = idx + 1
                break

    slice_items = sequence[start_index : start_index + limit]
    if not slice_items:
        return {"images": [], "nextCursor": None}

    response_images = [
        {
            "name": item["name"],
            "path": item["path"],
            "dateHint": item.get("dateHint"),
        }
        for item in slice_items
    ]

    next_cursor = None
    if start_index + len(slice_items) < len(sequence):
        next_cursor = slice_items[-1]["path"]

    return {"images": response_images, "nextCursor": next_cursor}


def warm_cache(root: Path) -> None:
    """Populate caches eagerly so first request isn't delayed."""
    try:
        sorted_image_paths(root, order="desc")
        build_hierarchy(root)
    except Exception as exc:  # noqa: BLE001 - cache warm failures shouldn't block startup
        print(f"[WARN] Failed to warm caches: {exc}")


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


def generate_thumbnail(image_path: Path, max_size: int) -> Optional[tuple[bytes, str]]:
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


class ImageRequestHandler(http.server.SimpleHTTPRequestHandler):
    root_path: Path = DEFAULT_ROOT

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def do_GET(self) -> None:  # noqa: N802 - standard library signature
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api(parsed)
            return
        if parsed.path in {"", "/"}:
            self.serve_index()
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802 - standard library signature
        parsed = urlparse(self.path)
        if parsed.path == "/api/download":
            self.api_download()
            return
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Unsupported POST endpoint")

    # API handlers
    def handle_api(self, parsed) -> None:
        route = parsed.path
        params = parse_qs(parsed.query or "")
        try:
            if route == "/api/list":
                self.api_list(params)
            elif route == "/api/image":
                self.api_image(params)
            elif route == "/api/thumbnail":
                self.api_thumbnail(params)
            elif route == "/api/search":
                self.api_search(params)
            elif route == "/api/hierarchy":
                self.api_hierarchy(params)
            elif route == "/api/group-images":
                self.api_group_images(params)
            elif route == "/api/timeline":
                self.api_timeline(params)
            else:
                self.send_json({"error": "Unknown endpoint"}, status=HTTPStatus.NOT_FOUND)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
        except FileNotFoundError:
            self.send_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)
        except Exception as exc:  # noqa: BLE001 - report unexpected errors
            self.send_json({"error": f"Unexpected server error: {exc}"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def api_list(self, params: Dict[str, List[str]]) -> None:
        relative = params.get("path", [""])[0]
        relative = unquote(relative)
        target = resolve_relative_path(self.root_path, relative)
        if not target.exists():
            raise FileNotFoundError
        if not target.is_dir():
            target = target.parent
        payload = directory_payload(self.root_path, target)
        self.send_json(payload)

    def api_image(self, params: Dict[str, List[str]]) -> None:
        relative = params.get("path", [""])[0]
        if not relative:
            raise ValueError("Missing image path")
        target = resolve_relative_path(self.root_path, unquote(relative))
        if not target.exists() or not target.is_file():
            raise FileNotFoundError
        self.send_file(target)

    def api_thumbnail(self, params: Dict[str, List[str]]) -> None:
        relative = params.get("path", [""])[0]
        if not relative:
            raise ValueError("Missing image path")
        size_param = params.get("size", [""])[0]
        try:
            max_size = int(size_param) if size_param else THUMBNAIL_DEFAULT_SIZE
        except ValueError as exc:
            raise ValueError("Invalid thumbnail size") from exc
        max_size = max(32, min(1024, max_size))

        target = resolve_relative_path(self.root_path, unquote(relative))
        if not target.exists() or not target.is_file():
            raise FileNotFoundError

        result = generate_thumbnail(target, max_size)
        if result is None:
            if THUMBNAIL_PLACEHOLDER_PATH.exists():
                self.send_file(THUMBNAIL_PLACEHOLDER_PATH)
            else:
                self.send_error(HTTPStatus.NOT_FOUND, "Thumbnail unavailable")
            return

        data, content_type = result
        self.send_binary(data, content_type)

    def api_download(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self.send_json({"error": "Invalid Content-Length"}, status=HTTPStatus.BAD_REQUEST)
            return

        if length <= 0:
            self.send_json({"error": "Request body required"}, status=HTTPStatus.BAD_REQUEST)
            return

        try:
            raw_body = self.rfile.read(length)
        except Exception as exc:  # noqa: BLE001 - stream errors
            self.send_json({"error": f"Unable to read request body: {exc}"}, status=HTTPStatus.BAD_REQUEST)
            return

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            self.send_json({"error": f"Invalid JSON: {exc}"}, status=HTTPStatus.BAD_REQUEST)
            return

        paths = payload.get("paths") if isinstance(payload, dict) else None
        if not isinstance(paths, list) or not paths:
            self.send_json({"error": "No images selected"}, status=HTTPStatus.BAD_REQUEST)
            return

        normalized: List[str] = []
        for item in paths:
            if isinstance(item, str) and item.strip():
                candidate = item.replace("\\", "/").strip()
                normalized.append(unquote(candidate))

        deduped = list(dict.fromkeys(normalized))
        if not deduped:
            self.send_json({"error": "No valid image paths provided"}, status=HTTPStatus.BAD_REQUEST)
            return

        resolved: List[Tuple[str, Path]] = []
        for relative in deduped:
            try:
                target = resolve_relative_path(self.root_path, relative)
            except ValueError:
                self.send_json({"error": f"Invalid path: {relative}"}, status=HTTPStatus.BAD_REQUEST)
                return
            if not target.exists() or not target.is_file():
                self.send_json({"error": f"File not found: {relative}"}, status=HTTPStatus.NOT_FOUND)
                return
            if target.suffix.lower() not in SUPPORTED_EXTENSIONS:
                self.send_json({"error": f"Unsupported file type: {relative}"}, status=HTTPStatus.BAD_REQUEST)
                return
            resolved.append((relative, target))

        if not resolved:
            self.send_json({"error": "No downloadable files found"}, status=HTTPStatus.BAD_REQUEST)
            return

        if len(resolved) == 1:
            _, target = resolved[0]
            filename = sanitize_zip_component(target.name, fallback="image")
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            try:
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="{filename}"',
                )
                self.send_header("Content-Length", str(target.stat().st_size))
                self.end_headers()
                with target.open("rb") as file_obj:
                    while True:
                        chunk = file_obj.read(64_000)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except BrokenPipeError:
                self.log_message("Client closed connection while downloading %s", target)
            return

        hierarchy = build_hierarchy(self.root_path)
        group_lookup: Dict[str, Dict[str, object]] = {}
        for group in hierarchy.get("top_groups", []):
            for subgroup in group.get("subgroups", []):
                group_lookup[subgroup.get("key")] = subgroup

        def group_folder(relative_path: str) -> str:
            parts = Path(relative_path).parts
            if not parts:
                return "images"
            if len(parts) >= 2:
                group_key = f"{parts[0]}/{parts[1]}"
                fallback_label = parts[1]
            else:
                group_key = parts[0]
                fallback_label = parts[0]
            metadata = group_lookup.get(group_key, {})
            label = metadata.get("formattedLabel") or metadata.get("label") or fallback_label
            return sanitize_zip_component(str(label), fallback="images")

        folder_sequence = [group_folder(relative) for relative, _ in resolved]
        unique_folders = list(dict.fromkeys(folder_sequence))
        zip_base = unique_folders[0] if len(unique_folders) == 1 else "selected-images"
        zip_name = sanitize_zip_component(zip_base, fallback="images") + ".zip"

        buffer = io.BytesIO()
        try:
            with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for (relative, target), folder in zip(resolved, folder_sequence):
                    arcname = f"{folder}/{target.name}"
                    archive.write(target, arcname=arcname)
        except Exception as exc:  # noqa: BLE001 - surface zip errors
            self.send_json({"error": f"Failed to build archive: {exc}"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        data = buffer.getvalue()
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/zip")
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{zip_name}"',
            )
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except BrokenPipeError:
            self.log_message("Client closed connection while downloading archive")

    def api_search(self, params: Dict[str, List[str]]) -> None:
        query = params.get("query", [""])[0]
        results = search_directories(self.root_path, query, limit=75)
        self.send_json({"results": results})

    def api_hierarchy(self, params: Dict[str, List[str]]) -> None:
        order = params.get("order", ["desc"])[0].lower()
        if order not in {"asc", "desc"}:
            order = "desc"
        payload = hierarchy_payload(self.root_path, order)
        self.send_json(payload)

    def api_group_images(self, params: Dict[str, List[str]]) -> None:
        group_key = params.get("group", [""])[0]
        if not group_key:
            raise ValueError("Missing group key")
        cursor = params.get("cursor", [None])[0]
        try:
            limit_value = params.get("limit", [""])[0]
            limit = int(limit_value) if limit_value else 120
        except ValueError as exc:
            raise ValueError("Invalid limit") from exc
        limit = max(20, min(500, limit))
        order = params.get("order", ["desc"])[0].lower()
        if order not in {"asc", "desc"}:
            order = "desc"
        payload = group_images_payload(self.root_path, group_key, cursor, limit, order)
        self.send_json(payload)

    def api_timeline(self, params: Dict[str, List[str]]) -> None:
        cursor = params.get("cursor", [None])[0]
        try:
            limit_str = params.get("limit", [""])[0]
            limit = int(limit_str) if limit_str else 120
        except ValueError as exc:
            raise ValueError("Invalid limit") from exc
        limit = max(20, min(500, limit))
        order = params.get("order", ["desc"])[0]
        order = order.lower()
        if order not in {"asc", "desc"}:
            order = "desc"
        payload = timeline_sections(self.root_path, cursor, limit, order=order)
        self.send_json(payload)

    # Helpers
    def serve_index(self) -> None:
        index_path = STATIC_DIR / "index.html"
        if not index_path.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "index.html missing")
            return
        self.path = "/index.html"
        super().do_GET()

    def send_json(self, payload: Dict[str, object], status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        except BrokenPipeError:
            self.log_message("Client closed connection while sending JSON response")

    def send_binary(self, data: bytes, content_type: str) -> None:
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "max-age=86400")
            self.end_headers()
            self.wfile.write(data)
        except BrokenPipeError:
            self.log_message("Client closed connection while sending binary response")

    def send_file(self, path: Path) -> None:
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(path.stat().st_size))
            self.end_headers()
            with path.open("rb") as file_obj:
                while True:
                    chunk = file_obj.read(64_000)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except BrokenPipeError:
            self.log_message("Client closed connection while streaming file %s", path)

    def log_message(self, format: str, *args) -> None:  # noqa: A003 - match base signature
        print(f"[HTTP] {self.address_string()} - {format % args}")


def parse_args(argv: Optional[Iterable[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Barry Image Viewer web server.")
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_ROOT,
        help=f"Root directory containing images (default: {DEFAULT_ROOT})",
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Host to bind (default: {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Port to listen on (default: {DEFAULT_PORT})")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    root_path = args.root.expanduser().resolve()
    if not root_path.exists():
        raise FileNotFoundError(f"Image directory not found: {root_path}")
    if not STATIC_DIR.exists():
        raise FileNotFoundError(f"Static directory missing: {STATIC_DIR}")

    handler_class = ImageRequestHandler
    handler_class.root_path = root_path

    print("Warming caches...")
    warm_cache(root_path)

    server = http.server.ThreadingHTTPServer((args.host, args.port), handler_class)
    print(f"Serving images from {root_path}")
    print(f"Open http://{args.host}:{args.port} in your browser")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
