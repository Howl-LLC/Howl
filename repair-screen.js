// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
document.getElementById('btn-clear').addEventListener('click', function() {
  if (window.electron && window.electron.repairClearCache) window.electron.repairClearCache();
});
document.getElementById('btn-reinstall').addEventListener('click', function() {
  if (window.electron && window.electron.repairReinstall) window.electron.repairReinstall();
});
