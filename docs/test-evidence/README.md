# Saved collection disk sync: recorded test

[Watch the full 2-minute 40-second recording](collection-disk-sync.webm).

The continuous recording shows the production Chromium sidebar beside observations read from real extension storage and file streams.
Run sends the current draft. Only explicit Save changes the saved collection request and its disk backup.

## Checkpoints

All 17 assertions passed during recording. Times below are approximate.

| Time | Check |
| --- | --- |
| 00:00 | Start the real extension with an empty draft. |
| 00:10 | Save a named request into a collection. |
| 00:20 | Show that automatic disk sync starts disabled. |
| 00:28 | Choose the test directory and enable sync. |
| 00:36 | Read the first Postman JSON backup from disk. |
| 00:44 | Run edited draft values while saved and disk values remain unchanged. |
| 00:56 | Close and reopen the sidebar without promoting the draft into the collection. |
| 01:10 | Select Save and verify the new disk contents. |
| 01:19 | Rename the collection while keeping its original disk filename. |
| 01:27 | Retry an unchanged export and verify zero file commits. |
| 01:37 | Disable sync and verify the disk file stays unchanged. |
| 01:45 | Re-enable sync and back up the saved changes. |
| 01:54 | Inject a disk-full failure and preserve the earlier complete backup. |
| 02:04 | Remove the failure and recover through Retry. |
| 02:16 | Finish an active export after the sidebar document closes. |
| 02:26 | Reopen and verify the final saved data and original filename. |

## Reproduce

Install the locked project dependencies and Playwright Chromium, then run:

```bash
pnpm build
node scripts/record-collection-sync.mjs
```

The script saves a raw WebM recording, screenshots, and timestamped assertion results in `.playwright/collection-sync-evidence/`.
The committed recording uses VP9 at 1280 × 960 and 10 frames per second. Compression preserves the recording's pace and duration.
To produce the smaller version with FFmpeg:

```bash
ffmpeg -y -i .playwright/collection-sync-evidence/collection-disk-sync.webm \
  -r 10 -c:v libvpx-vp9 -crf 34 -b:v 0 -deadline good -cpu-used 4 -threads 2 -an \
  docs/test-evidence/collection-disk-sync.webm
```

## Verification limits

- Folder selection returns a real browser-managed directory instead of opening the operating system's native picker.
- The production sidebar document runs in a test frame. Closing that frame tears down the actual document and exercises background completion.
- Disk-full errors and a held write are injected in the background and labeled in the recording.
- The native browser sidebar frame, external-folder permission dialogs, Firefox runtime, and external HTTP services are not covered.
- The local HTTP server, browser, and temporary browser profile are closed or removed after recording.
