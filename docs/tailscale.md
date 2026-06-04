# mdvr and Tailscale

Tailscale is a good fit for mdvr because mdvr is a private file reader/editor, not a public web service.

## Recommended pattern

Expose mdvr only inside:
- your LAN, or
- your Tailscale tailnet

This gives you:
- a smaller attack surface
- easier access from your laptop and phone
- less need to open public firewall ports

## Why this matters

mdvr can read and, depending on config, write files in a real vault.
That is useful, but it also means mistakes can cause real data loss.

Public internet exposure is not recommended.

## Generic access example

Use whatever hostname or IP your environment provides, for example:

```text
http://mdvr.local:8088
```

or

```text
http://<tailnet-hostname>:8088
```

The exact name depends on your network setup.

## Follow the official docs

Do not rely on guessed Tailscale commands in this repo doc.

Use the official Tailscale documentation for your platform and environment:
- device setup
- ACLs
- MagicDNS
- subnet routing if needed
- phone access

## Practical advice

- keep auth enabled
- keep the real vault read-only until you trust the setup
- test on a copied vault first
- treat write access as a deliberate change, not a default
