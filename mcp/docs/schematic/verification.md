# Schematic verification

Check the affected page before finishing or continuing to PCB work. Reuse current readback; call `get_schematic` when exact components or connectivity have not yet been confirmed after the edit.

- Confirm intended parts, values, packages, pins and net names. Trace changed connections through the functional circuit, including supply and return connections and intentionally unconnected pins.
- Confirm that unrelated circuitry and functional page ownership are preserved.
- After beautify, confirm every current-page component belongs to exactly one functional block and that electrical connectivity is preserved. Inspect the presentation when visual organization was requested.
- Review extraction's `sheetSpace`; below `10%` free is a reason to put substantial independent circuitry on another functional page.
- `extract_circuit_on_current_page` and `beautify_schematic_on_current_page` read the page back themselves and return `verification`. A result with `isError` and `verification.ok: false` means the page does not match the request even though assembly finished; inspect `mismatches`, `missing_components`, `unannotated_designators` and `hints` before any further change.
- Keep the intended connections as an expectation (`{designator: {pin_number: net}}`, `""` for an intentionally unconnected pin) and check it with `verify_netlist`. It reads EasyEDA's own whole-schematic netlist, so it also proves cross-page connections that page readback cannot.
- Run `check_schematic` when a page is finished. It reports native ERC counts, single-pin nets, unconnected pins and near-duplicate net names. Pass `expected_open` globs for nets that wait on pages not drawn yet, so real omissions stand out.

Repair a concrete omission or wrong connection on the affected page, then reread it. Use [recovery](../recovery.md) when the applied result is invalid and a safe local repair is unavailable. A purely aesthetic preference follows the user's requested style.

Report the affected pages, what was checked and any remaining issue. Schematic readback verifies the captured design; it does not establish electrical ratings, stability or other behavior that needs a datasheet or simulation.
