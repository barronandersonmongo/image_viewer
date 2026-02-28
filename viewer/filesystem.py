"""Filesystem-specific helpers for navigating images and directories."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, Iterator, List, Optional

from .utils import (
    guess_date_hint,
    iter_directories,
    iter_images,
    iter_images_recursive,
)


def build_breadcrumbs(root: Path, target: Path) -> List[Dict[str, str]]:
    breadcrumbs = [{"name": "Home", "path": ""}]
    if target == root:
        return breadcrumbs
    relative = target.relative_to(root)
    accumulated = Path()
    for segment in relative.parts:
        accumulated = accumulated / segment
        breadcrumbs.append(
            {
                "name": segment,
                "path": str(accumulated).replace(os.sep, "/"),
            }
        )
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
    relative = "" if target == root else str(target.relative_to(root)).replace(os.sep, "/")
    directories: List[Dict[str, object]] = []

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

    images: List[Dict[str, object]] = []
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
