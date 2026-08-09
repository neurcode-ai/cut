# Applyable Replies V1

An applyable reply is one canonical `cut: 1` archive. It remains readable by
ordinary Cut readers; there is no second patch archive format.

## Portable representation

The reply contains one ordinary uploaded JSON file item at the reserved path
`CUT_APPLYABLE_REPLY_V1.json`. Its canonical UTF-8 bytes use the format marker
`neurcode-cut-applyable-reply-v1`. Older readers show this as a normal file.
Aware readers validate the metadata and present the suggested edits.

The exact-field metadata binds:

- the hosted parent Cut ID, immutable parent digest, and complete parent Cut
  document needed to prove that digest offline;
- normalized repository identity and 40- or 64-hex base revision;
- authenticated author display identity and browser-suggested-edit provenance;
- server-created HMAC attestation syntax;
- for every edit: ordered ID, exact parent item, kind, NFC portable path,
  provenance, start/end range, original text and digest, bounded context,
  replacement text and digest, and range-result digest.

The complete reply Cut digest covers this metadata blob. Serialization is
canonical and newline-terminated; duplicate or unknown fields fail closed.
The hosted service constructs and attests the blob from the immutable parent.
It does not accept a client-authored archive as an applyable reply.

## Limits

| Boundary | V1 maximum |
| --- | ---: |
| Edits and unique paths | 20 |
| Metadata item | 2 MiB |
| Original or replacement text per edit | 1 MiB |
| Context before or after a range | 16 KiB |
| Portable path | 1,024 UTF-8 bytes; each segment at most 255 |

Normal Cut archive, expanded-byte, blob, and item limits also apply.

## Path and content rules

Paths must be repository-relative NFC text with forward slashes. V1 rejects
absolute and Windows-absolute paths, empty/dot/parent segments, `.git`,
backslashes, percent-encoded traversal separators, controls and bidi override
characters, Windows-invalid and reserved names, trailing spaces/dots,
overlong segments, duplicates, and case-fold collisions.

Only existing UTF-8 file and excerpt items are eligible. File edits bind the
complete carried file. Excerpt edits bind the exact carried range plus bounded
prefix/suffix context. Links, submodules, binary data, new files, deletion,
rename, and mode changes are unsupported.

## Validation model

Portable validation recomputes the embedded parent digest, confirms every
item/blob/range/path/provenance relation, and checks every text digest and
limit. Hosted publication additionally rechecks current reply authority,
immutable parent revision, access/team boundary, visibility, recipients,
expiry, author, and server attestation inside finalization. The reply inherits
the parent access boundary and expiry and is immutable after publication.

Local `cut try` and `cut apply` then bind that verified proposal to the selected
repository and exact current preimage. Metadata validity alone never implies
that local code is current or correct.
