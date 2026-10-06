# Forest Homepage

> **Disclaimer**: This plugin is a **vibe-coding product** — the whole codebase was generated in AI conversations and has not been reviewed line by line. It may contain bugs or conflict with your theme / other plugins. Use at your own risk.

A **card-based homepage** for SiYuan: the documents you opened recently, a scratchpad for quick notes, a month calendar you can page through, and a full-text search box — all on one screen. The background image and the greeting are configurable, and the cards can be dragged into any order.

## Development inspiration

Forest Homepage began with an idea taken from a real forest: no noise, no chatter — just you, quietly there.

It sets out to be an entrance with no complicated features at all, one that simply shows you your content and takes you straight to it, so you can slip into your flow quickly. That is enough.

## Usage

**Open it** from the homepage icon at the far left of the top bar, or via the "Open Homepage" command. It opens as a regular tab. Right-click the top bar icon for quick access to settings or the setup wizard.

Want SiYuan to **land on the homepage as soon as it starts**? Turn on **Settings → Open the homepage on launch** (the first item in the panel; off by default, takes effect on the next start).

- **Greeting (three lines)**
  - Line 1: a time-aware salutation plus your name, e.g. "Good evening, Alex"
  - Line 2: a short line — a different one each day by default (built-in list), or your own fixed sentence
  - Line 3: date and time
- **Search box** — right below the time. It searches **document titles** and **document content** at once. `↑` `↓` to move, `Enter` to open, `Esc` to clear. Press `⌘ / Ctrl + K` anywhere on the homepage to focus it.
- **Recent** — documents you viewed recently; click one to open it. Refresh with the button in the card header.
- **Quick Notes** — type an idea and press `⌘ / Ctrl + Enter` (or click Save). Hover a note to delete it.
- **Calendar** — `‹` `›` to change month, "Today" to jump back. Dots mark days that have documents; click a day to list them, or create a daily note from an empty day.
- **Quick access** — the documents you pinned, organised into groups. Three ways to pin:
  - hover a row in **Recent** or in the search results and click the **pin**;
  - **right-click** any document row and choose "Pin to quick access", or file it into a group directly;
  - click **+ Add** in the card header, search for a document, and click a row to pin or unpin it.
  The card is full width by default, and **the wider it gets, the more columns the items fit** (1/4 wide → 1 column, 1/2 wide → 3, full row → 6). So stretching it horizontally is exactly how you see more pinned content.
  - **Adaptive layout** — the column count comes from the width the items *actually* have: desktops and tablets lay them out in several columns once stretched, a phone in portrait fits two, landscape and tablets fit more, and very narrow screens fall back to a single column.
  - **Long titles are truncated** — an over-long name shows only its first few characters plus `…`; hover to read the full title. Nothing gets pushed out of shape.
  - **Drag an item onto another group** to recategorise it.
  - **Reorder groups** — drag the six-dot grip at the left of a group header up or down. The new order applies immediately and is saved.
  - **An empty "Unfiled" group is hidden** — once every pinned document lives in your own groups, the catch-all group stops taking up space, and reappears as soon as it has content.
- **Stats** — total documents, time used today, words written today. Refresh from the card header.
  - **Total documents** comes straight from SiYuan's database and is exact.
  - **SiYuan does not track usage time**, so the plugin accumulates it locally with a 30-second heartbeat: only while the window is visible and you have been active within the last 10 minutes. It therefore starts counting the day you install the plugin; earlier time cannot be recovered. You can clear it in the settings.
  - **Words written today** is not tracked by SiYuan either; it is counted per content block — blocks created or changed today, using their current length. Editing an old paragraph counts that whole paragraph, so treat it as an approximation.
- **Drag to reorder** — drag a card by its blank area (on touch devices, hold the grip at the top-left of the card). The order is remembered.
- **Drag to resize** — drag the diagonal grip at the bottom-right corner. Width snaps between **1/4 · 1/3 · 1/2 · 2/3 · full row** and height between **short · normal · tall · extra tall**, so the grid always stays tidy. A badge next to the cursor shows the current step.
- **Add / remove cards** — all in **Settings → Visible cards**, together with "Show all / Hide all / Reset order". The first-run wizard reads the same list, so any card added in a future version shows up in both places.

## First run

After enabling the plugin, a **setup wizard** opens automatically:

1. Pick a name (shown on the first line of the greeting)
2. Choose which cards you want
3. Pick a background image (skippable)

Run it again any time from **Settings → Plugins → Forest Homepage → Settings → Setup wizard**.

## Install

**Recommended**: in SiYuan open **Settings → Bazaar → Plugins**, search for "Forest Homepage" and install it.

Manual install:

1. Download `package.zip` from [Releases](https://github.com/Xiaozhu1619/siyuan-plugins-foresthomepage/releases)
2. Unzip it — make sure the folder name matches `name` in `plugin.json`
3. Put it under `data/plugins/` in your workspace
4. Restart SiYuan and enable it in **Settings → Plugins**

## Settings

**Settings → Plugins → Forest Homepage → Settings**

| Option | Meaning | Default |
| --- | --- | --- |
| Name | The name used on the first line of the greeting; leave empty to show only the salutation | (empty) |
| Second line | "A different line each day" or "Always use the line below" | daily |
| Custom line | Used in fixed mode; joins the rotation pool in daily mode | empty |
| Background image | A SiYuan asset path, a direct image URL, or upload one | empty (theme background) |
| Background blur | 0 - 40 px | 0 |
| Background dim | 0 - 80, raise it when the image is too bright | 28 |
| Visible cards | Card management: tick to show, untick to remove, plus show all / hide all / reset order | all |
| Search box | Whether to show the search box | on |
| Open the homepage on launch | When on, SiYuan switches to the homepage on the next start; an already-open homepage tab is focused instead of duplicated. Not applied on mobile, in read-only mode, or during the first-run wizard | off |
| Quick access item width | Minimum width per item; decides how many columns the quick access card fits (120 - 320 px) | 176 px |
| Quick access contents | Every pinned document and group, with remove / delete group / clear all | — |
| Usage time record | Clear the locally accumulated usage time | — |
| Reset card sizes | Every card back to its default size (the four regular cards 1/4 wide, normal height; quick access full width) | — |
| Recent documents | 3 - 30 items | 8 |
| Notes shown | 3 - 30 items | 5 |
| Where notes go | Three choices: keep them local, write them into a notebook, or **append them to one specific document** (searchable by title) | local only |
| Week starts on | Monday or Sunday | Monday |
| Daily note path | Path template used when creating a daily note. Supports `{yyyy}` `{MM}` `{dd}` `{yyyy-MM-dd}` | `/日记/{yyyy}/{yyyy-MM-dd}` |

## Data & privacy

- **No network access.** Document content is never copied into plugin storage — search runs against SiYuan's local SQL interface and only returns matching titles and paths.
- **Notes** live in the plugin storage at `data/storage/petal/<plugin-name>/inspirations.json` and travel with SiYuan cloud sync.
- **Quick access** lives in `quickaccess.json` in the same folder, storing only document ids, titles and group names. Groups are a layer inside this card — your notebooks are never modified.
- **Settings** live in `settings.json` in the same folder.
- A background image uploaded through the picker goes into your workspace `assets` folder; you can clean it up with SiYuan's asset manager.

## Known limitations

- Cards use **fixed size steps**; content that overflows scrolls inside the card instead of stretching it.
- "Time today" only starts counting from the day you first run the plugin; time before that cannot be recovered.
- "Words today" is an **approximation counted per content block**, not a per-character writing ledger.
- On narrower windows the available width steps shrink (half/full only at medium widths, full width only on small screens) and come back when the window grows again.
- Calendar dots mean "a document was created that day", not strictly "a daily note exists".
- Search is a `LIKE` match, not tokenized full-text; the first query on a very large workspace may take a moment.
- On touch devices cards can only be dragged by the grip, so that dragging does not fight page scrolling.
- In read-only / publish mode, notes and settings are not persisted to disk.
- With "Open the homepage on launch" on, the homepage shows up about 0.3 s after startup — the time SiYuan needs to finish restoring your previous tabs and recalculating the tab bar; waiting it out keeps the plugin from fighting that final pass over focus.

## Changelog

Only the last three releases are listed here; see [CHANGELOG.md](https://github.com/Xiaozhu1619/siyuan-plugins-foresthomepage/blob/main/CHANGELOG.md) for the full history.

- **v0.7.0** (2026-10-06): new "Open the homepage on launch" switch (first item in the settings panel, off by default, effective on the next start); startup delay cut from 1.2 s to 0.3 s; shorter store description.
- **v0.6.1** (2026-10-02): fixed the platform declarations in `plugin.json` to pass the bazaar PR check.
- **v0.6.0** (2026-10-02): first bazaar release.

## License

MIT

---

> If you are forking this: replace `author` and `url` in `plugin.json` with your own details before publishing, and keep `name` identical to the repository name.
