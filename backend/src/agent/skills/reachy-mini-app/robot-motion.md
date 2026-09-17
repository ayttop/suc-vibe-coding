# Robot Motion Philosophy

> **Source**: adapted from `reachy_mini/skills/motion-philosophy.md`. The
> code snippets below are in Python but the concepts map 1-to-1 to the
> browser SDK (`robot.goto()` / `robot.setTarget()` / `robot.playMove()`).

---

## When to read this

- Deciding between `goto()` (smooth, interpolated) and `setTarget()`
  (immediate).
- Planning how motion will behave in an interactive app.
- The user mentions "smooth motion", "tracking", "reactive", "dance".

---

## The two motion primitives

| Method | Behaviour | Use when |
|--------|-----------|----------|
| `goto(target, { duration, method })` | Smooth interpolation over `duration`. | **Default** for gestures, emotions, choreography, transitions lasting >= 0.5 s. |
| `setTarget(target)` | Immediate, no interpolation. | Real-time control that reacts every frame (tracking, joystick-like input, games). |

---

## `goto()` - the default choice

Use this for most scripted motion.

```js
await robot.goto(
  { head: { yaw: 30, pitch: 10 } }, // degrees
  { duration: 1.0, method: "minjerk" },
);
```

Interpolation methods:

| Method | Character |
|--------|-----------|
| `linear` | Constant speed. |
| `minjerk` | Natural, smooth - **default**. |
| `ease_in_out` | Slow start and end. |
| `cartoon` | Exaggerated, bouncy. Good for characterful apps. |

### Key insight

During an interpolated `goto()` the robot is **committed** to the move.
It does not react to new inputs until the interpolation ends. That's
fine for:

- Playing back an emotion.
- Running a choreographed sequence.
- Transitioning between UI states.

It's the wrong tool for anything that needs to follow a moving target
(face, cursor, ball, audio level, etc.) - use `setTarget()` instead.

---

## `setTarget()` - for real-time control

Use this when you need to react every frame.

**Requirements:**

- Run a loop at 50-100 Hz (`requestAnimationFrame` works; `setInterval`
  at 20 ms is fine too).
- **A single place in your code** calls `setTarget()`. All inputs (face
  position, keyboard, DOA, etc.) feed a shared state that the loop reads.
- Keep sending targets even when idle - don't go silent; the robot
  should always know its commanded pose.

```js
let targetPose = { yaw: 0, pitch: 0 };

// inputs update targetPose, never call setTarget directly
function onFaceMoved(face) {
  targetPose = mapFaceToHeadPose(face);
}
function onJoystickMoved(x, y) {
  targetPose = mapJoystickToHeadPose(x, y);
}

function controlLoop() {
  robot.setTarget({ head: targetPose });
  requestAnimationFrame(controlLoop);
}
controlLoop();
```

---

## Decision flowchart

```
Does the app need to react to input/sensors every frame?
├─ NO  → goto()
│        · simpler code
│        · guaranteed smooth motion
│        · good for: emotions, dances, scripted sequences
│
└─ YES → setTarget() in a single control loop
         · fully reactive
         · you control smoothing yourself if needed
         · good for: face/hand tracking, games, puppeteering, recording
```

---

## Common mistake - DON'T

```js
// BAD: setTarget calls scattered across event handlers
function onFaceDetected(face) {
  robot.setTarget({ head: lookAtFace(face) });
}
function onButtonPress() {
  robot.setTarget({ head: neutralPose });
}
function idle() {
  robot.setTarget({ head: breathingPose });
}
```

Each handler fights the others; the motion is jittery and there's no
single source of truth.

### DO instead

```js
// GOOD: one loop, handlers update shared state
const state = {
  faceTarget: null,
  override: null,
  idle: breathingPose,
};

function onFaceDetected(face) {
  state.faceTarget = lookAtFace(face);
}
function onButtonPress() {
  state.override = neutralPose;
}

function controlLoop() {
  const pose = state.override ?? state.faceTarget ?? state.idle;
  robot.setTarget({ head: pose });
  requestAnimationFrame(controlLoop);
}
controlLoop();
```

---

## Mixing the two

You **can** alternate: use `setTarget()` for a tracking phase, then `await
robot.goto(homePose, { duration: 1 })` to transition, then resume
`setTarget()`. What you cannot do is call both simultaneously on the
same DOF - the last write wins and motion looks broken.
