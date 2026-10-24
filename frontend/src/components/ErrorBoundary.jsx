import { Component } from 'react';

// A screen that throws must never turn the whole page white. Shows a plain
// message with Try again (re-renders the screen) and Reload page.
export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[screen error]', error, info && info.componentStack);
    if (this.props.onError) this.props.onError(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { compact } = this.props;
    return (
      <div className="notice red" role="alert" style={compact ? { margin: 8 } : { margin: '40px auto', maxWidth: 520 }}>
        <b>Something went wrong on this screen.</b>
        <div style={{ marginTop: 4 }}>Nothing you did was lost. Try again, and if it keeps happening reload the page.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => this.setState({ error: null })}>Try again</button>
          <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>Reload page</button>
          {this.props.onClose && <button type="button" className="btn btn-sm" onClick={this.props.onClose}>Close</button>}
        </div>
      </div>
    );
  }
}
