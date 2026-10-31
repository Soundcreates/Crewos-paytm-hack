import { Component } from 'react';
import { Button, Empty } from './ui.jsx';

/** Keep navigation available when a page or a lazy chunk fails to render. */
export class ViewBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="panel" role="alert"><Empty title="This view could not open">Saved work remains on the server. Any unsaved changes may not have been saved. Try loading the view again, or use the navigation to open another page.<div className="section-actions"><Button onClick={() => this.setState({failed:false})}>Try again</Button><Button onClick={() => location.reload()}>Reload workspace</Button></div></Empty></section>;
  }
}
