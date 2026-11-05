# runtime

The .bat files in the inoscula folder run Inoscula's tools with the Node in this folder (`node.exe`), so nothing
has to be installed. It comes with the Windows download, `inoscula-windows.zip`, on the Releases page.

If `node.exe` is not here (you got Inoscula from the code instead), the .bat files use the Node installed on your
computer, which needs to be 22.18 or newer.

## Making the Windows download

1. Download the Windows zip of Node (`node-v24.x.x-win-x64.zip`) from https://nodejs.org/en/download.
2. From it, copy `node.exe` into this folder, and its `LICENSE` into this folder as `NODE-LICENSE`.
3. Zip the contents of the inoscula folder (not the folder itself) as `inoscula-windows.zip`, leaving out `.git`,
   `node_modules` and `out`.
4. On GitHub: Releases, Draft a new release, attach `inoscula-windows.zip`.

`node.exe` and `NODE-LICENSE` are listed in .gitignore, so they never end up in the repository itself (node.exe is
about 90 MB).
