# Amazon Music Purchased Archiver

TypeScript/Playwright helper for backing up **Amazon Music purchased tracks** on Windows.

It is intentionally supervised:

- You sign in manually in a persistent browser profile.
- The tool only uses Amazon's normal UI and visible Download controls.
- It does not store passwords, bypass MFA/captcha, bypass DRM, or download Prime/Unlimited-only tracks.
- Downloaded ZIPs/audio files are organized locally with resumable reports.

## Install

From PowerShell or Windows Terminal:

```powershell
cd "$env:USERPROFILE\code\amazon-music-purchased-archiver"
npm install
npx playwright install chromium
npm run build
```

## First-time setup

```powershell
npm run dev -- init
npm run dev -- login
```

A browser opens to Amazon Music Purchased. Log in manually and confirm you can see your purchased music. Leave the browser profile authenticated, then stop the terminal with `Ctrl+C`.

## Recommended archive pipeline

Amazon's web UI has an important bulk-download behavior:

- selecting **over ~100 tracks** produces a fast ZIP download, capped around 100 tracks;
- selecting **under ~100 tracks** can be slow, unreliable, or download individual MP3s to the browser default location;
- Amazon reuses `AmazonMusicDownload.zip`, so ZIPs must be detected, stabilized, and renamed immediately.

The reliable supervised workflow is therefore:

```powershell
npm run dev -- capture-list
npm run dev -- download-windows --batch-pause-ms 5000
npm run dev -- consolidate
npm run dev -- reconcile
npm run dev -- normalize-tags
npm run dev -- cleanup --yes
```

### `capture-list`

Scrolls the virtualized purchased list until stable and writes:

```text
%USERPROFILE%\AmazonMusicPurchasedArchiver\purchased-songs.json
%USERPROFILE%\AmazonMusicPurchasedArchiver\purchased-songs.csv
```

The captured array position is the true list order. Amazon's `data-key` is preserved as identity but should not be treated as a positional index.

### `download-windows`

Uses the captured list to select overlapping >100-song windows. By default it plans windows around 140 targets with a 90-song step so Amazon's ~100-track ZIP cap still tiles the whole library.

Useful options:

```powershell
npm run dev -- download-windows --max-batches 3
npm run dev -- download-windows --window 672-778
npm run dev -- download-windows --batch-pause-ms 10000
```

Each successful window ZIP is saved in staging as a stable file such as:

```text
%USERPROFILE%\Downloads\AmazonMusicStaging\win_672_777.zip
```

### `consolidate`

Extracts all ZIPs and merges distinct recordings into:

```text
%USERPROFILE%\Music\Amazon Purchased\Purchased
```

The consolidation preserves distinct recordings by `Artist/Album/filename`. It does **not** dedupe by loose normalized title, because that collapses real version/edition differences such as soundtrack variants.

If a recording exists only in the pre-existing flat folder:

```text
%USERPROFILE%\Music\Amazon Purchased\Unsorted
```

`consolidate` can use it as a fill source and organize it under the matching purchased artist/album.

### `reconcile`

Writes a count report comparing captured purchase entries with the consolidated library. Purchase-entry count and final file count may differ because the purchased list can contain duplicate entries, multiple editions, and distinct versions.

### `normalize-tags`

Writes local ID3 tags from the final path structure:

- title
- artist
- album
- album artist
- track number

Cover art and release-year lookup are intentionally deferred.

### `cleanup`

Removes only intermediate ZIPs and extracted copies from:

```text
%USERPROFILE%\Downloads\AmazonMusicStaging
```

It does not delete `Purchased/` or the pre-existing `Unsorted/*.mp3` files.

Run without `--yes` for a dry run.

## Legacy commands

The original downloader remains available:

```powershell
npm run dev -- run --max-batches 20 --batch-pause-ms 5000
npm run dev -- organize
```

`run` processes visible rows while scrolling and is useful for diagnostics or small manual pilots, but the windowed pipeline above is the recommended large-library strategy.

## Output folders

Default folders:

```text
%USERPROFILE%\AmazonMusicPurchasedArchiver\manifest.csv
%USERPROFILE%\AmazonMusicPurchasedArchiver\purchased-songs.json
%USERPROFILE%\AmazonMusicPurchasedArchiver\purchased-songs.csv
%USERPROFILE%\AmazonMusicPurchasedArchiver\browser-profile
%USERPROFILE%\Downloads\AmazonMusicStaging
%USERPROFILE%\Music\Amazon Purchased\Purchased
%USERPROFILE%\Music\Amazon Purchased\Unsorted
```

## Troubleshooting

- **ZIP never appears:** rerun the specific range with `--window START-END`; keep selections over 100 when possible.
- **Selection count is too low:** the page may have been left at the bottom or Amazon may not have mounted rows yet. The tool explicitly scrolls to top before selection; rerun the window if Amazon is sluggish.
- **Tail tracks are missing:** run a late explicit range such as `--window 672-778` so the final album tracks fall inside Amazon's ~100-track ZIP block.
- **File count is lower than purchase count:** this can be correct if duplicate purchases or multiple editions normalize to the same file. Use `reconcile` and the consolidation report before deleting intermediates.
- **Amazon shows MFA/captcha/device prompts:** handle them manually in the visible browser. The tool will not bypass those checks.
