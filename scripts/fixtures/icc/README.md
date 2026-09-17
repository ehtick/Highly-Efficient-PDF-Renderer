# Synthetic ICC test profiles

These fixtures were generated for HEPR and are covered by the repository's MIT
license. `scripts/generate-icc-fixtures.py` regenerates them using system Little
CMS 2 through Python's standard-library ctypes (reference generation used 2.14).
The profile timestamps and descriptions are fixed; no third-party profile data
is copied.

* `srgb.icc`: standard sRGB matrix/TRC profile.
* `linear-rgb.icc`: sRGB primaries and D65 white, with linear tone curves.
* `linear-gray.icc`: D50 gray with a linear tone curve.
* `lab.icc`: D50 ICC Lab profile, using the PDF-compatible color-space class.
* `synthetic-cmyk.icc`: a 5×5×5×5 CMYK-to-Lab LUT. Grid colors are generated from
  sRGB = `(1 − [C, M, Y]) × (1 − K)`. This is a small test profile, not a printer
  characterization. Different engines' interpolation may differ slightly.

Expected linear 50% gray is approximately sRGB 188; Lab [50, 0, 0] is about 119.
Tests allow 2–3 byte codes for matrix/TRC and Lab colors, and 8 codes for
the synthetic CMYK LUT (qcms loses several codes near saturated Lab-PCS colors). They do not
use either WASM engine under test to calculate expected values.
