# Welcome to mdvr

This is the bundled demo vault. It is intentionally small: enough content to
test navigation, search, media previews, and write actions without becoming a
second project to maintain.

## Start
- [[Getting-Started]]
- [[Vault Map]]
- [[Research/media-test]]
- [[Demo]]

## What to Try
- Open a note from Home.
- Search for `Archive` and confirm files inside that folder stay visible.
- Open [[Research/media-test]] to verify image and PDF rendering.
- Open [[Demo]] to verify Excalidraw rendering.
- Select both `demo` and `obsidian` in Settings to see the multi-vault tree.

## Permissions
Docker Compose controls which vaults exist. The demo vault is mounted at
`/vaults/demo` and is write-enabled for testing. The `obsidian` example is
mounted read-only by default, so write actions should disappear there.
