import { useEffect } from "react";
import { photoUrl, type Photo } from "../../../shared/types";

export function PhotoViewer({ photo, onClose }: { photo: Photo; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Close only the viewer, not the sheet underneath.
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <button
      type="button"
      onClick={onClose}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black p-[env(safe-area-inset-top)_0_env(safe-area-inset-bottom)]"
      aria-label="Close photo"
    >
      <img src={photoUrl(photo.id)} alt={photo.caption ?? ""} className="max-h-full max-w-full object-contain" />
      {photo.caption && (
        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-5 pt-10 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] text-left text-sm text-white">
          {photo.caption}
        </span>
      )}
    </button>
  );
}
