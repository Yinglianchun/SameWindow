#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


ROOT = Path(__file__).resolve().parent.parent


CORE_TOOLS = {
    "shared_browser_lifecycle_status",
    "shared_browser_lifecycle_start",
    "shared_browser_lifecycle_stop",
    "shared_browser_status",
    "shared_browser_tabs",
    "shared_browser_open",
    "shared_browser_select",
    "shared_browser_close",
    "shared_browser_snapshot",
    "shared_browser_click",
    "shared_browser_type",
    "shared_browser_press",
    "social_feed",
    "social_read",
}

OPTIONAL_BROWSE_TOGETHER_TOOLS = {
    "shared_browser_watch_status",
    "shared_browser_events",
}

REMOVED_TOOLS = {
    "shared_browser_screenshot",
    "shared_browser_cursor_move",
    "shared_browser_user_cursor",
    "shared_browser_watch_set",
}


async def list_tool_names(*, browse_together: bool) -> set[str]:
    environment = dict(os.environ)
    environment["SAMEWINDOW_ENABLE_BROWSE_TOGETHER_MCP"] = "1" if browse_together else "0"
    parameters = StdioServerParameters(
        command=sys.executable,
        args=[str(ROOT / "src" / "mcp_server.py"), "--transport", "stdio"],
        cwd=str(ROOT),
        env=environment,
    )
    async with stdio_client(parameters) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            result = await session.list_tools()
    return {tool.name for tool in result.tools}


async def main() -> None:
    default_names = await list_tool_names(browse_together=False)
    if default_names != CORE_TOOLS:
        raise SystemExit(
            "Default MCP tools differ: "
            f"missing={sorted(CORE_TOOLS - default_names)}, "
            f"unexpected={sorted(default_names - CORE_TOOLS)}"
        )

    optional_names = await list_tool_names(browse_together=True)
    expected_optional = CORE_TOOLS | OPTIONAL_BROWSE_TOGETHER_TOOLS
    if optional_names != expected_optional:
        raise SystemExit(
            "Opt-in MCP tools differ: "
            f"missing={sorted(expected_optional - optional_names)}, "
            f"unexpected={sorted(optional_names - expected_optional)}"
        )

    exposed_removed = REMOVED_TOOLS & (default_names | optional_names)
    if exposed_removed:
        raise SystemExit(f"Removed tools are still exposed: {sorted(exposed_removed)}")

    print(
        f"MCP handshake passed with {len(default_names)} default tools "
        f"and {len(optional_names)} opt-in tools."
    )


if __name__ == "__main__":
    asyncio.run(main())
