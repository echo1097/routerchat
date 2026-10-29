import {
  CircleAlert,
  Clock,
  CreditCard,
  ExternalLink,
  KeyRound,
  MessageSquarePlus,
  RefreshCw,
  Settings,
  ShieldAlert,
  WifiOff,
  X,
} from "lucide-react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import { billingLink } from "./errorNotice.js";

const ICONS = {
  badKey: KeyRound,
  noCredit: CreditCard,
  rateLimited: Clock,
  timeout: Clock,
  network: WifiOff,
  unreachable: WifiOff,
  contentRefused: ShieldAlert,
};

const BUTTON_BASE =
  "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20";

const PRIMARY_BUTTON = cx(BUTTON_BASE, "bg-neutral-100 text-neutral-950 hover:bg-white", CONTROL_MOTION);

const SECONDARY_BUTTON = cx(
  BUTTON_BASE,
  "bg-white/[0.06] text-neutral-300 hover:bg-white/[0.09] hover:text-neutral-100",
  CONTROL_MOTION,
);

function noticeActions(error, { onRetry, onOpenSettings, onNewChat }) {
  const actions = [];
  const creditLink = billingLink(error.provider);

  if (error.kind === "badKey" && onOpenSettings) {
    actions.push({ label: "Open Settings", icon: Settings, onClick: onOpenSettings });
  }
  if (error.kind === "noCredit" && creditLink) {
    actions.push({ label: "Add credit", trailingIcon: ExternalLink, href: creditLink });
  }
  if ((error.kind === "modelUnavailable" || error.kind === "contextTooLong") && onNewChat) {
    actions.push({ label: "New chat", icon: MessageSquarePlus, onClick: onNewChat });
  }
  if (error.kind !== "badKey" && onRetry) {
    actions.push({ label: "Retry", icon: RefreshCw, onClick: onRetry });
  }

  return actions;
}

function NoticeButton({ action, primary }) {
  const Icon = action.icon;
  const TrailingIcon = action.trailingIcon;
  const className = primary ? PRIMARY_BUTTON : SECONDARY_BUTTON;
  const content = (
    <>
      {Icon && <Icon size={14} aria-hidden="true" />}
      {action.label}
      {TrailingIcon && <TrailingIcon size={13} aria-hidden="true" />}
    </>
  );

  if (action.href) {
    return (
      <a href={action.href} target="_blank" rel="noreferrer" className={className}>
        {content}
      </a>
    );
  }

  return (
    <button type="button" onClick={action.onClick} className={className}>
      {content}
    </button>
  );
}

export function ErrorNotice({ error, onRetry, onOpenSettings, onNewChat, onDismiss, className }) {
  if (!error) return null;

  const Icon = ICONS[error.kind] || CircleAlert;
  const actions = noticeActions(error, { onRetry, onOpenSettings, onNewChat });

  return (
    <div
      role="alert"
      className={cx(
        "flex max-w-3xl items-start gap-2.5 rounded-xl border border-red-500/25 bg-red-500/[0.08] px-3.5 py-3",
        className,
      )}
    >
      <Icon size={18} className="mt-px shrink-0 text-red-300" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-5 text-red-200">{error.title}</p>
        <p className="mt-0.5 text-pretty text-[13px] leading-5 text-neutral-300">{error.message}</p>
        {actions.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {actions.map((action, index) => (
              <NoticeButton key={action.label} action={action} primary={index === 0} />
            ))}
          </div>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className={cx(
            "-mr-1 -mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
            CONTROL_MOTION,
          )}
        >
          <X size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
