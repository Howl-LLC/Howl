// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { Copy, ChevronDown, FileDown, Maximize2, WrapText, X, Check, Code2 } from 'lucide-react';

// Import highlight.js core + common languages for smaller bundle
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import swift from 'highlight.js/lib/languages/swift';
import kotlin from 'highlight.js/lib/languages/kotlin';
import sql from 'highlight.js/lib/languages/sql';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import lua from 'highlight.js/lib/languages/lua';
import dart from 'highlight.js/lib/languages/dart';
import scala from 'highlight.js/lib/languages/scala';
import r from 'highlight.js/lib/languages/r';
import perl from 'highlight.js/lib/languages/perl';

// Register languages once at module level
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('c#', csharp);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c++', cpp);
hljs.registerLanguage('c', c);
hljs.registerLanguage('go', go);
hljs.registerLanguage('golang', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rb', ruby);
hljs.registerLanguage('php', php);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('kt', kotlin);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('zsh', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('docker', dockerfile);
hljs.registerLanguage('lua', lua);
hljs.registerLanguage('dart', dart);
hljs.registerLanguage('scala', scala);
hljs.registerLanguage('r', r);
hljs.registerLanguage('perl', perl);

hljs.configure({ classPrefix: 'hljs-' });

// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_CHARS_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD\u034F\u180E\uFFF9-\uFFFB]/g;

const LANG_META: Record<string, { display: string; color: string }> = {
  javascript: { display: 'JavaScript', color: '#f7df1e' },
  typescript: { display: 'TypeScript', color: '#3178c6' },
  python: { display: 'Python', color: '#3572A5' },
  java: { display: 'Java', color: '#b07219' },
  csharp: { display: 'C#', color: '#68217a' },
  cpp: { display: 'C++', color: '#f34b7d' },
  c: { display: 'C', color: '#555555' },
  go: { display: 'Go', color: '#00ADD8' },
  rust: { display: 'Rust', color: '#dea584' },
  ruby: { display: 'Ruby', color: '#CC342D' },
  php: { display: 'PHP', color: '#4F5D95' },
  swift: { display: 'Swift', color: '#F05138' },
  kotlin: { display: 'Kotlin', color: '#A97BFF' },
  sql: { display: 'SQL', color: '#e38c00' },
  bash: { display: 'Bash', color: '#89e051' },
  shell: { display: 'Shell', color: '#89e051' },
  css: { display: 'CSS', color: '#563d7c' },
  xml: { display: 'HTML', color: '#e34c26' },
  json: { display: 'JSON', color: '#292929' },
  yaml: { display: 'YAML', color: '#cb171e' },
  markdown: { display: 'Markdown', color: '#083fa1' },
  dockerfile: { display: 'Dockerfile', color: '#384d54' },
  lua: { display: 'Lua', color: '#000080' },
  dart: { display: 'Dart', color: '#00B4AB' },
  scala: { display: 'Scala', color: '#c22d40' },
  r: { display: 'R', color: '#198CE7' },
  perl: { display: 'Perl', color: '#0298c3' },
};

const LANG_EXT: Record<string, string> = {
  javascript: '.js', typescript: '.ts', python: '.py', java: '.java',
  csharp: '.cs', cpp: '.cpp', c: '.c', go: '.go', rust: '.rs',
  ruby: '.rb', php: '.php', swift: '.swift', kotlin: '.kt',
  sql: '.sql', bash: '.sh', shell: '.sh', css: '.css', xml: '.html',
  json: '.json', yaml: '.yml', markdown: '.md', dockerfile: 'Dockerfile',
  lua: '.lua', dart: '.dart', scala: '.scala', r: '.r', perl: '.pl',
};

const HLJS_THEME_CSS = `
.hljs-keyword { color: #c586c0; }
.hljs-built_in { color: #4ec9b0; }
.hljs-type { color: #4ec9b0; }
.hljs-literal { color: #569cd6; }
.hljs-number { color: #b5cea8; }
.hljs-string { color: #ce9178; }
.hljs-comment { color: #6a9955; }
.hljs-function { color: #dcdcaa; }
.hljs-title { color: #dcdcaa; }
.hljs-params { color: #9cdcfe; }
.hljs-variable { color: #9cdcfe; }
.hljs-attr { color: #9cdcfe; }
.hljs-tag { color: #569cd6; }
.hljs-name { color: #569cd6; }
.hljs-selector-class { color: #d7ba7d; }
.hljs-selector-id { color: #d7ba7d; }
.hljs-meta { color: #569cd6; }
.hljs-regexp { color: #d16969; }
.hljs-symbol { color: #b5cea8; }
.hljs-doctag { color: #608b4e; }
.hljs-addition { color: #b5cea8; }
.hljs-deletion { color: #ce9178; }
`;

const COLLAPSE_THRESHOLD = 12;
const LINE_HEIGHT = 22;
const COLLAPSED_MAX_HEIGHT = COLLAPSE_THRESHOLD * LINE_HEIGHT;

interface CodeBlockEmbedProps {
  code: string;
  lang?: string;
}

export const CodeBlockEmbed = React.memo(function CodeBlockEmbed({ code, lang }: CodeBlockEmbedProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);
  const [copied, setCopied] = useState(false);

  const { highlightedHtml, detectedLang } = useMemo(() => {
    const clean = code.replace(INVISIBLE_CHARS_RE, '');
    let raw: string;
    let detected: string | undefined;
    if (lang && hljs.getLanguage(lang)) {
      const result = hljs.highlight(clean, { language: lang, ignoreIllegals: true });
      raw = result.value;
      detected = lang;
    } else {
      const result = hljs.highlightAuto(clean);
      raw = result.value;
      detected = result.language || undefined;
    }
    // Defense-in-depth: strip everything except <span class="hljs-*">
    const sanitized = DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: ['span'],
      ALLOWED_ATTR: ['class'],
    });
    return { highlightedHtml: sanitized, detectedLang: detected };
  }, [code, lang]);

  const lines = useMemo(() => code.split('\n'), [code]);
  const htmlLines = useMemo(() => highlightedHtml.split('\n'), [highlightedHtml]);
  const lineCount = lines.length;
  const isCollapsible = lineCount > COLLAPSE_THRESHOLD;

  const meta = detectedLang ? LANG_META[detectedLang] : undefined;
  const displayLang = meta?.display ?? t('code.code', 'Code');
  const dotColor = meta?.color ?? '#888';

  const handleCopy = useCallback(() => {
    const clean = code.replace(INVISIBLE_CHARS_RE, '');
    navigator.clipboard?.writeText(clean);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [code]);

  const handleDownload = useCallback(async () => {
    const clean = code.replace(INVISIBLE_CHARS_RE, '');
    const ext = detectedLang ? (LANG_EXT[detectedLang] ?? '.txt') : '.txt';
    const filename = ext === 'Dockerfile' ? 'Dockerfile' : `code${ext}`;
    const blob = new Blob([clean], { type: 'text/plain;charset=utf-8' });
    const { downloadBlob } = await import('../utils/downloadFile');
    await downloadBlob(blob, filename);
  }, [code, detectedLang]);

  const btnClass = 'w-7 h-7 rounded-md flex items-center justify-center hover:bg-fill-hover transition-colors';

  const renderLineNumbers = (count: number) => (
    <div
      aria-hidden
      style={{
        minWidth: 40,
        textAlign: 'right',
        paddingRight: 12,
        borderRight: '1px solid var(--border-subtle)',
        color: 'var(--text-secondary)',
        opacity: 0.5,
        userSelect: 'none',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 13,
        lineHeight: `${LINE_HEIGHT}px`,
        flexShrink: 0,
      }}
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>{i + 1}</div>
      ))}
    </div>
  );

  const renderCode = (htmlArr: string[], wrap: boolean) => (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 13,
        lineHeight: `${LINE_HEIGHT}px`,
        color: 'var(--text-primary)',
        whiteSpace: wrap ? 'pre-wrap' : 'pre',
        wordBreak: wrap ? 'break-all' : undefined,
        overflowX: wrap ? undefined : 'auto',
      }}
    >
      {htmlArr.map((html, i) => (
        <div key={i} dangerouslySetInnerHTML={{ __html: html || '\n' }} />
      ))}
    </div>
  );

  return (
    <div
      className="my-2 rounded-xl overflow-hidden border"
      style={{ backgroundColor: 'var(--fill-hover)', borderColor: 'var(--glass-border)' }}
    >
      <style>{HLJS_THEME_CSS}</style>

      {/* Header bar */}
      <div
        className="px-3 py-2 flex items-center justify-between"
        style={{ borderBottom: '1px solid var(--border-subtle)', backgroundColor: 'var(--fill-hover)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Code2 size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
          <span
            className="flex items-center gap-1.5 text-xs font-medium truncate"
            style={{ color: 'var(--text-secondary)' }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: dotColor,
                flexShrink: 0,
                display: 'inline-block',
              }}
            />
            {displayLang}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>
            {lineCount === 1
              ? t('code.line', '1 line')
              : t('code.lines', '{{count}} lines', { count: lineCount })}
          </span>
        </div>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className={btnClass}
            onClick={() => setWordWrap((w) => !w)}
            title={wordWrap ? t('common.nowrap', 'No wrap') : t('common.wordWrap', 'Word wrap')}
          >
            <WrapText size={14} style={{ color: 'var(--text-secondary)', opacity: wordWrap ? 1 : 0.4 }} />
          </button>
          <button
            type="button"
            className={btnClass}
            onClick={handleCopy}
            title={copied ? t('code.copied', 'Copied!') : t('code.copy', 'Copy')}
          >
            {copied
              ? <Check size={14} style={{ color: 'var(--success)' }} />
              : <Copy size={14} style={{ color: 'var(--text-secondary)' }} />}
          </button>
          <button
            type="button"
            className={btnClass}
            onClick={handleDownload}
            title={t('code.download', 'Download')}
          >
            <FileDown size={14} style={{ color: 'var(--text-secondary)' }} />
          </button>
          <button
            type="button"
            className={btnClass}
            onClick={() => setLightboxOpen(true)}
            title={t('code.enlarge', 'Enlarge')}
          >
            <Maximize2 size={14} style={{ color: 'var(--text-secondary)' }} />
          </button>
        </div>
      </div>

      {/* Code area */}
      <div style={{ position: 'relative' }}>
        <div
          style={{
            maxHeight: isCollapsible && !expanded ? COLLAPSED_MAX_HEIGHT : 500,
            overflowY: isCollapsible && !expanded ? 'hidden' : 'auto',
            overflowX: 'hidden',
            backgroundColor: 'var(--bg-code)',
          }}
        >
          <div style={{ display: 'flex', padding: '8px 12px 8px 8px' }}>
            {renderLineNumbers(lineCount)}
            {renderCode(htmlLines, wordWrap)}
          </div>
        </div>

        {/* Collapsed gradient fade */}
        {isCollapsible && !expanded && (
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: 48,
              background: 'linear-gradient(transparent, var(--bg-code))',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>

      {/* Show more / less bar */}
      {isCollapsible && (
        <button
          type="button"
          className="w-full px-3 py-1.5 text-xs font-medium flex items-center justify-center gap-1 hover:bg-fill-hover transition-colors"
          style={{ color: 'var(--cyan-accent)', borderTop: '1px solid var(--border-subtle)' }}
          onClick={() => setExpanded((e) => !e)}
        >
          <ChevronDown
            size={14}
            style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
          />
          {expanded
            ? t('code.showLess', 'Show less')
            : t('code.showMore', 'Show more ({{count}} lines)', { count: lineCount })}
        </button>
      )}

      {/* Enlarge lightbox modal — fixed position, does NOT affect Virtuoso layout.
          Portal to document.body so it escapes the message row's stacking
          context; otherwise ancestor `contain`/`transform`/z-indexed panels
          trap the "fixed" layer and the modal renders off to the side of the
          chat instead of covering the viewport. */}
      {lightboxOpen && typeof document !== 'undefined' && createPortal(
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 'var(--z-max)' as unknown as number,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'var(--overlay-backdrop)',
            backdropFilter: 'blur(8px)',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setLightboxOpen(false); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setLightboxOpen(false); }}
          role="dialog"
          aria-modal
          tabIndex={-1}
        >
          <style>{HLJS_THEME_CSS}</style>
          <div
            className="rounded-xl overflow-hidden border"
            style={{
              backgroundColor: 'var(--bg-floating, #1e1e2e)',
              borderColor: 'var(--glass-border)',
              width: '90vw',
              maxWidth: 900,
              maxHeight: '85vh',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Modal header */}
            <div
              className="px-4 py-3 flex items-center justify-between"
              style={{ borderBottom: '1px solid var(--glass-border)' }}
            >
              <div className="flex items-center gap-2">
                <Code2 size={16} style={{ color: 'var(--text-secondary)' }} />
                <span className="flex items-center gap-1.5 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      backgroundColor: dotColor,
                      display: 'inline-block',
                    }}
                  />
                  {displayLang}
                </span>
                <span className="text-xs" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>
                  {lineCount === 1
                    ? t('code.line', '1 line')
                    : t('code.lines', '{{count}} lines', { count: lineCount })}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" className={btnClass} onClick={() => setWordWrap((w) => !w)} title={wordWrap ? t('common.nowrap', 'No wrap') : t('common.wordWrap', 'Word wrap')}>
                  <WrapText size={14} style={{ color: 'var(--text-secondary)', opacity: wordWrap ? 1 : 0.4 }} />
                </button>
                <button type="button" className={btnClass} onClick={handleCopy} title={copied ? t('code.copied', 'Copied!') : t('code.copy', 'Copy')}>
                  {copied ? <Check size={14} style={{ color: 'var(--success)' }} /> : <Copy size={14} style={{ color: 'var(--text-secondary)' }} />}
                </button>
                <button type="button" className={btnClass} onClick={handleDownload} title={t('code.download', 'Download')}>
                  <FileDown size={14} style={{ color: 'var(--text-secondary)' }} />
                </button>
                <button type="button" className={btnClass} onClick={() => setLightboxOpen(false)} title={t('common.close', 'Close')}>
                  <X size={14} style={{ color: 'var(--text-secondary)' }} />
                </button>
              </div>
            </div>

            {/* Modal code body */}
            <div style={{ flex: 1, overflow: 'auto', backgroundColor: 'var(--bg-code)' }}>
              <div style={{ display: 'flex', padding: '12px 16px 12px 8px' }}>
                {renderLineNumbers(lineCount)}
                {renderCode(htmlLines, wordWrap)}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
});
