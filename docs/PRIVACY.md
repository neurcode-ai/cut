# Privacy boundary

Local creation reads only the repository selections and commands the user
chooses. The Composer listens on `127.0.0.1`, drafts are stored under the local
Git directory with restricted permissions, and no network client is involved
until Publish.

The airlock inventories every selected item and metadata field. Sensitive paths
are denied by default, and secret-shaped material blocks completion unless the
user addresses the exact finding. Scanners are fallible; review the complete
inventory.

Hosted publishing is a separate, explicit action. The hosted service has its
own privacy and retention policy. This repository contains no production user
data, Share payload, recipient address, access link, or telemetry.
