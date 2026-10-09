# Amazon Music Purchased Archiver

TypeScript/Playwright helper for backing up **Amazon Music purchased tracks** on Windows.

It is intentionally supervised:

- You sign in manually in a persistent browser profile.
- The tool only uses Amazon's normal UI and visible Download controls.
- It does not store passwords, bypass MFA/captcha, bypass DRM, or download Prime/Unlimited-only tracks.
- Downloaded ZIPs/audio files are organized locally with a resumable manifest.

## Install

From PowerShell or Windows Terminal:

```powershell
cd C:\Users\rd\code\amazon-music-purchased-archiver
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

## Run the downloader

```powershell
npm run dev -- run --max-batches 500 --batch-pause-ms 5000
```

The tool opens the same persistent browser profile, visits:

```text
https://music.amazon.com/recently/purchased
```

It waits for the Amazon Music UI to load, then processes visible `music-image-row` tracks while scrolling through Amazon's lazy-loaded list. For each unique visible row, it clicks the row's three-dots button (`aria-label="Opens menu"`) followed by `music-list-item[primary-text="Download"]`. After each download attempt it organizes local files. Use `--batch-pause-ms` to slow the loop down if Amazon needs more time between downloads.

If Amazon shows MFA, captcha, device authorization, or an unexpected prompt, handle it manually in the visible browser. The script will not bypass those checks.

## Organize downloaded files only

If you download files manually, place them in:

```text
C:\Users\rd\Downloads\AmazonMusicStaging
```

Then run:

```powershell
npm run dev -- organize
```

## Output folders

Default folders:

```text
C:\Users\rd\AmazonMusicPurchasedArchiver\manifest.csv
C:\Users\rd\AmazonMusicPurchasedArchiver\staging
C:\Users\rd\AmazonMusicPurchasedArchiver\browser-profile
C:\Users\rd\Downloads\AmazonMusicStaging
C:\Users\rd\Music\Amazon Purchased\Unsorted
```

The manifest records source path, local path, SHA-256 hash, status, and errors. Duplicate audio files are detected by hash.

## Practical run strategy

1. Run `login` and manually download one small purchase to confirm Amazon still permits browser downloads for your account.
2. Run `run --max-batches 20` as a pilot.
3. Check `Music\Amazon Purchased\Unsorted` and `manifest.csv`.
4. Increase batches for a longer supervised run.

## Notes

Amazon changes its UI often. If the script scrolls without finding Download controls, start a manual download in the browser and run `organize`; then we can tune selectors against the exact current UI.
