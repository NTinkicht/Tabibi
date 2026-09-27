import unittest
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts"))
import native_factory_ruleset_policy as p


REQUIRED={"Quality and build","PostgreSQL integration","Browser smoke"}


def base_ruleset():
    return {
        "enforcement":"active",
        "bypass_actors":[],
        "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
        "rules":[
            {"type":"pull_request","parameters":{
                "required_approving_review_count":1,
                "dismiss_stale_reviews_on_push":True,
                "require_last_push_approval":True,
                "required_review_thread_resolution":True,
            }},
            {"type":"deletion"},
            {"type":"non_fast_forward"},
            {
                "type":"required_status_checks",
                "parameters":{
                    "strict_required_status_checks_policy":True,
                    "required_status_checks":[
                        {"context":"Quality and build"},
                        {"context":"PostgreSQL integration"},
                        {"context":"Browser smoke"},
                    ],
                },
            },
        ],
    }


class RulesetPolicyTests(unittest.TestCase):
    def test_strict_non_bypassable_default_branch_ruleset_passes(self):
        self.assertTrue(p.strict_ruleset_enforces(
            base_ruleset(),branch="main",required_checks=REQUIRED,default_branch="main"
        ))


    def test_default_branch_selector_fails_if_repository_default_moved(self):
        self.assertFalse(p.strict_ruleset_enforces(
            base_ruleset(),
            branch="main",
            required_checks=REQUIRED,
            default_branch="trunk",
        ))

    def test_bypass_actor_fails_closed(self):
        r=base_ruleset(); r["bypass_actors"]=[{"actor_id":1}]
        self.assertFalse(p.strict_ruleset_enforces(r,branch="main",required_checks=REQUIRED,default_branch="main"))

    def test_non_strict_status_checks_fail(self):
        r=base_ruleset()
        r["rules"][-1]["parameters"]["strict_required_status_checks_policy"]=False
        self.assertFalse(p.strict_ruleset_enforces(r,branch="main",required_checks=REQUIRED,default_branch="main"))

    def test_missing_required_check_fails(self):
        r=base_ruleset()
        r["rules"][-1]["parameters"]["required_status_checks"].pop()
        self.assertFalse(p.strict_ruleset_enforces(r,branch="main",required_checks=REQUIRED,default_branch="main"))

    def test_pull_request_rule_requires_fresh_exact_head_approval(self):
        for field, value in (
            ("required_approving_review_count", 0),
            ("dismiss_stale_reviews_on_push", False),
            ("require_last_push_approval", False),
            ("required_review_thread_resolution", False),
        ):
            with self.subTest(field=field):
                r=base_ruleset()
                r["rules"][0]["parameters"][field]=value
                self.assertFalse(p.strict_ruleset_enforces(
                    r,branch="main",required_checks=REQUIRED,default_branch="main"
                ))

    def test_missing_pr_or_force_push_protection_fails(self):
        for missing in ("pull_request","deletion","non_fast_forward"):
            with self.subTest(missing=missing):
                r=base_ruleset()
                r["rules"]=[x for x in r["rules"] if x["type"] != missing]
                self.assertFalse(p.strict_ruleset_enforces(r,branch="main",required_checks=REQUIRED,default_branch="main"))

    def test_excluded_or_inactive_ruleset_fails(self):
        r=base_ruleset()
        r["conditions"]["ref_name"]["exclude"]=["refs/heads/main"]
        self.assertFalse(p.strict_ruleset_enforces(r,branch="main",required_checks=REQUIRED,default_branch="main"))
        r=base_ruleset(); r["enforcement"]="evaluate"
        self.assertFalse(p.strict_ruleset_enforces(r,branch="main",required_checks=REQUIRED,default_branch="main"))


if __name__=="__main__":
    unittest.main()
