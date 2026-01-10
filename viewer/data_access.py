"""Database access helpers for Mongo-backed metadata."""

from __future__ import annotations

import json
import re
from typing import Dict, Iterable, List, Optional, Tuple

try:  # Optional dependency for MongoDB metadata support
    from pymongo.collection import Collection
except ImportError:  # pragma: no cover - pymongo may be absent in some environments
    Collection = None  # type: ignore[assignment]

from .utils import (
    build_search_haystack,
    date_value_from_datetime,
    format_date_iso,
    format_date_value,
    relative_path_from_id,
)


class ImageRepository:
    """Encapsulates MongoDB operations for image documents."""

    def __init__(self, collection: Optional["Collection"]) -> None:
        self.collection = collection

    @property
    def available(self) -> bool:
        return self.collection is not None

    def aggregate_documents(
        self,
        match: Optional[Dict[str, object]] = None,
        post_match: Optional[Dict[str, object]] = None,
        sort_direction: int = -1,
        limit: Optional[int] = None,
        log_pipeline: bool = False,
    ) -> List[Dict[str, object]]:
        if not self.available:
            return []

        pipeline: List[Dict[str, object]] = []
        if match:
            pipeline.append({"$match": match})

        pipeline.extend(
            [
                {
                    "$project": {
                        "_id": 1,
                        "image_datetime": 1,
                        "date_specific": 1,
                        "location": 1,
                        "relative_raw": {"$trim": {"input": "$_id", "chars": "/"}},
                    }
                },
                {
                    "$addFields": {
                        "parts_all": {
                            "$filter": {
                                "input": {"$split": ["$relative_raw", "/"]},
                                "cond": {"$ne": ["$$this", ""]},
                            }
                        }
                    }
                },
                {
                    "$addFields": {
                        "topKey": {"$arrayElemAt": ["$parts_all", 0]},
                        "subgroupKey": {
                            "$cond": [
                                {"$gte": [{"$size": "$parts_all"}, 2]},
                                {
                                    "$concat": [
                                        {"$arrayElemAt": ["$parts_all", 0]},
                                        "/",
                                        {"$arrayElemAt": ["$parts_all", 1]},
                                    ]
                                },
                                {"$arrayElemAt": ["$parts_all", 0]},
                            ]
                        },
                        "subgroupLabel": {
                            "$cond": [
                                {"$gte": [{"$size": "$parts_all"}, 2]},
                                {"$arrayElemAt": ["$parts_all", 1]},
                                {"$arrayElemAt": ["$parts_all", 0]},
                            ]
                        },
                    }
                },
                {"$addFields": {"relative": "$relative_raw"}},
                {
                    "$addFields": {
                        "dateValue": {
                            "$let": {
                                "vars": {
                                    "dt": {
                                        "$convert": {
                                            "input": "$image_datetime",
                                            "to": "date",
                                            "onError": None,
                                            "onNull": None,
                                        }
                                    }
                                },
                                "in": {
                                    "$cond": [
                                        {"$ifNull": ["$$dt", False]},
                                        {
                                            "$toInt": {
                                                "$dateToString": {
                                                    "format": "%Y%m%d",
                                                    "date": "$$dt",
                                                    "timezone": "UTC",
                                                }
                                            }
                                        },
                                        0,
                                    ]
                                },
                            }
                        }
                    }
                },
                {
                    "$project": {
                        "_id": 1,
                        "relative": 1,
                        "topKey": 1,
                        "subgroupKey": 1,
                        "subgroupLabel": 1,
                        "image_datetime": 1,
                        "date_specific": 1,
                        "location": 1,
                        "dateValue": 1,
                    }
                },
            ]
        )

        if post_match:
            pipeline.append({"$match": post_match})

        pipeline.append({"$sort": {"dateValue": sort_direction, "relative": 1}})
        if limit and isinstance(limit, int) and limit > 0:
            pipeline.append({"$limit": int(limit)})

        try:
            if log_pipeline:
                coll = self.collection
                assert coll is not None
                db_obj = getattr(coll, "database", None)
                db_name = getattr(db_obj, "name", None) or "<db>"
                coll_name = getattr(coll, "name", None) or "<collection>"
                pipeline_str = json.dumps(pipeline, indent=2)
                print(
                    "[DB] mongo shell copy/paste:\n"
                    f"use {db_name};\n"
                    f"db.{coll_name}.aggregate({pipeline_str});"
                )
            assert self.collection is not None
            return list(self.collection.aggregate(pipeline, allowDiskUse=True))
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] Mongo aggregation failed: {exc}")
            return []

    def fetch_documents(self) -> List[Dict[str, object]]:
        documents = self.aggregate_documents()
        for doc in documents:
            relative = doc.get("relative")
            if not isinstance(relative, str):
                doc["relative"] = relative_path_from_id(doc.get("_id"))
        return documents

    def search_by_filters(
        self,
        *,
        collected_values: Iterable[int],
        start_value: Optional[int],
        end_value: Optional[int],
        log_pipeline: bool = False,
    ) -> List[Dict[str, object]]:
        if not self.available:
            return []

        pipeline: List[Dict[str, object]] = [
            {
                "$addFields": {
                    "_convertedDate": {
                        "$convert": {
                            "input": "$image_datetime",
                            "to": "date",
                            "onError": None,
                            "onNull": None,
                        }
                    }
                }
            },
            {
                "$addFields": {
                    "dateValue": {
                        "$cond": [
                            {"$ifNull": ["$_convertedDate", False]},
                            {
                                "$toInt": {
                                    "$dateToString": {
                                        "format": "%Y%m%d",
                                        "date": "$_convertedDate",
                                        "timezone": "UTC",
                                    }
                                }
                            },
                            None,
                        ]
                    }
                }
            },
        ]

        match_clauses: List[Dict[str, object]] = [{"dateValue": {"$ne": None}}]
        collected_values = list(collected_values)
        if collected_values:
            match_clauses.append({"dateValue": {"$in": sorted(set(collected_values))}})
        if start_value is not None or end_value is not None:
            range_clause: Dict[str, object] = {}
            if start_value is not None:
                range_clause["$gte"] = start_value
            if end_value is not None:
                range_clause["$lte"] = end_value
            match_clauses.append({"dateValue": range_clause})

        if match_clauses:
            pipeline.append({"$match": {"$and": match_clauses}})

        pipeline.extend(
            [
                {
                    "$addFields": {
                        "relative_raw": {"$trim": {"input": "$_id", "chars": "/"}},
                        "parts": {
                            "$filter": {
                                "input": {"$split": [{"$trim": {"input": "$_id", "chars": "/"}}, "/"]},
                                "cond": {"$ne": ["$$this", ""]},
                            }
                        },
                    }
                },
                {
                    "$project": {
                        "relative": "$relative_raw",
                        "subgroupKey": {
                            "$cond": [
                                {"$gte": [{"$size": "$parts"}, 2]},
                                {
                                    "$concat": [
                                        {"$arrayElemAt": ["$parts", 0]},
                                        "/",
                                        {"$arrayElemAt": ["$parts", 1]},
                                    ]
                                },
                                {"$arrayElemAt": ["$parts", 0]},
                            ]
                        },
                        "topKey": {"$arrayElemAt": ["$parts", 0]},
                        "dateValue": "$dateValue",
                    }
                },
            ]
        )

        if log_pipeline:
            pipeline_str = json.dumps(pipeline, indent=2)
            print("[holiday-date] Mongo pipeline:\n" + pipeline_str)

        try:
            assert self.collection is not None
            documents = list(self.collection.aggregate(pipeline, allowDiskUse=True))
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] Mongo aggregation failed: {exc}")
            return []

        return documents

    def find_by_date_values(
        self,
        date_values: Iterable[int],
        log_pipeline: bool = False,
    ) -> List[Dict[str, object]]:
        if not self.available:
            return []

        unique_values = sorted({int(value) for value in date_values if isinstance(value, (int, str)) and str(value).strip()})
        if not unique_values:
            return []

        date_value_expr = {
            "$toInt": {
                "$dateToString": {
                    "format": "%Y%m%d",
                    "date": "$image_datetime",
                    "timezone": "UTC",
                }
            }
        }
        pipeline = [
            {
                "$match": {
                    "$expr": {
                        "$in": [date_value_expr, unique_values],
                    }
                }
            },
            {
                "$project": {
                    "relative_raw": {"$trim": {"input": "$_id", "chars": "/"}},
                    "topKey": {"$arrayElemAt": [{"$split": [{"$trim": {"input": "$_id", "chars": "/"}}, "/"]}, 0]},
                    "subgroupKey": {
                        "$let": {
                            "vars": {
                                "parts": {
                                    "$filter": {
                                        "input": {"$split": [{"$trim": {"input": "$_id", "chars": "/"}}, "/"]},
                                        "cond": {"$ne": ["$$this", ""]},
                                    }
                                }
                            },
                            "in": {
                                "$cond": [
                                    {"$gte": [{"$size": "$$parts"}, 2]},
                                    {
                                        "$concat": [
                                            {"$arrayElemAt": ["$$parts", 0]},
                                            "/",
                                            {"$arrayElemAt": ["$$parts", 1]},
                                        ]
                                    },
                                    {"$arrayElemAt": ["$$parts", 0]},
                                ]
                            },
                        }
                    },
                    "dateValue": date_value_expr,
                }
            },
            {
                "$project": {
                    "relative": "$relative_raw",
                    "topKey": 1,
                    "subgroupKey": 1,
                    "dateValue": 1,
                }
            },
        ]

        if log_pipeline:
            pipeline_str = json.dumps(pipeline, indent=2)
            print("[holiday-date] Mongo pipeline:\n" + pipeline_str)

        try:
            assert self.collection is not None
            return list(self.collection.aggregate(pipeline, allowDiskUse=True))
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] Mongo aggregation failed: {exc}")
            return []


class HolidayRepository:
    """Encapsulates MongoDB operations for the holidays collection."""

    def __init__(self, collection: Optional["Collection"]) -> None:
        self.collection = collection

    @property
    def available(self) -> bool:
        return self.collection is not None

    def resolve_records(self, names: Iterable[str]) -> List[Dict[str, object]]:
        if not self.available:
            return []

        normalized_terms: List[str] = []
        for raw_name in names or []:
            if not raw_name:
                continue
            cleaned = re.sub(r"\s+", " ", str(raw_name)).strip()
            if cleaned:
                normalized_terms.append(cleaned)

        if not normalized_terms:
            return []

        unique_terms = list(dict.fromkeys(normalized_terms))
        results: Dict[tuple[str, int], Dict[str, object]] = {}

        collection = self.collection
        assert collection is not None
        for term in unique_terms:
            pattern = {"$regex": term, "$options": "i"}
            try:
                cursor = collection.find({"name": pattern}, {"name": 1, "date": 1})
            except Exception:
                continue
            for doc in cursor:
                date_value = date_value_from_datetime(doc.get("date"))
                if not date_value:
                    continue
                iso = format_date_iso(date_value)
                if not iso:
                    continue
                resolved_name = str(doc.get("name") or term)
                key = (resolved_name, date_value)
                if key not in results:
                    results[key] = {
                        "name": resolved_name,
                        "dateValue": date_value,
                        "iso": iso,
                        "friendly": format_date_value(date_value) or iso,
                    }

        ordered = sorted(results.values(), key=lambda item: (item["dateValue"], item["name"].lower()))
        return ordered

    def resolve_date_values(self, names: Iterable[str]) -> Tuple[set[int], Dict[int, set[str]]]:
        records = self.resolve_records(names)
        date_values: set[int] = set()
        names_by_value: Dict[int, set[str]] = {}
        for record in records:
            value = int(record["dateValue"])
            date_values.add(value)
            names_by_value.setdefault(value, set()).add(str(record["name"]))
        return date_values, names_by_value


def search_haystack_from_doc(document: Dict[str, object]) -> str:
    parts = (
        document.get("relative"),
        document.get("subgroupLabel") or document.get("relative"),
        document.get("topKey"),
    )
    return build_search_haystack(parts, document.get("dateValue"))
