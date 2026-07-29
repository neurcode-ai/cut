# Release policy

Packages use semantic versioning independently. During `0.x`, incompatible
public API or format behavior requires a minor version increase. Patch releases
must preserve archive and CLI behavior.

A release candidate must pass:

- all package and adversarial tests;
- boundary, privacy, secret, and copy-overclaim scans;
- dependency-license audit;
- deterministic package build and packed-content parity;
- anonymous cold installation;
- generated CycloneDX SBOMs;
- `git diff --check`.

Packages are published from the exact audited commit. Tags identify both the
package and version. Provenance is claimed only when the registry supplies
verifiable provenance for that exact artifact.
