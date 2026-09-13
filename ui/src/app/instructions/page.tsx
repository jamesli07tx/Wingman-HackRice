import type { ReactNode } from "react";
import {
  CONF_THRESHOLD,
  COOLDOWN_MIN,
  FRAME_INTERVAL_MS,
  PAGE1_MIN_SEC,
  ROTATE_SEC,
  STABILITY_N,
} from "@wingman/shared";

// Wearer instructions — DESIGN.md §5.2. Static content, safe to prerender.
export const metadata = { title: "Wingman — Instructions" };

function Block({ title, kicker, children }: { title: string; kicker?: string; children: ReactNode }) {
  return (
    <section className="anim-rise mb-6 rounded-lg bg-[var(--panel)] p-6 shadow-[var(--shadow-2)]">
      <h2 className="text-xl font-bold">{title}</h2>
      {kicker ? <p className="mt-0.5 text-sm text-[var(--muted)]">{kicker}</p> : null}
      <div className="mt-2.5 space-y-2 text-[15px] leading-relaxed">{children}</div>
    </section>
  );
}

function Rule({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-[var(--faint)]" />
      <span>{children}</span>
    </li>
  );
}

export default function InstructionsPage() {
  return (
    <div>
      <h1 className="mb-1 text-[28px] font-bold">How to wear Wingman</h1>
      <p className="mb-5 text-[15px] text-[var(--muted)]">
        There is nothing to press, say, or gesture. Start the session on the home
        screen, then just walk the fair.
      </p>

      <Block title="The capture LED" kicker="Lit = armed, and that is on purpose">
        <p>
          While a session is armed the glasses&apos; capture LED is lit continuously. It
          is not a bug and it cannot be turned off — the platform forces it, and it is
          the honest signal to everyone around you that a camera is on.
        </p>
        <ul className="space-y-1.5">
          <Rule>LED on → frames are streaming and Wingman can show you cards.</Rule>
          <Rule>LED off → the session is stopped. Nothing is being captured.</Rule>
          <Rule>
            Arm per demo run, not all day — continuous streaming is the main battery
            cost. Keep a charger in your pocket.
          </Rule>
        </ul>
      </Block>

      <Block title="Standing at a booth" kicker="Banner centered, conversational distance">
        <ul className="space-y-1.5">
          <Rule>
            Face the banner so it sits <strong>near the center of your view</strong>, not
            off at the edge. The gate is deliberately strict about &quot;you are looking
            at it&quot; versus &quot;you walked past it.&quot;
          </Rule>
          <Rule>
            Stand at <strong>normal conversational distance</strong> — the distance you
            would stand to talk to a recruiter. It will not read a 10 cm logo from across
            the hall.
          </Rule>
          <Rule>
            <strong>Hold still for about {((STABILITY_N * FRAME_INTERVAL_MS) / 1000).toFixed(1)}{" "}
            seconds.</strong> A frame is sampled every{" "}
            {(FRAME_INTERVAL_MS / 1000).toFixed(2)}s and the banner has to register on{" "}
            {STABILITY_N} in a row before anything fires. A quick glance on your way past
            is ignored by design.
          </Rule>
          <Rule>
            You will see an <em>Identifying…</em> card first, then the real card within
            about five seconds.
          </Rule>
          <Rule>
            Nothing appears? Wingman is not sure (below {CONF_THRESHOLD} confidence) and
            stays silent rather than guessing at you. Whoever is on the dashboard sees
            the miss and can force the right company.
          </Rule>
          <Rule>
            Walked back to a booth you already saw? It stays quiet for {COOLDOWN_MIN}{" "}
            minutes — that is the cooldown, not a failure.
          </Rule>
        </ul>
      </Block>

      <Block title="Reading the two-page rotation" kicker="1/2 is the company · 2/2 is you">
        <ul className="space-y-1.5">
          <Rule>
            <strong>Page 1/2 — the company.</strong> Who they are, what they are hiring
            for, one recent thing worth mentioning. It holds for at least{" "}
            {PAGE1_MIN_SEC} seconds so you can actually read it.
          </Rule>
          <Rule>
            <strong>Page 2/2 — your pitch.</strong> Three to five talking points drawn
            from your own resume and links, aimed at this specific company. Everything on
            it is grounded in your profile — it will not invent experience for you.
          </Rule>
          <Rule>
            After that the card alternates every {ROTATE_SEC} seconds. The footer marker
            (<span className="font-mono">1/2</span> · <span className="font-mono">2/2</span>)
            tells you which page you are on. You never flip it yourself.
          </Rule>
          <Rule>
            A card set stays up until a <em>different</em> booth is clearly identified, or
            until you press Stop.
          </Rule>
        </ul>
      </Block>

      <Block title="Scanning a pamphlet" kicker="Hold it close, fill the frame">
        <ul className="space-y-1.5">
          <Rule>
            Hold the flyer or one-pager <strong>close to your face</strong> — roughly
            30 cm — so it fills most of your view. That is the whole trigger.
          </Rule>
          <Rule>
            Keep it flat and steady for two sampled frames. Wingman then takes one
            high-resolution photo on its own.
          </Rule>
          <Rule>
            Roles and deadlines from the sheet merge into the card you are already
            looking at, usually within eight seconds. If you are not at a booth, you get
            a standalone scan card instead.
          </Rule>
          <Rule>
            Avoid glare and hard shadows; a slight tilt away from overhead lights reads
            better than dead-on.
          </Rule>
        </ul>
      </Block>

      <Block title="Privacy — say this out loud" kicker="No audio · no faces · frames are ephemeral">
        <ul className="space-y-1.5">
          <Rule>
            <strong>There is no microphone path at all.</strong> Wingman has no speech
            recognition, no voice commands, no audio capture anywhere in the system.
          </Rule>
          <Rule>
            <strong>No facial recognition, ever.</strong> Identification is
            company-level, from banners and signage. Phone mode detects that a face is
            present only to position the bubble on screen — that happens on the phone,
            and those frames never leave it.
          </Rule>
          <Rule>
            <strong>Frames are ephemeral.</strong> Sampled frames are classified in
            memory and dropped — never written to disk. Document photos are discarded
            after the text is extracted.
          </Rule>
          <Rule>
            <strong>The LED is always on while armed</strong>, so nobody around you is
            unaware.
          </Rule>
          <Rule>
            <strong>Stop purges the session</strong> — frames, photos and context all go.
          </Rule>
        </ul>
      </Block>

      <Block title="Phone mode" kicker="Same product, no hardware">
        <ul className="space-y-1.5">
          <Rule>
            Switch the home screen toggle to <strong>Phone</strong> and press the button
            — it opens the capture page and claims this phone as a device automatically.
          </Rule>
          <Rule>
            Allow camera access when the browser asks. Then <strong>there are no
            buttons</strong>: it samples frames on the same cadence and auto-detects
            exactly like the glasses.
          </Rule>
          <Rule>
            Hold the phone up like you are taking a photo of the banner, at the same
            conversational distance, and keep it steady for two frames.
          </Rule>
          <Rule>
            The card appears as a floating bubble over the camera view — the same JSON
            the lens renders.
          </Rule>
          <Rule>
            Keep the screen awake and the tab in the foreground; a backgrounded browser
            tab stops the camera.
          </Rule>
          <Rule>
            Pamphlets work the same way: bring the sheet close enough to fill the frame.
          </Rule>
        </ul>
      </Block>

      <Block title="If something looks wrong">
        <ul className="space-y-1.5">
          <Rule>
            Keep the <a className="underline underline-offset-2" href="/feed">live feed</a>{" "}
            open on a second screen — it shows every frame&apos;s classification and every
            identification the lens silenced.
          </Rule>
          <Rule>
            Wrong company, or nothing at all? Use the override picker on that page to
            force the right card immediately.
          </Rule>
          <Rule>Cards never block your view for long: worst case, press Stop.</Rule>
        </ul>
      </Block>
    </div>
  );
}
