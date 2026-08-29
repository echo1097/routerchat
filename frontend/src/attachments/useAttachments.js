import { useCallback, useRef, useState } from "react";

import {
  MAX_FILES_PER_MESSAGE,
  deleteAttachment,
  rejectionReason,
  uploadAttachments,
} from "./attachmentsApi.js";

export function useAttachments({ allowImages, onError }) {
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const attachmentsRef = useRef([]);

  const rememberAttachments = useCallback((next) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const reportError = useCallback((message) => {
    if (onError) onError(message);
  }, [onError]);

  const addFiles = useCallback(async (fileList) => {
    const picked = Array.from(fileList || []);
    if (picked.length === 0) return;

    const remainingSlots = MAX_FILES_PER_MESSAGE - attachmentsRef.current.length;
    if (remainingSlots <= 0) {
      reportError(`You can attach at most ${MAX_FILES_PER_MESSAGE} files.`);
      return;
    }

    const accepted = [];
    for (const file of picked.slice(0, remainingSlots)) {
      const reason = rejectionReason(file, allowImages);
      if (reason) {
        reportError(reason);
        continue;
      }
      accepted.push(file);
    }

    if (picked.length > remainingSlots) {
      reportError(`You can attach at most ${MAX_FILES_PER_MESSAGE} files.`);
    }

    if (accepted.length === 0) return;

    setUploading(true);
    try {
      const uploaded = await uploadAttachments(accepted);
      rememberAttachments([...attachmentsRef.current, ...uploaded]);
    } catch (error) {
      reportError(error.message);
    } finally {
      setUploading(false);
    }
  }, [allowImages, rememberAttachments, reportError]);

  const removeAttachment = useCallback((attachmentId) => {
    rememberAttachments(
      attachmentsRef.current.filter((attachment) => attachment.id !== attachmentId),
    );
    deleteAttachment(attachmentId).catch(() => {});
  }, [rememberAttachments]);

  const releaseAttachments = useCallback(() => {
    rememberAttachments([]);
  }, [rememberAttachments]);

  const discardAttachments = useCallback(() => {
    const pending = attachmentsRef.current;
    rememberAttachments([]);
    for (const attachment of pending) {
      deleteAttachment(attachment.id).catch(() => {});
    }
  }, [rememberAttachments]);

  const attachmentIds = useCallback(
    () => attachmentsRef.current.map((attachment) => attachment.id),
    [],
  );

  return {
    attachments,
    uploading,
    addFiles,
    removeAttachment,
    releaseAttachments,
    discardAttachments,
    attachmentIds,
  };
}
