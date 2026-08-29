import { useCallback, useEffect, useRef, useState } from "react";

function dragCarriesFiles(event) {
  const types = event.dataTransfer?.types;
  if (!types) return false;

  return Array.from(types).includes("Files");
}

export function useFileDrop({ enabled, onFiles }) {
  const [dragActive, setDragActive] = useState(false);
  const depthRef = useRef(0);
  const enabledRef = useRef(enabled);
  const onFilesRef = useRef(onFiles);

  useEffect(() => {
    enabledRef.current = enabled;
    onFilesRef.current = onFiles;
  }, [enabled, onFiles]);

  const resetDrag = useCallback(() => {
    depthRef.current = 0;
    setDragActive(false);
  }, []);

  useEffect(() => {
    function handleDragEnter(event) {
      if (!dragCarriesFiles(event)) return;
      event.preventDefault();

      depthRef.current += 1;
      if (enabledRef.current) setDragActive(true);
    }

    function handleDragOver(event) {
      if (!dragCarriesFiles(event)) return;
      event.preventDefault();

      event.dataTransfer.dropEffect = enabledRef.current ? "copy" : "none";
    }

    function handleDragLeave(event) {
      if (!dragCarriesFiles(event)) return;

      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setDragActive(false);
    }

    function handleDrop(event) {
      if (!dragCarriesFiles(event)) return;
      event.preventDefault();
      resetDrag();

      const dropped = event.dataTransfer?.files;
      if (enabledRef.current && dropped?.length) onFilesRef.current(dropped);
    }

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("blur", resetDrag);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("blur", resetDrag);
    };
  }, [resetDrag]);

  return dragActive;
}
