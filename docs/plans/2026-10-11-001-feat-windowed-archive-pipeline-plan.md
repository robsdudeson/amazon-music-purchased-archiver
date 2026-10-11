---
title: feat: Add robust windowed archive pipeline
type: feat
status: active
date: 2026-10-11
---

# feat: Add robust windowed archive pipeline

## Overview

Update `amazon-music-purchased-archiver` from a row-by-row / small-batch downloader into a robust supervised archive pipeline based on the behavior observed during a full 779-purchase backup. The new pipeline should capture the complete purchased list, download with overlapping >100-row windows to work with Amazon's ZIP behavior, extract and union-consolidate recordings without over-deduping versions, optionally fill zip gaps from pre-existing flat files, normalize ID3 tags from the final path structure, and safely clean intermediates.

---

## Problem Frame

The current tool assumes visible-row batches can be downloaded and organized directly into `Unsorted/`. The real Amazon Music web behavior is more constrained:

- Selections **over ~100 songs** produce fast ZIP downloads, capped around 100 tracks.
- Selections **under ~100 songs** can be unreliable, slow, or download individual MP3s to the default browser destination.
- Amazon always names bulk ZIPs `AmazonMusicDownload.zip`, so downloads must be detected, stabilized, and renamed immediately.
- The purchased page is virtualized; all rows must be captured through scroll-and-dedupe before reliable window planning.
- Consolidating by loose normalized title is unsafe because it collapses distinct versions/editions, e.g. multiple *I Am A Man Of Constant Sorrow* variants. The correct final library is the union of distinct `Artist/Album/basename` recordings, plus verified fills from pre-existing flat `Unsorted/*.mp3` files.

This plan makes those findings first-class behavior in the archiver.

---

## Requirements Trace

- R1. Capture the full virtualized purchased-track list before downloading.
- R2. Download through overlapping >100-track windows that produce fast ZIPs and tolerate Amazon's ~100-track cap.
- R3. Detect ZIP completion by filesystem stabilization and rename each `AmazonMusicDownload.zip` to a stable window-specific filename.
- R4. Preserve distinct recordings by unioning extracted ZIP trees by `Artist/Album/basename`; never dedupe by loose normalized title alone.
- R5. Fill ZIP gaps from pre-existing flat `Unsorted/*.mp3` files when they represent recordings not present in the ZIP union.
- R6. Provide reconciliation reports: captured purchases, window downloads, distinct recordings, added-from-unsorted files, unmatched files, and cleanup eligibility.
- R7. Add local ID3 normalization from final `Artist/Album/NN - Title.mp3` paths.
- R8. Add safe cleanup for ZIPs and extracted intermediates only after successful consolidation.
- R9. Update README usage around the observed Amazon cap and the recommended supervised pipeline.

---

## Scope Boundaries

### In scope

- New CLI commands for capture, windowed download, extract/consolidate, normalize tags, and cleanup.
- Playwright automation against Amazon Music's visible web UI only.
- Local filesystem reconciliation and reporting.
- ID3 metadata derived from path structure.
- Tests for pure filesystem/manifest/consolidation/tag-planning logic.

### Out of scope

- Credential storage, MFA/captcha bypass, DRM bypass, or Prime/Unlimited streaming downloads.
- Cover art or release-year lookup from external metadata services.
- Fully unattended operation; the tool remains supervised.
- Perfect semantic equivalence detection across unrelated recordings with the same title.

---

## Key Technical Decisions

1. **Pipeline commands instead of one monolithic `run`.**
   - Rationale: capture, download, consolidate, normalize, and cleanup each have different failure/retry semantics.

2. **Use captured list positions for window planning.**
   - Rationale: the trailing numeric value in Amazon `data-key` is not a reliable list index; array position from the captured list is the stable ordering.

3. **Use overlapping windows of ~120-145 targets with ~90-step spacing.**
   - Rationale: selections over ~100 produce ZIPs; overlap compensates for Amazon's ~100 cap and click/selection misses.

4. **Set browser download behavior once per browser session.**
   - Rationale: repeated `Browser.setDownloadBehavior` calls appeared flaky; setting once matched the successful bulk ZIP runs.

5. **Consolidate by source tree identity, not normalized title.**
   - Rationale: normalized title matching over-collapsed distinct versions/editions. `Artist/Album/basename` preserves Amazon's actual downloaded recording structure.

6. **Use flat `Unsorted/*.mp3` only as a fill source.**
   - Rationale: pre-existing files can complete gaps the ZIP windows missed, but ZIPs provide better structure and should remain primary.

---

## System-Wide Impact

- **CLI users:** new recommended flow replaces `run --max-batches ...` as the primary archive path.
- **Local disk usage:** the archive process may temporarily use 20+ GB for ZIPs and extracted intermediates before cleanup.
- **Manifest/report consumers:** reports become more detailed and split by pipeline stage.
- **Tests/build:** existing organizer tests remain, but consolidation and window-planning logic should become independently testable.

---

## Implementation Units

- [x] U1. **Capture the full purchased list**
  - **Goal:** Add a command that scrolls the virtualized purchased page until stable and writes a durable purchased-song list.
  - **Requirements:** R1, R6
  - **Dependencies:** None
  - **Files:**
    - `src/cli.ts`
    - `src/browser.ts`
    - `src/purchased-list.ts`
    - `tests/purchased-list.test.ts`
    - `README.md`
  - **Approach:**
    - Extract page-row capture into a module that reads `music-image-row[primary-text]` attributes: `data-key`, `primary-text`, `secondary-text-1`, `secondary-text-2`.
    - Store true list order as array position; keep Amazon `data-key` as identity, not position.
    - Scroll until repeated passes add no new keys and scroll position/height stabilize.
    - Write JSON and CSV under the archiver output directory, e.g. `purchased-songs.json` and `purchased-songs.csv`.
  - **Patterns to follow:**
    - Existing persistent browser launch in `src/browser.ts`.
    - Existing path conventions in `src/paths.ts`.
  - **Test scenarios:**
    - Given repeated row snapshots with duplicate keys, capture output contains one song per key in first-seen order.
    - Given `data-key` suffixes that do not match array position, output preserves both `key` and `position` distinctly.
    - Given no new rows for the configured stable-pass count, capture stops.
  - **Verification:**
    - A supervised `capture-list` run writes complete JSON/CSV artifacts and logs count/progress.

- [x] U2. **Add window-planning and selection primitives**
  - **Goal:** Generate overlapping download windows and reliably select target rows by captured `data-key`.
  - **Requirements:** R2, R6
  - **Dependencies:** U1
  - **Files:**
    - `src/window-plan.ts`
    - `src/browser.ts`
    - `tests/window-plan.test.ts`
  - **Approach:**
    - Generate default windows from captured list: size around 140, step around 90, with an option for targeted explicit ranges.
    - For each window, explicitly scroll to top with DOM `scrollTo(0, 0)` before forward selection; this fixes the observed tail-window instant-abort state.
    - Ctrl-click target `music-image-row` instances by `data-key` as they mount while scrolling.
    - Read the toolbar selected-count line and apply guardrails:
      - abort if actual selection is unexpectedly low;
      - abort if actual selection exceeds target by a small tolerance, preventing stale-selection over-download.
  - **Patterns to follow:**
    - Existing `tryBulkDownload` and `clearSelection` concepts in `src/browser.ts`, but move reusable selection behavior into testable helpers where possible.
  - **Test scenarios:**
    - Default 779-track input creates overlapping windows covering the full range including the tail.
    - Custom explicit ranges parse correctly and preserve inclusive/exclusive semantics consistently.
    - Selection guard rejects actual count `0` and rejects stale over-selection above tolerance.
  - **Verification:**
    - Logs show each window's target range, target count, actual selected count, and pass/fail decision.

- [x] U3. **Implement ZIP download detection and stable renaming**
  - **Goal:** Treat bulk ZIP downloads as first-class artifacts with stable filenames and bounded waits.
  - **Requirements:** R2, R3, R6
  - **Dependencies:** U2
  - **Files:**
    - `src/download-watch.ts`
    - `src/browser.ts`
    - `tests/download-watch.test.ts`
  - **Approach:**
    - Snapshot the download directory before clicking Download.
    - Poll for new `.zip` files and partial files (`.crdownload`, `.tmp`, `.part`).
    - Consider a ZIP complete only when size is stable for several polls and no partial remains.
    - Rename `AmazonMusicDownload.zip` to `win_START_END.zip` or `batch_LABEL_START_END.zip` immediately.
    - Bound each window wait and record a failed/stalled window instead of hanging silently.
  - **Patterns to follow:**
    - Existing `downloadDirectorySnapshot` / `waitForDownloadsToSettle` in `src/browser.ts`, but specialize for ZIP stability and rename semantics.
  - **Test scenarios:**
    - A growing ZIP with a partial file is not marked complete until the partial disappears and size stabilizes.
    - A completed ZIP is renamed to the requested window name.
    - A timeout returns a structured failure without deleting partial evidence.
  - **Verification:**
    - Windowed run produces uniquely named ZIPs and can be resumed without filename collisions.

- [x] U4. **Add extract and union consolidation pipeline**
  - **Goal:** Merge all downloaded ZIP trees into a final structured library while preserving distinct versions/editions.
  - **Requirements:** R4, R5, R6
  - **Dependencies:** U3
  - **Files:**
    - `src/consolidator.ts`
    - `src/organizer.ts`
    - `tests/consolidator.test.ts`
    - `README.md`
  - **Approach:**
    - Extract each ZIP into a deterministic extracted-intermediates directory.
    - Copy distinct ZIP recordings to `Purchased/` by key `(normalized artist folder, normalized album folder, normalized basename)`.
    - Do not collapse recordings by normalized title only.
    - Add a second fill pass over pre-existing flat `Unsorted/*.mp3`:
      - compute a core filename identity that drops track number, disc marker, `[Explicit]`, and Windows duplicate suffixes;
      - skip if already present in the ZIP core set;
      - otherwise match to the purchased list and place under the purchased artist/album.
    - Emit `consolidation-report.json` with counts: from ZIPs, added from Unsorted, total, unmatched.
  - **Patterns to follow:**
    - Existing ZIP extraction via `adm-zip` in `src/organizer.ts`.
    - Existing filename sanitization and filesystem walking helpers in `src/organizer.ts`.
  - **Test scenarios:**
    - Two window extracts containing the same `Artist/Album/01 - Title.mp3` produce one output file.
    - Same basename under different albums is preserved as two distinct recordings.
    - Versioned titles such as `Radio Edit`, `Instrumental`, and `With Band` are preserved separately.
    - Flat `Unsorted/09 - Eleanor Rigby.mp3` fills a missing purchased album track when no ZIP recording core exists.
    - Windows duplicate suffixes like `(2)` do not create duplicate fill files.
  - **Verification:**
    - Final output has no loose root MP3s, no `Unmatched/` entries in normal successful runs, and preserves albums like The Beatles Tribute at full track count when fills exist.

- [x] U5. **Add reconciliation and reporting commands**
  - **Goal:** Make coverage and count discrepancies explainable before cleanup.
  - **Requirements:** R6
  - **Dependencies:** U1, U4
  - **Files:**
    - `src/reconcile.ts`
    - `src/cli.ts`
    - `tests/reconcile.test.ts`
    - `README.md`
  - **Approach:**
    - Add a `reconcile` command that reads captured purchases and final `Purchased/` output.
    - Report:
      - purchase entries count;
      - distinct recording count;
      - ZIP recordings count;
      - added-from-unsorted count;
      - unmatched files and unmatched purchases.
    - Include warnings explaining why purchase entries may not equal final recordings (duplicates, distinct versions, multiple editions, fills).
    - Avoid treating short titles (`Go`, `ii`, `22`, `C.L.U.`, `F.T.W.`) as missing solely because token matching is weak.
  - **Patterns to follow:**
    - Existing manifest/report style in `src/manifest.ts` and `src/organizer.ts`.
  - **Test scenarios:**
    - Short title purchases are verified by exact/core filename match before fuzzy token matching.
    - Report distinguishes duplicate purchase entries from distinct version recordings.
    - Missing Beatles Tribute tail tracks are reported when neither ZIP nor Unsorted contains them.
  - **Verification:**
    - Running `reconcile` produces an actionable report and a non-zero warning count only for real gaps.

- [x] U6. **Add local ID3 normalization**
  - **Goal:** Normalize basic ID3 tags from the final path structure.
  - **Requirements:** R7
  - **Dependencies:** U4
  - **Files:**
    - `src/tag-normalizer.ts`
    - `src/cli.ts`
    - `tests/tag-normalizer.test.ts`
    - `package.json`
    - `README.md`
  - **Approach:**
    - Add a JavaScript/TypeScript ID3 dependency rather than relying on system Python/Mutagen.
    - Parse `Artist/Album/NN - Title.mp3`.
    - Write title, artist, album, album artist, and track number.
    - Keep cover art and release-year lookup out of this unit.
    - Write `tag-normalization-report.json` with updated/skipped/errors.
  - **Patterns to follow:**
    - Existing CLI command style in `src/cli.ts`.
  - **Test scenarios:**
    - `Artist/Album/04 - 22.mp3` produces title `22`, track `4`, artist, and album tags.
    - Files with no `NN - ` prefix get title from basename and omit track number.
    - Normalization reports per-file errors without aborting the whole run.
  - **Verification:**
    - Running `normalize-tags` over `Purchased/` updates all valid MP3s and writes a report.

- [x] U7. **Add safe cleanup command**
  - **Goal:** Reclaim intermediate disk space only after consolidation succeeds.
  - **Requirements:** R8
  - **Dependencies:** U4, U5
  - **Files:**
    - `src/cleanup.ts`
    - `src/cli.ts`
    - `tests/cleanup.test.ts`
    - `README.md`
  - **Approach:**
    - Add a cleanup command with a dry-run default or explicit confirmation flag.
    - Delete only:
      - `Unsorted/incoming/*.zip`
      - `Unsorted/incoming/extracted/`
    - Never delete `Purchased/` or pre-existing `Unsorted/*.mp3`.
    - Refuse cleanup when the latest consolidation report is missing or indicates unmatched files unless forced.
  - **Patterns to follow:**
    - Existing `ensurePaths` and output folder conventions in `src/paths.ts`.
  - **Test scenarios:**
    - Dry run reports reclaimable paths and sizes without deleting.
    - Successful cleanup removes ZIPs and extracted directory only.
    - Cleanup refuses to run when consolidation report is absent unless forced.
  - **Verification:**
    - Cleanup leaves `Purchased/` and `Unsorted/*.mp3` untouched.

- [x] U8. **Update README around the new recommended workflow**
  - **Goal:** Document the observed Amazon behavior and the new pipeline commands.
  - **Requirements:** R9
  - **Dependencies:** U1-U7
  - **Files:**
    - `README.md`
  - **Approach:**
    - Replace the current row-menu / small-batch guidance with the supervised archive pipeline:
      1. `init`
      2. `login`
      3. `capture-list`
      4. `download-windows`
      5. `consolidate`
      6. `reconcile`
      7. `normalize-tags`
      8. `cleanup`
    - Add a section explaining Amazon's observed cap and why windows are >100 with overlap.
    - Add disk-space expectations and cleanup notes.
    - Add a recovery/resume section: rerun capture, rerun failed windows, rerun consolidation.
  - **Patterns to follow:**
    - README's current supervised/safety framing.
  - **Test scenarios:**
    - Test expectation: none -- documentation-only change.
  - **Verification:**
    - README gives a user enough context to run the new flow without knowing this investigation history.

---

## Phased Delivery

1. **Foundation:** U1, U2, U3
   - Captures list and reliably produces named ZIPs.
2. **Correct output:** U4, U5
   - Produces the final library and explains counts/gaps.
3. **Polish and lifecycle:** U6, U7, U8
   - Normalizes tags, cleans intermediates, and documents the workflow.

---

## Risk Analysis & Mitigation

- **Amazon UI drift:** selectors may break.
  - Mitigation: centralize selectors; keep commands supervised; document how to run live inspection.
- **Wrong dedup semantics:** title normalization can collapse distinct versions.
  - Mitigation: primary dedup is source tree identity (`Artist/Album/basename`), not title.
- **Tail-window misses:** final rows can be dropped if scroll state starts at bottom or selection is below ZIP threshold.
  - Mitigation: explicit `scrollTo(0,0)` before selection and targeted explicit-range reruns.
- **Disk pressure:** intermediate ZIPs/extractions can exceed 20 GB.
  - Mitigation: report sizes and add safe cleanup after verified consolidation.
- **False reconciliation warnings for short titles:** token matching fails on `Go`, `ii`, `22`.
  - Mitigation: exact/core filename matching before fuzzy matching.

---

## Deferred Implementation Notes

- Exact CLI flag names can be adjusted during implementation, but the pipeline stages should remain explicit.
- Cover art/release-year metadata can be added later as a separate feature after local tag normalization is stable.
- A future `download-targets` command could re-download only missing purchase positions after reconciliation, but this plan prioritizes the proven overlapping-window strategy.

---

## Documentation Plan

- Update `README.md` with the new pipeline and Amazon cap behavior.
- Add troubleshooting entries for:
  - ZIP not appearing;
  - selection count too low;
  - tail ranges;
  - apparent purchase-count vs file-count mismatches.

---

## Success Criteria

- A supervised user can archive a large purchased library without manually selecting every track.
- The tool preserves distinct versions/editions and avoids the 700-file over-collapse failure mode.
- The final `Purchased/` tree has no loose files and is ready for tag normalization.
- Cleanup is safe and only removes intermediates after successful consolidation.
