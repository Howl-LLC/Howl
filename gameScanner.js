// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Game scanner — detects running games by matching process names
 * against a bundled game database.
 *
 * Security: uses execFile (not exec) to avoid shell injection.
 * Performance: lightweight scans every 15s, <5% CPU impact.
 * Cross-platform: Windows (tasklist), macOS/Linux (ps).
 */

import { execFile } from 'child_process';
import path from 'path';

const EXEC_TIMEOUT_MS = 3000;

const SYSTEM_PROCESSES = new Set([
  'svchost.exe', 'csrss.exe', 'wininit.exe', 'services.exe', 'lsass.exe', 'smss.exe',
  'winlogon.exe', 'dwm.exe', 'explorer.exe', 'taskhostw.exe', 'runtimebroker.exe',
  'searchindexer.exe', 'spoolsv.exe', 'conhost.exe', 'dllhost.exe', 'sihost.exe',
  'system', 'system idle process', 'registry', 'wudfhost.exe', 'audiodg.exe',
  'systemd', 'init', 'launchd', 'kernel_task', 'windowserver', 'loginwindow',
  'kworker', 'ksoftirqd', 'migration', 'rcu_sched', 'rcu_bh', 'watchdog',
  'bash', 'zsh', 'sh', 'fish', 'csh', 'login', 'sshd', 'cron', 'rsyslogd',
  'ps', 'grep', 'find', 'cat', 'ls', 'top', 'htop',
]);

/**
 * @typedef {{ name: string, steamAppId?: string, windowTitleMatch?: string }} GameEntry
 * @typedef {{ name: string, exeName: string, steamAppId?: string, detectedAt: string }} DetectedGame
 */

export class GameScanner {
  /** @type {Map<string, GameEntry & { exeName: string }>} lowercase exe name -> game info */
  #games = new Map();
  /** @type {Map<string, { exeName: string, name: string }>} lowercase exe name -> custom game */
  #customGames = new Map();
  /** @type {GameEntry[]} entries requiring window title verification */
  #ambiguousEntries = [];
  /** @type {NodeJS.Timeout | null} */
  #scanTimer = null;
  /** @type {DetectedGame | null} */
  #currentGame = null;
  /** @type {boolean} */
  #enabled = true;
  /** @type {((game: DetectedGame | null) => void) | null} */
  #onChange = null;
  /**
   * Cache for verbose tasklist output (window titles). Populated once per scan
   * cycle and reused for all ambiguous-candidate lookups within that cycle.
   * TTL of 3 seconds — one scan period.
   * @type {{ result: Map<string, string>, timestamp: number } | null}
   */
  #verboseCache = null;

  /**
   * @param {Record<string, GameEntry>} games — the `games` object from game-database.json
   */
  constructor(games) {
    this.#loadGames(games);
  }

  /** Validate and index the game entries. */
  #loadGames(games) {
    if (!games || typeof games !== 'object') return;

    for (const [exeName, entry] of Object.entries(games)) {
      if (!entry || typeof entry.name !== 'string' || !entry.name) continue;
      if (typeof exeName !== 'string' || !exeName) continue;

      const normalized = exeName.toLowerCase();
      const record = {
        name: entry.name.slice(0, 128),
        exeName,
        steamAppId: typeof entry.steamAppId === 'string' ? entry.steamAppId : undefined,
        windowTitleMatch: typeof entry.windowTitleMatch === 'string' ? entry.windowTitleMatch : undefined,
      };
      this.#games.set(normalized, record);

      if (record.windowTitleMatch) {
        this.#ambiguousEntries.push(record);
      }
    }
  }

  get currentGame() {
    return this.#currentGame;
  }

  get enabled() {
    return this.#enabled;
  }

  set enabled(val) {
    this.#enabled = !!val;
    if (!this.#enabled && this.#currentGame) {
      this.#currentGame = null;
      this.#onChange?.(null);
    }
  }

  /** Start periodic scanning. */
  startScanning(onChange, intervalMs = 15_000) {
    this.#onChange = onChange;
    this.stopScanning();
    // Initial scan
    this.#scan().catch(() => {});
    this.#scanTimer = setInterval(() => {
      this.#scan().catch(() => {});
    }, Math.max(5000, intervalMs));
  }

  /** Stop scanning. */
  stopScanning() {
    if (this.#scanTimer) {
      clearInterval(this.#scanTimer);
      this.#scanTimer = null;
    }
  }

  /** Add a custom game to the detection set. */
  addCustomGame(exeName, displayName) {
    if (!exeName || !displayName) return;
    if (!/^[\w.\-]+$/.test(exeName)) return;
    this.#customGames.set(exeName.toLowerCase(), {
      exeName: exeName.slice(0, 128),
      name: displayName.slice(0, 128),
    });
  }

  /** Remove a custom game from the detection set. */
  removeCustomGame(exeName) {
    if (!exeName) return;
    this.#customGames.delete(exeName.toLowerCase());
  }

  /** Get the current custom games list. */
  getCustomGames() {
    return [...this.#customGames.values()];
  }

  /** Get deduplicated list of running process names (public, for UI picker). */
  async getRunningProcesses() {
    try {
      const names = await this.#getProcessNames();
      const filtered = [...names].filter(n => !SYSTEM_PROCESSES.has(n.toLowerCase())).sort();
      return filtered.slice(0, 500);
    } catch { return []; }
  }

  /** Single scan cycle. */
  async #scan() {
    if (!this.#enabled) return;
    // Invalidate verbose tasklist cache at the start of each cycle so
    // stale titles from the previous cycle are never reused.
    this.#verboseCache = null;

    try {
      const processes = await this.#getProcessNames();
      const game = await this.#matchGame(processes);

      const prev = this.#currentGame;
      const changed =
        (prev === null && game !== null) ||
        (prev !== null && game === null) ||
        (prev !== null && game !== null && prev.name !== game.name);

      if (changed) {
        this.#currentGame = game;
        this.#onChange?.(game);
      }
    } catch {
      // Never crash the main process — silently swallow scan errors
    }
  }

  /** Get list of running process base names. */
  async #getProcessNames() {
    const platform = process.platform;

    if (platform === 'win32') {
      return this.#getProcessNamesWindows();
    }
    // macOS and Linux
    return this.#getProcessNamesUnix();
  }

  /** Windows: parse `tasklist /fo csv /nh` output. */
  #getProcessNamesWindows() {
    return new Promise((resolve, reject) => {
      execFile('tasklist', ['/fo', 'csv', '/nh'], { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err) return reject(err);
        const names = new Set();
        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('"')) continue;
          // Extract first quoted field: "name.exe","pid",...
          const endQuote = trimmed.indexOf('"', 1);
          if (endQuote > 1) {
            names.add(trimmed.slice(1, endQuote));
          }
        }
        resolve(names);
      });
    });
  }

  /** macOS/Linux: parse `ps -eo comm=` output. */
  #getProcessNamesUnix() {
    return new Promise((resolve, reject) => {
      execFile('ps', ['-eo', 'comm='], { timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
        if (err) return reject(err);
        const names = new Set();
        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Extract basename — ps can return full paths
          names.add(path.basename(trimmed));
        }
        resolve(names);
      });
    });
  }

  /**
   * Match process names against the game database.
   * Priority: direct matches first, ambiguous (windowTitleMatch) second.
   * @param {Set<string>} processNames
   * @returns {Promise<DetectedGame | null>}
   */
  async #matchGame(processNames) {
    /** @type {(GameEntry & { exeName: string }) | null} */
    let directMatch = null;
    const ambiguousCandidates = [];

    for (const procName of processNames) {
      const lower = procName.toLowerCase();

      // Try custom games first (user-defined take priority)
      const custom = this.#customGames.get(lower) || (process.platform !== 'win32' ? this.#customGames.get(lower + '.exe') : undefined);
      if (custom && !directMatch) {
        directMatch = { name: custom.name, exeName: custom.exeName };
        continue;
      }

      // Try bundled database
      let entry = this.#games.get(lower);
      if (!entry && process.platform !== 'win32') {
        entry = this.#games.get(lower + '.exe');
      }

      if (!entry) continue;

      if (entry.windowTitleMatch) {
        ambiguousCandidates.push({ entry, procName });
      } else if (!directMatch) {
        directMatch = entry;
      }
    }

    if (directMatch) {
      return {
        name: directMatch.name,
        exeName: directMatch.exeName,
        steamAppId: directMatch.steamAppId,
        detectedAt: new Date().toISOString(),
      };
    }

    // Check ambiguous candidates via window title (Windows only)
    if (ambiguousCandidates.length > 0 && process.platform === 'win32') {
      for (const { entry, procName } of ambiguousCandidates) {
        const title = await this.#getWindowTitle(procName).catch(() => null);
        if (title && title.toLowerCase().includes(entry.windowTitleMatch.toLowerCase())) {
          return {
            name: entry.name,
            exeName: entry.exeName,
            steamAppId: entry.steamAppId,
            detectedAt: new Date().toISOString(),
          };
        }
      }
    }

    return null;
  }

  /**
   * Windows-only: get window title for a specific process name.
   * Caches the full verbose tasklist output for 3 seconds (one scan cycle)
   * so multiple ambiguous-candidate lookups reuse a single tasklist call.
   * @param {string} imageName
   * @returns {Promise<string | null>}
   */
  async #getWindowTitle(imageName) {
    // Validate imageName: only allow alphanumeric, dots, spaces, hyphens, underscores
    if (!/^[\w.\- ]+$/.test(imageName)) return null;

    const VERBOSE_CACHE_TTL_MS = 3000;
    const now = Date.now();

    // Return cached result if still fresh
    if (this.#verboseCache && (now - this.#verboseCache.timestamp < VERBOSE_CACHE_TTL_MS)) {
      return this.#verboseCache.result.get(imageName.toLowerCase()) ?? null;
    }

    // Run verbose tasklist once for ALL processes and cache the result
    const titleMap = await this.#fetchAllWindowTitles();
    this.#verboseCache = { result: titleMap, timestamp: Date.now() };
    return titleMap.get(imageName.toLowerCase()) ?? null;
  }

  /**
   * Fetch verbose tasklist output and parse all rows into a Map of
   * lowercase image name -> window title. Used to batch multiple lookups.
   * @returns {Promise<Map<string, string>>}
   */
  #fetchAllWindowTitles() {
    return new Promise((resolve) => {
      execFile('tasklist', ['/v', '/fo', 'csv', '/nh'],
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          const titleMap = new Map();
          if (err || !stdout) return resolve(titleMap);
          for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('"')) continue;
            // Extract first quoted field (image name)
            const endQuote = trimmed.indexOf('"', 1);
            if (endQuote < 1) continue;
            const name = trimmed.slice(1, endQuote);
            // Extract last quoted field (window title)
            const lastQuoteStart = trimmed.lastIndexOf(',"');
            if (lastQuoteStart < 0) continue;
            let title = trimmed.slice(lastQuoteStart + 2);
            if (title.endsWith('"')) title = title.slice(0, -1);
            if (title && title !== 'N/A') {
              // Store by lowercase image name; first match wins (most likely
              // the one with an actual window)
              const key = name.toLowerCase();
              if (!titleMap.has(key)) titleMap.set(key, title);
            }
          }
          resolve(titleMap);
        },
      );
    });
  }
}
