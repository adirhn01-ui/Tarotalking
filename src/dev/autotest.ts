// Dev-only in-app E2E harness — fleshed out during the verification phase.
// Activated via TAROTALKING_AUTOTEST=1; writes a JSON report the test runner
// polls (judge only by the report, never the dev-server exit code).

export async function runAutotest(): Promise<void> {
  // Populated in the verification phase.
  console.log("[autotest] harness placeholder");
}
