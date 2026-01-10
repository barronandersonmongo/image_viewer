"""Application configuration and constants."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# Base paths
PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = PROJECT_ROOT / "static"
THUMBNAIL_CACHE_DIR = PROJECT_ROOT / ".thumbnail_cache"
THUMBNAIL_PLACEHOLDER_PATH = STATIC_DIR / "thumbnail-placeholder.svg"

# Defaults
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8765
DEFAULT_ROOT = Path("/home/barry/bobby/pictures")
DEFAULT_MONGO_URI = "mongodb://192.168.1.8"
DEFAULT_MONGO_DB = "barrydb"
DEFAULT_MONGO_COLLECTION = "images"
DEFAULT_MONGO_HOLIDAY_COLLECTION = "holidays"
THUMBNAIL_DEFAULT_SIZE = 320
IMAGE_CACHE_TTL_SECONDS = 30
EXIF_CACHE_TTL_SECONDS = 300


@dataclass(frozen=True)
class MongoConfig:
    """Settings required to connect to MongoDB."""

    uri: str = DEFAULT_MONGO_URI
    database: str = DEFAULT_MONGO_DB
    image_collection: str = DEFAULT_MONGO_COLLECTION
    holiday_collection: str = DEFAULT_MONGO_HOLIDAY_COLLECTION


@dataclass
class AppConfig:
    """Aggregate configuration for the image viewer."""

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    root: Path = DEFAULT_ROOT
    thumbnail_size: int = THUMBNAIL_DEFAULT_SIZE
    mongo: Optional[MongoConfig] = None

    @property
    def using_database(self) -> bool:
        return self.mongo is not None
