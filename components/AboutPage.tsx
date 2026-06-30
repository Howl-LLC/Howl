// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect } from 'react';
import { ArrowLeft, ExternalLink, Scale, Heart, Shield, Sparkles, Users, Receipt, Gavel, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { assetPath } from '../utils/assetPath';

interface AboutPageProps {}

const PACKAGE_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0';

/* ─── Section ─────────────────────────────────────────────── */

const Section = React.memo(function Section({
  icon: Icon,
  title,
  id,
  children,
}: {
  icon: React.FC<{ size?: number; className?: string }>;
  title: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-white/[0.06] pt-10">
      <div className="mb-5 flex items-center gap-3">
        <Icon size={18} className="text-[#076FA0]" />
        <h2 className="font-clash text-xs font-semibold uppercase tracking-[0.18em] text-white/70">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
});

/* ─── Main ────────────────────────────────────────────────── */

export const AboutPage: React.FC<AboutPageProps> = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  useEffect(() => {
    document.title = 'Howl | About';
  }, []);

  useEffect(() => {
    if (!location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (el && typeof el.scrollIntoView === 'function') {
      requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }, [location.hash]);

  return (
    <div
      className="min-h-[100dvh] w-full overflow-y-auto overflow-x-hidden"
      style={{ backgroundColor: '#000000' }}
    >
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-white/[0.06] bg-black/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-3xl items-center px-6 md:px-10">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="group flex items-center gap-2 font-satoshi text-sm font-semibold text-white/60 transition-colors hover:text-white"
          >
            <ArrowLeft
              size={16}
              className="transition-transform group-hover:-translate-x-0.5"
            />
            {t('common.back')}
          </button>
        </div>
      </nav>

      {/* Content */}
      <div className="mx-auto max-w-3xl px-6 py-20 md:px-10">
        {/* Hero */}
        <header className="mb-20 flex items-center gap-6">
          <img
            src={assetPath('/howl-logo.png')}
            alt="Howl"
            className="h-16 w-16 rounded-lg object-cover"
          />
          <div>
            <h1 className="font-clash text-5xl font-semibold tracking-[-0.02em] text-white sm:text-6xl">
              Howl
            </h1>
            <p className="mt-2 font-satoshi text-xs font-medium uppercase tracking-[0.18em] text-white/40">
              {t('about.version', { version: PACKAGE_VERSION })}
            </p>
          </div>
        </header>

        {/* Sections */}
        <div className="space-y-12">
          <Section icon={Users} title={t('about.story')}>
            <p className="mb-5 font-satoshi text-base leading-relaxed text-white/65">
              {t('about.storyBody1')}
            </p>
            <p className="font-satoshi text-base leading-relaxed text-white/65">
              {t('about.storyBody2')}
            </p>
          </Section>

          <Section icon={Shield} title={t('about.values')}>
            <ul className="space-y-4">
              {[
                t('about.valuesPrivate'),
                t('about.valuesNotForSale'),
                t('about.valuesFeatures'),
                t('about.valuesIndependent'),
              ].map((line, i) => (
                <li key={i} className="flex gap-3 font-satoshi text-base leading-relaxed text-white/65">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#076FA0]" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section icon={Lock} title={t('about.security')} id="security">
            <p className="mb-8 font-satoshi text-base leading-relaxed text-white/65">
              {t('about.securityIntro')}
            </p>
            <div className="space-y-6">
              {[
                { title: t('about.securityPqTitle'), body: t('about.securityPqBody') },
                { title: t('about.securityMlsTitle'), body: t('about.securityMlsBody') },
                { title: t('about.securityKeysTitle'), body: t('about.securityKeysBody') },
                { title: t('about.securityFsTitle'), body: t('about.securityFsBody') },
                { title: t('about.securityCallsTitle'), body: t('about.securityCallsBody') },
                { title: t('about.securityFilesTitle'), body: t('about.securityFilesBody') },
                { title: t('about.securityDevicesTitle'), body: t('about.securityDevicesBody') },
              ].map((point) => (
                <div key={point.title}>
                  <h3 className="mb-1.5 font-clash text-sm font-semibold text-white/90">{point.title}</h3>
                  <p className="font-satoshi text-sm leading-relaxed text-white/55">{point.body}</p>
                </div>
              ))}
            </div>
            <p className="mt-8 rounded-md border border-white/[0.06] bg-white/[0.03] px-4 py-4 font-satoshi text-sm leading-relaxed text-white/45">
              {t('about.securityTransparency')}
            </p>
          </Section>

          <Section icon={Sparkles} title={t('about.openSourceCredits')}>
            <p className="mb-6 font-satoshi text-base leading-relaxed text-white/65">
              {t('about.openSourceDescription')}
            </p>
            <Link
              to="/credits"
              className="group inline-flex items-center gap-2 font-satoshi text-sm font-semibold text-[#076FA0] transition-colors hover:text-white"
            >
              <ExternalLink size={14} />
              <span className="border-b border-[#076FA0]/40 pb-0.5 transition-colors group-hover:border-white">
                {t('about.viewCredits')}
              </span>
            </Link>
          </Section>

          <Section icon={Scale} title={t('about.legal')}>
            <p className="mb-8 font-satoshi text-base leading-relaxed text-white/65">
              {t('about.legalPrefix')}{' '}
              <a
                href="/terms-of-service"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#076FA0] underline-offset-4 hover:underline"
              >
                {t('about.termsOfService')}
              </a>{' '}
              {t('about.and')}{' '}
              <a
                href="/privacy-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#076FA0] underline-offset-4 hover:underline"
              >
                {t('about.privacyPolicy')}
              </a>
              . {t('about.legalTrademarks')}
            </p>
            <ul className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-white/[0.06] bg-white/[0.06] sm:grid-cols-3">
              {[
                { href: '/terms-of-service', label: t('about.termsOfService'), icon: Shield },
                { href: '/privacy-policy', label: t('about.privacyPolicy'), icon: Shield },
                { href: '/community-guidelines', label: t('about.communityGuidelines'), icon: Users },
                { href: '/dmca-policy', label: t('about.dmcaPolicy'), icon: Scale },
                { href: '/refund-policy', label: t('about.refundPolicy'), icon: Receipt },
                { href: '/law-enforcement', label: t('about.lawEnforcement'), icon: Gavel },
              ].map((link) => (
                <li key={link.href} className="bg-black">
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center gap-2 px-4 py-4 font-satoshi text-xs font-semibold text-white/70 transition-colors hover:bg-white/[0.03] hover:text-white"
                  >
                    <link.icon size={13} className="shrink-0 text-[#076FA0]" />
                    <span className="truncate">{link.label}</span>
                    <ExternalLink
                      size={11}
                      className="ml-auto shrink-0 text-white/30 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-white"
                    />
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        </div>

        {/* Footer */}
        <footer className="mt-24 border-t border-white/[0.06] pt-8">
          <div className="flex items-center justify-between">
            <p className="font-satoshi text-xs text-white/30">
              {t('about.copyright', { year: new Date().getFullYear() })}
            </p>
            <p className="flex items-center gap-1.5 font-satoshi text-xs text-white/30">
              {t('about.madeWithHeart')}
              <Heart size={10} className="text-[#076FA0]" />
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
};
