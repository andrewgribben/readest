# Vanilla BookOrbit OPDS auto-sync verification

Status: **not yet executed**. Track this separately from the fork's OPDS and audiobook changes. Do not describe upstream audio auto-download as a bug or an intentional feature until this test supplies evidence.

## Baselines and fixture

- Test the unmodified official Readest v0.12.10 APK first. Record its source URL, SHA256, device, and installed version.
- Repeat against unmodified upstream main at `2401d3e230e4742a9486e7898552459c07db1d98`, recording the APK checksum and exact build command.
- Use a dedicated BookOrbit test catalog containing one ebook-only title, one audiobook-only title, and one title offered in both formats. Record each audio asset's advertised size and whether it is a complete book or one track.
- Use a spare device or isolated Android profile. Preserve the user's existing Readest installation and data; do not clear storage or uninstall it.
- Save the actual OPDS feed with credentials and private identifiers redacted. Record the acquisition links, relations, media types, pagination, and which entries are discoverable from the subscribed URL.

## Procedure

1. With auto-sync off, observe an idle period and record the baseline network traffic and bookshelf contents.
2. Turn auto-sync on. Do not press Play or Download. Record the enable time, first network request, first ebook appearance, and each subsequent bookshelf change.
3. Capture BookOrbit access logs or equivalent network evidence: request path, method, status, Range header, response bytes, duration, and retries. Do not retain credentials or authorization headers.
4. Wait for the initial sync to finish and observe the next scheduled sync. Record any errors, repeated downloads, cache files, imported ebooks, and audiobook library rows.
5. Only after capturing the auto-sync result, disable networking and attempt to open any audiobook that appeared. Record whether it plays, seeks, and continues across all tracks. Distinguish actual offline playback from a library stub or cached first track.
6. Restore networking, manually open an audiobook from OPDS, and record its requests separately. This distinguishes auto-sync behavior from playback-triggered transfers.
7. Repeat with an ebook-only control feed on the same network. Compare when ebooks appear, recording whether audio transfers occupy download slots or delay a batch's publication.

## Evidence and interpretation

- [ ] Official release tested without fork features.
- [ ] Upstream-main build tested without fork features.
- [ ] Confirmed exactly which audio bytes auto-sync transfers, if any.
- [ ] Confirmed whether transfers produce a usable complete offline audiobook.
- [ ] Confirmed errors/retries and their effect on later syncs.
- [ ] Measured whether audio transfers delay ebook shelf publication.
- [ ] Compared vanilla behavior with PR1's streaming-stub behavior.
- [ ] Recorded a conclusion supported by the observations, including any existing useful behavior PR1 must preserve.

No results are asserted by this checklist. Commit a dated, redacted results section after execution. If vanilla provides working automatic offline audiobook downloads, treat PR1's difference as a compatibility decision before merging; if it only downloads bytes and fails to import, document that measured failure rather than assuming it.
