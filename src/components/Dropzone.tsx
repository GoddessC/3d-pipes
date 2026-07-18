import { useCallback, useRef, useState } from "react";
import type { ViewKey } from "../lib/api";

export interface ViewImage {
  file: File;
  preview: string;
}

interface Props {
  view: ViewKey;
  image: ViewImage | null;
  onChange: (image: ViewImage | null) => void;
}

export function Dropzone({ view, image, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState(false);

  const accept = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (!file || !file.type.startsWith("image/")) return;
      if (image) URL.revokeObjectURL(image.preview);
      onChange({ file, preview: URL.createObjectURL(file) });
    },
    [image, onChange],
  );

  return (
    <div
      className={`dropzone ${hover ? "dropzone-hover" : ""} ${image ? "dropzone-filled" : ""}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        accept(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => accept(e.target.files)}
      />
      {image ? (
        <>
          <img src={image.preview} alt={`${view} view`} />
          <button
            className="dropzone-clear"
            onClick={(e) => {
              e.stopPropagation();
              URL.revokeObjectURL(image.preview);
              onChange(null);
            }}
          >
            ×
          </button>
        </>
      ) : (
        <span className="dropzone-hint">drop or click</span>
      )}
      <label className="dropzone-label">{view}</label>
    </div>
  );
}
