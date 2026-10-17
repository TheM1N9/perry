# Installer preflight failure inventory

Before the isolated installer E2E harness: the macOS Git placeholder can exist but
exit nonzero; a pipeline ending in sed masks that exit; Linux Git can also be
broken; the installer can continue into downloads, package installs, shell profile
writes or clone attempts; the desktop-pet path can bypass the guard; a healthy Git
must still install normally and reruns must still update rather than clone.

Run the actual install.sh in an isolated HOME with fake git/node/pnpm/bun/curl and
uname. All filesystem output stays in this batch's small W: scratch folder. No
network, installs, services, personal settings, real home or live Perry may run.
Capture exit status, command trace and output as JSON. This simulates macOS's Git
failure under Git Bash on Windows; it does not exercise Apple's real GUI installer.

Cross-platform CI review: macOS does not provide `/usr/bin/sh`; use `/bin/sh`
on native Unix hosts and the Git Bash shell path only on Windows. The launcher
must still verify fixture resolution before executing the installer.
