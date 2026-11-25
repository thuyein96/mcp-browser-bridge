# Privacy Policy – MCP Browser Bridge for Claude Code

_Last updated: November 25, 2026_

MCP Browser Bridge for Claude Code ("the extension") lets a Claude Code session running on your own
computer automate and inspect your Chrome tabs when you ask it to. This policy explains what
the extension accesses and where that data goes.

## What the extension accesses

Only when you, through your local Claude Code session, ask it to act on a tab, the extension
may read:

- Tab titles and URLs
- Page text and the structure of interactive elements (buttons, links, form fields)
- Screenshots of the visible part of a page
- Console messages and network request metadata (URL, method, status) for debugging
- Files on your computer that you explicitly ask it to upload into a web page

The extension also stores one setting locally: the port number of the local bridge.

## Where data goes

- **Only to your own computer.** The extension sends data solely to the companion bridge
  process at `127.0.0.1` (localhost). It has no server of its own and contains no analytics,
  tracking, advertising or telemetry.
- **Your Claude Code session.** The bridge hands results to the Claude Code session you
  started. What Claude Code then sends to Anthropic is governed by your agreement with
  Anthropic and Anthropic's privacy policy, not by this extension.
- **Websites you automate.** Clicks, typed text and uploads you request go to the website in
  that tab, exactly as if you had done them yourself.

## What the extension does not do

- It does not sell, rent or share data with third parties.
- It does not use data for advertising, profiling, creditworthiness or lending.
- It does not act on tabs unless your local Claude Code session sends a request.
- It does not save page content to disk. The activity log (the last 25 actions, shown in
  the popup) and the console and network entries of automated tabs (up to 500 per tab) are
  kept in memory only, and are cleared when the tab closes or the browser stops the
  extension's background worker.

## Your control

You can disconnect at any time by stopping the bridge, turning the extension off, or
removing it in `chrome://extensions`. "Allow User Scripts" and "Allow access to file URLs" are
off unless you turn them on.

## Contact

Questions about this policy: <your contact email or support URL>

_MCP Browser Bridge for Claude Code is an independent project and is not affiliated with or endorsed by
Anthropic._
