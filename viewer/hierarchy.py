"""Hierarchy and grouping helpers for images."""

from __future__ import annotations

import os
from collections import Counter, defaultdict
from typing import Dict, Iterable, List, Optional, Sequence, Tuple
from pathlib import Path, PurePosixPath

from .cache import IMAGE_CACHE
from .data_access import ImageRepository
from .utils import (
    extract_date_value,
    format_date_value,
    format_display_date,
    format_location_label,
    guess_date_hint,
    is_year_label,
    relative_path_from_id,
    summarize_locations,
    to_pure_posix,
)


class HierarchyService:
    def __init__(self, repository: ImageRepository) -> None:
        self.repository = repository

    @property
    def using_database(self) -> bool:
        return self.repository.available

    def build(
        self,
        root: Path,
        *,
        include_images: bool = True,
        use_cache: bool = True,
    ) -> Dict[str, object]:
        if self.using_database:
            return self._build_from_db(include_images=include_images)

        if use_cache:
            cached = IMAGE_CACHE.get_hierarchy(root)
            if cached:
                return cached

        hierarchy = self._build_from_filesystem(root)
        IMAGE_CACHE.set_hierarchy(root, hierarchy)
        return hierarchy

    def random_pool_payload(
        self,
        root: Path,
        start: Optional[int],
        end: Optional[int],
        order: str,
        limit: int,
    ) -> Dict[str, object]:
        normalized = order if order in {"asc", "desc"} else "desc"
        sort_direction = -1 if normalized == "desc" else 1

        post_match: Dict[str, object] = {}
        if isinstance(start, int) and start > 0:
            post_match.setdefault("dateValue", {})["$gte"] = start
        if isinstance(end, int) and end > 0:
            post_match.setdefault("dateValue", {})["$lte"] = end

        if self.using_database:
            documents = self.repository.aggregate_documents(
                post_match=post_match or None,
                sort_direction=sort_direction,
                limit=max(1, min(limit, 20_000)),
            )

            images: List[Dict[str, object]] = []
            for doc in documents:
                relative = doc.get("relative") or relative_path_from_id(doc.get("_id"))
                if not isinstance(relative, str):
                    continue
                rel_path = to_pure_posix(relative)
                parts = rel_path.parts
                if not parts:
                    continue
                top_key = str(doc.get("topKey") or parts[0])
                if len(parts) >= 2:
                    subgroup_key = str(doc.get("subgroupKey") or f"{parts[0]}/{parts[1]}")
                else:
                    subgroup_key = str(doc.get("subgroupKey") or top_key)

                images.append(
                    {
                        "path": relative,
                        "groupKey": subgroup_key,
                        "topKey": top_key,
                        "dateValue": doc.get("dateValue") or 0,
                        "dateHint": doc.get("subgroupLabel") or doc.get("relative"),
                    }
                )

            return {"images": images, "order": normalized}

        hierarchy = self.build(root)
        images_by_group = hierarchy.get("images_by_group", {}) or {}
        images: List[Dict[str, object]] = []
        for group_key, items in images_by_group.items():
            for item in items:
                value = item.get("dateValue") or 0
                if start and value and value < start:
                    continue
                if end and value and value > end:
                    continue
                images.append(
                    {
                        "path": item.get("path"),
                        "groupKey": group_key,
                        "topKey": group_key.split("/")[0] if "/" in group_key else group_key,
                        "dateValue": value,
                        "dateHint": item.get("dateHint"),
                    }
                )
        images.sort(key=lambda item: (item["dateValue"], item["path"]))
        return {"images": images[:limit], "order": normalized}

    def hierarchy_payload(self, root: Path, order: str) -> Dict[str, object]:
        normalized = order.lower()
        if normalized not in {"asc", "desc"}:
            normalized = "desc"

        data = self.build(root, include_images=True)
        top_groups = data["top_groups"]
        ordered_groups = self._order_groups(top_groups, normalized)
        images_by_group = data.get("images_by_group", {}) or {}

        images_payload: Dict[str, List[Dict[str, object]]] = {}
        for group_key, image_list in images_by_group.items():
            sequence = image_list if normalized == "desc" else list(reversed(image_list))
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
            "order": normalized,
            "database": self.using_database,
        }

    def groups_payload(self, root: Path, order: str) -> Dict[str, object]:
        normalized = order.lower()
        if normalized not in {"asc", "desc"}:
            normalized = "desc"

        data = self.build(root, include_images=self.using_database)
        top_groups = data.get("top_groups", [])
        ordered_groups = self._order_groups(top_groups, normalized)
        return {"groups": ordered_groups, "order": normalized, "database": self.using_database}

    def group_images_payload(
        self,
        root: Path,
        group_key: str,
        cursor: Optional[str],
        limit: int,
        order: str,
    ) -> Dict[str, object]:
        normalized = order.lower()
        if normalized not in {"asc", "desc"}:
            normalized = "desc"

        if self.using_database:
            return self._group_images_payload_db(group_key, cursor, limit, normalized)

        data = self.build(root)
        images = data["images_by_group"].get(group_key)
        if images is None:
            return {"images": [], "nextCursor": None}

        sequence = images if normalized == "desc" else list(reversed(images))
        start_index = 0
        if cursor:
            cursor = cursor.replace("\\", "/")
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
                "dateValue": item.get("dateValue"),
            }
            for item in slice_items
        ]

        next_cursor = None
        if start_index + len(slice_items) < len(sequence):
            next_cursor = slice_items[-1]["path"]

        return {"images": response_images, "nextCursor": next_cursor}

    def sorted_image_paths(self, root: Path, order: str = "desc") -> List[str]:
        normalized = order if order in {"asc", "desc"} else "desc"
        if self.using_database:
            return self._sorted_image_paths_db(normalized)

        cached_paths = IMAGE_CACHE.get_paths(root)
        if cached_paths is not None:
            cache_paths = list(cached_paths)
        else:
            from .utils import iter_images_recursive  # Lazy import to avoid cycles

            dated: List[Tuple[int, str]] = []
            undated: List[str] = []
            for image_path in iter_images_recursive(root):
                relative = str(image_path.relative_to(root)).replace(os.sep, "/")
                has_date, value = extract_date_value(Path(relative))
                if has_date:
                    dated.append((value, relative))
                else:
                    undated.append(relative)

            dated.sort(key=lambda item: (item[0], item[1].lower()))
            undated.sort(key=lambda path: path.lower())
            cache_paths = [path for _value, path in dated] + undated
            IMAGE_CACHE.mark_paths(root, cache_paths)

        if normalized == "asc":
            return list(cache_paths)

        dated_paths = []
        undated_paths = []
        for path in cache_paths:
            has_date, _ = extract_date_value(Path(path))
            if has_date:
                dated_paths.append(path)
            else:
                undated_paths.append(path)
        dated_paths.reverse()
        return dated_paths + undated_paths

    def _sorted_image_paths_db(self, order: str) -> List[str]:
        documents = self.repository.fetch_documents()
        dated: List[Tuple[int, str]] = []
        undated: List[str] = []
        for doc in documents:
            relative = doc.get("relative") or relative_path_from_id(doc.get("_id"))
            if not relative:
                continue
            rel_path = to_pure_posix(relative)
            subgroup_label = str(doc.get("subgroupLabel") or rel_path.parent.name or rel_path.name)
            _manifest, has_date, date_value = self._build_manifest_entry(
                rel_path,
                relative,
                subgroup_label,
                doc,
            )
            if has_date and date_value:
                dated.append((date_value, relative))
            else:
                undated.append(relative)

        dated.sort(key=lambda item: (item[0], item[1].lower()))
        undated.sort(key=lambda path: path.lower())
        ordered = [path for _value, path in dated] + undated

        if order == "asc":
            return ordered

        dated_paths = []
        undated_paths = []
        for path in ordered:
            has_date, _ = extract_date_value(Path(path))
            if has_date:
                dated_paths.append(path)
            else:
                undated_paths.append(path)
        dated_paths.reverse()
        return dated_paths + undated_paths

    def timeline_sections(
        self,
        root: Path,
        cursor: Optional[str],
        limit: int,
        order: str,
    ) -> Dict[str, object]:
        normalized = order if order in {"asc", "desc"} else "desc"
        paths = self.sorted_image_paths(root, normalized)
        if not paths:
            return {"sections": [], "nextCursor": None}

        start_index = 0
        if cursor:
            cursor = cursor.replace("\\", "/")
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

    # Internal helpers -----------------------------------------------------

    def _build_from_db(self, *, include_images: bool) -> Dict[str, object]:
        documents = self.repository.fetch_documents()
        top_groups, location_counts, images_by_group = self._accumulate_documents(
            documents,
            include_images=include_images,
        )

        if include_images and images_by_group is not None:
            for manifest in images_by_group.values():
                manifest.sort(
                    key=lambda item: (
                        1 if item.get("hasDate") else 0,
                        item.get("dateValue", 0),
                        (item.get("path") or "").lower(),
                    ),
                    reverse=True,
                )

        result: Dict[str, object] = {
            "top_groups": self._finalize_top_groups(top_groups, location_counts),
        }
        if include_images and images_by_group is not None:
            result["images_by_group"] = images_by_group
        return result

    def _build_from_filesystem(self, root: Path) -> Dict[str, object]:
        from .utils import iter_images_recursive  # avoid cycle

        top_groups: Dict[str, Dict[str, object]] = {}
        images_by_group: Dict[str, List[Dict[str, object]]] = {}

        for image_path in iter_images_recursive(root):
            relative_str = str(image_path.relative_to(root)).replace("\\", "/")
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

            has_date, date_value = extract_date_value(rel_path)
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

        top_group_list = []
        location_counts: Dict[str, Counter] = {}
        for top_entry in top_groups.values():
            subgroups_raw = top_entry["subgroups"].values()
            subgroups_list: List[Dict[str, object]] = []
            for sub in subgroups_raw:
                formatted_label = (
                    format_date_value(sub.get("maxDate", 0))
                    or format_display_date(sub["label"])
                    or sub["label"]
                )
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
            if not is_year_label(top_entry["label"]):
                top_entry["maxDate"] = 0
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

        return {
            "top_groups": top_group_list,
            "images_by_group": images_by_group,
        }

    def _accumulate_documents(
        self,
        documents: Iterable[Dict[str, object]],
        *,
        include_images: bool,
    ) -> Tuple[
        Dict[str, Dict[str, object]],
        Dict[str, Counter],
        Optional[Dict[str, List[Dict[str, object]]]],
    ]:
        top_groups: Dict[str, Dict[str, object]] = {}
        location_counts: Dict[str, Counter] = defaultdict(Counter)
        images_by_group: Optional[Dict[str, List[Dict[str, object]]]] = {} if include_images else None

        for doc in documents:
            relative = doc.get("relative") or relative_path_from_id(doc.get("_id"))
            if not isinstance(relative, str):
                continue

            rel_path = to_pure_posix(relative)
            parts = rel_path.parts
            if not parts:
                continue

            top_key = str(doc.get("topKey") or parts[0])
            subgroup_key = str(doc.get("subgroupKey") or (f"{parts[0]}/{parts[1]}" if len(parts) >= 2 else parts[0]))
            subgroup_label = str(doc.get("subgroupLabel") or (parts[1] if len(parts) >= 2 else parts[0]))

            has_date = bool(doc.get("dateValue"))
            date_value = int(doc.get("dateValue") or 0)
            date_hint = guess_date_hint(Path(relative)) or subgroup_label

            top_entry = self._update_group_summary(
                top_groups,
                top_key,
                top_key,
                has_date,
                date_value,
            )

            subgroup_entry = self._update_group_summary(
                top_entry["subgroups"],
                subgroup_key,
                subgroup_label,
                has_date,
                date_value,
            )

            location_label = format_location_label(doc.get("location"))
            if location_label:
                location_counts[subgroup_key][location_label] += 1

            if include_images and images_by_group is not None:
                manifest_entry, has_date_flag, date_value_flag = self._build_manifest_entry(
                    rel_path,
                    relative,
                    subgroup_label,
                    doc,
                )
                if has_date_flag and date_value_flag:
                    subgroup_entry["maxDate"] = max(subgroup_entry.get("maxDate", 0), date_value_flag)
                    top_entry["maxDate"] = max(top_entry.get("maxDate", 0), date_value_flag)
                images_by_group.setdefault(subgroup_key, []).append(manifest_entry)

        return top_groups, location_counts, images_by_group

    def _update_group_summary(
        self,
        summary: Dict[str, object],
        key: str,
        label: str,
        has_date: bool,
        date_value: int,
    ) -> Dict[str, object]:
        record = summary.setdefault(
            key,
            {
                "key": key,
                "label": label,
                "count": 0,
                "maxDate": 0,
                "subgroups": {},
            },
        )
        record["count"] = int(record.get("count", 0)) + 1
        if has_date:
            record["maxDate"] = max(int(record.get("maxDate", 0)), date_value)
        return record

    def _finalize_top_groups(
        self,
        top_groups: Dict[str, Dict[str, object]],
        location_counts: Dict[str, Counter],
    ) -> List[Dict[str, object]]:
        top_group_list: List[Dict[str, object]] = []
        for top_entry in top_groups.values():
            subgroups_values = top_entry["subgroups"].values()
            subgroups_payload: List[Dict[str, object]] = []
            for sub in subgroups_values:
                max_date_value = int(sub.get("maxDate", 0))
                formatted_label = (
                    format_date_value(max_date_value)
                    or format_display_date(str(sub.get("label")))
                    or str(sub.get("label"))
                )
                payload: Dict[str, object] = {
                    "key": sub["key"],
                    "label": sub["label"],
                    "formattedLabel": formatted_label,
                    "count": sub["count"],
                    "dateValue": max_date_value,
                }
                location_label = summarize_locations(location_counts, sub["key"])
                if location_label:
                    payload["location"] = location_label
                subgroups_payload.append(payload)
            subgroups_payload.sort(
                key=lambda item: (item["dateValue"], item["key"]), reverse=True
            )
            formatted_top_label = (
                format_display_date(str(top_entry["label"]))
                or str(top_entry["label"])
            )
            if not is_year_label(top_entry["label"]):
                top_entry["maxDate"] = 0
            top_group_list.append(
                {
                    "key": top_entry["key"],
                    "label": top_entry["label"],
                    "formattedLabel": formatted_top_label,
                    "count": top_entry["count"],
                    "dateValue": top_entry["maxDate"],
                    "subgroups": subgroups_payload,
                }
            )
        top_group_list.sort(
            key=lambda item: (item["dateValue"], item["key"]), reverse=True
        )
        return top_group_list

    def _order_groups(
        self,
        top_groups: Sequence[Dict[str, object]],
        order: str,
    ) -> List[Dict[str, object]]:
        normalized = order if order in {"asc", "desc"} else "desc"
        reverse = normalized == "desc"

        ordered_groups: List[Dict[str, object]] = []
        for group in sorted(
            top_groups,
            key=lambda item: (item.get("dateValue", 0), item.get("key")),
            reverse=reverse,
        ):
            subgroups = group.get("subgroups", []) or []
            subgroups_ordered = sorted(
                subgroups,
                key=lambda item: (item.get("dateValue", 0), item.get("key")),
                reverse=reverse,
            )
            ordered_groups.append(
                {
                    "key": group.get("key"),
                    "label": group.get("label"),
                    "formattedLabel": group.get("formattedLabel"),
                    "count": group.get("count", 0),
                    "dateValue": group.get("dateValue", 0),
                    "subgroups": subgroups_ordered,
                }
            )

        return ordered_groups

    def _build_manifest_entry(
        self,
        rel_path: PurePosixPath,
        relative: str,
        subgroup_label: str,
        doc: Dict[str, object],
    ) -> Tuple[Dict[str, object], bool, int]:
        date_value = int(doc.get("dateValue") or 0)
        has_date = bool(date_value and doc.get("date_specific", True))
        if not date_value:
            from .utils import date_value_from_iso, extract_date_value  # lazy to avoid cycles

            iso_value = date_value_from_iso(doc.get("image_datetime"))
            if iso_value:
                date_value = iso_value
                has_date = bool(doc.get("date_specific", True))
        if not date_value:
            extracted_has_date, extracted_value = extract_date_value(Path(rel_path))
            if extracted_has_date:
                has_date = True
                date_value = extracted_value
        date_hint = guess_date_hint(Path(rel_path)) or subgroup_label
        manifest_entry = {
            "name": rel_path.name,
            "path": relative,
            "dateHint": date_hint,
            "dateValue": date_value,
            "hasDate": has_date,
        }
        return manifest_entry, has_date, date_value

    def _group_images_payload_db(
        self,
        group_key: str,
        cursor: Optional[str],
        limit: int,
        order: str,
    ) -> Dict[str, object]:
        sort_direction = -1 if order == "desc" else 1
        documents = self.repository.aggregate_documents(
            post_match={"subgroupKey": group_key},
            sort_direction=sort_direction,
        )
        if not documents:
            return {"images": [], "nextCursor": None}

        manifest: List[Dict[str, object]] = []
        for doc in documents:
            relative = doc.get("relative") or relative_path_from_id(doc.get("_id"))
            if not relative:
                continue
            rel_path = to_pure_posix(relative)
            parts = rel_path.parts
            subgroup_label = str(doc.get("subgroupLabel") or (parts[1] if len(parts) >= 2 else parts[0]))
            manifest_entry, _has_date, _date_value = self._build_manifest_entry(rel_path, relative, subgroup_label, doc)
            manifest.append(manifest_entry)

        manifest.sort(
            key=lambda item: (
                1 if item.get("hasDate") else 0,
                item.get("dateValue", 0),
                (item.get("path") or "").lower(),
            ),
            reverse=True,
        )
        if order == "asc":
            manifest = list(reversed(manifest))

        start_index = 0
        if cursor:
            cursor_normalized = cursor.replace("\\", "/")
            for idx, item in enumerate(manifest):
                if item.get("path") == cursor_normalized:
                    start_index = idx + 1
                    break

        slice_items = manifest[start_index : start_index + limit]
        if not slice_items:
            return {"images": [], "nextCursor": None}

        next_cursor = None
        if start_index + len(slice_items) < len(manifest):
            next_cursor = slice_items[-1].get("path")

        response_images = [
            {
                "name": item.get("name"),
                "path": item.get("path"),
                "dateHint": item.get("dateHint"),
                "dateValue": item.get("dateValue"),
            }
            for item in slice_items
            if item.get("path")
        ]

        return {"images": response_images, "nextCursor": next_cursor}
