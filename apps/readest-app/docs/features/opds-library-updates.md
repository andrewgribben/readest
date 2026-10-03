# OPDS library updates and download progress (PR #3)

## What you can do

Use **Update library** on a catalog to refresh its already-linked ebooks from the feed: metadata, covers and changed acquisition files. It does not import new unmapped entries, delete library books or reset Auto-download's known-entry list. Use Auto-download to discover and import new books and add streaming audiobook stubs.

While a catalog is working, its card shows progress under the Auto-download controls. Active ebook downloads show their titles, percentages when the server supplies a size, and completed/total counts. Unknown sizes use an indeterminate bar. Concurrent transfers are displayed separately; failures are counted separately. Update library distinguishes checked entries from downloaded files. Audiobook stub creation is not counted as an audio-file download. The indicator disappears when that catalog's work ends and stays current if Catalog Manager is closed and reopened during the same run.

Catalog discovery follows next-page links beyond the old five-page cutoff, within a shared budget of 50 feed fetches. Visited URLs prevent loops. If the budget is exhausted, remaining pages are not fetched in that run; there is no resumable crawl cursor. The previous five-page cap is no longer a separate restriction.

## Why this was added

A catalog can change after its books are imported. The user needs an explicit way to refresh those existing entries and see whether the app is checking or downloading files. Without progress, large acquisitions appear to do nothing. The former five-page crawl also left later entries undiscovered in larger catalogs.

## How file changes are detected

Matching ETags are preferred. Without comparable ETags, matching Last-Modified and size establish an unchanged acquisition. When the remote response has neither HTTP validator, matching valid OPDS updated timestamps and matching file sizes are the fallback. Size alone never proves unchanged content. The fallback relies on the publisher advancing the feed timestamp when acquisition bytes change.

Auto-download records the feed timestamp with the verified download fingerprint. An additive database migration preserves old source mappings; those without a captured feed timestamp need one download/hash check to establish it. A later unchanged update can then skip the ebook transfer. Missing or invalid revision information, failed HEAD probes, changed revisions or changed sizes require a content check. Matching downloaded content updates the fingerprint without importing another library row. Covers are refreshed independently and may still transfer.

Progress is temporary per-catalog state, not persisted or synced. Auto-download and Update library cannot overlap on the same catalog. A restart loses the progress display, while committed library batches and subscription state remain on disk.

## How it was tested

Test-first regressions cover six-page discovery with previously known entries, the shared crawl budget, concurrent file percentages, unknown sizes, failures, catalog isolation and cleanup. Further tests cover initial revision capture, database persistence, unchanged-file skips, same-size revision changes, HTTP-validator precedence and a legacy mapping's first verification followed by an unchanged update. A SQLite migration check preserved an existing mapping and its size while adding an unset revision column.

The combined upstream-main + PR1 + PR3 APK source passed 12,864 JavaScript tests (16 skipped), types and lint. Manual phone testing confirmed audiobook stubs and explicit downloads, discovery beyond the old cutoff, and unchanged-file Update library behaviour after the corrected APK was installed. The user accepted these corrections. Other server implementations and all failure cases are not claimed as manually verified.

## Dependency and rollback

This PR stacks on PR #1. It adds the source-fingerprint migrations without changing existing audiobook progress identities. Revert this PR's implementation commit to remove Update library, its progress display and its pagination/change-detection additions; coordinate that rollback with any dependent code. Do not drop database columns or clear app storage as part of rollback. Keep previously applied migration records and use forward migrations if the schema later changes.
