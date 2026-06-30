#!/bin/sh
set -e

# Restore SUID on chrome-sandbox. electron-builder ships chrome-sandbox as
# 755 in the .deb archive (owner nobody); Chromium's SUID sandbox refuses
# to start without mode 4755 + owner root.
if [ -f /opt/Howl/chrome-sandbox ]; then
  chown root:root /opt/Howl/chrome-sandbox || true
  chmod 4755 /opt/Howl/chrome-sandbox || true
fi

# Install AppArmor profile so Chromium's userns-based sandbox works on
# Ubuntu 24.04+. Kernels without AppArmor (or without /etc/apparmor.d)
# just skip this block — chrome-sandbox above is the fallback path.
if [ -d /etc/apparmor.d ] && [ -f /opt/Howl/resources/apparmor-howl ]; then
  cp /opt/Howl/resources/apparmor-howl /etc/apparmor.d/howl
  chmod 644 /etc/apparmor.d/howl
  if command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser -r -W -T /etc/apparmor.d/howl 2>/dev/null || true
  fi
fi

exit 0
