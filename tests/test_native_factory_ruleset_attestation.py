"""Adversarial assurance for owner-attested GitHub ruleset bypass readback."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import native_factory_ruleset_attestation as a


def fixture():
    updated = "2026-10-12T18:33:39.381+04:00"
    detail = {
        "id": 24411900, "updated_at": updated, "source_type": "Repository",
        "source": a.REPO, "enforcement": "active", "target": "branch",
    }
    summary = {"id": 24411900, "updated_at": updated}
    comment = {
        "user": {"login": a.OWNER},
        "issue_url": f"https://api.github.com/repos/{a.REPO}/issues/{a.ISSUE}",
        "created_at": "2026-10-12T14:36:00Z",
        "updated_at": "2026-10-12T14:36:00Z",
        "body": (
            f"Owner-verified zero bypass actors for the live main branch ruleset.\n"
            f"<!-- TABIBI_L4_NO_BYPASS_V1 repo={a.REPO} ruleset=24411900 "
            f"updated={updated} bypass=none -->"
        ),
    }
    return detail, summary, comment


class AttestationTests(unittest.TestCase):
    def test_exact_unedited_owner_attestation_fills_omitted_field(self):
        detail, summary, owner = fixture()
        self.assertEqual(a.authorized_ruleset_detail(detail, summary, [owner])["bypass_actors"], [])

    def test_explicit_bypass_can_never_be_overridden(self):
        detail, summary, owner = fixture()
        detail["bypass_actors"] = [{"actor_id": 1}]
        self.assertIsNone(a.authorized_ruleset_detail(detail, summary, [owner]))
        detail["bypass_actors"] = []
        self.assertEqual(a.authorized_ruleset_detail(detail, summary, [])["bypass_actors"], [])

    def test_omitted_proof_never_passes(self):
        detail, summary, _ = fixture()
        self.assertIsNone(a.authorized_ruleset_detail(detail, summary, []))

    def test_wrong_actor_or_edited_comment_fails(self):
        for change in (
            {"user": {"login": "github-actions[bot]"}},
            {"user": {"login": "chatgpt"}},
            {"updated_at": "2026-10-12T14:37:00Z"},
        ):
            detail, summary, owner = fixture()
            owner.update(change)
            self.assertIsNone(a.authorized_ruleset_detail(detail, summary, [owner]))

    def test_ruleset_update_invalidates_even_true_old_proof(self):
        detail, summary, owner = fixture()
        detail["updated_at"] = summary["updated_at"] = "2026-10-12T19:00:00+04:00"
        self.assertIsNone(a.authorized_ruleset_detail(detail, summary, [owner]))

    def test_created_before_ruleset_change_fails(self):
        detail, summary, owner = fixture()
        owner["created_at"] = owner["updated_at"] = "2026-10-12T14:33:00Z"
        self.assertIsNone(a.authorized_ruleset_detail(detail, summary, [owner]))

    def test_wrong_ruleset_or_repo_or_issue_fails(self):
        for field, value in (("id", 123), ("source", "other/repo"), ("source_type", "Organization")):
            detail, summary, owner = fixture()
            detail[field] = value
            self.assertIsNone(a.authorized_ruleset_detail(detail, summary, [owner]))
        detail, summary, owner = fixture()
        owner["issue_url"] = "https://api.github.com/repos/NTinkicht/Tabibi/issues/12"
        self.assertIsNone(a.authorized_ruleset_detail(detail, summary, [owner]))

    def test_mismatched_or_duplicate_marker_fails(self):
        detail, summary, owner = fixture()
        owner["body"] += "\n" + owner["body"]
        self.assertIsNone(a.authorized_ruleset_detail(detail, summary, [owner]))

    def test_attestation_code_and_tests_are_owner_governed(self):
        source = (
            Path(__file__).resolve().parents[1]
            / "scripts" / "native_factory_merge.py"
        ).read_text(encoding="utf-8")
        for critical in (
            "scripts/native_factory_ruleset_attestation.py",
            "tests/test_native_factory_ruleset_attestation.py",
            ".github/workflows/native-ruleset-attestation-ci.yml",
        ):
            self.assertIn(f'"{critical}"', source)

    def test_missing_timezone_fails_closed(self):
        detail, summary, owner = fixture()
        detail["updated_at"] = summary["updated_at"] = "2026-10-12T18:33:39"
        owner["body"] = owner["body"].replace("2026-10-12T18:33:39.381+04:00", "2026-10-12T18:33:39")
        self.assertIsNone(a.authorized_ruleset_detail(detail, summary, [owner]))


if __name__ == "__main__":
    unittest.main()
