"""Project source tree."""

from pathlib import Path
from pkgutil import extend_path

__path__ = extend_path(__path__, __name__)
_legacy_python_host = Path(__file__).resolve().parent.parent / "archive" / "legacy" / "python-host"
if _legacy_python_host.exists():
    legacy_path = str(_legacy_python_host)
    if legacy_path not in __path__:
        __path__.append(legacy_path)
