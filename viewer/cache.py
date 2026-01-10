"""In-memory caches used by the image viewer."""

from __future__ import annotations

import time
from typing import Dict, List, Optional, Tuple

from .config import IMAGE_CACHE_TTL_SECONDS, EXIF_CACHE_TTL_SECONDS


class ImageCache:
    """Cache for directory listings and hierarchy payloads."""

    def __init__(self) -> None:
        self._state: Dict[str, object] = {
            "root": None,
            "generated": 0.0,
            "paths": [],
            "hierarchy_root": None,
            "hierarchy_generated": 0.0,
            "hierarchy": None,
        }

    def mark_paths(
        self,
        root_marker: object,
        payload: List[str],
    ) -> None:
        self._state["root"] = root_marker
        self._state["generated"] = time.time()
        self._state["paths"] = payload

    def set_hierarchy(self, root_marker: object, payload: object) -> None:
        self._state["hierarchy_root"] = root_marker
        self._state["hierarchy_generated"] = time.time()
        self._state["hierarchy"] = payload

    def get_paths(self, root_marker: object) -> Optional[List[str]]:
        if (
            self._state.get("root") == root_marker
            and time.time() - float(self._state.get("generated", 0.0)) < IMAGE_CACHE_TTL_SECONDS
        ):
            return list(self._state.get("paths", []))
        return None

    def get_hierarchy(self, root_marker: object) -> Optional[object]:
        if (
            self._state.get("hierarchy_root") == root_marker
            and time.time() - float(self._state.get("hierarchy_generated", 0.0)) < IMAGE_CACHE_TTL_SECONDS
        ):
            return self._state.get("hierarchy")
        return None

    def clear(self) -> None:
        self._state.update(
            {
                "root": None,
                "generated": 0.0,
                "paths": [],
                "hierarchy_root": None,
                "hierarchy_generated": 0.0,
                "hierarchy": None,
            }
        )


class ExifCache:
    """Cache for extracted EXIF metadata."""

    def __init__(self) -> None:
        self._cache: Dict[str, Tuple[float, List[Dict[str, str]]]] = {}

    def get(self, key: str) -> Optional[List[Dict[str, str]]]:
        entry = self._cache.get(key)
        if not entry:
            return None
        generated_at, payload = entry
        if time.time() - generated_at > EXIF_CACHE_TTL_SECONDS:
            self._cache.pop(key, None)
            return None
        return payload

    def set(self, key: str, payload: List[Dict[str, str]]) -> None:
        self._cache[key] = (time.time(), payload)

    def clear(self) -> None:
        self._cache.clear()


IMAGE_CACHE = ImageCache()
EXIF_CACHE = ExifCache()
