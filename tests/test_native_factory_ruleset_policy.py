import copy
import unittest
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts"))
import native_factory_ruleset_policy as p


REQUIRED={"Quality and build","PostgreSQL integration","Browser smoke","L4 review authorization"}
RESTRICTED={".github/workflows/**","scripts/**","coordination/**"}


def base_ruleset():
    return {
        "enforcement":"active",
        "target":"branch",
        "bypass_actors":[],
        "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
        "rules":[
            {
                "type":"pull_request",
                "parameters":{
                    "required_approving_review_count":1,
                    "dismiss_stale_reviews_on_push":True,
                    "require_last_push_approval":True,
                    "required_review_thread_resolution":True,
                },
            },
            {"type":"deletion"},
            {"type":"non_fast_forward"},
            {
                "type":"required_status_checks",
                "parameters":{
                    "strict_required_status_checks_policy":True,
                    "required_status_checks":[
                        {"context":"Quality and build","integration_id":15368},
                        {"context":"PostgreSQL integration","integration_id":15368},
                        {"context":"Browser smoke","integration_id":15368},
                        {"context":"L4 review authorization","integration_id":15368},
                    ],
                },
            },
            {
                "type":"file_path_restriction",
                "parameters":{"restricted_file_paths":sorted(RESTRICTED)},
            },
        ],
    }


class RulesetPolicyTests(unittest.TestCase):
    def assert_policy(self,r,expected):
        self.assertEqual(
            p.strict_ruleset_enforces(
                r,branch="main",required_checks=REQUIRED,default_branch="main"
            ),
            expected,
        )

    def test_strict_non_bypassable_default_branch_ruleset_passes(self):
        self.assert_policy(base_ruleset(),True)

    def test_default_branch_selector_fails_if_repository_default_moved(self):
        self.assertFalse(p.strict_ruleset_enforces(
            base_ruleset(),branch="main",required_checks=REQUIRED,default_branch="trunk"
        ))

    def test_bypass_actor_fails_closed(self):
        r=base_ruleset(); r["bypass_actors"]=[{"actor_id":1}]
        self.assert_policy(r,False)

    def test_non_strict_status_checks_fail(self):
        r=base_ruleset()
        r["rules"][-1]["parameters"]["strict_required_status_checks_policy"]=False
        self.assert_policy(r,False)

    def test_missing_required_check_fails(self):
        r=base_ruleset()
        r["rules"][-1]["parameters"]["required_status_checks"].pop()
        self.assert_policy(r,False)

    def test_wrong_check_publisher_fails(self):
        r=base_ruleset()
        r["rules"][-1]["parameters"]["required_status_checks"][0]["integration_id"]=999
        self.assert_policy(r,False)

    def test_fresh_non_author_review_is_required(self):
        for field,value in (
            ("required_approving_review_count",0),
            ("dismiss_stale_reviews_on_push",False),
            ("require_last_push_approval",False),
            ("required_review_thread_resolution",False),
        ):
            with self.subTest(field=field):
                r=base_ruleset()
                r["rules"][0]["parameters"][field]=value
                self.assert_policy(r,False)

    def test_missing_pr_or_force_push_protection_fails(self):
        for missing in ("pull_request","deletion","non_fast_forward"):
            with self.subTest(missing=missing):
                r=base_ruleset()
                r["rules"]=[x for x in r["rules"] if x["type"] != missing]
                self.assert_policy(r,False)

    def test_optional_control_path_restriction_is_enforced_when_requested(self):
        r=base_ruleset()
        self.assertTrue(p.strict_ruleset_enforces(
            r, branch="main", required_checks=REQUIRED, default_branch="main",
            required_restricted_paths=RESTRICTED,
        ))
        for rule in r["rules"]:
            if rule["type"] == "file_path_restriction":
                rule["parameters"]["restricted_file_paths"].remove("scripts/**")
        self.assertFalse(p.strict_ruleset_enforces(
            r, branch="main", required_checks=REQUIRED, default_branch="main",
            required_restricted_paths=RESTRICTED,
        ))

    def test_non_branch_ruleset_fails(self):
        r=base_ruleset(); r["target"]="tag"
        self.assert_policy(r,False)

    def test_excluded_or_inactive_ruleset_fails(self):
        r=base_ruleset()
        r["conditions"]["ref_name"]["exclude"]=["refs/heads/main"]
        self.assert_policy(r,False)
        r=base_ruleset(); r["enforcement"]="evaluate"
        self.assert_policy(r,False)


if __name__=="__main__":
    unittest.main()
