interface DetailRenderSnapshotOverlayProps {
  html: string;
}

export function DetailRenderSnapshotOverlay({
  html
}: DetailRenderSnapshotOverlayProps) {
  return (
    <div
      aria-hidden="true"
      className="detail-render-snapshot"
      data-detail-render-snapshot-overlay="true"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
