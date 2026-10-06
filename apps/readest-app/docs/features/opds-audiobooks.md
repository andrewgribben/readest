# OPDS audiobooks and saved listening progress (PR #1)

## What you can do

Pair an ebook with an audiobook from an OPDS catalog, including a configured BookOrbit server. Audiobooks can appear on the library shelf as streaming stubs before playback. Download a recording explicitly to listen offline; paired playback prefers a completed, matching local download and otherwise streams with the catalog's credentials.

Paired and standalone playback share the recording's saved listening position. Playing inside an ebook, pausing, and then opening the standalone audiobook resumes the recording at the saved timestamp. Saves are periodic during playback and flushed on pause, seek and shutdown through the existing provider paths where supported. Generic OPDS feeds have no standard remote progress service; their saved listening state is local unless an identified provider supplies one.

When a new paired session has both a valid listening checkpoint and an approximate ebook-derived position more than 30 seconds apart, choose **Resume audiobook** or **Start from ebook**. At 30 seconds or less, resume the saved audiobook position. A checkpoint must have a matching recording duration within one second. The newest capture wins, including a deliberate rewind; this is not a furthest-position rule. Cancel leaves playback stopped and saves nothing.

Opening the ebook, receiving ebook sync data, or turning pages does not replace the listening checkpoint or repeatedly open the audio-position dialog. BookOrbit percentage-only ebook progress is also accepted when no ebook locator is supplied.

## Why this was added

An OPDS audiobook previously needed to be started before it could be selected for pairing. A downloaded recording could still be described and selected as a stream. Paired playback could also restart from the ebook's estimated chapter position and overwrite the timestamp that standalone playback had saved. These changes make the recording's identity, offline source and listening saves consistent across both entry points.

Auto-download creates streaming audiobook stubs rather than fetching all audio files. Ebook acquisitions continue to download. This is an intentional behaviour change; it is not a claim that every released upstream app behaved incorrectly. Explicit audiobook downloads remain available.

## How it was tested

Automated tests cover OPDS audio detection, stub creation and retry recovery, pairing and offline source selection, shared local/provider progress hooks, duration validation, rewind handling, startup-choice boundaries, cancellation and an unplayed session's shutdown. The combined upstream-main + PR1 + PR3 source passed 12,864 JavaScript tests (16 skipped), types and lint before the last installed APK.

Phone testing confirmed OPDS stubs and explicit downloads, ebook sync, paired-to-standalone listening resume, and the paired startup position choice. The PR1 feature stage was accepted before PR3 testing. This describes the specific checks confirmed in this session, not coverage of every provider or device.

## Limits, dependencies and rollback

### Chapter sleep timer correction

Paired recordings keep their audio clock running between narrated chunks to avoid playback gaps. A chapter sleep stop now explicitly stops that clock before queuing the next ebook section. Standalone playback checks the outgoing chapter before loading the next audio file, and checks chapter boundaries before publishing periodic progress marks. This prevents a file transition or progress tick from losing the boundary. Files that continue the same chapter still play normally, and manual skips retain their existing behaviour.

Regression tests cover paired clock shutdown, standalone file-boundary stops, progress-tick ordering and continued playback across files within one chapter. Manual verification should seek close to a chapter end, enable **End of chapter**, confirm audible playback stops, and press Play to confirm it resumes. This correction does not add sleep-timer handling to Android Auto's independent native playback path.

PR #3 adds catalog updates and download progress; PR #10 adds Android Auto behaviour. Both stack on this PR. Reading ahead does not yet save an estimated audio timestamp in the background, and standalone listening does not yet offer an audio-derived ebook position alongside ebook sync choices. Those are separate future changes. Ordinary ebook sync behaviour remains responsible for ebook progress.

The consolidated implementation is one commit above fork main, followed by a documentation commit. Revert that implementation commit to remove the feature as a whole, after handling dependent PRs. Do not undo individual historical fix commits from the archived branches. The technical startup-selection rules remain in read-along-narration.md and their boundary tests.
