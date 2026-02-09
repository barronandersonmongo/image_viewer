#!/usr/bin/env python3
"""Barry Image Viewer web application."""

from __future__ import annotations

import io
import json
import logging
import logging.handlers
import mimetypes
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
import http.server
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple
from urllib.parse import parse_qs, unquote, urlparse

try:  # Optional dependency for MongoDB metadata support
    from pymongo import MongoClient
    from pymongo.collection import Collection
except ImportError:  # pragma: no cover - pymongo may be absent
    MongoClient = None  # type: ignore[assignment]
    Collection = None  # type: ignore[assignment]

try:  # Optional dependency for Voyage embeddings
    from voyageai import Client as VoyageClient
except ImportError:  # pragma: no cover - voyageai may be absent
    VoyageClient = None  # type: ignore[assignment]

from config import (
    AppConfig,
    MongoConfig,
    BIND_IP,
    PORT,
    IMAGE_PATH_ROOT,
    MONGO_COLLECTION,
    MONGO_DB,
    MONGO_HOLIDAY_COLLECTION,
    MONGO_URI,
    SEMANTIC_SCORE_DEFAULT,
    VOYAGE_API_KEY,
    VOYAGE_EMBEDDING_MODEL,
    STATIC_DIR,
    THUMBNAIL_SIZE,
    THUMBNAIL_PLACEHOLDER_PATH,
    LOG_LEVEL,
    LOG_FILE_PATH,
    LOG_MAX_BYTES,
    LOG_BACKUP_COUNT,
)
from viewer.data_access import HolidayRepository, ImageRepository
from viewer.exif import get_exif_metadata
from viewer.filesystem import directory_payload
from viewer.hierarchy import HierarchyService
from viewer.search import find_images_by_date_values, find_images_by_filters, search_directories
from viewer.thumbnails import generate_thumbnail
from viewer.utils import (
    SUPPORTED_EXTENSIONS,
    date_value_from_datetime,
    resolve_relative_path,
    sanitize_zip_component,
)


mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")


APP_CONFIG = AppConfig()
IMAGE_REPOSITORY = ImageRepository(None)
HOLIDAY_REPOSITORY = HolidayRepository(None)
HIERARCHY_SERVICE = HierarchyService(IMAGE_REPOSITORY)
MONGO_CLIENT: Optional["MongoClient"] = None
VOYAGE_CLIENT: Optional["VoyageClient"] = None
LOGGER = logging.getLogger("barry_image_viewer")


class JsonFormatter(logging.Formatter):
    _standard_attrs = {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "message",
        "module",
        "msecs",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "thread",
        "threadName",
    }

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc)
            .isoformat()
            .replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        for key, value in record.__dict__.items():
            if key not in self._standard_attrs and not key.startswith("_"):
                payload[key] = value
        return json.dumps(payload, ensure_ascii=True)


def _resolve_log_level(level: str) -> int:
    try:
        return int(level)
    except (TypeError, ValueError):
        resolved = logging.getLevelName(str(level).upper())
        return resolved if isinstance(resolved, int) else logging.INFO


def configure_logging() -> None:
    level = _resolve_log_level(LOG_LEVEL)
    formatter = JsonFormatter()

    root_logger = logging.getLogger()
    root_logger.setLevel(level)
    for handler in list(root_logger.handlers):
        root_logger.removeHandler(handler)

    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)

    file_handler = logging.handlers.RotatingFileHandler(
        LOG_FILE_PATH,
        maxBytes=LOG_MAX_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    file_handler.setLevel(level)
    file_handler.setFormatter(formatter)

    root_logger.addHandler(console_handler)
    root_logger.addHandler(file_handler)


def _json_safe(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_safe(val) for key, val in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(val) for val in value]
    return str(value)


class ImageRequestHandler(http.server.SimpleHTTPRequestHandler):
    config: AppConfig = APP_CONFIG
    image_repository: ImageRepository = IMAGE_REPOSITORY
    holiday_repository: HolidayRepository = HOLIDAY_REPOSITORY
    hierarchy_service: HierarchyService = HIERARCHY_SERVICE

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self) -> None:  # noqa: D401 - inherited behavior
        """Attach cache headers for static UI assets before finalizing headers."""
        parsed = urlparse(self.path or "")
        path = parsed.path
        if path == "/" or path.endswith((".html", ".js", ".css")):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    @property
    def root_path(self) -> Path:
        return self.config.root

    def do_GET(self) -> None:  # noqa: N802 - standard library signature
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            params = parse_qs(parsed.query or "")
            self.handle_api(parsed.path, params)
            return
        if parsed.path in {"", "/"}:
            self.serve_index()
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/download":
            self.api_download()
            return
        if parsed.path == "/api/images-by-dates":
            self.api_images_by_dates()
            return
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Unsupported POST endpoint")

    # API handlers -----------------------------------------------------
    def handle_api(self, route: str, params: Dict[str, List[str]]) -> None:
        LOGGER.info(
            "HTTP request",
            extra={"method": "GET", "route": route, "params": params},
        )
        try:
            if route == "/api/list":
                self.api_list(params)
            elif route == "/api/config":
                self.api_config()
            elif route == "/api/image":
                self.api_image(params)
            elif route == "/api/thumbnail":
                self.api_thumbnail(params)
            elif route == "/api/search":
                self.api_search(params)
            elif route == "/api/search-vector":
                self.api_search_vector(params)
            elif route == "/api/exif":
                self.api_exif(params)
            elif route == "/api/groups":
                self.api_groups(params)
            elif route == "/api/hierarchy":
                self.api_hierarchy(params)
            elif route == "/api/random-pool":
                self.api_random_pool(params)
            elif route == "/api/group-images":
                self.api_group_images(params)
            elif route == "/api/timeline":
                self.api_timeline(params)
            elif route == "/api/holiday-dates":
                self.api_holiday_dates(params)
            else:
                self.send_json({"error": "Unknown endpoint"}, status=HTTPStatus.NOT_FOUND)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
        except FileNotFoundError:
            self.send_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)
        except Exception as exc:  # noqa: BLE001 - defensive catch
            self.send_json({"error": f"Unexpected server error: {exc}"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def api_list(self, params: Dict[str, List[str]]) -> None:
        relative = unquote(params.get("path", [""])[0])
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
            max_size = int(size_param) if size_param else self.config.thumbnail_size
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
        except Exception as exc:  # noqa: BLE001
            self.send_json({"error": f"Unable to read request body: {exc}"}, status=HTTPStatus.BAD_REQUEST)
            return

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            self.send_json({"error": f"Invalid JSON: {exc}"}, status=HTTPStatus.BAD_REQUEST)
            return

        LOGGER.info(
            "HTTP request",
            extra={"method": "POST", "route": "/api/download", "length": length},
        )
        paths = payload.get("paths") if isinstance(payload, dict) else None
        if not isinstance(paths, list) or not paths:
            self.send_json({"error": "No images selected"}, status=HTTPStatus.BAD_REQUEST)
            return

        normalized: List[str] = []
        for item in paths:
            if isinstance(item, str) and item.strip():
                normalized.append(unquote(item.replace("\\", "/").strip()))

        deduped = list(dict.fromkeys(normalized))
        if not deduped:
            self.send_json({"error": "No valid image paths provided"}, status=HTTPStatus.BAD_REQUEST)
            return

        resolved: List[Tuple[str, Path]] = []
        for relative in deduped:
            target = resolve_relative_path(self.root_path, relative)
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
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
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

        hierarchy = self.hierarchy_service.build(self.root_path)
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
        except Exception as exc:  # noqa: BLE001
            self.send_json({"error": f"Failed to build archive: {exc}"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        data = buffer.getvalue()
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", f'attachment; filename="{zip_name}"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except BrokenPipeError:
            self.log_message("Client closed connection while downloading archive")

    def api_search(self, params: Dict[str, List[str]]) -> None:
        query = params.get("query", [""])[0]
        holiday_terms = params.get("holiday", [])
        date_values: Sequence[int] = []
        holiday_names: Dict[int, Sequence[str]] = {}
        if holiday_terms:
            values, names_by_value = self.holiday_repository.resolve_date_values(holiday_terms)
            date_values = sorted(values)
            holiday_names = {key: sorted(names) for key, names in names_by_value.items()}
        results = search_directories(
            self.root_path,
            query,
            limit=75,
            holiday_date_values=date_values,
            holiday_names_by_value=holiday_names,
        )
        LOGGER.info(
            "HTTP response",
            extra={"route": "/api/search", "results_count": len(results)},
        )
        self.send_json({"results": results})

    def api_search_vector(self, params: Dict[str, List[str]]) -> None:
        query = params.get("query", [""])[0].strip()
        if not query:
            raise ValueError("Missing search query")
        if VOYAGE_CLIENT is None:
            raise ValueError("Voyage client not configured")
        if not self.image_repository.available:
            raise ValueError("MongoDB metadata unavailable")
        try:
            candidates_value = params.get("candidates", [""])[0]
            candidates = int(candidates_value) if candidates_value else 2000
        except ValueError as exc:
            raise ValueError("Invalid candidates") from exc
        candidates = max(1, min(10000, candidates))
        limit = candidates
        try:
            min_score_value = params.get("min_score", [""])[0]
            min_score = float(min_score_value) if min_score_value else self.config.semantic_score_default
        except ValueError as exc:
            raise ValueError("Invalid min_score") from exc
        min_score = max(0.0, min(1.0, min_score))

        if not isinstance(self.config.voyage_api_key, str) or not self.config.voyage_api_key.strip():
            raise ValueError("Voyage API key missing")

        try:
            embed_result = VOYAGE_CLIENT.multimodal_embed(
                model=self.config.voyage_model,
                inputs=[[query]],
            )
            query_vector = embed_result.embeddings[0]
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"Failed to embed query: {exc}") from exc

        if not isinstance(query_vector, list):
            raise ValueError("Invalid embedding response")

        results = self.image_repository.vector_search(
            query_vector=query_vector,
            limit=limit,
            num_candidates=candidates,
        )
        results = [result for result in results if float(result.get("score") or 0) >= min_score]
        results.sort(key=lambda item: float(item.get("score") or 0), reverse=True)
        LOGGER.info(
            "HTTP response",
            extra={"route": "/api/search-vector", "results_count": len(results)},
        )
        self.send_json({"results": results})

    def api_config(self) -> None:
        payload = {"semantic_score_default": self.config.semantic_score_default}
        LOGGER.info("HTTP response", extra={"route": "/api/config"})
        self.send_json(payload)

    def api_holiday_dates(self, params: Dict[str, List[str]]) -> None:
        names = params.get("name", [])
        LOGGER.info(
            "HTTP request",
            extra={"method": "GET", "route": "/api/holiday-dates", "names": names},
        )
        records = self.holiday_repository.resolve_records(names)
        self.send_json({"results": records})

    def api_images_by_dates(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self.send_json({"error": "Invalid Content-Length"}, status=HTTPStatus.BAD_REQUEST)
            return

        if length <= 0:
            self.send_json({"error": "Request body required"}, status=HTTPStatus.BAD_REQUEST)
            return

        try:
            payload_raw = self.rfile.read(length)
        except Exception as exc:  # noqa: BLE001
            self.send_json({"error": f"Unable to read request body: {exc}"}, status=HTTPStatus.BAD_REQUEST)
            return

        try:
            payload = json.loads(payload_raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            self.send_json({"error": f"Invalid JSON: {exc}"}, status=HTTPStatus.BAD_REQUEST)
            return

        date_values_input = payload.get("dateValues") or []
        iso_dates_input = payload.get("isoDates") or []
        start_filter = payload.get("start")
        end_filter = payload.get("end")
        LOGGER.info(
            "HTTP request",
            extra={
                "method": "POST",
                "route": "/api/images-by-dates",
                "date_values": date_values_input,
                "iso_dates": iso_dates_input,
                "start": start_filter,
                "end": end_filter,
            },
        )

        collected: List[int] = []
        for value in date_values_input:
            try:
                collected.append(int(value))
            except (ValueError, TypeError):
                continue

        for iso in iso_dates_input:
            parsed = date_value_from_datetime(iso)
            if parsed:
                collected.append(parsed)

        start_value = date_value_from_datetime(start_filter) if start_filter else None
        end_value = date_value_from_datetime(end_filter) if end_filter else None

        images = find_images_by_filters(
            self.root_path,
            self.image_repository,
            hierarchy_provider=lambda: self.hierarchy_service.build(self.root_path),
            date_values=collected,
            start=start_value,
            end=end_value,
        )
        LOGGER.info(
            "HTTP response",
            extra={"route": "/api/images-by-dates", "results_count": len(images)},
        )
        self.send_json({"images": images})

    def api_exif(self, params: Dict[str, List[str]]) -> None:
        relative_param = params.get("path", [""])[0]
        if not relative_param:
            raise ValueError("Missing image path")
        resolved_relative = unquote(relative_param)
        normalized = resolved_relative.replace("\\", "/").lstrip("/")
        fields = get_exif_metadata(self.root_path, normalized)
        location = None
        if self.image_repository and self.image_repository.available:
            location = self.image_repository.fetch_location(normalized)
        self.send_json(
            {
                "path": normalized,
                "fields": fields,
                "location": _json_safe(location) if location else None,
            }
        )

    def api_groups(self, params: Dict[str, List[str]]) -> None:
        order = params.get("order", ["desc"])[0].lower()
        LOGGER.info(
            "HTTP request",
            extra={"method": "GET", "route": "/api/groups", "order": order},
        )
        payload = self.hierarchy_service.groups_payload(self.root_path, order)
        self.send_json(payload)

    def api_hierarchy(self, params: Dict[str, List[str]]) -> None:
        order = params.get("order", ["desc"])[0].lower()
        LOGGER.info(
            "HTTP request",
            extra={"method": "GET", "route": "/api/hierarchy", "order": order},
        )
        payload = self.hierarchy_service.hierarchy_payload(self.root_path, order)
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
        payload = self.hierarchy_service.group_images_payload(
            self.root_path,
            group_key,
            cursor,
            limit,
            order,
        )
        LOGGER.info(
            "HTTP response",
            extra={
                "route": "/api/group-images",
                "group": group_key,
                "cursor": cursor,
                "order": order,
                "limit": limit,
                "results_count": len(payload.get("images", [])),
            },
        )
        self.send_json(payload)

    def api_random_pool(self, params: Dict[str, List[str]]) -> None:
        start = params.get("start", [None])[0]
        end = params.get("end", [None])[0]
        try:
            limit_str = params.get("limit", [""])[0]
            limit = int(limit_str) if limit_str else 500
        except ValueError as exc:
            raise ValueError("Invalid limit") from exc
        limit = max(20, min(20_000, limit))
        order = params.get("order", ["desc"])[0]
        start_value = int(start) if start and str(start).isdigit() else None
        end_value = int(end) if end and str(end).isdigit() else None
        payload = self.hierarchy_service.random_pool_payload(
            self.root_path,
            start_value,
            end_value,
            order,
            limit,
        )
        LOGGER.info(
            "HTTP response",
            extra={
                "route": "/api/random-pool",
                "start": start_value,
                "end": end_value,
                "order": order,
                "limit": limit,
                "results_count": len(payload.get("images", [])),
            },
        )
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
        payload = self.hierarchy_service.timeline_sections(
            self.root_path,
            cursor,
            limit,
            order,
        )
        LOGGER.info(
            "HTTP response",
            extra={
                "route": "/api/timeline",
                "cursor": cursor,
                "order": order,
                "limit": limit,
                "results_count": len(payload.get("images", [])),
            },
        )
        self.send_json(payload)

    # Helpers ----------------------------------------------------------
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
        LOGGER.info(
            "HTTP request",
            extra={
                "remote": self.address_string(),
                "detail": format % args,
            },
        )


def build_config() -> AppConfig:
    root_path = IMAGE_PATH_ROOT.expanduser().resolve()
    return AppConfig(
        host=BIND_IP,
        port=PORT,
        root=root_path,
        thumbnail_size=THUMBNAIL_SIZE,
        semantic_score_default=SEMANTIC_SCORE_DEFAULT,
        mongo=MongoConfig(
            uri=MONGO_URI,
            database=MONGO_DB,
            image_collection=MONGO_COLLECTION,
            holiday_collection=MONGO_HOLIDAY_COLLECTION,
        ),
        voyage_api_key=VOYAGE_API_KEY,
        voyage_model=VOYAGE_EMBEDDING_MODEL,
    )


def configure_mongo(config: AppConfig) -> Tuple[Optional["MongoClient"], Optional["Collection"], Optional["Collection"]]:
    if config.mongo is None or MongoClient is None:
        if config.mongo and MongoClient is None:
            LOGGER.warning("pymongo not available; continuing without MongoDB support.")
        return None, None, None

    try:
        client = MongoClient(
            config.mongo.uri,
            tz_aware=True,
            serverSelectionTimeoutMS=5000,
        )
        client.admin.command("ping")
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning(
            "Failed to connect to MongoDB; falling back to filesystem metadata.",
            extra={"mongo_uri": config.mongo.uri, "error": str(exc)},
        )
        return None, None, None

    image_collection = client[config.mongo.database][config.mongo.image_collection]
    holiday_collection = client[config.mongo.database][config.mongo.holiday_collection]
    LOGGER.info(
        "Using MongoDB metadata.",
        extra={
            "mongo_db": image_collection.database.name,
            "mongo_collection": image_collection.name,
        },
    )
    return client, image_collection, holiday_collection


def warm_cache(root: Path) -> None:
    try:
        HIERARCHY_SERVICE.sorted_image_paths(root)
        HIERARCHY_SERVICE.build(root)
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("Failed to warm caches.", extra={"error": str(exc)})


def main() -> None:
    global APP_CONFIG, MONGO_CLIENT, VOYAGE_CLIENT

    configure_logging()
    config = build_config()
    APP_CONFIG = config

    LOGGER.info(
        "Startup parameters.",
        extra={
            "host": config.host,
            "port": config.port,
            "root": str(config.root),
            "semantic_score_default": config.semantic_score_default,
            "mongo_db": config.mongo.database if config.mongo else None,
            "mongo_collection": config.mongo.image_collection if config.mongo else None,
            "mongo_holiday_collection": config.mongo.holiday_collection if config.mongo else None,
            "voyage_model": config.voyage_model,
            "voyage_key_configured": bool(config.voyage_api_key and config.voyage_api_key.strip()),
        },
    )

    if VoyageClient is not None and config.voyage_api_key.strip():
        try:
            VOYAGE_CLIENT = VoyageClient(api_key=config.voyage_api_key.strip())
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning(
                "Failed to initialize Voyage client.",
                extra={"error": str(exc)},
            )
            VOYAGE_CLIENT = None

    if not config.root.exists():
        raise FileNotFoundError(f"Image directory not found: {config.root}")
    if not STATIC_DIR.exists():
        raise FileNotFoundError(f"Static directory missing: {STATIC_DIR}")

    client, image_collection, holiday_collection = configure_mongo(config)
    MONGO_CLIENT = client
    IMAGE_REPOSITORY.collection = image_collection
    HOLIDAY_REPOSITORY.collection = holiday_collection

    handler_class = ImageRequestHandler
    handler_class.config = config
    handler_class.image_repository = IMAGE_REPOSITORY
    handler_class.holiday_repository = HOLIDAY_REPOSITORY
    handler_class.hierarchy_service = HIERARCHY_SERVICE

    warm_cache(config.root)

    server = http.server.ThreadingHTTPServer((config.host, config.port), handler_class)
    LOGGER.info(
        "Server started.",
        extra={
            "root": str(config.root),
            "host": config.host,
            "port": config.port,
        },
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("Shutting down server.")
    finally:
        server.server_close()
        if MONGO_CLIENT is not None:
            MONGO_CLIENT.close()


if __name__ == "__main__":
    main()
