#!/usr/bin/env python3

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import mcp_server as samewindow  # noqa: E402


LOCAL = {
    "name": "local",
    "control": "http://127.0.0.1:16081",
    "lifecycle": "",
}
VPS = {
    "name": "vps",
    "control": "http://127.0.0.1:6081",
    "lifecycle": "http://127.0.0.1:6082",
}


def status(state: str) -> dict:
    return {
        "ok": True,
        "state": state,
        "controlReady": state == "running",
    }


def snapshot(local: str, vps: str):
    return [
        (LOCAL, status(local), ""),
        (VPS, status(vps), ""),
    ]


class SplitRouterTest(unittest.TestCase):
    def setUp(self) -> None:
        samewindow._clear_backend_lease()

    def test_local_browser_is_preferred_and_refs_are_owned(self) -> None:
        with (
            mock.patch.object(samewindow, "_targets", return_value=[LOCAL, VPS]),
            mock.patch.object(samewindow, "_snapshot", return_value=snapshot("running", "stopped")),
            mock.patch.object(
                samewindow,
                "_json_request",
                return_value={"ok": True, "tabs": [{"ref": "tab-1"}]},
            ) as request,
        ):
            result = samewindow._control("/browser/tabs")

        self.assertEqual(request.call_args.args[0], LOCAL["control"])
        self.assertEqual(result["browserBackend"], "local")
        self.assertEqual(result["tabs"][0]["ref"], "local:tab-1")

    def test_ordinary_action_never_wakes_vps_fallback(self) -> None:
        with (
            mock.patch.object(samewindow, "_targets", return_value=[LOCAL, VPS]),
            mock.patch.object(samewindow, "_snapshot", return_value=snapshot("stopped", "stopped")),
            mock.patch.object(samewindow, "_start_target") as start,
            mock.patch.object(samewindow, "_json_request") as request,
        ):
            with self.assertRaisesRegex(RuntimeError, "shared_browser_lifecycle_start"):
                samewindow._control(
                    "/browser/open",
                    {"url": "https://example.com", "newTab": True, "tabRef": ""},
                )

        start.assert_not_called()
        request.assert_not_called()

    def test_explicit_lifecycle_start_wakes_vps(self) -> None:
        snapshots = [
            snapshot("stopped", "stopped"),
            snapshot("stopped", "running"),
        ]
        with (
            mock.patch.object(samewindow, "_targets", return_value=[LOCAL, VPS]),
            mock.patch.object(samewindow, "_snapshot", side_effect=snapshots),
            mock.patch.object(samewindow, "_start_target") as start,
        ):
            result = samewindow.shared_browser_lifecycle_start()

        start.assert_called_once_with(VPS)
        self.assertEqual(result["browserBackend"], "vps")
        self.assertEqual(result["state"], "running")

    def test_backend_owned_ref_stays_on_vps(self) -> None:
        with (
            mock.patch.object(samewindow, "_targets", return_value=[LOCAL, VPS]),
            mock.patch.object(samewindow, "_snapshot", return_value=snapshot("running", "running")),
            mock.patch.object(
                samewindow,
                "_json_request",
                return_value={"ok": True, "tabRef": "tab-1"},
            ) as request,
        ):
            result = samewindow._control("/browser/select", {"tabRef": "vps:tab-1"})

        self.assertEqual(request.call_args.args[0], VPS["control"])
        self.assertEqual(request.call_args.kwargs["payload"]["tabRef"], "tab-1")
        self.assertEqual(result["tabRef"], "vps:tab-1")

    def test_snapshot_scoped_element_refs_keep_backend_ownership(self) -> None:
        with (
            mock.patch.object(samewindow, "_targets", return_value=[LOCAL, VPS]),
            mock.patch.object(samewindow, "_snapshot", return_value=snapshot("running", "running")),
            mock.patch.object(
                samewindow,
                "_json_request",
                return_value={
                    "ok": True,
                    "snapshot": {
                        "snapshotId": "s42",
                        "tabRef": "tab-1",
                        "elements": [{"ref": "s42:e1"}],
                    },
                },
            ) as request,
        ):
            result = samewindow._control(
                "/browser/click",
                {"tabRef": "vps:tab-1", "ref": "vps:s42:e1"},
            )

        self.assertEqual(request.call_args.args[0], VPS["control"])
        self.assertEqual(
            request.call_args.kwargs["payload"],
            {"tabRef": "tab-1", "ref": "s42:e1"},
        )
        self.assertEqual(result["snapshot"]["tabRef"], "vps:tab-1")
        self.assertEqual(result["snapshot"]["elements"][0]["ref"], "vps:s42:e1")
        self.assertEqual(
            samewindow._prefix_refs({"ref": "e1"}, "local", True)["ref"],
            "local:e1",
        )


if __name__ == "__main__":
    unittest.main()
