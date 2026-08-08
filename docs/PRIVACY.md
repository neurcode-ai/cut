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
data, Cut payload, recipient address, access link, or telemetry.

A hosted reply target may contain an unlisted capability in its URL fragment.
Passing that URL as a command-line argument can retain it in shell history or
expose it to local process inspection, so `--reply-to -` accepts one target on
piped stdin. The CLI keeps the capability in process memory, sends it only in
the parent-access request header, and never writes it to the local Composer
draft, archive, portable Markdown/JSON, logs, or telemetry. Parent IDs and the
reply relation are sent only when hosted publication is explicitly confirmed.

The local AI Markdown preview is another representation of the same reviewed
Cut cut. It is not sent to an AI service by the Composer. Copying it or using
an external agent is an explicit user action governed by that destination's
privacy terms.
