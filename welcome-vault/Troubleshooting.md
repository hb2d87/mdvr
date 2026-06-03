# Troubleshooting

## If the vault looks empty
- hard refresh the browser
- confirm `demo` is selected in Settings
- confirm the container was rebuilt after frontend changes
- check `/api/vaults` for `demo` and `obsidian`

## If a note does not open
- verify the file extension is allowed
- check the browser console for errors
- confirm the URL starts with a stable vault id, for example `/demo/Welcome.md`

## If actions are missing
Actions follow the opened vault. The demo vault can create, rename, and delete.
The `obsidian` example vault is read-only, so write actions are hidden there.
