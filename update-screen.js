// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Howl — Update Screen
 *
 * Chromatic-arc shader based on web-gl-shader by Ali Imam (@aliimam)
 * https://21st.dev/r/designali-in/web-gl-shader
 * MIT License — Copyright (c) Ali Imam
 */

(function () {
  'use strict';

  // DOM refs
  var versionText = document.getElementById('version-text');
  var progressFill = document.getElementById('progress-fill');
  var progressPct = document.getElementById('progress-percent');

  // State management
  function showState(id) {
    var states = document.querySelectorAll('.state');
    states.forEach(function (el) { el.classList.remove('active'); });
    var target = document.getElementById('state-' + id);
    if (target) target.classList.add('active');
  }

  // WebGL chromatic-arc shader
  var canvas = document.getElementById('shader-canvas');
  var gl = null;
  var rafId = null;
  var contextLost = false;
  var resizeTimer = 0;

  try {
    gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false })
      || canvas.getContext('experimental-webgl', { alpha: false, antialias: false, depth: false, stencil: false });
  } catch (e) { gl = null; }

  if (gl) {
    var vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, 'attribute vec2 p;void main(){gl_Position=vec4(p,0,1);}');
    gl.compileShader(vs);

    var fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, [
      'precision mediump float;',
      'uniform vec2 resolution;',
      'uniform float time;',
      'void main(){',
      '  vec2 p=(gl_FragCoord.xy*2.0-resolution)/min(resolution.x,resolution.y);',
      '  float d=length(p)*0.05;',
      '  float rx=p.x*(1.0+d);float gx=p.x;float bx=p.x*(1.0-d);',
      '  float r=0.05/abs(p.y+sin(rx+time)*0.5);',
      '  float g=0.05/abs(p.y+sin(gx+time)*0.5);',
      '  float b=0.05/abs(p.y+sin(bx+time)*0.5);',
      '  gl_FragColor=vec4(r+0.008,g+0.024,b+0.09,1.0);',
      '}'
    ].join('\n'));
    gl.compileShader(fs);

    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var pAttr = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(pAttr);
    gl.vertexAttribPointer(pAttr, 2, gl.FLOAT, false, 0, 0);

    var uRes = gl.getUniformLocation(prog, 'resolution');
    var uTime = gl.getUniformLocation(prog, 'time');

    function applyResize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    applyResize();
    var resizeHandler = function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyResize, 150);
    };
    window.addEventListener('resize', resizeHandler);

    var startTime = performance.now();
    function frame() {
      if (contextLost) return;
      var t = (performance.now() - startTime) * 0.0005; // 0.5x speed
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, t);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); contextLost = true; if (rafId) cancelAnimationFrame(rafId); });
    canvas.addEventListener('webglcontextrestored', function () { contextLost = false; applyResize(); rafId = requestAnimationFrame(frame); });
  } else {
    // Fallback: solid dark background
    canvas.style.background = '#020617';
  }

  // IPC event listeners
  // The default "loading" state is shown on boot. We only switch to the
  // update-specific states (downloading / installing) when an update is
  // actually happening. Checking for updates + update-errors (including
  // "no internet") fall through to the generic "Loading Howl..." copy —
  // normal launches and failed update checks should look identical from
  // the user's perspective, because in both cases all they're waiting on
  // is the main app to finish loading.
  if (window.electron) {
    if (window.electron.onUpdateChecking) {
      window.electron.onUpdateChecking(function () { showState('loading'); });
    }

    if (window.electron.onUpdateAvailable) {
      window.electron.onUpdateAvailable(function (version) {
        showState('downloading');
        if (version && versionText) versionText.textContent = 'v' + version;
      });
    }

    if (window.electron.onUpdateDownloadProgress) {
      window.electron.onUpdateDownloadProgress(function (percent) {
        if (progressFill) progressFill.style.width = percent + '%';
        if (progressPct) progressPct.textContent = percent + '%';
      });
    }

    if (window.electron.onUpdateDownloaded) {
      window.electron.onUpdateDownloaded(function () {
        showState('installing');
        setTimeout(function () {
          if (window.electron.restartForUpdate) window.electron.restartForUpdate();
        }, 1500);
      });
    }

    if (window.electron.onUpdateNotAvailable) {
      window.electron.onUpdateNotAvailable(function () {
        if (window.electron.updateCheckComplete) window.electron.updateCheckComplete();
      });
    }

    if (window.electron.onUpdateError) {
      window.electron.onUpdateError(function () {
        // Stay on the generic "Loading Howl..." state — the user shouldn't
        // see a scary "Couldn't check for updates" when they're just booting
        // the app offline. Main app takes over after the short grace period.
        showState('loading');
        setTimeout(function () {
          if (window.electron.updateCheckComplete) window.electron.updateCheckComplete();
        }, 1500);
      });
    }
  }

  // Cleanup on unload
  window.addEventListener('beforeunload', function () {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (typeof resizeHandler === 'function') {
      window.removeEventListener('resize', resizeHandler);
    }
  }, { once: true });
})();
