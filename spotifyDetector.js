// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Spotify detector — detects currently playing Spotify track by reading
 * the OS media info or Spotify window title.
 *
 * Security: uses execFile (not exec) to avoid shell injection.
 * Performance: lightweight check every 5s, <1% CPU.
 * Cross-platform: Windows (PowerShell), macOS (osascript), Linux (playerctl).
 */

import { execFile } from 'child_process';

const EXEC_TIMEOUT_MS = 3000;
const MAX_OUTPUT_LEN = 1024;

export class SpotifyDetector {
  /** @type {{ name: string, artist: string, detectedAt: string } | null} */
  #currentTrack = null;
  /** @type {NodeJS.Timeout | null} */
  #scanTimer = null;
  /** @type {boolean} */
  #enabled = true;
  /** @type {((track: { name: string, artist: string, detectedAt: string } | null) => void) | null} */
  #onChange = null;
  /** @type {boolean} */
  #playerctlWarned = false;

  get currentTrack() { return this.#currentTrack; }
  get enabled() { return this.#enabled; }
  set enabled(val) {
    this.#enabled = !!val;
    if (!this.#enabled && this.#currentTrack) {
      this.#currentTrack = null;
      this.#onChange?.(null);
    }
  }

  /** Start periodic detection. */
  startDetecting(onChange, intervalMs = 5000) {
    this.#onChange = onChange;
    this.stopDetecting();
    this.#detect().catch(() => {});
    this.#scanTimer = setInterval(() => {
      this.#detect().catch(() => {});
    }, Math.max(3000, intervalMs));
  }

  /** Stop detection. */
  stopDetecting() {
    if (this.#scanTimer) {
      clearInterval(this.#scanTimer);
      this.#scanTimer = null;
    }
  }

  async #detect() {
    if (!this.#enabled) {
      if (this.#currentTrack) {
        this.#currentTrack = null;
        this.#onChange?.(null);
      }
      return;
    }

    try {
      const result = await this.#getSpotifyState();

      if (result) {
        // Track changed?
        if (!this.#currentTrack || this.#currentTrack.name !== result.name || this.#currentTrack.artist !== result.artist) {
          this.#currentTrack = { ...result, detectedAt: new Date().toISOString() };
          this.#onChange?.(this.#currentTrack);
        }
      } else {
        // Spotify not playing
        if (this.#currentTrack) {
          this.#currentTrack = null;
          this.#onChange?.(null);
        }
      }
    } catch {
      // Detection failed — silent
    }
  }

  async #getSpotifyState() {
    switch (process.platform) {
      case 'win32': return this.#detectWindows();
      case 'darwin': return this.#detectMacOS();
      case 'linux': return this.#detectLinux();
      default: return null;
    }
  }

  /** @type {boolean} */
  #tasklist_firstLogged = false;

  /**
   * Windows: Get Spotify's main window title.
   * Optimisation: spawns a cheap `tasklist` first to check if Spotify.exe is
   * running at all. Only if it IS running do we spawn the heavier PowerShell
   * call to read the window title. When Spotify is not running (the common
   * case for most users) this avoids a PowerShell process every 5 seconds.
   * Falls back to the old PowerShell-only path if tasklist fails.
   *
   * Title format when playing: "Artist(s) - Track Name"
   * Idle titles: "Spotify", "Spotify Free", "Spotify Premium"
   * @returns {Promise<{ name: string, artist: string } | null>}
   */
  async #detectWindows() {
    // Step 1: cheap tasklist check — is Spotify.exe even running?
    let spotifyRunning = false;
    try {
      spotifyRunning = await this.#isSpotifyProcessRunning();
    } catch {
      // tasklist failed — fall through to PowerShell path (graceful degradation)
      spotifyRunning = true;
    }
    if (!spotifyRunning) return null;

    // Step 2: Spotify is running — use PowerShell to read the window title
    return this.#getSpotifyWindowTitle();
  }

  /**
   * Spawn `tasklist /fi "IMAGENAME eq Spotify.exe"` to cheaply check
   * if the Spotify process exists. Same pattern as gameScanner.js.
   * @returns {Promise<boolean>}
   */
  #isSpotifyProcessRunning() {
    return new Promise((resolve, reject) => {
      execFile('tasklist', ['/fi', 'IMAGENAME eq Spotify.exe', '/fo', 'csv', '/nh'],
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) return reject(err);
          // With /nh, output is either CSV rows or "INFO: No tasks are running..."
          const output = (stdout || '').slice(0, MAX_OUTPUT_LEN).trim();
          const running = !!output && !output.startsWith('INFO:');
          if (running && !this.#tasklist_firstLogged) {
            this.#tasklist_firstLogged = true;
            console.log('[spotify] tasklist-first check detected Spotify process');
          }
          resolve(running);
        },
      );
    });
  }

  /**
   * PowerShell: read Spotify's main window title to extract track info.
   * @returns {Promise<{ name: string, artist: string } | null>}
   */
  #getSpotifyWindowTitle() {
    return new Promise((resolve) => {
      execFile('powershell', [
        '-NoProfile', '-NoLogo', '-NonInteractive', '-Command',
        'Get-Process spotify -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle -and $_.MainWindowTitle -ne "Spotify" -and $_.MainWindowTitle -ne "Spotify Free" -and $_.MainWindowTitle -ne "Spotify Premium"} | Select-Object -First 1 -ExpandProperty MainWindowTitle',
      ], { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const title = stdout.slice(0, MAX_OUTPUT_LEN).trim();
        if (!title) return resolve(null);

        // Format: "Artist(s) - Track Name" — split on first " - "
        const sep = title.indexOf(' - ');
        if (sep < 1) return resolve(null);

        const artist = title.slice(0, sep).trim().slice(0, 128);
        const name = title.slice(sep + 3).trim().slice(0, 128);
        if (!artist || !name) return resolve(null);

        resolve({ name, artist });
      });
    });
  }

  /**
   * macOS: Use AppleScript to query Spotify player state.
   * @returns {Promise<{ name: string, artist: string } | null>}
   */
  #detectMacOS() {
    return new Promise((resolve) => {
      execFile('osascript', ['-e',
        'if application "Spotify" is running then\n' +
        'tell application "Spotify"\n' +
        'if player state is playing then\n' +
        'return (get artist of current track) & "\\n" & (get name of current track)\n' +
        'end if\n' +
        'end tell\n' +
        'end if',
      ], { timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const lines = stdout.slice(0, MAX_OUTPUT_LEN).trim().split('\n');
        if (lines.length < 2) return resolve(null);

        const artist = lines[0].trim().slice(0, 128);
        const name = lines[1].trim().slice(0, 128);
        if (!artist || !name) return resolve(null);

        resolve({ name, artist });
      });
    });
  }

  /**
   * Linux: Use playerctl to query Spotify via MPRIS D-Bus.
   * @returns {Promise<{ name: string, artist: string } | null>}
   */
  #detectLinux() {
    return new Promise((resolve) => {
      execFile('playerctl', [
        '--player=spotify', 'metadata', '--format', '{{status}}\n{{artist}}\n{{title}}',
      ], { timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
        if (err) {
          // playerctl not installed — log once
          if (err.code === 'ENOENT' && !this.#playerctlWarned) {
            this.#playerctlWarned = true;
            console.info('playerctl not found — install it for Spotify detection on Linux');
          }
          return resolve(null);
        }
        const lines = stdout.slice(0, MAX_OUTPUT_LEN).trim().split('\n');
        if (lines.length < 3) return resolve(null);

        const status = lines[0].trim();
        if (status !== 'Playing') return resolve(null);

        const artist = lines[1].trim().slice(0, 128);
        const name = lines[2].trim().slice(0, 128);
        if (!artist || !name) return resolve(null);

        resolve({ name, artist });
      });
    });
  }
}
