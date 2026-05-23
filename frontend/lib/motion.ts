/**
 * Motion vocabulary - shared across the StreamCheats app.
 *
 * Ported verbatim from streamcheats-marketing/app-v2/src/lib/motion.ts —
 * the marketing site is the single source of truth for the motion
 * vocabulary; this file MUST stay in lockstep with it. If you need a
 * different ease/duration, change it in the marketing repo first and
 * re-port here.
 *
 * "Elegant restraint" means: one piece moves at a time, no looping
 * particles, no parallax, no rotation, no spring overshoot. Settle,
 * don't bounce. See marketing-repo DESIGN.md § Motion vocabulary.
 */

export const ease = {
  out: [0.22, 1, 0.36, 1] as const,        // gentle settle - the default
  inOut: [0.65, 0, 0.35, 1] as const,      // paired travel
  linear: [0, 0, 1, 1] as const,
};

export const duration = {
  quick: 0.18,   // hover state, focus ring
  base: 0.32,    // interactive element transitions
  settle: 0.5,   // first-paint piece reveals
  piece: 0.72,   // single longest piece allowed
};

/** First-paint reveal. Use sparingly - one cascade per surface. */
export const reveal = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: duration.settle, ease: ease.out },
};

/** Stagger children of a container. Keep stagger tight (<0.08s). */
export const staggerContainer = {
  initial: {},
  animate: {
    transition: { staggerChildren: 0.06, delayChildren: 0.08 },
  },
};

/** Card / panel that pushes up on hover. Restrained - 2px lift only. */
export const liftHover = {
  whileHover: { y: -2 },
  transition: { duration: duration.base, ease: ease.out },
};
