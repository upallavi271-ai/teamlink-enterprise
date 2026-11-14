import { Component } from 'react';

// A screen that throws must never turn the whole page white. Shows a plain
// message with Try again (re-renders the screen) and Reload page.
export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[screen error]', error, info && info.componentStack);
    // A deploy renames the screen's files: a tab opened before it asks for a file that is gone. One reload brings the new ones
    // (guarded so it can never loop).
    try {
      const stale = /dynamically imported module|Importing a module script failed|Loading chunk|Loading CSS chunk|Unable to preload/i.test(String((error && error.message) || error));
      const last = Number(sessionStorage.getItem('tl.staleReload') || 0);
      if (stale && Date.now() - last > 60000) { sessionStorage.setItem('tl.staleReload', String(Date.now())); window.location.reload(); return; }
    } catch (e) { /* no storage: the buttons below still work */ }
    if (this.props.onError) this.props.onError(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { compact } = this.props;
    return (
      <div className="notice red" role="alert" style={compact ? { margin: 8 } : { margin: '40px auto', maxWidth: 520 }}>
        <b>Something went wrong on this screen.</b>
        <div style={{ marginTop: 4 }}>Nothing you did was lost. Try again, and if it keeps happening reload the page.</div>
        <div className="small-muted" style={{ marginTop: 6, fontSize: 12, overflowWrap: 'anywhere' }}>Details for support: {String((this.state.error && this.state.error.message) || this.state.error).slice(0, 220)}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => this.setState({ error: null })}>Try again</button>
          <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>Reload page</button>
          {this.props.onClose && <button type="button" className="btn btn-sm" onClick={this.props.onClose}>Close</button>}
        </div>
      </div>
    );
  }
}
