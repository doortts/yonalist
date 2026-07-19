import { Component, type ReactNode } from "react";
import { getFeatureDefinition } from "./featureRegistry";
import type { FeatureId } from "./featureTypes";

interface FeatureRuntimeBoundaryProps {
  featureId: FeatureId;
  onRetry: () => void;
  children: ReactNode;
}

interface FeatureRuntimeBoundaryState {
  error: Error | null;
  featureId: FeatureId;
}

export class FeatureRuntimeBoundary extends Component<
  FeatureRuntimeBoundaryProps,
  FeatureRuntimeBoundaryState
> {
  state: FeatureRuntimeBoundaryState = {
    error: null,
    featureId: this.props.featureId
  };

  static getDerivedStateFromProps(
    props: FeatureRuntimeBoundaryProps,
    state: FeatureRuntimeBoundaryState
  ): Partial<FeatureRuntimeBoundaryState> | null {
    return props.featureId === state.featureId
      ? null
      : { error: null, featureId: props.featureId };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  private retry = () => {
    this.setState({ error: null });
    this.props.onRetry();
  };

  render() {
    if (this.state.error) {
      const feature = getFeatureDefinition(this.props.featureId);
      return (
        <div className="feature-runtime-error" role="alert">
          <p>{feature.label}를 열 수 없습니다.</p>
          <button type="button" onClick={this.retry}>
            다시 시도
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
