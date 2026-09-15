"use client";

import { Volume2, VolumeX } from "lucide-react";
import { playAlertChime, useAlertSound } from "./alertSound";

/**
 * The speaker switch in the alerts drawer header.
 *
 * ── Why turning it ON plays the sound ───────────────────────────────────────
 * Two reasons, and the second is the important one.
 *
 * It tells the client what they have just switched on, which is ordinary good
 * manners for a sound setting. But it also *unlocks* it: browsers keep an
 * `AudioContext` suspended until the visitor has interacted with the page, so
 * a client who loads the portal and never clicks gets no chime for the first
 * alert. This click is an interaction, and playing here resumes the context
 * while the gesture is still live — so the switch doubles as the thing that
 * makes the feature work on a tab nobody has touched.
 */
export function AlertSoundToggle() {
  const [on, setOn] = useAlertSound();

  return (
    <button
      type="button"
      onClick={() => {
        setOn(!on);
        // Only on the way on. Confirming a mute with a noise is a joke the
        // client is not in on.
        if (!on) void playAlertChime();
      }}
      aria-pressed={on}
      title={on ? "Alert sound on" : "Alert sound off"}
      aria-label={on ? "Turn alert sound off" : "Turn alert sound on"}
      className={`p-1.5 rounded-[9px] hover:bg-white cursor-pointer ${on ? "text-ink" : "text-mut-d"}`}
    >
      {on ? (
        <Volume2 className="w-4.25 h-4.25 stroke-[1.7]" />
      ) : (
        <VolumeX className="w-4.25 h-4.25 stroke-[1.7]" />
      )}
    </button>
  );
}
