# Downloaded audiobooks in Android Auto (PR #10)

## What you can do

Select a downloaded standalone or paired audiobook in Android Auto and start it without first pressing Play on the phone. Recorded audio uses 15-second backward and 30-second forward controls. Synthesized ebook speech keeps its existing paragraph navigation.

When a paired recording has a saved audiobook position and an ebook-derived estimate more than 30 seconds apart, the car can offer **Resume audiobook** or **Start from ebook**. Custom actions provide the choices, with a browse node showing the two timestamps as a fallback. Dismissing a pending choice does not start playback or save a position. Stale actions from an older selection cannot resolve the current request.

Native downloaded playback saves a private local listening journal every 15 seconds while playing and on pause, seek and end. Opening the phone player reconciles a valid newer journal, including rewinds, and takes over the native recording's actual timestamp. The handoff stops the other player so two recordings cannot play together. Native local checkpoints preserve progress until the phone's existing provider reporting paths can resume.

## Why this was added

The original car interface depended on an active phone playback session for recorded audio, and its previous/next actions moved between chapters. This feature gives downloaded recordings an independent native startup path and the same timed skip controls as the app.

## How it was tested

Earlier testing passed the full JavaScript suite, focused car checkpoint/transport regressions, Kotlin debug unit tests and an ARM64 debug APK build. Manual testing used Android Auto's Desktop Head Unit with the phone's head-unit server. The user confirmed the downloaded-audio stage was working. That confirmation belongs to the earlier cumulative APK at 7a5b6b7b6, before these history-only cleanups; it does not claim that the most recently installed PR1 + PR3 APK contains Android Auto changes.

Automated coverage checks timeline and skip boundaries, choice thresholds, invalid/older/mismatched journals, position handoff and stale request handling. The cleanup separately reruns these checks on the current fork-main base. Host Rust/Clippy limitations, if still present, must be reported as baseline limitations rather than treated as a passing check.

## Limits, dependency and rollback

This PR stacks on PR #1 and is a sibling of PR #3. Cold authenticated streaming, streaming audiobook stubs in the car, and direct native provider reporting/retry reconciliation remain follow-up work. Downloaded-audio tests do not verify those capabilities. The existing app-lock restrictions remain enforced, and browse metadata exposes no credentials or private local file paths.

Revert this PR's implementation commit to remove the native downloaded startup, car position choices and listening-journal reconciliation while retaining PR1's phone playback behaviour. Do not remove saved books or journals during rollback. The native and phone 30-second thresholds must stay aligned if changed later. See read-along-narration.md for the detailed startup and handoff rules.
