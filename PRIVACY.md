# Markloupe Privacy Policy

English | [繁體中文](PRIVACY.zh-TW.md)

*Last updated: 2026-11-21*

Markloupe is a browser extension that displays Markdown files. **It does not collect, sell or send your data to anyone.** It has no account, no analytics, no ads and no server of its own. Everything described below stays in your browser on your computer.

## What Markloupe stores, and where

| Data | Where it is kept | Why |
|---|---|---|
| Your settings (theme, colors, custom CSS, font size, text width, language, and the other options in the popup) | The extension's own storage (`chrome.storage.local`). With settings sync on, also `chrome.storage.sync` (see below) | So your choices apply every time you open a document |
| Reading position: the address of the last 300 Markdown files you opened and how far you had scrolled | The extension's own storage (`chrome.storage.local`) | To return you to the same place when you reopen a file. Older entries are removed automatically. Files opened in an incognito window are not recorded |
| Recent and pinned documents: the address and title of the last 20 Markdown documents you opened, and of up to 20 you pinned | The extension's own storage (`chrome.storage.local`) | To list them in the sidebar's **Recent** tab of local documents and in the popup, so you can open them again. Documents opened in an incognito window are not recorded. Turn it off or clear the list in the popup; turning it off also clears the recent list |
| Folders you allowed for task check-off | The extension's own database (IndexedDB), as folder access handles from Chrome | So checking a box can write back to the file without asking again. Remove them from the popup → **Manage folders** |
| Word template you chose: its style and theme definitions (fonts, sizes, colors, spacing), not the document text | The extension's own storage (`chrome.storage.local`) | To apply the template's styles when you export a Word document. Remove it in the popup → **Word export** |
| Folder tree of each tab: the starting folder, which subfolders are open, and the names it has listed | The extension's own session storage (`chrome.storage.session`). It is removed when you close the tab or the browser | So the tree stays as it was when you open another file in the same tab |
| Small interface states: which popup sections are open, the sidebar of the current tab, the theme of the loading screen | The browser's storage for the popup or for local `file://` pages only (`localStorage`, `sessionStorage`). Markloupe does not read or write the storage of websites | So the interface looks the same as you left it |

**Settings sync** is on by default and can be turned off in the popup. While it's on, your settings are also saved to `chrome.storage.sync`. Your browser then copies them to your other computers through your Google or Microsoft account. Markloupe never receives or sends this data; the browser handles the sync. Folder access, reading positions, recent and pinned documents, the Word template, the custom editor URL and the sidebar width are never synced.

Uninstalling Markloupe deletes all of this data from your computer.

## Network access

Markloupe never sends your data anywhere. It makes network requests on its own in only two cases:

- **Auto refresh** of a Markdown file opened from a website reloads that same address from that same website, the way pressing Reload would. No other site is contacted.
- **Export** as an HTML **Single file** or as a **Word document** downloads the images the document shows from wherever they are hosted, to embed them in the exported file. This happens only when you choose one of these options.
- **Images and links** inside a document are loaded from wherever the document points, as with any web page. Apart from the export above, Markloupe does not add requests of its own.
- **Mermaid diagrams and math** are drawn with libraries packaged inside the extension. No code or data is downloaded from elsewhere.

## Your files

- Markloupe reads a local file only when you open it in the browser, and only that file. When you export a local document as a **Single file** or a **Word document**, it also reads the local images the document shows, to embed them. The **Files** tab lists the names of Markdown files and folders next to it, and in the folders you expand or move up to; it does not read their contents until you open one. To mark links to missing local files, Markloupe lists the names in the folders those links point to, without reading any file. You can turn this off in the popup.
- Markloupe changes a file only when you check or uncheck a task box in a folder you allowed, and then only that one line. You can turn task check-off off in the popup.
- **Export** and **Copy** only happen when you click them; the file goes where you choose to save it, and copied text goes to your clipboard.
- **Open in your editor** passes the file's path and line number to the editor installed on your computer.

## Permissions

Markloupe asks for two permissions when installed: `storage`, to keep the settings above, and `scripting`, to register its scripts for websites once you allow it. Its content scripts run only on addresses that end in a Markdown extension (`.md`, `.markdown`, `.mkd`, `.mdx`).

Reading `.md` files on websites is optional. When you turn on **Also open .md files on websites**, Chrome asks for access to all websites, because its prompt ignores the part of the address after the site name. Markloupe still runs only on the addresses above. You can turn the option off in the popup at any time, or limit it on the extension's **Details** page under **Site access**.

## Changes

Changes to this policy are recorded in this file's history on GitHub. If Markloupe ever needs to handle data in a new way, this page will be updated before that version is released.

## Contact

Questions or concerns: open an issue at <https://github.com/xjin9612/markloupe/issues>.
