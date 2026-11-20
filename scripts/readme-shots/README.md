# README screenshots

Regenerates the images the READMEs show: `doc/images/hero.*.png` (the desktop session with a phone
signing on top), `signature.*.png` and `node-trust.*.png`, in English and Chinese.

```sh
node scripts/readme-shots/run.mjs            # shots in the printed work dir, nothing in the repo changes
node scripts/readme-shots/run.mjs --write    # also copy them into doc/images
node scripts/readme-shots/run.mjs --locale zh-CN --keep   # one locale, leave the cluster running
node scripts/readme-shots/run.mjs --down /tmp/crh-readme-shots-XXXX   # remove a kept cluster
```

It needs podman, go, openssl, ssh-keygen and the web workspace's Playwright Chromium.

For each locale it starts a throwaway cluster on its own podman network: crhs from this checkout, three
crha nodes (web-1, db-1, app-1) and an SSH node (ssh-1) on the privileged system suite's image, and a
scripted model. Nothing needs a real model or the demo cluster:

- `fake-model.mjs` answers Chat Completions requests from a script, chosen by the first user message and
  the number of tool calls so far, so each run tells the same story in the right language. The commands
  themselves run on the real nodes.
- `cluster.mjs` sets crhs up (a generated admin password, sign-in without the proof of work, the
  account language), registers a generated SSH signing key and enrolls the nodes. db-1 trusts only the
  admin, so its privileged command waits for a signature.
- `shoot.mjs` registers a Passkey on a Chromium virtual authenticator, adds it to db-1's trust, runs the
  two sessions (approving ordinary commands as they come) and takes the desktop shots and the phone shot.
- `compose.mjs` lays the desktop and phone shots out as the hero image.

The scripts are a tool for the README, not part of the product or CI: when the UI changes, adjust the
selectors in `shoot.mjs` and the transcript in `fake-model.mjs`.
