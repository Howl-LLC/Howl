#!/bin/sh
set -e

# Remove AppArmor profile on uninstall/purge. Upgrades pass "upgrade" as
# $1 and must leave the profile in place.
case "$1" in
  remove|purge)
    if [ -f /etc/apparmor.d/howl ]; then
      if command -v apparmor_parser >/dev/null 2>&1; then
        apparmor_parser -R /etc/apparmor.d/howl 2>/dev/null || true
      fi
      rm -f /etc/apparmor.d/howl
    fi
    ;;
esac

exit 0
