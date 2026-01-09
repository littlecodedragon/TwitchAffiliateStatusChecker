# Twitch Affiliate Status Checker

Lightweight userscript (Tampermonkey / Violentmonkey) that annotates Twitch with broadcaster affiliation status: PARTNER, AFFILIATE, or NOT AFFILIATE.

## Features

- Annotates stream previews in directory and search pages.
- Adds a label next to the channel title on channel pages (live and offline).
- Uses a local token server to keep your Twitch `client_secret` off the client.
- Caches results and backs off on Twitch rate limits.

## Supported URLs

- Directory and discovery: `https://www.twitch.tv/directory/*`
- Search/browse: `https://www.twitch.tv/search*`
- Channel pages: `https://www.twitch.tv/<username>`

## Installation

1. Install a userscript manager (Tampermonkey, Violentmonkey, Greasemonkey).
2. Install `twitch-affiliate-checker.user.js` from this repository into your userscript manager.

## Token server 

App Access Tokens require a `client_id` and `client_secret`. Do NOT embed `client_secret` in the userscript. Run the included `token-server.js` locally to perform the client_credentials exchange and expose a local endpoint the userscript can query.

Quick start:

```bash
export CLIENT_ID=your_client_id
export CLIENT_SECRET=your_client_secret
node token-server.js
```

By default the userscript requests `http://localhost:4000/twitch-token` and expects JSON like:

```json
{ "access_token": "..." }
```

## Usage

- Visit Twitch directory/search or a channel page. The script auto-annotates visible previews.
- If a token is not available the script shows a small banner and will retry the local token endpoint periodically.

## Development & debugging

- Enable debug logs by setting `DEBUG = true` in `twitch-affiliate-checker.user.js`.
- The userscript logs diagnostic messages prefixed with `TAC:` in the browser console while debugging.
