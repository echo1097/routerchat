import { useEffect, useRef, useState } from "react";

const NOTIFICATION_VISIBLE_MS = 2600;
const NOTIFICATION_EXIT_MS = 150;

export function useNotifications() {
  const [notifications, setNotifications] = useState([]);
  const notificationTimersRef = useRef(new Map());
  const nextNotificationIdRef = useRef(0);

  useEffect(
    () => () => {
      notificationTimersRef.current.forEach(({ closeTimer, removeTimer }) => {
        window.clearTimeout(closeTimer);
        if (removeTimer) window.clearTimeout(removeTimer);
      });
      notificationTimersRef.current.clear();
    },
    [],
  );

  function clearNotificationTimers(notificationId) {
    const timers = notificationTimersRef.current.get(notificationId);
    if (!timers) return;

    window.clearTimeout(timers.closeTimer);
    if (timers.removeTimer) window.clearTimeout(timers.removeTimer);
    notificationTimersRef.current.delete(notificationId);
  }

  function removeNotification(notificationId) {
    clearNotificationTimers(notificationId);
    setNotifications((current) => current.filter(({ id }) => id !== notificationId));
  }

  function clearNotifications(kind) {
    notificationTimersRef.current.forEach((timers, notificationId) => {
      if (timers.kind === kind) clearNotificationTimers(notificationId);
    });
    setNotifications((current) => current.filter((notification) => notification.kind !== kind));
  }

  function enqueueNotification(message, kind) {
    if (!message) return;

    const id = `${kind}-${nextNotificationIdRef.current++}`;
    setNotifications((current) => [
      { id, message, kind, phase: "visible" },
      ...current,
    ]);

    const closeTimer = window.setTimeout(() => {
      setNotifications((current) => current.map((notification) => (
        notification.id === id
          ? { ...notification, phase: "closing" }
          : notification
      )));

      const timers = notificationTimersRef.current.get(id);
      if (!timers) return;

      timers.removeTimer = window.setTimeout(
        () => removeNotification(id),
        NOTIFICATION_EXIT_MS,
      );
    }, NOTIFICATION_VISIBLE_MS);

    notificationTimersRef.current.set(id, { kind, closeTimer, removeTimer: null });
  }

  function setStatus(message) {
    if (!message) {
      clearNotifications("status");
      return;
    }

    enqueueNotification(message, "status");
  }

  function showToast(message) {
    enqueueNotification(message, "toast");
  }

  return { notifications, setStatus, showToast };
}
