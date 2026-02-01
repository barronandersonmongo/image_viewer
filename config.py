"""Application configuration and constants."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# Base paths
PROJECT_ROOT = Path(__file__).resolve().parent
STATIC_DIR = PROJECT_ROOT / "static"
THUMBNAIL_CACHE_DIR = PROJECT_ROOT / ".thumbnail_cache"
THUMBNAIL_PLACEHOLDER_PATH = STATIC_DIR / "thumbnail-placeholder.svg"

# Defaults
BIND_IP = "0.0.0.0"
PORT = 8080
IMAGE_PATH_ROOT = Path("/home/barry/bobby/pictures")
MONGO_URI = "mongodb://barry:barry@192.168.1.9:27017/"
MONGO_DB = "barrydb"
MONGO_COLLECTION = "images"
MONGO_HOLIDAY_COLLECTION = "holidays"
THUMBNAIL_SIZE = 320
IMAGE_CACHE_TTL_SECONDS = 30
EXIF_CACHE_TTL_SECONDS = 300

# Logging defaults
LOG_LEVEL = "INFO"
LOG_FILE_PATH = PROJECT_ROOT / "barry_image_viewer.log"
LOG_MAX_BYTES = 100 * 1024 * 1024
LOG_BACKUP_COUNT = 3


@dataclass(frozen=True)
class MongoConfig:
    """Settings required to connect to MongoDB."""

    uri: str = MONGO_URI
    database: str = MONGO_DB
    image_collection: str = MONGO_COLLECTION
    holiday_collection: str = MONGO_HOLIDAY_COLLECTION


@dataclass
class AppConfig:
    """Aggregate configuration for the image viewer."""

    host: str = BIND_IP
    port: int = PORT
    root: Path = IMAGE_PATH_ROOT
    thumbnail_size: int = THUMBNAIL_SIZE
    mongo: Optional[MongoConfig] = None

    @property
    def using_database(self) -> bool:
        return self.mongo is not None
