-- TAB-P0-02 (#686, #669 Q1 = A): exactly one location per clinic, stored on
-- the clinic row. Every column is nullable so existing clinics stay valid
-- without a location. The wilaya code is checked against the versioned list
-- dz-wilayas-2019-58 (src/modules/clinic/wilayas.ts). A commune or street
-- address is only meaningful inside a wilaya, so neither may be stored
-- without one. The address describes the clinic, never a patient.
ALTER TABLE clinics
  ADD COLUMN wilaya_code text
    CONSTRAINT clinics_wilaya_code_known
    CHECK (wilaya_code ~ '^(0[1-9]|[1-4][0-9]|5[0-8])$'),
  ADD COLUMN commune text
    CONSTRAINT clinics_commune_length
    CHECK (char_length(commune) BETWEEN 1 AND 100 AND commune = btrim(commune)),
  ADD COLUMN address_line text
    CONSTRAINT clinics_address_line_length
    CHECK (
      char_length(address_line) BETWEEN 1 AND 200
      AND address_line = btrim(address_line)
    ),
  ADD CONSTRAINT clinics_location_requires_wilaya
    CHECK (wilaya_code IS NOT NULL OR (commune IS NULL AND address_line IS NULL));
