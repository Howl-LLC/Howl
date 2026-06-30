// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import './overlay.css';
import { createRoot } from 'react-dom/client';
import { OverlayApp } from './OverlayApp';

const root = createRoot(document.getElementById('overlay-root')!);
root.render(<OverlayApp />);
