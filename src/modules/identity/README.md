# identity

This directory owns authentication identities and clinic-scoped authorization. Its
public contract defines the `doctor`, `receptionist`, and `clinic_admin` membership
roles and requires an explicit actor and clinic for every protected operation.
`platform_admin` is an identity-level role only and receives no implicit clinic-data
access. Patient identities are intentionally outside this slice.
