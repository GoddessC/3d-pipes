import "@google/model-viewer";

interface Props {
  src: string | null;
  poster?: string | null;
}

export function Viewer({ src, poster }: Props) {
  if (!src) {
    return <div className="viewer viewer-empty">generated model will appear here</div>;
  }
  return (
    <model-viewer
      class="viewer"
      src={src}
      poster={poster ?? undefined}
      camera-controls
      auto-rotate
      shadow-intensity="1"
      exposure="0.9"
      ar={false}
    />
  );
}
