# BeeHave Pi update 0.4.2

Built 2026-10-25 from update 0.4.1 (agent `e9f2383a…`, setup service `a4c8008b…`). It also installs over 0.4.0 (`f8281f22…` / `81571ba0…`), which then gains 0.4.1's saved-network management too.

**What changes:** the Pi's setup label (setup Wi-Fi name, its password, and the setup code) shows up in the BeeHave app for the device's farm owners under **Edge Device → Advanced settings → Setup label**. You no longer need a terminal on the Pi (`sudo cat /var/lib/beehave-setup/setup-label.txt`) to find them.

- The agent asks the setup service for the label over the existing local socket and sends it to BeeHave once it is online, and again only if it changes. It is never logged.
- BeeHave stores it encrypted and shows it only to owners of the device's farm. Viewers and other farms cannot read it.
- Because BeeHave keeps the last copy, owners can still read it after the Pi has lost Wi-Fi and switched to its setup hotspot. That is when the hotspot password is needed.
- The setup page on the hotspot now says where to find the setup code in the app.
- **Wi-Fi setup result:** after you press *Connect Pi to Wi-Fi* on the setup page, a "What happens next" box explains that your phone will drop off the setup Wi-Fi and how to tell success (the setup Wi-Fi stays gone) from failure (it comes back). Once the Pi is back online, the result shows in the app on the device's card in Edge Device (for a day) and under Advanced settings → Network configuration → "Last setup page Wi-Fi change". After a failed attempt, entering the setup code on the setup page shows the reason straight away.

Nothing else changes: Wi-Fi, the hotspot, its password, the setup code, monitoring, the runs folder, WAVs and the outbox are untouched.

## Install (on the Pi, from this folder)

```sh
sudo sh install.sh
sudo sh rollback.sh   # undo
```

The installer refuses to run unless the installed agent and setup service are exactly 0.4.0 or 0.4.1. It backs up all four files (`*.bak-before-0.4.2`) and restores them if either service fails to start.

The BeeHave API must be restarted first, with this version, so it accepts the label (`PUT /api/edge/setup-label`). Until then, the agent retries on each heartbeat and nothing else is affected.
