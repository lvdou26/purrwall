import { Component, type ContextType, type ReactNode } from 'react';
import { LangContext, dict } from '../lib/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * One crashed cell must never blank the whole wall. The fallback keeps the
 * grid slot and offers a reload that remounts the cell from scratch.
 */
export class CellErrorBoundary extends Component<Props, State> {
  static contextType = LangContext;
  declare context: ContextType<typeof LangContext>;

  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn('[purrwall] cell crashed:', error);
  }

  render() {
    if (this.state.error) {
      const t = dict[this.context ?? 'en'];
      return (
        <div className="cell">
          <div className="cell-body">
            <div className="cell-overlay">
              <span className="err-text">{t.cell_crashed}</span>
              <button className="retry-btn" onClick={() => this.setState({ error: null })}>
                {t.reload_cell}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
