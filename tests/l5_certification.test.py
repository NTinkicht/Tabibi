import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("l5_certification", ROOT / "scripts" / "l5_certification.py")
cert = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(cert)


class L5CertificationTest(unittest.TestCase):
    def test_full_fault_matrix_certifies_read_only(self):
        report = cert.run_certification()
        self.assertTrue(report["certified"])
        self.assertFalse(report["mutation_allowed"])
        self.assertGreaterEqual(report["scenario_count"], 16)

    def test_matrix_contains_required_safety_faults(self):
        names = {scenario.name for scenario in cert.scenario_matrix()}
        self.assertTrue({
            "ci-red",
            "review-outage",
            "self-review",
            "stale-head",
            "stale-base",
            "duplicate-stream",
            "emergency-stop",
            "human-only",
            "merge-ready",
        }.issubset(names))

    def test_certification_never_grants_mutation(self):
        for scenario in cert.scenario_matrix():
            snapshot = {**cert.base_snapshot(), **scenario.patch}
            plan = cert.plan_recovery(snapshot)
            self.assertFalse(plan["mutation_allowed"], scenario.name)


if __name__ == "__main__":
    unittest.main()
