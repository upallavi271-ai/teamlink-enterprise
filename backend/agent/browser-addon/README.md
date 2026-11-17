# TeamLink Website Reporter (Chrome / Edge add-on)

This small browser add-on lets TeamLink's Employee Monitoring show the **exact website** (for example `naukri.com`) a person is on, instead of guessing it from the browser window title.

It reads **only the hostname** of the active tab of the focused window and sends it to the TeamLink monitor agent already running on the same PC (a local listener on `127.0.0.1:47811`). It is sent when the active tab or its host changes, and once every 60 seconds.

**It never sends** the full web address, the path, the query string, page content, or anything at all from an **incognito / InPrivate** window. It talks only to `127.0.0.1` on the same machine — never to any outside server.

Permissions requested: `tabs` (to read the active tab's address), `alarms` (the 60-second refresh), and one host permission for the local agent only (`http://127.0.0.1:47811/*`). It has **no permission to read the content of any web page**.

> The agent (`TeamLinkMonitor.ps1`, version 3.4+) must be running, and the add-on only matters for Chrome and Microsoft Edge. If the add-on is not installed, monitoring still works — the website is then read from the window title, as before.

---

## For the pilot: load it by hand (Developer mode)

Copy the `browser-addon` folder to the PC (any folder), then:

**Chrome**
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and pick the `browser-addon` folder.

**Microsoft Edge**
1. Open `edge://extensions`.
2. Turn on **Developer mode** (left side).
3. Click **Load unpacked** and pick the `browser-addon` folder.

That is all. There is nothing to configure.

---

## Company-wide: force-install with policy (recommended for rollout)

Package the add-on and host it, or publish it privately to the Chrome Web Store / Edge Add-ons, to get an **extension ID** and an **update URL**. Then push the `ExtensionInstallForcelist` policy so every managed PC installs it silently and users cannot remove it.

**Chrome** — registry (Group Policy writes the same keys):

```
HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
  1 = "<EXTENSION_ID>;https://clients2.google.com/service/update2/crx"
```

**Microsoft Edge:**

```
HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist
  1 = "<EXTENSION_ID>;https://edge.microsoft.com/extensionwebstorebase/v1/crx"
```

(Use the matching ADMX template — *Google Chrome* or *Microsoft Edge* → *Extensions* → *Configure the list of force-installed apps and extensions* — if you manage via Group Policy instead of the registry.)

For a self-hosted CRX (no store), host the packed `.crx` and an `update.xml`, set the update URL in the forcelist entry to your `update.xml`, and allow the ID with `ExtensionInstallAllowlist`.

## Notes
- Icons are intentionally omitted (not required by Manifest V3); the add-on has no popup and no UI.
- The listener port is fixed at `47811`. It is opened by the agent on `127.0.0.1` only and needs no administrator rights.
