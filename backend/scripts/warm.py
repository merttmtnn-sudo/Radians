"""Fill the caches for the demo targets: python scripts/warm.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.main import warm  # noqa: E402

warm()
