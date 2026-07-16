// Real browsers expose AnimationEvent. jsdom 29 does not, which makes React
// subscribe to a WebKit-prefixed fallback that jsdom reports but never emits.
if (typeof window !== "undefined" && !window.AnimationEvent) {
  window.AnimationEvent = Event as unknown as typeof AnimationEvent;
}
