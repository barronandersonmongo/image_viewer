"""Search and filtering helpers."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence

from .data_access import ImageRepository
from .utils import (
    build_search_haystack,
    date_value_from_datetime,
    extract_date_value,
    format_date_iso,
    guess_date_hint,
    iter_images_recursive,
    normalize_search_text,
    relative_path_from_id,
)


def search_directories(
    root: Path,
    query: str,
    limit: int = 50,
    holiday_date_values: Optional[Sequence[int]] = None,
    holiday_names_by_value: Optional[Dict[int, Sequence[str]]] = None,
) -> List[Dict[str, object]]:
    normalized_query = normalize_search_text(query)
    if not normalized_query:
        return []

    query_tokens = [token for token in normalized_query.split(" ") if token]
    if not query_tokens:
        return []

    results: List[Dict[str, object]] = []
    results_map: Dict[str, Dict[str, object]] = {}

    def ensure_result_entry(path: str, name: str) -> Dict[str, object]:
        entry = results_map.get(path)
        if entry is None:
            entry = {"name": name, "path": path}
            results_map[path] = entry
            results.append(entry)
        return entry

    holiday_date_values_set = set(holiday_date_values or [])
    holiday_names_lookup: Dict[int, Sequence[str]] = holiday_names_by_value or {}

    for current_root, dirs, _files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for directory in sorted(dirs, key=str.lower):
            dir_path = Path(current_root) / directory
            relative = str(dir_path.relative_to(root)).replace(os.sep, "/")
            hint = guess_date_hint(dir_path.relative_to(root))
            has_date, date_value = extract_date_value(Path(relative))
            haystack = build_search_haystack(
                (relative, directory, hint or ""),
                date_value if has_date else None,
            )
            matches_tokens = haystack and all(token in haystack for token in query_tokens)
            matches_holiday = bool(
                holiday_date_values_set and has_date and date_value in holiday_date_values_set
            )
            if matches_tokens or matches_holiday:
                entry = ensure_result_entry(relative, directory)
                if matches_holiday and date_value in holiday_names_lookup:
                    holiday_set = entry.setdefault("holidayNames", set())
                    holiday_set.update(holiday_names_lookup[date_value])
                if len(results) >= limit:
                    return finalize_search_results(results)

    if len(results) < limit:
        for image_path in iter_images_recursive(root):
            relative = str(image_path.relative_to(root)).replace(os.sep, "/")
            hint = guess_date_hint(image_path.relative_to(root))
            has_date, date_value = extract_date_value(Path(relative))
            haystack = build_search_haystack(
                (
                    relative,
                    image_path.name,
                    image_path.parent.name,
                    hint or "",
                ),
                date_value if has_date else None,
            )
            directory_path = str(image_path.parent.relative_to(root)).replace(os.sep, "/")
            directory_name = image_path.parent.name
            matches_tokens = haystack and all(token in haystack for token in query_tokens)
            matches_holiday = bool(
                holiday_date_values_set and has_date and date_value in holiday_date_values_set
            )
            if matches_tokens or matches_holiday:
                entry = ensure_result_entry(directory_path, directory_name)
                if matches_holiday and date_value in holiday_names_lookup:
                    holiday_set = entry.setdefault("holidayNames", set())
                    holiday_set.update(holiday_names_lookup[date_value])
                if len(results) >= limit:
                    break

    return finalize_search_results(results)


def finalize_search_results(entries: List[Dict[str, object]]) -> List[Dict[str, object]]:
    finalized: List[Dict[str, object]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        result_item: Dict[str, object] = {
            "name": str(entry.get("name", "")),
            "path": str(entry.get("path", "")),
        }
        holiday_names = entry.get("holidayNames")
        if isinstance(holiday_names, set):
            result_item["holidayNames"] = sorted(holiday_names)
        elif isinstance(holiday_names, list):
            result_item["holidayNames"] = holiday_names
        finalized.append(result_item)
    return finalized


def find_images_by_filters(
    root: Path,
    repository: ImageRepository,
    hierarchy_provider: Callable[[], Dict[str, object]],
    *,
    date_values: Optional[Iterable[int]] = None,
    start: Optional[int] = None,
    end: Optional[int] = None,
) -> List[Dict[str, object]]:
    collected_values: set[int] = set()
    if date_values:
        for value in date_values:
            try:
                collected_values.add(int(value))
            except (TypeError, ValueError):
                continue

    start_value = int(start) if isinstance(start, (int, str)) and str(start).strip() else None
    end_value = int(end) if isinstance(end, (int, str)) and str(end).strip() else None

    if not collected_values and start_value is None and end_value is None:
        return []

    results: List[Dict[str, object]] = []
    seen_paths: set[str] = set()

    if repository.available:
        preview_values = sorted(list(collected_values))[:10]
        preview = ", ".join(str(value) for value in preview_values)
        if len(collected_values) > 10:
            preview += ", …"
        print(
            "[holiday-date] Querying MongoDB for filters: values=["
            + preview
            + f"], start={start_value}, end={end_value}"
        )

        documents = repository.search_by_filters(
            collected_values=collected_values,
            start_value=start_value,
            end_value=end_value,
            log_pipeline=True,
        )
        for doc in documents:
            relative = doc.get("relative") or relative_path_from_id(doc.get("_id"))
            if not isinstance(relative, str):
                continue
            if relative in seen_paths:
                continue
            date_value = doc.get("dateValue")
            subgroup_key = doc.get("subgroupKey")
            top_key = doc.get("topKey")
            iso = format_date_iso(int(date_value)) if date_value else None
            results.append(
                {
                    "path": relative,
                    "groupKey": subgroup_key,
                    "topKey": top_key,
                    "dateValue": date_value,
                    "iso": iso,
                }
            )
            seen_paths.add(relative)
        print(f"[holiday-date] Retrieved {len(results)} images from MongoDB.")
        for preview in results[:10]:
            print("  -", preview.get("path"))
        if len(results) > 10:
            print("  - …")
        return results

    hierarchy = hierarchy_provider()
    images_by_group = hierarchy.get("images_by_group", {}) or {}
    for group_key, image_list in images_by_group.items():
        for item in image_list:
            value = item.get("dateValue")
            if collected_values and value not in collected_values:
                continue
            if start_value is not None and (value or 0) < start_value:
                continue
            if end_value is not None and (value or 0) > end_value:
                continue
            if not item.get("path") or item["path"] in seen_paths:
                continue
            results.append(
                {
                    "path": item["path"],
                    "groupKey": group_key,
                    "topKey": group_key.split("/")[0] if "/" in group_key else group_key,
                    "dateValue": value,
                    "iso": format_date_iso(int(value)) if value else None,
                }
            )
            seen_paths.add(item["path"])
    return results


def find_images_by_date_values(
    root: Path,
    repository: ImageRepository,
    hierarchy_provider: Callable[[], Dict[str, object]],
    date_values: Iterable[int],
) -> List[Dict[str, object]]:
    try:
        unique_values = sorted(
            {int(value) for value in date_values if isinstance(value, (int, str)) and str(value).strip()}
        )
    except ValueError:
        unique_values = []
    if not unique_values:
        return []

    results: List[Dict[str, object]] = []
    seen_paths: set[str] = set()

    if repository.available:
        preview = ", ".join(str(value) for value in unique_values[:25])
        if len(unique_values) > 25:
            preview += ", …"
        print("[holiday-date] Querying MongoDB for dateValue IN [" + preview + "]")
        documents = repository.find_by_date_values(unique_values, log_pipeline=True)
        for doc in documents:
            relative = doc.get("relative") or relative_path_from_id(doc.get("_id"))
            if not isinstance(relative, str):
                continue
            if relative in seen_paths:
                continue
            subgroup_key = doc.get("subgroupKey")
            top_key = doc.get("topKey")
            date_value = doc.get("dateValue")
            iso = format_date_iso(int(date_value)) if date_value else None
            results.append(
                {
                    "path": relative,
                    "groupKey": subgroup_key,
                    "topKey": top_key,
                    "dateValue": date_value,
                    "iso": iso,
                }
            )
            seen_paths.add(relative)
        print(f"[holiday-date] Retrieved {len(results)} images from MongoDB.")
        for preview in results[:10]:
            print("  -", preview.get("path"))
        if len(results) > 10:
            print("  - …")
        return results

    hierarchy = hierarchy_provider()
    images_by_group = hierarchy.get("images_by_group", {}) or {}
    lookup = set(unique_values)
    for group_key, image_list in images_by_group.items():
        for item in image_list:
            value = item.get("dateValue")
            if value in lookup and item.get("path"):
                if item["path"] in seen_paths:
                    continue
                results.append(
                    {
                        "path": item["path"],
                        "groupKey": group_key,
                        "topKey": group_key.split("/")[0] if "/" in group_key else group_key,
                        "dateValue": value,
                        "iso": format_date_iso(int(value)) if value else None,
                    }
                )
                seen_paths.add(item["path"])
    return results
