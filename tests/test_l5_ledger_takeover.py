#!/usr/bin/env python3
"""Durable active-lease takeover regression."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from l5_ledger import LedgerConflict, SCHEMA_VERSION, cas_lease


def doc():
    return {
        "schema_version": SCHEMA_VERSION,
        "repository": "NTinkicht/repo",
        "revision": 0,
        "mode": "GOVERNANCE_DRIFT",
        "mode_version": 1,
        "human_clear_required": True,
        "leases": {}, "budgets": {}, "observations": {},
        "platform_enforcement": {"branch_protected": False, "active_rulesets": 0},
    }


def row(version, epoch, holder, acquired_at, expires_at):
    return {
        "version": version, "epoch": epoch, "holder": holder, "state": "ACTIVE",
        "acquired_at": acquired_at, "expires_at": expires_at,
        "observed": {"head": "a" * 40, "base": "b" * 40, "wu_body_hash": "wu", "pr_updated_at": "t"},
        "intent": None,
    }


class DurableLeaseTakeoverTests(unittest.TestCase):
    def test_active_owner_cannot_be_replaced_before_expiry(self):
        state = doc(); state["leases"]["k"] = row(3, 7, "r1", 1.0, 300.0)
        with self.assertRaises(LedgerConflict):
            cas_lease(state, "k", expected_revision=0, expected_lease_version=3, new_record=row(4, 8, "r2", 299.0, 599.0))
        out = cas_lease(state, "k", expected_revision=0, expected_lease_version=3, new_record=row(4, 8, "r2", 300.0, 600.0))
        self.assertEqual((out["leases"]["k"]["holder"], out["leases"]["k"]["epoch"]), ("r2", 8))


if __name__ == "__main__": unittest.main()
