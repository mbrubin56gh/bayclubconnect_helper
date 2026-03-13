# Firefox Android Development Workflow

Tampermonkey on Firefox Android doesn't support local `file://` access, so manually copy-pasting the script after every change is painful. Instead, serve the script over your local network and install a stub userscript that fetches it dynamically on every page load.

## Setup

### 1. Start a local HTTP server

From the project root:

```bash
npx http-server -p 8765 --cors -c-1
```

The `-c-1` flag disables caching so Firefox always gets the latest version.

### 2. Find your Mac's local IP

```bash
ifconfig en0 | grep 'inet ' | awk '{print $2}'
```

As of last check: `192.168.86.27`

### 3. Install the stub userscript in Tampermonkey on Firefox Android

Create a new userscript in Tampermonkey with this content (update the IP if it changes).

Uses `GM_xmlhttpRequest` instead of `fetch` because the page is HTTPS and the local server is HTTP — browsers block mixed content on normal `fetch`, but Tampermonkey's `GM_xmlhttpRequest` bypasses that restriction.

```javascript
// ==UserScript==
// @name         BC Helper (dev loader)
// @match        https://bayclubconnect.com/*
// @run-at       document-body
// @grant        GM_xmlhttpRequest
// @connect      192.168.86.27
// ==/UserScript==

GM_xmlhttpRequest({
  method: 'GET',
  url: 'http://192.168.86.27:8765/loading_script.user.js',
  onload: function (response) {
    var script = document.createElement('script');
    script.textContent = response.responseText;
    document.head.appendChild(script);
  },
});
```

Make sure to **disable** the real Bay Club helper userscript in Tampermonkey while using this loader to avoid running both copies simultaneously.

### 4. Iterate

Edit `loading_script.user.js` locally, save, reload the page on Firefox Android. No copy-paste needed.
