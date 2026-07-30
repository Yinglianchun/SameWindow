#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations


CONTROL_URL = os.getenv("SAMEWINDOW_CONTROL_URL", "http://127.0.0.1:6081").rstrip("/")
LIFECYCLE_URL = os.getenv("SAMEWINDOW_LIFECYCLE_URL", "http://127.0.0.1:6082").rstrip("/")
FALLBACK_CONTROL_URL = os.getenv("SAMEWINDOW_FALLBACK_CONTROL_URL", "").rstrip("/")
FALLBACK_LIFECYCLE_URL = os.getenv("SAMEWINDOW_FALLBACK_LIFECYCLE_URL", "").rstrip("/")
BACKEND_LEASE_SECONDS = max(
    30,
    int(os.getenv("SAMEWINDOW_BACKEND_LEASE_SECONDS", "600")),
)
MCP_HOST = os.getenv("SAMEWINDOW_MCP_HOST", "127.0.0.1")
MCP_PORT = int(os.getenv("SAMEWINDOW_MCP_PORT", "6083"))
ENABLE_BROWSE_TOGETHER_MCP = os.getenv(
    "SAMEWINDOW_ENABLE_BROWSE_TOGETHER_MCP",
    "0",
).strip().lower() in {"1", "true", "yes", "on"}

READ_ONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=True,
)
WRITE_ACTION = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=False,
    openWorldHint=True,
)
STATE_ACTION = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=True,
)
CLOSE_ACTION = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=False,
    openWorldHint=True,
)

mcp = FastMCP(
    "SameWindow",
    instructions=(
        "Control one browser shared visibly with the user. An already-running local split browser is preferred; "
        "an already-running VPS browser may be used as a fallback. Ordinary browser tools never wake a sleeping "
        "fallback; call shared_browser_lifecycle_start explicitly when neither backend is running. "
        "Take a fresh snapshot before ref-based actions and refresh after navigation or major DOM changes. "
        "Never request or enter passwords, one-time codes, recovery codes, payment data, or other secrets. "
        "Sensitive pages are intentionally blocked from agent automation; ask the user to complete them in the viewer."
    ),
    host=MCP_HOST,
    port=MCP_PORT,
    streamable_http_path="/mcp",
    stateless_http=True,
    json_response=True,
)

_backend_lease_name = ""
_backend_lease_until = 0.0


def _json_request(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    lifecycle: bool = False,
    timeout: float = 25.0,
) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if lifecycle:
        headers["X-SameWindow-Lifecycle"] = "1"
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"SameWindow request failed ({error.code}): {detail}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise RuntimeError(f"SameWindow is unavailable: {error}") from error
    if not isinstance(result, dict):
        raise RuntimeError("SameWindow returned a non-object response")
    if result.get("ok") is False:
        raise RuntimeError(str(result.get("error") or "SameWindow request failed"))
    return result


def _targets() -> list[dict[str, str]]:
    if FALLBACK_CONTROL_URL:
        return [
            {"name": "local", "control": CONTROL_URL, "lifecycle": LIFECYCLE_URL},
            {
                "name": "vps",
                "control": FALLBACK_CONTROL_URL,
                "lifecycle": FALLBACK_LIFECYCLE_URL,
            },
        ]
    return [{"name": "default", "control": CONTROL_URL, "lifecycle": LIFECYCLE_URL}]


def _target_status(target: dict[str, str], timeout: float = 2.5) -> tuple[dict[str, Any] | None, str]:
    lifecycle_url = target.get("lifecycle", "")
    if lifecycle_url:
        try:
            return _json_request(lifecycle_url, "/api/status", timeout=timeout), ""
        except RuntimeError as error:
            lifecycle_error = str(error)
    else:
        lifecycle_error = "no lifecycle endpoint"
    try:
        control = _json_request(target["control"], "/browser/status", timeout=timeout)
        return {
            "ok": True,
            "state": "running",
            "controlReady": True,
            "control": control,
        }, ""
    except RuntimeError as error:
        return None, f"{lifecycle_error}; control: {error}"[:500]


def _is_running(status: dict[str, Any] | None) -> bool:
    return bool(
        isinstance(status, dict)
        and status.get("state") == "running"
        and status.get("controlReady") is not False
    )


def _snapshot(
    targets: list[dict[str, str]],
) -> list[tuple[dict[str, str], dict[str, Any] | None, str]]:
    return [(target, *_target_status(target)) for target in targets]


def _wait_for_target(target: dict[str, str], timeout_seconds: float) -> dict[str, Any] | None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        status, _ = _target_status(target, timeout=2)
        if _is_running(status):
            return status
        time.sleep(0.35)
    return None


def _start_target(target: dict[str, str]) -> dict[str, Any]:
    lifecycle_url = target.get("lifecycle", "")
    if not lifecycle_url:
        raise RuntimeError(
            f"The {target['name']} browser has no remote lifecycle endpoint; start it on that machine."
        )
    result = _json_request(
        lifecycle_url,
        "/api/start",
        method="POST",
        payload={},
        lifecycle=True,
        timeout=55,
    )
    if not _is_running(result):
        result = _wait_for_target(target, 15)
    if not _is_running(result):
        raise RuntimeError(f"The {target['name']} browser did not become ready.")
    return result


def _clear_backend_lease() -> None:
    global _backend_lease_name, _backend_lease_until
    _backend_lease_name = ""
    _backend_lease_until = 0.0


def _active_backend_lease(targets: list[dict[str, str]]) -> str:
    if (
        not _backend_lease_name
        or time.monotonic() >= _backend_lease_until
        or not any(target["name"] == _backend_lease_name for target in targets)
    ):
        _clear_backend_lease()
        return ""
    return _backend_lease_name


def _remember_backend(target: dict[str, str], targets: list[dict[str, str]]) -> None:
    global _backend_lease_name, _backend_lease_until
    if len(targets) < 2:
        return
    _backend_lease_name = target["name"]
    _backend_lease_until = time.monotonic() + BACKEND_LEASE_SECONDS


def _backend_ref(value: Any, targets: list[dict[str, str]]) -> tuple[str, Any]:
    if not isinstance(value, str) or len(targets) < 2:
        return "", value
    for target in targets:
        prefix = f"{target['name']}:"
        if value.startswith(prefix):
            return target["name"], value[len(prefix):]
    return "", value


def _prepare_payload(
    payload: dict[str, Any] | None,
    targets: list[dict[str, str]],
) -> tuple[dict[str, Any] | None, str]:
    if payload is None:
        return None, ""
    clean_payload = dict(payload)
    requested_backends: set[str] = set()
    for key in ("tabRef", "ref"):
        backend, value = _backend_ref(clean_payload.get(key), targets)
        if backend:
            requested_backends.add(backend)
            clean_payload[key] = value
    if len(requested_backends) > 1:
        raise RuntimeError("Browser tab and element refs belong to different browser backends.")
    return clean_payload, next(iter(requested_backends), "")


def _prefix_refs(value: Any, backend: str, split_mode: bool) -> Any:
    if not split_mode:
        return value
    if isinstance(value, list):
        return [_prefix_refs(item, backend, split_mode) for item in value]
    if not isinstance(value, dict):
        return value
    result: dict[str, Any] = {}
    for key, item in value.items():
        if (
            key.lower().endswith("ref")
            and isinstance(item, str)
            and (item.startswith("tab-") or (item.startswith("e") and item[1:].isdigit()))
        ):
            result[key] = f"{backend}:{item}"
        else:
            result[key] = _prefix_refs(item, backend, split_mode)
    return result


def _select_target(
    targets: list[dict[str, str]],
    *,
    requested_backend: str = "",
    stateful_action: bool,
) -> dict[str, str]:
    statuses = _snapshot(targets)
    if requested_backend:
        for target, status, _ in statuses:
            if target["name"] == requested_backend:
                if _is_running(status):
                    return target
                raise RuntimeError(
                    f"The {requested_backend} browser ref is stale because that browser is not running. "
                    "Take a fresh snapshot."
                )
    leased_backend = _active_backend_lease(targets)
    if leased_backend:
        for target, status, _ in statuses:
            if target["name"] != leased_backend:
                continue
            if _is_running(status):
                return target
            if isinstance(status, dict) and status.get("state") == "stopped":
                _clear_backend_lease()
                break
            if stateful_action:
                _clear_backend_lease()
                raise RuntimeError(
                    f"The active {leased_backend} browser changed state. No action was sent to another "
                    "browser backend. Read fresh browser state, then retry."
                )
            raise RuntimeError(
                f"The active {leased_backend} browser is temporarily unavailable; its backend lease is preserved."
            )
    for target, status, _ in statuses:
        if _is_running(status):
            return target
    for target, status, _ in statuses:
        if isinstance(status, dict) and status.get("state") == "starting":
            if _wait_for_target(target, 6):
                return target
    details = "; ".join(
        f"{target['name']}={status.get('state') if isinstance(status, dict) else error or 'offline'}"
        for target, status, error in statuses
    )
    raise RuntimeError(
        f"No SameWindow browser is running ({details}). Ordinary browser tools do not wake the VPS fallback. "
        "Call shared_browser_lifecycle_start explicitly, then retry."
    )


def _control(path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    targets = _targets()
    clean_payload, requested_backend = _prepare_payload(payload, targets)
    target = _select_target(
        targets,
        requested_backend=requested_backend,
        stateful_action=payload is not None,
    )
    result = _json_request(
        target["control"],
        path,
        method="POST" if clean_payload is not None else "GET",
        payload=clean_payload,
    )
    if path not in {"/browser/status", "/browser/watch"}:
        _remember_backend(target, targets)
    result = _prefix_refs(result, target["name"], len(targets) > 1)
    result.setdefault("browserBackend", target["name"])
    return result


def _lifecycle_result(
    statuses: list[tuple[dict[str, str], dict[str, Any] | None, str]],
) -> dict[str, Any]:
    selected = next((item for item in statuses if _is_running(item[1])), None)
    if selected is None:
        selected = next(
            (
                item for item in statuses
                if isinstance(item[1], dict)
                and item[1].get("state") in {"starting", "degraded", "stopping"}
            ),
            None,
        )
    if selected is None:
        selected = next((item for item in reversed(statuses) if isinstance(item[1], dict)), statuses[-1])
    target, status, error = selected
    result = dict(status or {"ok": False, "state": "offline", "error": error or "unavailable"})
    result["browserBackend"] = target["name"]
    result["routing"] = {
        "preference": "local-first" if len(statuses) > 1 else "single",
        "backends": {
            item_target["name"]: {
                "reachable": isinstance(item_status, dict),
                "state": item_status.get("state") if isinstance(item_status, dict) else "offline",
                "controlReady": item_status.get("controlReady") if isinstance(item_status, dict) else False,
                **({"error": item_error} if item_error else {}),
            }
            for item_target, item_status, item_error in statuses
        },
    }
    return result


@mcp.tool(annotations=READ_ONLY)
def shared_browser_lifecycle_status() -> dict[str, Any]:
    """Return whether the local or VPS shared browser is stopped, starting, or ready."""
    return _lifecycle_result(_snapshot(_targets()))


@mcp.tool(annotations=STATE_ACTION)
def shared_browser_lifecycle_start() -> dict[str, Any]:
    """Explicitly start a browser; an already-running local split browser wins."""
    targets = _targets()
    statuses = _snapshot(targets)
    if any(_is_running(status) for _, status, _ in statuses):
        return _lifecycle_result(statuses)
    for target, status, _ in statuses:
        if isinstance(status, dict) and status.get("state") == "starting":
            if _wait_for_target(target, 30):
                return _lifecycle_result(_snapshot(targets))
    _start_target(targets[-1])
    return _lifecycle_result(_snapshot(targets))


@mcp.tool(annotations=STATE_ACTION)
def shared_browser_lifecycle_stop() -> dict[str, Any]:
    """Stop lifecycle-managed browser services while preserving their Chrome profiles."""
    targets = _targets()
    statuses = _snapshot(targets)
    stop_errors: list[str] = []
    for target, status, _ in statuses:
        if not target.get("lifecycle") or not isinstance(status, dict) or status.get("state") == "stopped":
            continue
        try:
            _json_request(
                target["lifecycle"],
                "/api/stop",
                method="POST",
                payload={},
                lifecycle=True,
                timeout=55,
            )
        except RuntimeError as error:
            stop_errors.append(f"{target['name']}: {error}")
    _clear_backend_lease()
    result = _lifecycle_result(_snapshot(targets))
    if stop_errors:
        result["stopErrors"] = stop_errors
    return result


@mcp.tool(annotations=READ_ONLY)
def shared_browser_status() -> dict[str, Any]:
    """Return the control connection and currently selected tab summary."""
    return _control("/browser/status")


@mcp.tool(annotations=READ_ONLY)
def shared_browser_tabs() -> dict[str, Any]:
    """List the tabs open in the shared Chrome with temporary tab references."""
    return _control("/browser/tabs")


@mcp.tool(annotations=WRITE_ACTION)
def shared_browser_open(url: str, new_tab: bool = True, tab_ref: str = "") -> dict[str, Any]:
    """Open an HTTP(S) URL in a new tab or replace the referenced tab."""
    return _control(
        "/browser/open",
        {"url": url, "newTab": new_tab, "tabRef": tab_ref},
    )


@mcp.tool(annotations=STATE_ACTION)
def shared_browser_select(tab_ref: str) -> dict[str, Any]:
    """Bring one shared-browser tab to the visible foreground."""
    return _control("/browser/select", {"tabRef": tab_ref})


@mcp.tool(annotations=CLOSE_ACTION)
def shared_browser_close(tab_ref: str) -> dict[str, Any]:
    """Close a tab, refusing to close the final shared-browser tab."""
    return _control("/browser/close", {"tabRef": tab_ref})


@mcp.tool(annotations=READ_ONLY)
def shared_browser_snapshot(
    tab_ref: str = "",
    limit: int = 50,
    include_pointer_extras: bool = False,
) -> dict[str, Any]:
    """Read visible text and interactive elements from the foreground or referenced tab."""
    return _control(
        "/browser/snapshot",
        {
            "tabRef": tab_ref,
            "limit": limit,
            "includePointerExtras": include_pointer_extras,
        },
    )


@mcp.tool(annotations=WRITE_ACTION)
def shared_browser_click(
    tab_ref: str,
    ref: str,
    wait_after_ms: int = 0,
) -> dict[str, Any]:
    """Click an element reference from the most recent snapshot."""
    return _control(
        "/browser/click",
        {"tabRef": tab_ref, "ref": ref, "waitAfterMs": wait_after_ms},
    )


@mcp.tool(annotations=WRITE_ACTION)
def shared_browser_type(
    tab_ref: str,
    ref: str,
    text: str,
    clear: bool = True,
    submit: bool = False,
) -> dict[str, Any]:
    """Type non-sensitive text into an element reference from the latest snapshot."""
    return _control(
        "/browser/type",
        {
            "tabRef": tab_ref,
            "ref": ref,
            "text": text,
            "clear": clear,
            "submit": submit,
        },
    )


@mcp.tool(annotations=WRITE_ACTION)
def shared_browser_press(tab_ref: str, key: str, wait_after_ms: int = 0) -> dict[str, Any]:
    """Press a keyboard key or shortcut in the referenced tab."""
    return _control(
        "/browser/press",
        {"tabRef": tab_ref, "key": key, "waitAfterMs": wait_after_ms},
    )


if ENABLE_BROWSE_TOGETHER_MCP:

    @mcp.tool(annotations=READ_ONLY)
    def shared_browser_watch_status() -> dict[str, Any]:
        """Return whether the person enabled browse-together observation in the viewer."""
        return _control("/browser/watch")


    @mcp.tool(annotations=READ_ONLY)
    def shared_browser_events(after: int = 0, limit: int = 20) -> dict[str, Any]:
        """Read queued opt-in semantic events after a sequence number."""
        return _control(f"/browser/events?after={max(0, after)}&limit={max(1, min(50, limit))}")


def main() -> None:
    parser = argparse.ArgumentParser(description="SameWindow MCP server")
    parser.add_argument(
        "--transport",
        choices=("stdio", "streamable-http"),
        default=os.getenv("SAMEWINDOW_MCP_TRANSPORT", "stdio"),
    )
    args = parser.parse_args()
    mcp.run(transport=args.transport)


if __name__ == "__main__":
    main()
