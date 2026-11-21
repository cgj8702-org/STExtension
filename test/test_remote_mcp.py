"""Tests for RemoteMCP.py tools (mock mode, no network). Run: python3 -m pytest test"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import RemoteMCP as R  # noqa: E402
from lovense_client import LovenseClient  # noqa: E402


class Recorder(LovenseClient):
    """Mock-mode client that records what would have been sent."""

    def __init__(self):
        super().__init__(connection_mode="mock")
        self.calls = []

    def send_command(self, action="Vibrate", strength=2, duration=5, toy_id=None):
        res = super().send_command(action, strength, duration, toy_id)
        self.calls.append(("send", res["action"], res["strength"], res["duration"]))
        return res

    def stop_all(self, toy_id=None):
        self.calls.append(("stop",))
        return super().stop_all(toy_id)


def setup(allow_delayed=False):
    R.client = Recorder()
    R.ALLOW_DELAYED = allow_delayed
    R._pending.clear()
    return R.client


def run(coro):
    return asyncio.run(coro)


def test_strength_is_hard_capped():
    c = setup()
    res = run(R.control_lovense_toy("Vibrate", 9, 999))
    assert res["success"] is True
    assert c.calls == [("send", "Vibrate", 3, 60)]


def test_mock_send_does_not_write_to_stdout(capsys):
    # stdout is the MCP stdio protocol channel; any print() would corrupt it.
    setup()
    run(R.control_lovense_toy("Vibrate", 1, 5))
    assert capsys.readouterr().out == ""


def test_delay_ignored_when_disabled():
    c = setup(allow_delayed=False)
    res = run(R.control_lovense_toy("Vibrate", 1, 5, delay=30))
    assert "scheduled" not in res
    assert len(c.calls) == 1


def test_delay_schedules_then_fires_without_blocking(monkeypatch):
    c = setup(allow_delayed=True)

    async def main():
        gate = asyncio.Event()
        real_sleep = asyncio.sleep

        async def fake_sleep(_):
            await gate.wait()

        monkeypatch.setattr(R.asyncio, "sleep", fake_sleep)
        res = await R.control_lovense_toy("Vibrate", 7, 5, delay=30)
        assert res["scheduled"] is True and res["delay"] == 30
        await real_sleep(0.05)
        assert c.calls == []  # nothing fired yet, and the call returned immediately
        gate.set()
        await real_sleep(0.1)
        assert c.calls == [("send", "Vibrate", 3, 5)]  # still capped at 3

    run(main())


def test_stop_cancels_pending_delayed_commands(monkeypatch):
    c = setup(allow_delayed=True)

    async def main():
        real_sleep = asyncio.sleep

        async def never(_):
            await asyncio.Event().wait()

        monkeypatch.setattr(R.asyncio, "sleep", never)
        await R.control_lovense_toy("Vibrate", 1, 5, delay=20)
        await R.control_lovense_toy("Pulse", 1, 5, delay=20)
        assert len([t for t in R._pending if not t.done()]) == 2
        res = await R.control_lovense_toy("Stop")
        assert "cancelled 2" in res["message"]
        await real_sleep(0.05)
        assert c.calls == [("stop",)]

    run(main())


def test_send_stop_function_also_cancels(monkeypatch):
    c = setup(allow_delayed=True)

    async def main():
        real_sleep = asyncio.sleep

        async def never(_):
            await asyncio.Event().wait()

        monkeypatch.setattr(R.asyncio, "sleep", never)
        await R.control_lovense_toy("Vibrate", 1, 5, delay=20)
        await R.SendStopFunction()
        await real_sleep(0.05)
        assert c.calls == [("stop",)]

    run(main())


def test_max_pending_enforced(monkeypatch):
    setup(allow_delayed=True)

    async def main():
        real_sleep = asyncio.sleep

        async def never(_):
            await asyncio.Event().wait()

        monkeypatch.setattr(R.asyncio, "sleep", never)
        for _ in range(R.MAX_PENDING):
            assert (await R.control_lovense_toy("Vibrate", 1, 5, delay=10))["success"]
        res = await R.control_lovense_toy("Vibrate", 1, 5, delay=10)
        assert res["success"] is False and "Too many" in res["message"]
        R._cancel_pending()

    run(main())


def test_delay_is_clamped():
    assert R._clamp_delay(99999) == 300
    assert R._clamp_delay(-5) == 0
    assert R._clamp_delay("x") == 0
