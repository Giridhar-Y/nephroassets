import { useCallback, useEffect, useRef, useState } from "react";

// Healthcare/finance data left open on an unattended workstation is a real audit-
// compliance risk — 30 minutes total idle time before forced sign-out, with a 2-minute
// countdown warning starting at the 28-minute mark, is the enterprise SaaS standard this
// was asked to match.
const WARNING_AFTER_MS = 28 * 60 * 1000;
const COUNTDOWN_MS = 2 * 60 * 1000;
const LOGOUT_AFTER_MS = WARNING_AFTER_MS + COUNTDOWN_MS;
const TICK_MS = 1000;
// How often an active tab writes its activity timestamp to localStorage for other tabs
// to see — not on every raw mousemove event, just enough that cross-tab reset still
// reads as immediate.
const CROSS_TAB_WRITE_THROTTLE_MS = 2000;

const ACTIVITY_STORAGE_KEY = "nephroassets.lastActivityTimestamp";
const ACTIVITY_EVENTS = ["mousemove", "keydown", "click", "scroll", "touchstart"] as const;

/** Idle timer with cross-tab sync via localStorage (activity in one tab resets every
 *  other open tab's timer) — `onExpire` fires once, exactly when total idle time crosses
 *  LOGOUT_AFTER_MS. `stayActive` is what the warning modal's "Stay Signed In" button (and
 *  "Sign Out Now" calling onExpire directly) hook into. */
export function useIdleLogout(onExpire: () => void) {
  const [showWarning, setShowWarning] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(Math.ceil(COUNTDOWN_MS / 1000));
  const lastActivityRef = useRef(Date.now());
  const lastWriteRef = useRef(0);
  const expiredRef = useRef(false);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  const recordActivity = useCallback((forceWrite = false) => {
    const now = Date.now();
    lastActivityRef.current = now;
    if (forceWrite || now - lastWriteRef.current > CROSS_TAB_WRITE_THROTTLE_MS) {
      lastWriteRef.current = now;
      localStorage.setItem(ACTIVITY_STORAGE_KEY, String(now));
    }
  }, []);

  useEffect(() => {
    // Pick up any more-recent activity another tab already recorded before this one
    // mounted (e.g. this tab was just opened).
    const stored = Number(localStorage.getItem(ACTIVITY_STORAGE_KEY));
    if (stored > lastActivityRef.current) lastActivityRef.current = stored;

    const onActivity = () => recordActivity(false);
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true });

    function onStorage(e: StorageEvent) {
      if (e.key !== ACTIVITY_STORAGE_KEY || !e.newValue) return;
      const ts = Number(e.newValue);
      if (ts > lastActivityRef.current) lastActivityRef.current = ts;
    }
    window.addEventListener("storage", onStorage);

    const interval = setInterval(() => {
      if (expiredRef.current) return;
      const idleFor = Date.now() - lastActivityRef.current;
      if (idleFor >= LOGOUT_AFTER_MS) {
        expiredRef.current = true;
        setShowWarning(false);
        onExpireRef.current();
        return;
      }
      if (idleFor >= WARNING_AFTER_MS) {
        setShowWarning(true);
        setSecondsRemaining(Math.max(0, Math.ceil((LOGOUT_AFTER_MS - idleFor) / 1000)));
      } else {
        setShowWarning(false);
      }
    }, TICK_MS);

    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity);
      window.removeEventListener("storage", onStorage);
      clearInterval(interval);
    };
  }, [recordActivity]);

  const stayActive = useCallback(() => {
    recordActivity(true);
    setShowWarning(false);
  }, [recordActivity]);

  return { showWarning, secondsRemaining, stayActive };
}
