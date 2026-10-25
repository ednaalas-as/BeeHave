# BeeHave Pi update 0.4.1

Built 2026-10-23 from the **installed** files: agent 0.4.0 (sha256 `f8281f22…`) and setup service `81571ba0…`. It adds only saved-network management requested from the BeeHave app:

- **Priority (0–100):** changes the order the Pi tries saved networks in. The current connection does not change.
- **Disconnect** (the network in use only): the Pi moves to the next saved network in range that reaches BeeHave. The network stays saved.
- **Forget:** deletes the saved network and its password. If the Pi is using it, it first moves to another network.

If no other saved network in range reaches BeeHave, Disconnect and Forget leave the Pi where it is and change nothing. The setup hotspot cannot be forgotten.

## Install (on the Pi, from this folder)

```sh
sudo sh install.sh
sudo sh rollback.sh   # undo
```

The installer refuses to run unless both installed files match the hashes above. It backs them up (`*.bak-0.4.0-20261023`) and restores them if either service fails to start. Restarting the setup service does not change the current Wi-Fi connection. Monitoring, the runs folder, the WAVs and the outbox are not touched.

Rolling back does not undo Wi-Fi changes already made: a forgotten network has to be added again.
