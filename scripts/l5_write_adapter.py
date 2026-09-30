#!/usr/bin/env python3
"""Guarded L5 write adapter.

Executes only a mutation previously authorized by ``l5_recovery.authorize_mutation``.
The adapter itself performs no network I/O and holds no credentials: every remote
read/write goes through an injected ``client`` and every durable fact through an
injected ``store``. Anything outside ``SAFE_MUTATIONS`` fails closed.
"""
from __future__ import annotations

import fcntl
import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from l5_recovery import (
    HARD_BOUNDARY_FIELDS, KNOWN_RETRY_SCOPES, MAX_RETRIES, SAFE_MUTATIONS, SHA40, TOKEN64,
    _required_bool, authorize_mutation,
)

RETRYABLE = frozenset({"retry_ci", "dispatch_review", "remediate_review"})
MUTATIONS = frozenset(SAFE_MUTATIONS.values())


class LostResponse(Exception):
    """Write outcome unknown (timeout / dropped response)."""


class AlreadyExists(Exception):
    """Branch/PR/reservation already exists (creation race)."""


class WriteRejected(Exception):
    """Remote refused the write (e.g. expected-head merge race)."""


def stream_key(auth: dict[str, Any], snapshot: dict[str, Any]) -> str:
    return json.dumps([snapshot.get("repository"), auth["issue"], auth["canonical_pr"]], separators=(",", ":"))


def _result(status: str, reason: str, token: Any = None) -> dict[str, Any]:
    return {"status": status, "reason": reason, "mutation_token": token, "written": False}


def _validate_authorization(auth: Any, snapshot: Any) -> str | None:
    if not isinstance(auth, dict) or auth.get("authorized") is not True or auth.get("mutation_allowed") is not True:
        return "NOT_AUTHORIZED"
    if auth.get("mutation") not in MUTATIONS:
        return "MUTATION_NOT_WHITELISTED"
    token = auth.get("mutation_token")
    if not isinstance(token, str) or not TOKEN64.fullmatch(token):
        return "TOKEN_INVALID"
    for key in ("expected_head_sha", "expected_base_sha"):
        if not isinstance(auth.get(key), str) or not SHA40.fullmatch(auth[key]):
            return "EXPECTED_REFS_INVALID"
    pr = auth.get("canonical_pr")
    if type(pr) is not int or pr < 1 or type(auth.get("issue")) is not int:
        return "CANONICAL_PR_INVALID"
    try:
        fresh = authorize_mutation(snapshot)
    except ValueError:
        return "AUTHORIZATION_NOT_REPRODUCIBLE"
    if fresh.get("authorized") is not True or fresh != auth:
        return "AUTHORIZATION_MISMATCH"
    if auth["mutation"] in RETRYABLE:
        count, scope = auth.get("retry_count_after"), auth.get("retry_action_after")
        if type(count) is not int or count < 1 or scope not in KNOWN_RETRY_SCOPES:
            return "RETRY_STATE_INVALID"
        if count > MAX_RETRIES:
            return "RETRY_BUDGET_EXHAUSTED"
    elif auth["mutation"] == "reserve_next_wu" and (type(auth.get("selected_issue")) is not int or auth["selected_issue"] < 1):
        return "SELECTED_ISSUE_INVALID"
    return None


def _live_gate(auth: dict[str, Any], client: Any, *, retry: tuple[int, str | None] | None = None) -> str | None:
    boundaries = client.fetch_boundaries()
    if not isinstance(boundaries, dict):
        return "BOUNDARY_STATE_UNKNOWN"
    try:
        if any(_required_bool(boundaries, key) for key in HARD_BOUNDARY_FIELDS):
            return "HARD_BOUNDARY"
    except ValueError:
        return "BOUNDARY_STATE_UNKNOWN"
    live = client.fetch_live(auth["canonical_pr"])
    if not isinstance(live, dict):
        return "LIVE_STATE_UNKNOWN"
    if live.get("head_sha") != auth["expected_head_sha"] or live.get("base_sha") != auth["expected_base_sha"]:
        return "STALE_HEAD_OR_BASE"
    mutation = auth["mutation"]
    expected_state = "merged" if mutation == "reserve_next_wu" else "open"
    if live.get("pr_state") != expected_state:
        return "PR_STATE_MISMATCH"
    streams = live.get("open_streams")
    if not isinstance(streams, dict):
        return "LIVE_STATE_UNKNOWN"
    if mutation == "reserve_next_wu":
        if any(prs for prs in streams.values()) or streams.get(auth["selected_issue"]):
            return "DUPLICATE_STREAM"
    elif streams.get(auth["issue"]) != [auth["canonical_pr"]] or sum(len(v) for v in streams.values()) != 1:
        return "DUPLICATE_STREAM"
    if mutation == "dispatch_review" and live.get("review_eligible_nonauthor") is not True:
        return "REVIEWER_NOT_ELIGIBLE"
    if retry is not None and mutation in RETRYABLE:  # validates the caller's single read; never re-reads
        count, action = retry
        scope = auth["retry_action_after"]
        if (count if action == scope else 0) + 1 != auth["retry_count_after"]:
            return "RETRY_STATE_STALE"
    return None


def _params(auth: dict[str, Any]) -> dict[str, Any]:
    params = {k: auth.get(k) for k in ("canonical_pr", "issue", "expected_head_sha", "expected_base_sha", "selected_issue")}
    params["idempotency_key"] = auth["mutation_token"]
    return params


def _reconcile(auth: dict[str, Any], client: Any, store: Any, written: bool) -> dict[str, Any]:
    token = auth["mutation_token"]
    if client.verify_effect(auth["mutation"], _params(auth)) is True:
        store.set_status(token, "COMPLETE")
        return {**_result("COMPLETE", "EFFECT_VERIFIED", token), "written": written}
    store.set_status(token, "VERIFICATION_FAILED")
    return {**_result("VERIFICATION_FAILED", "EFFECT_NOT_OBSERVED", token), "written": written}


def execute_mutation(auth: dict[str, Any], snapshot: dict[str, Any], client: Any, store: Any) -> dict[str, Any]:
    reason = _validate_authorization(auth, snapshot)
    if reason:
        return _result("BLOCKED", reason, auth.get("mutation_token") if isinstance(auth, dict) else None)
    token = auth["mutation_token"]
    prior = store.get(token)
    if prior is not None:
        status = prior.get("status")
        if status == "COMPLETE":
            return _result("REPLAY_NOOP", "ALREADY_COMPLETE", token)
        if status == "PENDING":
            return _reconcile(auth, client, store, written=False)
        return _result("BLOCKED", f"PRIOR_{status}", token)

    stream = stream_key(auth, snapshot)
    # One retry-state read: the exact value the gate validates is the CAS expectation for begin().
    observed_retry = store.retry_state(stream) if auth["mutation"] in RETRYABLE else None
    block = _live_gate(auth, client, retry=observed_retry)
    if block:
        return _result("BLOCKED", block, token)

    record = {"mutation": auth["mutation"], "canonical_pr": auth["canonical_pr"], "status": "PENDING",
              "expected_head_sha": auth["expected_head_sha"], "expected_base_sha": auth["expected_base_sha"]}
    started = store.begin(
        token,
        record,
        stream,
        auth.get("retry_count_after"),
        auth.get("retry_action_after"),
        expected_retry=observed_retry,
    )
    if not started:
        if store.get(token) is not None:
            return _result("REPLAY_NOOP", "TOKEN_ALREADY_PERSISTED", token)
        return _result("BLOCKED", "RETRY_STATE_STALE", token)

    # A process crash after begin() leaves PENDING + advanced retry state; replay only observes the remote
    # (verify_effect). If the effect is not observed the token ends VERIFICATION_FAILED and needs
    # operator reconciliation: the retry is never treated as success or silently refunded.
    # Before perform() no write has been attempted, so any failure here may restore the prior retry state.
    try:
        block = _live_gate(auth, client)
    except Exception as exc:  # fail closed; final gate failed before any write
        store.fail_and_restore(token, f"{type(exc).__name__}: {exc}", stream, observed_retry)
        return _result("FAILED", "UNEXPECTED_ERROR", token)
    if block:
        store.fail_and_restore(token, block, stream, observed_retry)
        return _result("BLOCKED", block, token)

    # From here the remote outcome may be unknown: only an explicit WriteRejected proves no write happened.
    try:
        client.perform(auth["mutation"], _params(auth))
    except WriteRejected as exc:
        store.fail_and_restore(token, str(exc), stream, observed_retry)
        return _result("FAILED", "WRITE_REJECTED", token)
    except Exception:  # LostResponse, AlreadyExists or unknown transport error: observe, never refund
        return _reconcile(auth, client, store, written=False)
    return _reconcile(auth, client, store, written=True)


class MemoryStore:
    def __init__(self) -> None:
        self.records: dict[str, dict[str, Any]] = {}
        self.retry: dict[str, tuple[int, str | None]] = {}

    def get(self, token: str) -> dict[str, Any] | None:
        return dict(self.records[token]) if token in self.records else None

    def begin(
        self,
        token: str,
        record: dict[str, Any],
        stream: str,
        count: int | None,
        action: str | None,
        *,
        expected_retry: tuple[int, str | None] | None = None,
    ) -> bool:
        if token in self.records:
            return False
        if expected_retry is not None and self.retry.get(stream, (0, None)) != expected_retry:
            return False
        self.records[token] = dict(record)
        if count is not None:
            self.retry[stream] = (count, action)
        return True

    def fail_and_restore(self, token: str, detail: Any, stream: str, prior_retry: tuple[int, str | None] | None) -> None:
        self.records[token]["status"] = "FAILED"
        self.records[token]["detail"] = detail
        if prior_retry is None:
            return  # non-retryable mutation: no retry state was advanced
        if prior_retry == (0, None):
            self.retry.pop(stream, None)
        else:
            self.retry[stream] = prior_retry

    def set_status(self, token: str, status: str, detail: Any = None) -> None:
        self.records[token]["status"] = status
        self.records[token]["detail"] = detail

    def retry_state(self, stream: str) -> tuple[int, str | None]:
        return self.retry.get(stream, (0, None))


class JsonFileStore(MemoryStore):
    """Durable store: flock-guarded JSON file with crash-safe atomic replacement."""

    def __init__(self, path: Path) -> None:
        super().__init__()
        self.path = Path(path)

    def _locked(self, fn: Any) -> Any:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(str(self.path) + ".lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if self.path.exists():
                data = json.loads(self.path.read_text(encoding="utf-8"))
                self.records = data["records"]
                self.retry = {k: (v[0], v[1]) for k, v in data["retry"].items()}
            else:
                self.records, self.retry = {}, {}
            out = fn()
            tmp = self.path.with_suffix(".tmp")
            payload = json.dumps({"records": self.records, "retry": {k: list(v) for k, v in self.retry.items()}}, sort_keys=True)
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.path)
            dir_fd = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
            return out

    def get(self, token: str) -> dict[str, Any] | None:
        return self._locked(lambda: MemoryStore.get(self, token))

    def begin(
        self,
        token: str,
        record: dict[str, Any],
        stream: str,
        count: int | None,
        action: str | None,
        *,
        expected_retry: tuple[int, str | None] | None = None,
    ) -> bool:
        return self._locked(lambda: MemoryStore.begin(self, token, record, stream, count, action, expected_retry=expected_retry))

    def fail_and_restore(self, token: str, detail: Any, stream: str, prior_retry: tuple[int, str | None] | None) -> None:
        self._locked(lambda: MemoryStore.fail_and_restore(self, token, detail, stream, prior_retry))

    def set_status(self, token: str, status: str, detail: Any = None) -> None:
        self._locked(lambda: MemoryStore.set_status(self, token, status, detail))

    def retry_state(self, stream: str) -> tuple[int, str | None]:
        return self._locked(lambda: MemoryStore.retry_state(self, stream))


def selftest() -> None:
    from l5_recovery import selftest as recovery_selftest
    recovery_selftest()
    assert MUTATIONS == frozenset(SAFE_MUTATIONS.values())
    print("l5_write_adapter selftest PASS")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        raise SystemExit("l5_write_adapter is a library; it has no CLI write path (use --selftest)")
