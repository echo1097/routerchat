import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../uiShared.js";

function NotificationItem({ notification, setRef }) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => setIsVisible(true));
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  return (
    <div ref={setRef} className="notification-item">
      <div
        className={cx(
          "notification-surface",
          isVisible && "is-visible",
          notification.phase === "closing" && "is-closing",
        )}
      >
        {notification.message}
      </div>
    </div>
  );
}

export default function NotificationStack({ notifications }) {
  const itemRefs = useRef(new Map());
  const previousTopsRef = useRef(new Map());
  const frameRef = useRef(null);

  useLayoutEffect(() => {
    const previousTops = previousTopsRef.current;
    const movedItems = [];
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    itemRefs.current.forEach((node, id) => {
      if (!node) return;

      const previousTop = previousTops.get(id);
      if (previousTop === undefined) return;

      node.style.transition = "none";
      node.style.transform = "none";
      const nextTop = node.getBoundingClientRect().top;
      const delta = previousTop - nextTop;

      if (reducedMotion || Math.abs(delta) < 0.5) {
        node.style.transition = "";
        node.style.transform = "";
        return;
      }

      node.style.transform = `translateY(${delta}px)`;
      movedItems.push(node);
    });

    if (frameRef.current) window.cancelAnimationFrame(frameRef.current);

    if (movedItems.length > 0) {
      frameRef.current = window.requestAnimationFrame(() => {
        movedItems.forEach((node) => {
          node.style.transition = "";
          node.style.transform = "";
        });
        frameRef.current = null;
      });
    }

    return () => {
      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }

      const currentTops = new Map();
      itemRefs.current.forEach((node, id) => {
        if (node) currentTops.set(id, node.getBoundingClientRect().top);
      });
      previousTopsRef.current = currentTops;
    };
  }, [notifications]);

  return (
    <div className="notification-stack" aria-live="polite" aria-atomic="false">
      {notifications.map((notification) => (
        <NotificationItem
          key={notification.id}
          notification={notification}
          setRef={(node) => {
            if (node) {
              itemRefs.current.set(notification.id, node);
            } else {
              itemRefs.current.delete(notification.id);
            }
          }}
        />
      ))}
    </div>
  );
}
