import { Component, type ReactNode } from 'react';
import { dict, initialLang } from '../lib/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * The last resort, mounted OUTSIDE App in main.tsx.
 *
 * CellErrorBoundary only wraps the two ChartCell sites; App's own body, both
 * market tables, the modals, the list view and the walls manager have no
 * boundary of their own, and React 19 unmounts the whole root on an uncaught
 * render throw — without this, a blank dark page with no message and no way
 * back.
 *
 * Three deliberate constraints:
 *
 * 1. NOT a reuse of CellErrorBoundary. That one renders cell-shaped chrome and
 *    reads LangContext, which is provided from inside App — the thing that has
 *    just failed. Language is re-derived here from initialLang(), the same
 *    localStorage-then-navigator rule App boots with, so a Chinese user does
 *    not get an English wall of text at the worst moment.
 * 2. The reload is a BUTTON. The app never reloads itself (see
 *    updateCheck.ts) — not even out of a crash, where an automatic reload
 *    could loop silently on a deterministic failure.
 * 3. Styles are inline. Every other surface in this app can assume the
 *    stylesheet loaded; the one screen whose job is to work when things are
 *    broken should not.
 */
export class RootErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn('[purrwall] app crashed:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const t = dict[initialLang()];
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          padding: 24,
          textAlign: 'center',
          background: '#0b0e11',
          color: '#e6e8ea',
          font: '14px ui-sans-serif, system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600 }}>{t.app_crashed}</div>
        <div style={{ color: '#8b949e', maxWidth: 380, lineHeight: 1.5 }}>{t.app_crashed_hint}</div>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: 4,
            padding: '8px 18px',
            borderRadius: 6,
            border: '1px solid #2f3944',
            background: '#161b22',
            color: '#e6e8ea',
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          {t.reload_app}
        </button>
      </div>
    );
  }
}
