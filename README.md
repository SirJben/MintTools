# MintServers Pack Checker

A free, static web page that checks a Minecraft pack file (`.mcpack`, `.mcaddon`, `.zip`, `.jar`) and tells the visitor:

- whether it is Bedrock or Java
- whether it is a behavior pack or a resource pack
- which folder to upload it to
- the exact `pack_id` / `version` entry for `world_behavior_packs.json` or `world_resource_packs.json`

Everything runs in the visitor's browser. Files are never uploaded. There is no build step and no server.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page (styles included) |
| `pack-checker.js` | The checker logic. Loaded by `index.html` |

## Publish with GitHub Pages

1. Create a new repository on GitHub (for example `pack-checker`). Use an organization or company account if you can, not a personal one.
2. Upload `index.html` and `pack-checker.js` to the root of the repository.
3. Go to **Settings > Pages**.
4. Under **Build and deployment**, set **Source** to **Deploy from a branch**, pick the `main` branch and the `/ (root)` folder, then save.
5. Wait a minute or two. The page appears at `https://YOUR-ACCOUNT.github.io/pack-checker/`.

Link that address from the knowledgebase guides.

## Optional: use a MintServers address

To serve it from something like `tools.mintservers.com`, add that name under **Settings > Pages > Custom domain**, then ask whoever manages DNS to add a `CNAME` record pointing to `YOUR-ACCOUNT.github.io`. Turn on **Enforce HTTPS** once it is available.

## Things to check before linking it

- The install guide link used on the page is `https://mintservers.com/knowledgebase/install-bedrock-behavior-texture-packs`. Search `index.html` for `install-bedrock-behavior-texture-packs` and change it if the real article address is different (it appears three times).
- The page loads two fonts from Google Fonts. If they are blocked, it falls back to system fonts and still works.
- Keep the repository under a company-controlled account. The script runs for every visitor, so whoever can edit the repository controls what runs.

## Updating

Edit `pack-checker.js` or `index.html` on GitHub and commit. Pages republishes automatically.
