import { Component, type ReactNode } from 'react';
import { reportClientError } from './errorReporting';

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportClientError({
      message: error.message,
      stack: error.stack,
      component: 'react_error_boundary',
      context: { component_stack: info.componentStack ?? undefined },
    });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center px-4">
          <div className="max-w-md text-center space-y-4">
            <h1 className="text-2xl font-semibold text-red-400">Something broke.</h1>
            <p className="text-sm text-neutral-400 font-mono break-words">{this.state.error.message}</p>
            <button
              onClick={() => { this.setState({ error: null }); window.location.reload(); }}
              className="bg-indigo-600 hover:bg-indigo-500 text-white rounded-md px-4 py-2 text-sm"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
