import { useRef } from "react";
import { CameraIcon } from "./icons";

/** Opens the phone's camera / photo library chooser. */
export function PhotoButton({
  onFiles,
  label = "Photo",
  disabled = false,
}: {
  onFiles: (files: File[]) => void;
  label?: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-40 dark:text-stone-300 dark:hover:bg-stone-800"
      >
        <CameraIcon className="text-lg" />
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
