"""Cross-cutting executor helpers: SDK version probe, GAQL escaping, and the
step-error machinery (`_StepError` + `_step`) that gives publish_v1 its
step-granular partial-success/failure reporting. No dependency on the entity
builders or the publish orchestration — those import from here.

All Google Ads SDK imports are deferred (inside functions) so the pure libs and
tests can import this without google-ads installed.
"""

from __future__ import annotations

from typing import Callable, TypeVar

from ..gaql.escape import gaql_string as _gaql_string  # noqa: F401  (historical name)
from ..lib.schema import FailureStep

T = TypeVar("T")


def _sdk_version() -> str:
    try:
        from importlib.metadata import version

        return version("google-ads")
    except Exception:
        return "unknown"


class _StepError(Exception):
    def __init__(
        self,
        step: FailureStep,
        message: str,
        raw: str | None,
        ad_group_name: str | None = None,
    ) -> None:
        super().__init__(message)
        self.step = step
        self.message = message
        self.raw = raw
        self.ad_group_name = ad_group_name


def _step(name: FailureStep, fn: Callable[[], T], ad_group_name: str | None = None) -> T:
    try:
        return fn()
    except _StepError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _StepError(
            name, _format_google_ads_error(exc), str(exc), ad_group_name=ad_group_name
        ) from exc


def _format_google_ads_error(exc: Exception) -> str:
    try:
        from google.ads.googleads.errors import GoogleAdsException  # type: ignore[import-untyped]

        if isinstance(exc, GoogleAdsException):
            errs = [
                f"{err.error_code}: {err.message} "
                f"(at {'.'.join(part.field_name or '' for part in err.location.field_path_elements)})"
                for err in exc.failure.errors
            ]
            return "; ".join(errs) if errs else str(exc)
    except Exception:
        pass
    return f"{type(exc).__name__}: {exc}"
